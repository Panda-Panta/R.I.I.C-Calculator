import {OPERATOR_MAP} from '../domain/operators'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {isShiftRunOperator} from '../scheduler/scheduleAdapter'
import {isTradeRunOrderOperator} from '../domain/shiftRunPolicy'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import type {MowerRoomId,RosterWorkspace} from '../workbench/model'
import {admitCombinationCandidates} from './inventoryAdmission'
import {compileCandidateLayout,validatePhysicalRoster,type LayoutAssignment} from './rosterDraft'
import {projectRosterOutput} from './rosterProjection'
import {buildBackupSnapshot} from './backupSnapshot'
import {combineDutySnapshots} from './fixedDuty'
export {buildBackupSnapshot} from './backupSnapshot'

export interface BackupEfficiencyResult {
 workspace:RosterWorkspace;beforeScore:number|null;afterScore:number|null;beforeRanking:number|null;afterRanking:number|null
 changes:{roomId:string;before:string[];after:string[];kind:'combination'|'single'}[]
 evaluations:number;diagnostics:string[]
}
const facilityTypes={manufacture:'MANUFACTURE',trading:'TRADING',power:'POWER',central:'CONTROL'} as const
const special=(id:string)=>isShiftRunOperator(resolveId(id))||OPERATOR_MAP.get(resolveId(id))?.name==='菲亚梅塔'
const participants=(w:RosterWorkspace)=>Object.values(w.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[
 ...(s.occupant.kind==='operator'?[resolveId(s.occupant.operatorId)]:[]),...s.replacements.map(resolveId),
]))
export function hasOpaqueStrategy(w:RosterWorkspace):boolean {
 const known=new Set(['ling_xi','exhaust_require','rest_in_full','resting_priority','workaholic','refresh_trading','refresh_drained','ope_resting_priority'])
 return Object.entries(w.mainPlan.conf).some(([k,v])=>!known.has(k)||(k!=='ling_xi'&&(!Array.isArray(v)||v.length>0)))||
 w.compatibility.backupPlans.length>0||[w.compatibility.otherPlans,w.compatibility.unrecognizedFields,w.compatibility.unrecognizedRooms,w.compatibility.facilityMetadata].some(v=>v&&Object.keys(v).length>0)||
 Object.values(w.mainPlan.facilities).some(r=>r.slots.some(s=>Object.keys(s.metadata??{}).length>0||r.type==='trading'&&s.replacements.some(isTradeRunOrderOperator)))
}
function supportSatisfied(snapshot:RosterWorkspace,supports:LayoutAssignment[],targetRoom:MowerRoomId):boolean {
 const rooms=Object.values(snapshot.mainPlan.facilities)
 function match(index:number,used:Set<string>):boolean {
  if(index===supports.length)return true
  const s=supports[index]!
  for(const r of rooms){
   if(used.has(r.roomId)||r.type!==s.facility||r.level<s.minimumLevel||(s.product&&r.product!==s.product))continue
   const ids=r.slots.flatMap(slot=>slot.occupant.kind==='operator'?[resolveId(slot.occupant.operatorId)]:[])
   if(s.operatorIds.every(id=>ids.includes(id))&&(s.occupancy!=='exact'||ids.length===s.operatorIds.length)&&match(index+1,new Set([...used,r.roomId])))return true
  }
  return false
 }
 return match(0,new Set([targetRoom]))
}
/** Improve the full 82 projection of the coordinated backup snapshot while reserving every primary. */
export function optimizeBackupEfficiency(workspace:RosterWorkspace,entries:readonly OwnedOperatorInput[],options:{maxEvaluations?:number;lockedPositions?:readonly string[];mainDutyRatio?:number}={}):BackupEfficiencyResult {
 const result:BackupEfficiencyResult={workspace:structuredClone(workspace),beforeScore:null,afterScore:null,beforeRanking:null,afterRanking:null,changes:[],evaluations:0,diagnostics:[]}
 const locked=new Set(options.lockedPositions??[])
 const max=options.maxEvaluations??2000
 if(!Number.isSafeInteger(max)||max<1||max>100000){result.diagnostics.push('替班评分预算须为 1–100000 的整数。');return result}
 const ratio=options.mainDutyRatio
 if(ratio!==undefined&&(!Number.isFinite(ratio)||ratio<.75||ratio>.8)){result.diagnostics.push('普通主班参考占比须为75%–80%。');return result}
 const inventory=compileOperatorInventory(entries)
 if(!inventory.valid){result.diagnostics.push(...inventory.diagnostics.map(d=>d.message));return result}
 const eligible=inventory.operators.filter(o=>o.matchesMaximumSkills&&!special(o.charId)),owned=new Set(eligible.map(o=>o.charId))
 const ids=participants(workspace)
 if(new Set(ids).size!==ids.length){result.diagnostics.push('主班和候补必须独立且唯一，不能共用或重复占位。');return result}
 if(ids.some(id=>!owned.has(id))){result.diagnostics.push('在岗或候补包含缺失、阶段不支持或特殊跑单/菲亚梅塔干员。');return result}
 if(hasOpaqueStrategy(workspace)){result.diagnostics.push('存在特殊配置或未解释策略字段，保留原候补。');return result}
 const normalized=structuredClone(workspace)
 for(const r of Object.values(normalized.mainPlan.facilities))for(const s of r.slots){if(s.occupant.kind==='operator')s.occupant.operatorId=resolveId(s.occupant.operatorId);s.replacements=s.replacements.map(resolveId)}
 const physical=validatePhysicalRoster(normalized)
 if(physical.length){result.diagnostics.push(...physical.map(d=>d.message));return result}
 let initial:RosterWorkspace
 try{initial=buildBackupSnapshot(workspace)}catch(error){result.diagnostics.push(String(error));return result}
 const evaluate=(snapshot:RosterWorkspace)=>{if(result.evaluations>=max)return null;result.evaluations++;return projectRosterOutput(snapshot)}
 const baseline=evaluate(initial)!
 const main=ratio===undefined?null:evaluate(workspace)
 if(ratio!==undefined&&(!main?.complete||!Number.isFinite(main.daily.score))){result.diagnostics.push('主班快照未完整量化或预算不足，保留原候补。');return result}
 const ranking=(candidate:RosterWorkspace,value:ReturnType<typeof projectRosterOutput>)=>{
  if(!value.complete||!Number.isFinite(value.daily.score))return null
  const score=ratio===undefined?value.daily.score:combineDutySnapshots(candidate,main!,value,ratio).rankingScore
  return score!==null&&Number.isFinite(score)?score:null
 }
 const baselineRanking=ranking(workspace,baseline)
 const rooms=Object.values(workspace.mainPlan.facilities).filter(r=>r.type in facilityTypes).sort((a,b)=>Number(b.type==='central')-Number(a.type==='central'))
 if(baselineRanking!==null){
  result.beforeScore=baseline.daily.score;result.afterScore=baseline.daily.score;result.beforeRanking=baselineRanking;result.afterRanking=baselineRanking
 }else{
  // Rebuild an unknown backup baseline atomically. Unknown output is never treated as zero.
  result.diagnostics.push('原替班快照未完整量化，尝试建立可量化起点；不宣称相对原表的数值改善。',...baseline.diagnostics)
  const rebuilding=structuredClone(initial),candidate=structuredClone(workspace)
  const positions=rooms.flatMap(r=>r.slots.flatMap((s,index)=>s.replacements.length===1&&!locked.has(`${r.roomId}:${index}`)?[{roomId:r.roomId,index,type:r.type as keyof typeof facilityTypes}]:[]))
  const replaced=new Set(positions.map(p=>resolveId(workspace.mainPlan.facilities[p.roomId].slots[p.index]!.replacements[0]!)))
  const reserved=new Set(ids.filter(id=>!replaced.has(id)))
  for(const p of positions)rebuilding.mainPlan.facilities[p.roomId].slots[p.index]!.occupant={kind:'empty'}
  const empty=evaluate(rebuilding)
  if(!empty?.complete){result.diagnostics.push('固定辅助配置仍未量化或预算不足，保留原替班。');return result}
  // Smallest eligible pool first prevents a versatile worker consuming a scarce facility's sole option.
  positions.sort((a,b)=>eligible.filter(o=>!reserved.has(o.charId)&&o.skills.some(s=>s.roomType===facilityTypes[a.type])).length-eligible.filter(o=>!reserved.has(o.charId)&&o.skills.some(s=>s.roomType===facilityTypes[b.type])).length)
  let failed=false
  for(const [positionIndex,p] of positions.entries()){
   let winner:string|null=null,best=-Infinity,bestPower=-Infinity
   // Share the remaining budget across all unfilled seats and reserve final validation.
   const allowance=Math.min(32,Math.floor((max-result.evaluations-1)/(positions.length-positionIndex)))
   if(allowance<1){failed=true;break}
   const pool=eligible.filter(o=>!reserved.has(o.charId)&&o.skills.some(s=>s.roomType===facilityTypes[p.type]))
   for(const operator of pool.slice(0,allowance)){
    rebuilding.mainPlan.facilities[p.roomId].slots[p.index]!.occupant={kind:'operator',operatorId:operator.charId}
    const value=evaluate(rebuilding)
    rebuilding.mainPlan.facilities[p.roomId].slots[p.index]!.occupant={kind:'empty'}
    if(!value)break
    if(value.complete&&Number.isFinite(value.daily.score)&&(value.daily.score>best||value.daily.score===best&&value.powerBonusPercent>bestPower)){winner=operator.charId;best=value.daily.score;bestPower=value.powerBonusPercent}
   }
   if(!winner){failed=true;break}
   reserved.add(winner);candidate.mainPlan.facilities[p.roomId].slots[p.index]!.replacements=[winner]
   rebuilding.mainPlan.facilities[p.roomId].slots[p.index]!.occupant={kind:'operator',operatorId:winner}
  }
  const completed=failed?null:evaluate(rebuilding)
  if(!completed?.complete||!Number.isFinite(completed.daily.score)){result.diagnostics.push('预算内未形成完整可量化替班，保留原表。');return result}
  const completedRanking=ranking(candidate,completed)
  if(completedRanking===null){result.diagnostics.push('新替班的联合评分尚未完整量化，保留原表。');return result}
  result.workspace=candidate;result.afterScore=completed.daily.score;result.afterRanking=completedRanking
  for(const p of positions){const before=workspace.mainPlan.facilities[p.roomId].slots[p.index]!.replacements[0]!,after=candidate.mainPlan.facilities[p.roomId].slots[p.index]!.replacements[0]!;if(resolveId(before)!==resolveId(after))result.changes.push({roomId:p.roomId,before:[resolveId(before)],after:[after],kind:'single'})}
 }
 const templates=admitCombinationCandidates(inventory).filter(a=>a.status==='needs-context').map(a=>compileCandidateLayout(a.candidate)).filter(c=>!c.temporal&&c.assignments.every(a=>a.operatorIds.every(id=>owned.has(id))))
 const tryMove=(roomId:MowerRoomId,indices:number[],replacementIds:string[],kind:'combination'|'single',supports:LayoutAssignment[]=[])=>{
  if(result.evaluations>=max||indices.some(i=>locked.has(`${roomId}:${i}`)))return false
  const current=result.workspace.mainPlan.facilities[roomId]
  const old=indices.map(i=>resolveId(current.slots[i]!.replacements[0]!))
  if(old.every((id,i)=>id===replacementIds[i]))return false
  const reserved=new Set(participants(result.workspace).filter(id=>!old.includes(id)))
  if(new Set(replacementIds).size!==replacementIds.length||replacementIds.some(id=>reserved.has(id)||!owned.has(id)))return false
  const candidate=structuredClone(result.workspace)
  indices.forEach((slot,i)=>candidate.mainPlan.facilities[roomId].slots[slot]!.replacements=[replacementIds[i]!])
  const snapshot=buildBackupSnapshot(candidate)
  if(!supportSatisfied(snapshot,supports,roomId))return false
  const score=evaluate(snapshot)
  if(!score)return false
  const candidateRanking=ranking(candidate,score)
  if(candidateRanking===null||candidateRanking<=result.afterRanking!+1e-8)return false
  result.workspace=candidate;result.afterScore=score.daily.score;result.afterRanking=candidateRanking
  result.changes.push({roomId,before:old,after:[...replacementIds],kind})
  return true
 }
 // Revisit templates once after central/other room changes can activate their real support.
 for(let pass=0;pass<2&&result.evaluations<max;pass++){
  const previous=result.changes.length
  for(const room of rooms){
   const indices=room.slots.flatMap((s,i)=>s.occupant.kind==='operator'&&s.replacements.length===1?[i]:[])
   if(!indices.length)continue
   for(const template of templates){
    const target=template.assignments[0]!
    if(target.facility!==room.type||!target.operatorIds.length||target.operatorIds.length>indices.length||room.level<target.minimumLevel||(target.product&&room.product!==target.product))continue
    // Layout 'exact' is a placement contract, not a rule forbidding extra coworkers.
    // Try each small team's seat subset and retain every other actual backup worker.
    for(let mask=1;mask<(1<<indices.length)&&result.evaluations<max;mask++){
     const subset=indices.filter((_,i)=>(mask&(1<<i))!==0)
     if(subset.length===target.operatorIds.length)tryMove(room.roomId,subset,target.operatorIds,'combination',template.assignments.slice(1))
    }
   }
   for(const index of indices)for(const operator of eligible){
    if(result.evaluations>=max)break
    if(operator.skills.some(s=>s.roomType===facilityTypes[room.type as keyof typeof facilityTypes]))tryMove(room.roomId,[index],[operator.charId],'single')
   }
  }
  if(result.changes.length===previous)break
 }
 if(result.evaluations>=max)result.diagnostics.push('替班评分预算已用尽；当前结果是已检查候选中的改进，不代表全局最优。')
 if(ratio!==undefined)result.diagnostics.push('候补改动按主替班联合排序分验收；特殊工休比待定，替班单侧82分数不保证单调。')
 result.diagnostics.push('替班分数来自普通候补同时在岗的静态 82 快照；未计算疲劳、暖机或真实换班时序。')
 return result
}
