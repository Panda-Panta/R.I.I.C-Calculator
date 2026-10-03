import { mainPlanOnly } from './mainPlanOnly'
import { ensureBuiltDormKeepers } from './dormKeepers'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {isShiftRunOperator} from '../scheduler/scheduleAdapter'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import {type MowerFacility,type MowerRoomId,type RosterWorkspace} from '../workbench/model'
import {admitCombinationCandidates} from './inventoryAdmission'
import {sampleCombinationTemplates} from './templateSampling'
import {CROSS_ROOM_TEMPLATES,applyCrossRoomTemplate,crossRoomTemplateIssues,type CrossRoomPlacement} from './crossRoomTemplates'
import {projectRosterOutput as project} from './rosterProjection'
import {optimizeBackupEfficiency} from './backupEfficiency'
import {estimateFixedDuty,type FixedDutyEstimate} from './fixedDuty'
import {refineJointRoster,type JointRosterChange} from './jointRosterRefinement'
import {assignBackups,compileCandidateLayout,generateRosterDraft,validatePhysicalRoster,type RosterDraftResult} from './rosterDraft'

export interface AutomaticRosterOptions {seed?:number;trials?:number;maxStates?:number;mainDutyRatio?:number}
export interface AutomaticRosterTrial {
 seed:number;status:'draft'|'blocked';staticScore:number|null;complete:boolean;candidateIds:string[];diagnostics:string[]
 seedCandidateIds?:string[]
 crossRoomSelections?:CrossRoomPlacement[]
 backupBeforeRanking?:number|null;backupAfterRanking?:number|null
 refinement?:{beforeRanking:number;afterRanking:number;changes:JointRosterChange[]}
 duty?:FixedDutyEstimate;backupBeforeScore?:number|null;backupAfterScore?:number|null
}
export interface AutomaticRosterResult {
 status:'draft'|'blocked';draft:RosterDraftResult|null;diagnostics:{code:string;message:string}[]
 trials:AutomaticRosterTrial[];selectedTrial:number|null
}
const facilityTypes={manufacture:'MANUFACTURE',trading:'TRADING',power:'POWER',central:'CONTROL'} as const
const capacity=(r:MowerFacility)=>r.level===0?0:r.type==='central'?5:r.type==='power'?1:r.level
const mutable=(r:MowerFacility)=>r.type in facilityTypes
const scheduleIssues=(workspace:RosterWorkspace)=>compileRosterSchedule(workspace).diagnostics.filter(d=>d.severity==='error'||d.code==='UNKNOWN_OPERATOR')
const occupied=(w:RosterWorkspace)=>new Set(Object.values(w.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[
 ...(s.occupant.kind==='operator'?[resolveId(s.occupant.operatorId)]:[]),...s.replacements.map(resolveId),
])))
function random(seed:number){let n=seed>>>0;return()=>{n=(n+0x6d2b79f5)>>>0;let t=n;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
function shuffled<T>(items:readonly T[],next:()=>number):T[]{const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[result[i],result[j]]=[result[j]!,result[i]!]}return result}
/** Bounded instantaneous screening. A complete draft is still conditional on dynamic rest simulation. */
export function generateAutomaticRoster(base:RosterWorkspace,entries:readonly OwnedOperatorInput[],options:AutomaticRosterOptions={}):AutomaticRosterResult {
 base=mainPlanOnly(base)
 const result:AutomaticRosterResult={status:'blocked',draft:null,diagnostics:[],trials:[],selectedTrial:null}
 const seed=options.seed??42,trials=options.trials??3,maxStates=options.maxStates??2000,mainDutyRatio=options.mainDutyRatio??.775
 const fail=(code:string,message:string)=>{result.diagnostics.push({code,message});return result}
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff||!Number.isInteger(trials)||trials<1||trials>8||!Number.isInteger(maxStates)||maxStates<1||maxStates>100000)return fail('INVALID_OPTIONS','随机种子须为 uint32，生成次数须为 1–8，单次状态预算须为 1–100000 的整数。')
 if(!Number.isFinite(mainDutyRatio)||mainDutyRatio<.75||mainDutyRatio>.8)return fail('INVALID_DUTY_RATIO','普通主班参考占比须为75%–80%。')
 const inventory=compileOperatorInventory(entries)
 if(!inventory.valid){result.diagnostics.push(...inventory.diagnostics);return result}
 const normalized=structuredClone(base)
 for(const room of Object.values(normalized.mainPlan.facilities))for(const slot of room.slots){if(slot.occupant.kind==='operator')slot.occupant.operatorId=resolveId(slot.occupant.operatorId);slot.replacements=slot.replacements.map(resolveId)}
 result.diagnostics.push(...validatePhysicalRoster(normalized))
 if(result.diagnostics.length)return result
 const conf=base.mainPlan.conf,knownConf=new Set(['ling_xi','exhaust_require','rest_in_full','resting_priority','workaholic','refresh_trading','refresh_drained','ope_resting_priority'])
 const opaque=Object.entries(conf).some(([key,value])=>!knownConf.has(key)||(key!=='ling_xi'&&(!Array.isArray(value)||value.length>0)))||base.compatibility.backupPlans.length>0||[base.compatibility.unrecognizedFields,base.compatibility.unrecognizedRooms,base.compatibility.facilityMetadata].some(v=>v&&Object.keys(v).length>0)||Object.values(base.mainPlan.facilities).some(r=>r.slots.some(s=>Object.keys(s.metadata??{}).length>0||s.replacements.length>0||s.groupId!==null))
 if(opaque)return fail('AUTOMATIC_OPAQUE_STRATEGY','当前版本只为空布局生成普通轮班；存在策略、候补、分组或未解释字段，请使用已有排班搜索。')
 const rooms=Object.values(base.mainPlan.facilities).filter(mutable)
 if(!rooms.some(r=>r.type==='manufacture'||r.type==='trading'))return fail('NO_PRODUCTION_ROOM','至少需要一个制造站或贸易站。')
 if(rooms.some(r=>r.slots.some(s=>s.occupant.kind!=='empty')))return fail('AUTOMATIC_OCCUPIED_OUTPUT','生产设施与中枢必须为空；现有辅助干员及宿舍 Free 会保留。')
 if(rooms.some(r=>r.product==='fragment'||r.product==='orundum'))return fail('UNSUPPORTED_PRODUCT','当前 82 初筛仅支持作战记录、赤金和龙门币订单。')
 const admission=scheduleIssues(base)
 if(admission.length){result.diagnostics.push(...admission);return result}
 const eligible=inventory.operators.filter(o=>o.matchesMaximumSkills&&!isShiftRunOperator(o.charId)&&o.name!=='菲亚梅塔')
 const templates=admitCombinationCandidates(inventory).filter(a=>a.status==='needs-context').map(a=>a.candidate).filter(c=>{
  const contract=compileCandidateLayout(c),target=contract.assignments[0]!
  return !contract.temporal&&['manufacture','trading','power'].includes(target.facility)&&rooms.some(r=>r.type===target.facility&&r.level>=target.minimumLevel&&(!target.product||r.product===target.product)&&capacity(r)>=target.operatorIds.length)
 })
 const crossTemplates=CROSS_ROOM_TEMPLATES.filter(t=>!crossRoomTemplateIssues(t).length)
 let bestScore=-Infinity
 for(let trialIndex=0;trialIndex<trials;trialIndex++){
  const trialSeed=(seed+Math.imul(trialIndex,0x9e3779b9))>>>0,next=random(trialSeed)
  const trial:AutomaticRosterTrial={seed:trialSeed,status:'blocked',staticScore:null,complete:false,candidateIds:[],diagnostics:[]};result.trials.push(trial)
  let workspace=structuredClone(base),states=0
  const conditions:RosterDraftResult['uncheckedConditions']=[],placements:RosterDraftResult['placements']=[]
  const evaluate=(w:RosterWorkspace)=>{if(states>=maxStates)return null;states++;return project(w)}
  const lockedPositions:string[]=[]
  // Keep the first trial as the existing local-team baseline. Later starts can seed one real cross-room group.
  if(trialIndex>0&&maxStates>=512){
   let winner:{draft:ReturnType<typeof applyCrossRoomTemplate>;priority:number}|null=null
   const baseline=evaluate(workspace)
   for(const template of shuffled(crossTemplates,next).slice(0,8)){
    const budget=Math.min(96,Math.floor(maxStates/8)-states)
    if(budget<1)break
    const draft=applyCrossRoomTemplate(workspace,entries,template,budget);states+=draft.statesVisited
    if(!draft.workspace)continue
    const score=evaluate(draft.workspace)
    if(!baseline||!score?.complete)continue
    const priority=(score.daily.score-baseline.daily.score)/template.members.length
    if(priority>0&&(!winner||priority>winner.priority))winner={draft,priority}
   }
   if(winner){
    workspace=winner.draft.workspace!;const selection=winner.draft.selection!
    trial.crossRoomSelections=[selection]
    lockedPositions.push(...selection.members.map(m=>`${m.roomId}:${m.slotIndex}`))
    trial.diagnostics.push(`采用原表跨站组 ${selection.groupId}，${selection.members.length}名成员共同换班，候补来自原候补池。`)
    conditions.push({kind:'cross-room',text:'跨站分组及候补来自原表；仅普通无条件组参与此次生成，原候补选择锁定，特殊工休比仍待定。'})
   }
  }
  // Catalog sampling is deliberately finite. Placement resolves every named support to a real seat.
  // Discard its provisional backups: reserve replacements only after every primary is selected.
  // Sample first, then prioritize whole-base 82 gain per target worker before occupying seats.
  const ranked=[] as {candidate:typeof templates[number];priority:number}[]
  const emptyValue=evaluate(workspace)
  for(const candidate of sampleCombinationTemplates(templates,next,12)){
   if(states>=Math.floor(maxStates/4))break
   const attempt=generateRosterDraft(workspace,entries,[candidate.id],{maxStates:Math.max(1,Math.min(32,Math.floor(maxStates/4)-states))})
   states+=attempt.statesVisited
   if(!attempt.workspace)continue
   const value=evaluate(attempt.workspace)
   if(value?.complete&&emptyValue)ranked.push({candidate,priority:(value.daily.score-emptyValue.daily.score)/candidate.targetAssignment.operators.length})
  }
  ranked.sort((a,b)=>b.priority-a.priority)
  for(const {candidate} of ranked){
   if(states>=Math.floor(maxStates/3))break
   const remaining=Math.min(64,Math.floor(maxStates/3)-states)
   if(remaining<1)break
   const draft=generateRosterDraft(workspace,entries,[candidate.id],{maxStates:remaining});states+=draft.statesVisited
   if(!draft.workspace)continue
   const target=compileCandidateLayout(candidate).assignments[0]!
   const placedTarget=draft.placements.find(p=>p.roomKey===target.roomKey)
   if(!placedTarget||capacity(draft.workspace.mainPlan.facilities[placedTarget.roomId])<target.operatorIds.length)continue
   const before=occupied(workspace),after=occupied(draft.workspace)
   for(const r of Object.values(draft.workspace.mainPlan.facilities))for(const [i,s]of r.slots.entries())s.replacements=[...(workspace.mainPlan.facilities[r.roomId].slots[i]?.replacements??[])]
   if([...after].every(id=>before.has(id)))continue
   const old=evaluate(workspace),value=evaluate(draft.workspace)
   if(!old||!value)break
   if(!value.complete||value.daily.score<old.daily.score||value.daily.score===old.daily.score&&value.powerBonusPercent<=old.powerBonusPercent)continue
   workspace=draft.workspace;trial.candidateIds.push(candidate.id);conditions.push(...draft.uncheckedConditions);placements.push(...draft.placements)
  }
  let blocked=false
  const fillRooms=shuffled(Object.values(workspace.mainPlan.facilities).filter(r=>mutable(r)&&r.type!=='central'),next)
  fillRooms.push(workspace.mainPlan.facilities.central)
  for(const room of fillRooms){
   while(room.slots.length<capacity(room))room.slots.push({occupant:{kind:'empty'},groupId:null,replacements:[]})
   for(let index=0;index<capacity(room);index++){
    const slot=room.slots[index]!
    if(slot.occupant.kind==='operator')continue
    const used=occupied(workspace)
    const pool=shuffled(eligible.filter(o=>!used.has(o.charId)&&o.skills.some(s=>s.roomType===facilityTypes[room.type as keyof typeof facilityTypes])),next)
    let winner:string|null=null,score=-Infinity,power=-Infinity
    const projectionIssues=new Set<string>()
    // Bound candidate scoring per seat while sampling a fresh subset in each trial.
    for(const operator of pool.slice(0,32)){
     slot.occupant={kind:'operator',operatorId:operator.charId}
     const value=evaluate(workspace)
     slot.occupant={kind:'empty'}
     if(!value)break
     for(const issue of value.diagnostics)projectionIssues.add(issue)
     if(value.complete&&(value.daily.score>score||value.daily.score===score&&value.powerBonusPercent>power)){winner=operator.charId;score=value.daily.score;power=value.powerBonusPercent}
    }
    if(!winner){blocked=true;trial.diagnostics.push(...[...projectionIssues].slice(0,4));trial.diagnostics.push(states>=maxStates?'状态预算耗尽，未形成完整主班。':`${room.roomId}：没有可量化且未占用的最高技能干员补齐工位。`);break}
    slot.occupant={kind:'operator',operatorId:winner}
   }
   if(blocked)break
  }
  if(blocked)continue
  if(!ensureBuiltDormKeepers(workspace,inventory)){trial.diagnostics.push('已建宿舍缺少可用宿管工位或持有干员。');continue}
  const added:{roomId:MowerRoomId;slotIndex:number;operatorId:string}[]=[]
  for(const room of Object.values(workspace.mainPlan.facilities))for(const [slotIndex,slot]of room.slots.entries()){
   const original=base.mainPlan.facilities[room.roomId]?.slots[slotIndex]
   if(slot.occupant.kind==='operator'&&original?.occupant.kind!=='operator'){
    added.push({roomId:room.roomId,slotIndex,operatorId:slot.occupant.operatorId})
    const present=workspace.compatibility.importedPresentRooms
    if(present&&!present.includes(room.roomId))present.push(room.roomId)
    if(['manufacture','trading'].includes(room.type)&&slot.groupId===null)slot.groupId=`自动_${room.roomId}`
   }
  }
  let rest=assignBackups(workspace,inventory,added.filter(p=>!lockedPositions.includes(`${p.roomId}:${p.slotIndex}`)))
  const groupSizes=new Map<string,number>()
  for(const room of Object.values(workspace.mainPlan.facilities))for(const slot of room.slots)if(slot.occupant.kind==='operator'&&slot.groupId)groupSizes.set(slot.groupId,(groupSizes.get(slot.groupId)??0)+1)
  rest.minimumFreeBedsForNewGroup=Math.max(rest.minimumFreeBedsForNewGroup,...groupSizes.values())
  for(const room of Object.values(workspace.mainPlan.facilities).filter(r=>r.type==='dormitory'))for(const slot of room.slots){
   if(slot.occupant.kind==='empty'&&!slot.replacements.length&&!slot.groupId&&!Object.keys(slot.metadata??{}).length){slot.occupant={kind:'free'};rest.freeBeds++;const present=workspace.compatibility.importedPresentRooms;if(present&&!present.includes(room.roomId))present.push(room.roomId)}
  }
  const errors=[...validatePhysicalRoster(workspace),...scheduleIssues(workspace)]
  if(rest.missingReplacementIds.length)errors.push({code:'REST_RESOURCES_INCOMPLETE',message:'无法为全部新增主班配置独立候补；不返回半成品。'})
  if(errors.length){trial.diagnostics.push(...errors.map(d=>d.message));continue}
  if(maxStates-states<4){trial.diagnostics.push('预算不足以比较完整主替班快照。');continue}
  const jointReserve=Math.min(256,Math.max(0,Math.floor((maxStates-states-3)/4)))
  const optimized=optimizeBackupEfficiency(workspace,entries,{maxEvaluations:Math.max(1,maxStates-states-3-jointReserve),lockedPositions,mainDutyRatio})
  states+=optimized.evaluations;workspace=optimized.workspace
  trial.backupBeforeScore=optimized.beforeScore;trial.backupAfterScore=optimized.afterScore
  trial.backupBeforeRanking=optimized.beforeRanking;trial.backupAfterRanking=optimized.afterRanking
  trial.diagnostics.push(...optimized.diagnostics)
  const refinementBudget=Math.min(512,maxStates-states-3)
  if(refinementBudget>=4){
   const refined=refineJointRoster(workspace,entries,{maxEvaluations:refinementBudget,mainDutyRatio,lockedPositions})
   states+=refined.evaluations;workspace=refined.workspace
   if(refined.before?.rankingScore!=null&&refined.after?.rankingScore!=null){
    trial.refinement={beforeRanking:refined.before.rankingScore,afterRanking:refined.after.rankingScore,changes:refined.changes}
    if(refined.changes.length)trial.diagnostics.push(`主替联合改进 ${refined.changes.length} 次，排序分 ${refined.before.rankingScore.toFixed(2)} → ${refined.after.rankingScore.toFixed(2)}。`)
   }
  }
  // A seed template is no longer an actual placement if refinement moved any of its members.
  const intact=new Set(placements.map(p=>p.candidateId).filter(candidateId=>placements.filter(p=>p.candidateId===candidateId).every(p=>{
   const members=new Set(workspace.mainPlan.facilities[p.roomId].slots.flatMap(s=>s.occupant.kind==='operator'?[resolveId(s.occupant.operatorId)]:[]))
   return p.operatorIds.every(id=>members.has(id))
  })))
  placements.splice(0,placements.length,...placements.filter(p=>intact.has(p.candidateId)))
  trial.seedCandidateIds=[...trial.candidateIds];trial.candidateIds=trial.candidateIds.filter(id=>intact.has(id))
  const value=evaluate(workspace)
  if(!value){trial.diagnostics.push('状态预算耗尽，最终全表评分尚未完成。');continue}
  if(!value.complete){trial.diagnostics.push(...value.diagnostics);continue}
  const duty=estimateFixedDuty(workspace,mainDutyRatio);states+=2;trial.duty=duty
  if(!duty.complete||duty.rankingScore===null){trial.diagnostics.push(...duty.diagnostics);continue}
  trial.staticScore=value.daily.score;trial.complete=true;trial.status='draft'
  trial.diagnostics.push('按主替班两套完整快照进行搭配初筛，暂不以疲劳或休息床判定优劣；特殊心情干员工休比待定。')
  const draft:RosterDraftResult={status:'draft',workspace,placements,diagnostics:[{code:'CONDITIONAL_DRAFT',message:trial.diagnostics[trial.diagnostics.length-1]!}],statesVisited:states,uncheckedConditions:conditions,restResources:rest}
  if(duty.rankingScore>bestScore){bestScore=duty.rankingScore;result.status='draft';result.draft=draft;result.selectedTrial=trialIndex}
 }
 if(!result.draft)result.diagnostics.push({code:'NO_COMPLETE_AUTOMATIC_ROSTER',message:'本次有限搜索未得到完整可量化草案；可增加次数/预算或补充干员库。'})
 else result.diagnostics.push({code:'FIXED_DUTY_SCREENING',message:'按普通岗位固定主班占比及特殊岗位两快照较低值选择搭配排序分最高者；特殊工休比待定，分值不是完整日均预测。'})
 return result
}
