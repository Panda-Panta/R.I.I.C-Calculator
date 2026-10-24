import type {MowerSchedulingData} from './mowerSchedulingData'
import type {MowerTask,MowerTaskPlan} from './mowerTaskQueue'
import {alphaPosition} from './mowerAlphaDorm'

/** Native retained_task_reservations: unfinished execution owns targets, actual occupants and group members. */
export function mowerRetainedTaskReservations(data:MowerSchedulingData,tasks:readonly MowerTask[],currentTask?:MowerTask,returningGroups:Iterable<string>=[],ownRecovery:readonly string[]=currentTask?.urgentRecoveryRequestNames??[]):{names:Set<string>;slots:Set<string>} {
 const returning=[...returningGroups],names=new Set<string>(),slots=new Set<string>()
 if(returning.length){
  for(const task of tasks){
   if(task===currentTask||!task.retainsExecution)continue
   const reserved=mowerRetainedTaskReservations(data,[task])
   const released=new Set(returning.filter(group=>mowerRetainedRecoveryMayReturn(data,task,group)).flatMap(group=>data.shiftGroupMembers(group)))
   for(const name of released){
    reserved.names.delete(name)
    const op=data.operators[name];if(op){reserved.slots.delete(alphaPosition(op.room,op.index));reserved.slots.delete(alphaPosition(op.currentRoom,op.currentIndex))}
   }
   for(const name of reserved.names)names.add(name)
   for(const slot of reserved.slots)slots.add(slot)
  }
  return {names,slots}
 }
 for(const task of tasks){
  if(task===currentTask||!task.retainsExecution)continue
  for(const [room,row] of Object.entries(task.plan))row.forEach((name,index)=>{if(name!=='Current')slots.add(alphaPosition(room,index));if(!['Current','Free',''].includes(name))names.add(name)})
  for(const [position,name] of Object.entries(task.groupShiftExpected??{})){if(name!=='Current')slots.add(position);if(!['Current','Free',''].includes(name))names.add(name)}
  for(const name of Object.keys(task.releaseDormTargets()))names.add(name)
 }
 for(const task of tasks)if(task!==currentTask&&!(ownRecovery.length&&task.urgentRecoveryRequestNames.length===ownRecovery.length&&task.urgentRecoveryRequestNames.every(name=>ownRecovery.includes(name)))){for(const name of task.urgentRecoveryReservedNames)names.add(name);for(const slot of task.urgentRecoveryReservedSlots)slots.add(slot)}
 for(const op of Object.values(data.operators))if(slots.has(alphaPosition(op.currentRoom,op.currentIndex)))names.add(op.name)
 const groups=new Set([...names].flatMap(name=>{const op=data.operators[name];return op?.multiGroup?op.groupBindings.map(binding=>binding.group):op?[op.group]:[]}).filter(Boolean))
 for(const group of groups)for(const name of data.group(group))names.add(name)
 for(const name of names){const op=data.operators[name];if(op?.currentRoom&&op.currentIndex>=0)slots.add(alphaPosition(op.currentRoom,op.currentIndex))}
 return {names,slots}
}

/** Derived preview moves cannot replay unfinished execution or borrow its occupants. */
export function suppressMowerRetainedArrangements(data:MowerSchedulingData,plan:MowerTaskPlan,pending:readonly MowerTask[],dependencyProofs:ReadonlyMap<MowerTask,MowerTaskPlan>=new Map()):void {
 const returning=new Set<string>()
 for(const [room,row] of Object.entries(plan))row.forEach((name,index)=>{const op=data.operators[data.plan[room]?.[index]??''];if(op?.group&&data.isGroupShiftAnchor(op)&&name===op.name)returning.add(op.group)})
 const reserved=mowerRetainedTaskReservations(data,pending.filter(task=>!dependencyProofs.has(task)),undefined,returning)
 const proved=pending.flatMap(task=>{
  const proof=dependencyProofs.get(task)
  return proof?[{proof,...mowerRetainedTaskReservations(data,[task],undefined,returning)}]:[]
 })
 for(const [room,row] of Object.entries(plan)){
  row.forEach((name,index)=>{if(reserved.slots.has(alphaPosition(room,index))||reserved.names.has(name)||proved.some(claim=>(claim.slots.has(alphaPosition(room,index))||claim.names.has(name))&&claim.proof[room]?.[index]!==name))row[index]='Current'})
  if(row.every(name=>name==='Current'))delete plan[room]
 }
}

/** A failed preview's incidental bed moves do not own another group's completed recovery. */
export function mowerRetainedRecoveryMayReturn(data:MowerSchedulingData,task:MowerTask,group:string):boolean {
 if(!task.executionFailure||task.backupShiftActive||task.productShiftLocked||task.dormRecoveryRestore.length)return false
 const intent=task.backupShiftIntent??task.plan,members=new Set(data.shiftGroupMembers(group))
 if(!members.size||Object.keys(task.releaseDormTargets()).some(name=>members.has(name)))return false
 for(const [room,row] of Object.entries(intent))for(const [index,name] of row.entries()){
  if(['Current',''].includes(name))continue
  const op=data.operators[name],owner=data.operators[data.plan[room]?.[index]??'']
  const explicit=task.backupExplicitSlots.has(alphaPosition(room,index))
  // Actual primary shifts and explicitly requested backup positions remain owned.
  if(owner&&members.has(owner.name)&&(!room.startsWith('dorm')||owner.room===room&&owner.index===index))return false
  if(op&&members.has(op.name)&&(!room.startsWith('dorm')||!data.canStandby(op)||explicit))return false
  if(explicit&&members.has(data.currentOperator(room,index)?.name??''))return false
 }
 return true
}

/** Reconcile only after an observed return; preserve the original task and unrelated remaining work. */
export function reconcileMowerRetainedRecovery(data:MowerSchedulingData,task:MowerTask):void {
 const failure=task.executionFailure;if(!failure)return
 const returnedGroups=new Set(Object.values(data.operators).filter(op=>{
  const previous=failure.snapshot.observations[op.name]
  return !!op.group&&data.isGroupShiftAnchor(op)&&previous?.[0].startsWith('dorm')&&op.currentRoom===op.room&&op.currentIndex===op.index&&!op.moodIsPrediction&&mowerRetainedRecoveryMayReturn(data,task,op.group)
 }).map(op=>op.group).filter(group=>data.shiftGroupMembers(group).map(name=>data.operators[name]!).filter(op=>data.isGroupShiftAnchor(op)).every(op=>op.currentRoom===op.room&&op.currentIndex===op.index&&!op.moodIsPrediction)))
 const returned=new Set([...returnedGroups].flatMap(group=>data.shiftGroupMembers(group)).filter(name=>{const op=data.operators[name]!;return !op.room.startsWith('dorm')&&op.currentRoom===op.room&&op.currentIndex===op.index&&!op.moodIsPrediction}))
 if(!returned.size)return
 const prune=(plan:MowerTaskPlan)=>{
  for(const [room,row] of Object.entries(plan))if(room.startsWith('dorm')){
   row.forEach((name,index)=>{if(returned.has(name))row[index]='Current'})
   if(row.every(name=>['Current',''].includes(name)))delete plan[room]
  }
 }
 prune(task.plan)
 if(task.backupShiftIntent)prune(task.backupShiftIntent)
 prune(task.dormFillPlan)
 task.groupShiftExpected=Object.fromEntries(Object.entries(task.groupShiftExpected??{}).filter(([position,name])=>!position.slice(0,position.lastIndexOf('\0')).startsWith('dorm')||!returned.has(name)))
 for(const group of returnedGroups)delete task.groupShiftTransitions[group]
}
