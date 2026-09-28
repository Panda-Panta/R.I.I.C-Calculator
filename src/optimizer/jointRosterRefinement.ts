import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {OPERATOR_MAP} from '../domain/operators'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {isShiftRunOperator} from '../scheduler/scheduleAdapter'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import type {RosterWorkspace} from '../workbench/model'
import {hasOpaqueStrategy,buildBackupSnapshot} from './backupEfficiency'
import {estimateFixedDuty,type FixedDutyEstimate} from './fixedDuty'
import {validatePhysicalRoster} from './rosterDraft'

export interface JointRosterChange {kind:'main-backup-swap'|'main-room-swap'|'main-replacement';positions:string[];before:string[];after:string[];beforeRanking:number;afterRanking:number}
export interface JointRosterRefinement {workspace:RosterWorkspace;before:FixedDutyEstimate|null;after:FixedDutyEstimate|null;evaluations:number;changes:JointRosterChange[];diagnostics:string[]}
const facilities={manufacture:'MANUFACTURE',trading:'TRADING',power:'POWER',central:'CONTROL'} as const
/** Monotonic joint refinement within the supplied projection budget. Source-defined cross-room groups stay intact. */
export function refineJointRoster(workspace:RosterWorkspace,entries:readonly OwnedOperatorInput[],options:{maxEvaluations?:number;mainDutyRatio?:number;lockedPositions?:readonly string[]}={}):JointRosterRefinement {
 const result:JointRosterRefinement={workspace:structuredClone(workspace),before:null,after:null,evaluations:0,changes:[],diagnostics:[]}
 const max=options.maxEvaluations??256,ratio=options.mainDutyRatio??.775
 if(!Number.isInteger(max)||max<2||max>100000||!Number.isFinite(ratio)||ratio<.75||ratio>.8){result.diagnostics.push('INVALID_OPTIONS');return result}
 const inventory=compileOperatorInventory(entries)
 const schedule=compileRosterSchedule(workspace)
 if(!inventory.valid||hasOpaqueStrategy(workspace)||validatePhysicalRoster(workspace).length||schedule.diagnostics.some(d=>d.severity==='error'||d.code==='UNKNOWN_OPERATOR')){result.diagnostics.push('SOURCE_NOT_ADMITTED');return result}
 try{buildBackupSnapshot(workspace)}catch{result.diagnostics.push('BACKUP_SNAPSHOT_UNAVAILABLE');return result}
 const participants=Object.values(workspace.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[...(s.occupant.kind==='operator'?[id(s.occupant.operatorId)]:[]),...s.replacements.map(id)]))
 if(participants.some(value=>isShiftRunOperator(value)||OPERATOR_MAP.get(value)?.name==='菲亚梅塔')){result.diagnostics.push('SPECIAL_SCHEDULE_UNSUPPORTED');return result}
 const eligible=inventory.operators.filter(o=>o.matchesMaximumSkills&&!isShiftRunOperator(o.charId)&&o.name!=='菲亚梅塔')
 const locked=new Set(options.lockedPositions??[]),groupRooms=new Map<string,Set<string>>()
 for(const room of Object.values(workspace.mainPlan.facilities))for(const slot of room.slots)if(slot.groupId){const rooms=groupRooms.get(slot.groupId)??new Set<string>();rooms.add(room.roomId);groupRooms.set(slot.groupId,rooms)}
 const positions=Object.values(workspace.mainPlan.facilities).flatMap(room=>room.slots.flatMap((slot,index)=>{
  const key=`${room.roomId}:${index}`
  if(!(room.type in facilities)||slot.occupant.kind!=='operator'||slot.replacements.length!==1||locked.has(key)||slot.groupId&&(groupRooms.get(slot.groupId)?.size??0)>1)return []
  return [{roomId:room.roomId,index,key,type:room.type as keyof typeof facilities}]
 }))
 const evaluate=(candidate:RosterWorkspace)=>{
  if(result.evaluations+2>max)return null
  result.evaluations+=2
  const value=estimateFixedDuty(candidate,ratio)
  return value.complete&&value.rankingScore!==null&&Number.isFinite(value.rankingScore)?value:null
 }
 result.before=evaluate(result.workspace);result.after=result.before
 if(!result.before){result.diagnostics.push('UNQUANTIFIED_SOURCE');return result}
 const primary=(w:RosterWorkspace,p:typeof positions[number])=>{const occupant=w.mainPlan.facilities[p.roomId].slots[p.index]!.occupant;return occupant.kind==='operator'?id(occupant.operatorId):''}
 const hasSkill=(operatorId:string,type:keyof typeof facilities)=>OPERATOR_MAP.get(id(operatorId))?.skills.some(s=>s.roomType===facilities[type])??false
 const attempt=(kind:JointRosterChange['kind'],changed:typeof positions,after:string[],edit:(w:RosterWorkspace)=>void)=>{
  if(result.evaluations+2>max)return
  const before=changed.map(p=>primary(result.workspace,p)),candidate=structuredClone(result.workspace)
  edit(candidate)
  const score=evaluate(candidate)
  if(!score||score.rankingScore!<=result.after!.rankingScore!+1e-8)return
  result.changes.push({kind,positions:changed.map(p=>p.key),before,after,beforeRanking:result.after!.rankingScore!,afterRanking:score.rankingScore!})
  result.workspace=candidate;result.after=score
 }
 for(let pass=0;pass<2&&result.evaluations+2<=max;pass++){
  const count=result.changes.length
  // A finite cheap pass promotes an already-owned strong backup before considering unused staff.
  for(const p of positions){
   const slot=result.workspace.mainPlan.facilities[p.roomId].slots[p.index]!,backup=id(slot.replacements[0]!),main=primary(result.workspace,p)
   if(!hasSkill(backup,p.type)||!hasSkill(main,p.type))continue
   attempt('main-backup-swap',[p],[backup],w=>{const s=w.mainPlan.facilities[p.roomId].slots[p.index]!;s.occupant={kind:'operator',operatorId:backup};s.replacements=[main]})
  }
  const swapLimit=result.evaluations+Math.floor((max-result.evaluations)/2)
  for(const [i,a]of positions.entries())for(const b of positions.slice(i+1)){
   if(result.evaluations+2>swapLimit)break
   if(a.roomId===b.roomId||a.type!==b.type)continue
   const first=primary(result.workspace,a),second=primary(result.workspace,b)
   if(!hasSkill(first,b.type)||!hasSkill(second,a.type))continue
   attempt('main-room-swap',[a,b],[second,first],w=>{w.mainPlan.facilities[a.roomId].slots[a.index]!.occupant={kind:'operator',operatorId:second};w.mainPlan.facilities[b.roomId].slots[b.index]!.occupant={kind:'operator',operatorId:first}})
  }
  // Divide remaining trials among seats so early rooms cannot consume the entire budget.
  const ordered=[...positions].sort((a,b)=>Number(b.type==='central')-Number(a.type==='central'))
  for(const [index,p]of ordered.entries()){
   const allowance=Math.min(24,Math.floor((max-result.evaluations)/(2*(ordered.length-index))))
   if(allowance<1)break
   const used=new Set(Object.values(result.workspace.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[...(s.occupant.kind==='operator'?[id(s.occupant.operatorId)]:[]),...s.replacements.map(id)])))
   const pool=eligible.filter(o=>!used.has(o.charId)&&hasSkill(o.charId,p.type))
   for(const operator of pool.slice(0,allowance))attempt('main-replacement',[p],[operator.charId],w=>{w.mainPlan.facilities[p.roomId].slots[p.index]!.occupant={kind:'operator',operatorId:operator.charId}})
  }
  if(result.changes.length===count)break
 }
 result.diagnostics.push('仅接受完整主替班排序分提升；跨站组保持整体，副表暂不参与优化。')
 return result
}
