import type {MowerSchedulingData} from './mowerSchedulingData'
import {MOWER_TASK_TYPES as T,MowerTaskQueue,type MowerTask,type MowerTaskPlan} from './mowerTaskQueue'
import {mowerArrangementGroupTransitions,normalizeMowerSharedArrangement,commitMowerGroupShifts,mowerRestingBindingGroups,mowerSharedReplacements} from './mowerSharedGroups'
import {projectMowerArrangements} from './mowerObservations'
import {cloneMowerShiftTask,prepareMowerShiftCycle,type MowerShiftModel} from './mowerShiftCycle'
import {alphaPosition} from './mowerAlphaDorm'
import {MowerShiftPreviewError} from './mowerNativeErrors'

/** Admit a due normal return only after proving the retained arrangement becomes feasible. */
export function proveMowerRecoveryDependencyReturn(data:MowerSchedulingData,retained:MowerTask,candidate:MowerTask,pending:readonly MowerTask[],model:MowerShiftModel):MowerTaskPlan|undefined {
 if(!retained.executionFailure||retained.arrangementStarted||retained.backupShiftActive||retained.productShiftLocked||retained.dormRecoveryRestore.length||candidate.type!==T.SHIFT_ON||candidate.timeMicros>data.nowMicros)return undefined
 const returning=new Set(Object.entries(mowerArrangementGroupTransitions(data,candidate.plan)).filter(([group,resting])=>!resting&&data.groupIsResting(group)).map(([group])=>group))
 if(!returning.size)return undefined
 const blockedSlots:[string,number][]=[]
 for(const [room,row] of Object.entries(retained.plan))row.forEach((name,index)=>{
  const owner=data.operators[data.plan[room]?.[index]??'']
  if(!['Current',''].includes(name)&&owner?.group&&returning.has(owner.group)&&!room.startsWith('dorm'))blockedSlots.push([room,index])
 })
 const original=projectMowerArrangements(data,[]),failed=cloneMowerShiftTask(retained)
 const transitions=mowerArrangementGroupTransitions(original,failed.plan)
 const sharedBlockers=Object.values(original.operators).filter(op=>{
  if(!op.multiGroup||failed.backupExplicitSlots.has(alphaPosition(op.room,op.index)))return undefined
  if(op.index>=(failed.plan[op.room]?.length??0)&&!op.groupBindings.some(binding=>binding.group in transitions))return undefined
  const groups=mowerRestingBindingGroups(original,op,transitions)
  return groups.some(group=>returning.has(group))&&!mowerSharedReplacements(op,groups).length
 })
 if(!blockedSlots.length&&!sharedBlockers.length)return undefined
 if(normalizeMowerSharedArrangement(original,structuredClone(failed.plan),transitions,failed.backupExplicitSlots))return undefined
 const queue=new MowerTaskQueue();queue.tasks=pending.filter(task=>task!==retained&&task!==candidate).map(cloneMowerShiftTask)
 const next=cloneMowerShiftTask(candidate);queue.tasks.push(next)
 try {
  if(!normalizeMowerSharedArrangement(original,next.plan,undefined,next.backupExplicitSlots))return undefined
  next.groupShiftTransitions=mowerArrangementGroupTransitions(original,next.plan)
  prepareMowerShiftCycle(original,next,queue,model)
  const returnedPlan=structuredClone(next.plan)
  const conditions=next.backupShiftConditions??original.planConditions
  let projected=model.swap(projectMowerArrangements(original,[]),conditions,next.backupGroup)
  projected=projectMowerArrangements(projected,[next.plan]);commitMowerGroupShifts(projected,next.groupShiftTransitions)
  failed.groupShiftTransitions=mowerArrangementGroupTransitions(projected,failed.plan)
  const changedOwners=JSON.stringify(conditions)!==JSON.stringify(original.planConditions)&&blockedSlots.length>0&&blockedSlots.every(([room,index])=>projected.plan[room]?.[index]!==data.plan[room]?.[index])
  const releasedBinding=sharedBlockers.some(before=>{
   const after=projected.operators[before.name]
   if(!after||projected.plan[before.room]?.[before.index]!==before.name)return undefined
   const previous=mowerRestingBindingGroups(original,before,transitions),remaining=mowerRestingBindingGroups(projected,after,failed.groupShiftTransitions)
   return previous.some(group=>returning.has(group)&&!remaining.includes(group)&&!projected.groupIsResting(group))&&mowerSharedReplacements(after,remaining).length>0
  })
  if(!changedOwners&&!releasedBinding)return undefined
  if(!normalizeMowerSharedArrangement(projected,failed.plan,failed.groupShiftTransitions,failed.backupExplicitSlots))return undefined
  queue.tasks=queue.tasks.filter(task=>task!==next);queue.tasks.push(failed)
  prepareMowerShiftCycle(projected,failed,queue,model)
  const finalRules=model.swap(projectMowerArrangements(projected,[]),failed.backupShiftConditions??projected.planConditions,failed.backupGroup)
  return normalizeMowerSharedArrangement(finalRules,failed.plan,failed.groupShiftTransitions,failed.backupExplicitSlots)?returnedPlan:undefined
 }catch(error){if(error instanceof MowerShiftPreviewError)return undefined;throw error}
}

/** Keep the admission API boolean; the evidence itself is local to one preview. */
export function mowerVerifiedRecoveryDependencyReturn(data:MowerSchedulingData,retained:MowerTask,candidate:MowerTask,pending:readonly MowerTask[],model:MowerShiftModel):boolean {
 return !!proveMowerRecoveryDependencyReturn(data,retained,candidate,pending,model)
}

/** Each exemption owns only assignments proved safe against that retained task. */
export function mowerRecoveryDependencyProofs(data:MowerSchedulingData,candidate:MowerTask,pending:readonly MowerTask[],model:MowerShiftModel):ReadonlyMap<MowerTask,MowerTaskPlan> {
 const proofs=new Map<MowerTask,MowerTaskPlan>()
 if(candidate.type!==T.SHIFT_ON)return proofs
 for(const retained of pending){
  if(retained===candidate||!retained.executionFailure)continue
  const plan=proveMowerRecoveryDependencyReturn(data,retained,candidate,pending,model)
  if(plan)proofs.set(retained,plan)
 }
 return proofs
}
