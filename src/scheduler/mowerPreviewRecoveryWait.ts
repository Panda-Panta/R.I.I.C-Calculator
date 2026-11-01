import {refreshMowerDerivedCorrection} from './mowerCorrection'
import {mowerMissingDepartedRecovery,type MowerBackupRecoveryBlocked} from './mowerBackupDepartureRecovery'
import {mowerDormTaskReservations} from './mowerAlphaCandidates'
import {projectMowerArrangements} from './mowerObservations'
import {mowerAssignDormGroup} from './mowerDormAssignment'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {MOWER_TASK_TYPES as T,type MowerTask,type MowerTaskQueue} from './mowerTaskQueue'

export interface MowerPreviewRecoveryWait {
 task:MowerTask
 reason:'recovery'|'backup-veto'|'departure-bed'
 conditionIndexes?:number[]
 observedNames?:string[]
 observation:string
 deadlines:Record<string,number>
 names:string[]
 rooms:string[]
 reservations?:string
 effectiveReservations?:boolean
}
export type MowerPreviewRecoveryAdmissionResult={kind:'ready'}|{kind:'blocked';failure:MowerBackupRecoveryBlocked}
export type MowerPreviewRecoveryAdmission=(task:MowerTask)=>MowerPreviewRecoveryAdmissionResult
interface RecoveryWaitState {data:MowerSchedulingData;queue:MowerTaskQueue;waitingRecovery?:MowerPreviewRecoveryWait[]}
function observations(data:MowerSchedulingData,names:readonly string[],rooms:readonly string[],previous?:string,conditionIndexes?:readonly number[],observedNames?:readonly string[]):string {
 const observed=new Map<string,number|null>(previous?JSON.parse(previous)[2].map((row:unknown[])=>[row[0],row[5]]):[])
 const groups=new Set(names.flatMap(name=>{const op=data.operators[name];return op?[op.group,...op.groupBindings.map(binding=>binding.group)]:[]}).filter(Boolean))
 return JSON.stringify([conditionIndexes?conditionIndexes.map(index=>data.planConditions[index]):data.planConditions,Object.fromEntries([...groups].map(group=>[group,data.groupShiftState[group]])),Object.values(data.operators).filter(op=>names.includes(op.name)||rooms.includes(op.currentRoom)).map(op=>[op.name,op.room,op.index,op.currentRoom,op.currentIndex,observedNames&&!observedNames.includes(op.name)?null:op.moodIsPrediction?(observed.get(op.name)??null):op.timeStampMicros??null]),data.allDorms().filter(bed=>rooms.includes(bed.position[0])).map(bed=>[bed.position,bed.name,bed.timeMicros])])
}
function reservations(source:RecoveryWaitState,task:MowerTask,names:readonly string[],rooms:readonly string[]):string {
 return JSON.stringify([source.queue.tasks.filter(candidate=>candidate!==task&&Object.entries(candidate.plan).some(([room,row])=>rooms.includes(room)||row.some(name=>names.includes(name)))).map(candidate=>[candidate.type.key,candidate.timeMicros,candidate.plan,candidate.arrangementStarted,candidate.productShiftLocked]),[...source.data.reservedProductBeds], [...source.data.reservedProductReplacements]])
}
/** Native departure signatures observe effective protection, including empty-plan reservations. */
function departureReservations(source:RecoveryWaitState,task:MowerTask,names:readonly string[],rooms:readonly string[]):string {
 const reserved=mowerDormTaskReservations(source.data,source.queue.tasks.filter(candidate=>candidate!==task))
 return JSON.stringify([[...reserved.names].filter(name=>names.includes(name)).sort(),[...reserved.slots].filter(slot=>rooms.includes(slot.split('\0')[0]!)).sort(),[...source.data.reservedProductBeds].sort(([a],[b])=>a.localeCompare(b)),[...source.data.reservedProductReplacements].sort()])
}
function names(source:RecoveryWaitState):void {
 source.data.waitingRecoveryNames=new Set(source.waitingRecovery?.flatMap(wait=>Object.values(wait.task.plan).flat().filter(name=>!!source.data.operators[name]))??[])
}
/** Retain empty returns on observed recovery or a proven explicit backup veto. */
export function parkMowerPreviewRecovery(source:RecoveryWaitState,task:MowerTask,original:MowerTask,pending:MowerTask[],conditionNames:readonly string[]=[]):boolean {
 const {data}=source
 if(Object.keys(task.plan).length||![T.SHIFT_ON,T.SELF_CORRECTION,T.RE_ORDER].includes(original.type)||original.arrangementStarted||original.backupShiftActive||original.productShiftLocked||original.dormRecoveryRestore.length||JSON.stringify(task.backupShiftConditions??data.planConditions)!==JSON.stringify(data.planConditions))return false
 const recovering=Object.entries(original.plan).flatMap(([room,row])=>room.startsWith('dorm')?[]:row.flatMap((name,index)=>{
  const op=data.operators[name],bed=data.getDormByName(name)?.[1]
  return op&&op.room===room&&op.index===index&&op.isResting()&&op.timeStampMicros!==undefined&&!op.moodIsPrediction&&op.mood>=0&&op.mood<op.upperLimit&&bed?.name===name&&bed.position[0]===op.currentRoom&&bed.position[1]===op.currentIndex&&bed.timeMicros!==undefined&&bed.timeMicros>data.nowMicros?[[op.currentRoom,bed.timeMicros] as const]:[]
 }))
 if(!recovering.length){
  const requested=new Set(Object.values(original.plan).flat()),groups=new Set([...requested].map(name=>data.operators[name]?.group).filter((group):group is string=>!!group&&data.groupIsResting(group)))
  const waiting=Object.values(data.operators).filter(op=>groups.has(op.group)&&op.isHigh()&&!op.workaholic&&!op.room.startsWith('dorm')&&!op.currentRoom&&op.timeStampMicros!==undefined&&!op.moodIsPrediction&&op.mood>=0&&op.mood<op.upperLimit).map(op=>op.name)
  if(waiting.length&&mowerAssignDormGroup(projectMowerArrangements(data,[]),waiting,groups)===undefined){
   const released=projectMowerArrangements(data,[])
   for(const bed of released.allDorms()){
    const op=data.operators[bed.name]
    if(op?.isResting()&&op.currentRoom===bed.position[0]&&op.currentIndex===bed.position[1]&&op.timeStampMicros!==undefined&&!op.moodIsPrediction&&op.mood>=0&&op.mood<op.upperLimit&&bed.timeMicros!==undefined&&bed.timeMicros>data.nowMicros){recovering.push([op.currentRoom,bed.timeMicros]);bed.reset();released.operators[op.name]!.setProjectedPosition('',-1)}
   }
   if(mowerAssignDormGroup(released,waiting,groups)===undefined)recovering.splice(0)
  }
 }
 const veto=task.previewReturnVeto
 if(!recovering.length&&!veto?.conditions.length)return false
 const reason=recovering.length?'recovery':'backup-veto'
 Object.assign(task,original);delete task.previewReturnVeto
 source.queue.tasks=pending.filter(candidate=>candidate!==task)
 const deadlines:Record<string,number>={}
 for(const [room,due] of recovering)deadlines[room]=Math.min(deadlines[room]??Infinity,due)
 const referenced=new Set([...Object.values(original.plan).flat(),...(reason==='backup-veto'?veto!.names:conditionNames)]),groups=new Set([...referenced].map(name=>data.operators[name]?.group).filter(Boolean))
 for(const op of Object.values(data.operators))if(reason==='recovery'&&groups.has(op.group)){referenced.add(op.name);op.replacement.forEach(name=>referenced.add(name))}
 const watched=[...referenced],rooms=reason==='backup-veto'?[]:[...new Set([...Object.keys(original.plan),...Object.keys(deadlines)])],conditionIndexes=reason==='backup-veto'?veto!.conditions:undefined,observedNames=reason==='backup-veto'?veto!.names:undefined
 ;(source.waitingRecovery??=[]).push({task,reason,conditionIndexes,observedNames,observation:observations(data,watched,rooms,undefined,conditionIndexes,observedNames),deadlines,names:watched,rooms})
 names(source)
 return true
}
/** A still-blocked preview consumes the changed evidence without releasing its intent. */
function refreshDepartureWait(source:RecoveryWaitState,wait:MowerPreviewRecoveryWait,failure:MowerBackupRecoveryBlocked):void {
 const {data}=source
 const previousBeds:[[string,number],string,number|null][]=JSON.parse(wait.observation)[3]
 for(const [room,due] of Object.entries(wait.deadlines))if(due<=data.nowMicros){
  const matured=previousBeds.filter(([position,,time])=>position[0]===room&&time===due)
  // Passing time or a prediction is not a room read. Keep its due observation
  // until the prior residents have actually been measured at/after the deadline.
  if(matured.length&&matured.every(([,name])=>{
   const op=data.operators[name]
   return !!op&&!op.moodIsPrediction&&op.timeStampMicros!==undefined&&op.timeStampMicros>=due&&op.mood>=0&&op.mood<=24
  }))delete wait.deadlines[room]
 }
 const {projection,names:departing,explicitSlots,reservedSlots,reservedNames}=failure
 wait.effectiveReservations=mowerMissingDepartedRecovery(projection,departing).some(name=>reservedNames.has(name))
 const changed=Object.values(projection.operators).filter(op=>{const actual=data.operators[op.name];return actual&&(actual.currentRoom!==op.currentRoom||actual.currentIndex!==op.currentIndex)}).map(op=>op.name)
 wait.names=[...new Set([...wait.names,...departing,...changed,...departing.flatMap(name=>projection.operators[name]?.replacement??[])])]
 wait.rooms=[...new Set([...wait.rooms,...Object.keys(wait.task.plan),...projection.allDorms().map(bed=>bed.position[0]),...Array.from(reservedSlots,slot=>slot.split('\0')[0]!)])]
 if(!wait.effectiveReservations)for(const bed of data.allDorms()){
  const op=data.operators[bed.name]
  if(!wait.rooms.includes(bed.position[0])||explicitSlots.has(bed.position[0]+'\0'+bed.position[1])||!op?.isResting()||op.currentRoom!==bed.position[0]||op.currentIndex!==bed.position[1]||op.timeStampMicros===undefined||op.moodIsPrediction||op.mood<0||op.mood>=op.upperLimit||bed.timeMicros===undefined||bed.timeMicros<=data.nowMicros)continue
  wait.deadlines[bed.position[0]]=Math.min(wait.deadlines[bed.position[0]]??Infinity,bed.timeMicros)
 }
 wait.observation=observations(data,wait.names,wait.rooms,wait.observation,wait.conditionIndexes,wait.observedNames)
 wait.reservations=(wait.effectiveReservations?departureReservations:reservations)(source,wait.task,wait.names,wait.rooms)
}
/** Actual observations allow revalidation; only admitted work regains its old deadline. */
export function resumeMowerPreviewRecovery(source:RecoveryWaitState,admission?:MowerPreviewRecoveryAdmission):boolean {
 const changed=(source.waitingRecovery??[]).filter(wait=>wait.observation!==observations(source.data,wait.names,wait.rooms,wait.observation,wait.conditionIndexes,wait.observedNames)||wait.reservations!==undefined&&wait.reservations!==(wait.effectiveReservations?departureReservations:reservations)(source,wait.task,wait.names,wait.rooms))
 const resumed:MowerPreviewRecoveryWait[]=[]
 for(const wait of changed){
  if(wait.reason==='departure-bed'&&admission){
   const result=admission(wait.task)
   if(result.kind==='blocked'){refreshDepartureWait(source,wait,result.failure);continue}
  }
  resumed.push(wait)
 }
 for(const wait of resumed)if(!source.queue.tasks.includes(wait.task)){wait.task.executionRetained=true;source.queue.tasks.push(wait.task)}
 source.waitingRecovery=source.waitingRecovery?.filter(wait=>!resumed.includes(wait))
 names(source)
 for(const wait of resumed)refreshMowerDerivedCorrection(source.data,wait.task,source.queue.tasks)
 return resumed.length>0
}
export function nextMowerPreviewRecoveryObservation(source:RecoveryWaitState):number {
 return Math.min(...(source.waitingRecovery??[]).flatMap(wait=>Object.values(wait.deadlines)))
}

/** Keep the failed effective projection for proof; only actual observations can release the original request. */
export function parkMowerBackupDepartureRecovery(source:RecoveryWaitState,task:MowerTask,failure:MowerBackupRecoveryBlocked,conditionNames:readonly string[]=[]):boolean {
 const {data}=source,{names:departing,projection,explicitSlots,reservedSlots,reservedNames}=failure
 if(task.arrangementStarted||task.backupShiftActive||task.productShiftLocked)return false
 const groups=new Set(departing.map(name=>projection.operators[name]?.group).filter((group):group is string=>!!group)),released=projectMowerArrangements(projection,[]),deadlines:Record<string,number>={}
 // Mower alpha ae9fc322 suspends recovery_names on a name conflict without a timer proof.
 const nameReserved=mowerMissingDepartedRecovery(projection,departing).some(name=>reservedNames.has(name))
 const allReserved=new Set([...reservedSlots,...explicitSlots])
 if(!nameReserved){
  if(mowerAssignDormGroup(projectMowerArrangements(projection,[]),[...departing],groups,undefined,{},allReserved)!==undefined)return false
  const reservationOnly=reservedSlots.size>0&&mowerAssignDormGroup(projectMowerArrangements(projection,[]),[...departing],groups,undefined,{},explicitSlots)!==undefined
  for(const bed of released.allDorms()){
   const op=released.operators[bed.name],actual=data.operators[bed.name],observed=actual&&data.getDormByName(actual.name)?.[1]
   if(explicitSlots.has(bed.position[0]+'\0'+bed.position[1])||!op?.isResting()||!actual?.isResting()||actual.currentRoom!==bed.position[0]||actual.currentIndex!==bed.position[1]||actual.timeStampMicros===undefined||actual.moodIsPrediction||actual.mood<0||actual.mood>=actual.upperLimit||observed?.timeMicros===undefined||observed.timeMicros<=data.nowMicros)continue
   deadlines[actual.currentRoom]=Math.min(deadlines[actual.currentRoom]??Infinity,observed.timeMicros)
   bed.reset();op.setProjectedPosition('',-1)
  }
  if(!reservationOnly&&(!Object.keys(deadlines).length||mowerAssignDormGroup(released,[...departing],groups,undefined,{},explicitSlots)===undefined))return false
 }
 const projectedNames=Object.values(projection.operators).filter(op=>{const actual=data.operators[op.name];return actual&&(actual.currentRoom!==op.currentRoom||actual.currentIndex!==op.currentIndex)}).map(op=>op.name)
 const watched=[...new Set([...departing,...conditionNames,...projectedNames,...Object.values(task.plan).flat(),...departing.flatMap(name=>projection.operators[name]?.replacement??[])])],rooms=[...new Set([...Object.keys(task.plan),...projection.allDorms().map(bed=>bed.position[0]),...Array.from(reservedSlots,slot=>slot.split('\0')[0]!)])]
 source.queue.tasks=source.queue.tasks.filter(candidate=>candidate!==task)
 ;(source.waitingRecovery??=[]).push({task,reason:'departure-bed',observation:observations(data,watched,rooms),deadlines,names:watched,rooms,effectiveReservations:nameReserved,reservations:(nameReserved?departureReservations:reservations)(source,task,watched,rooms)})
 names(source)
 return true
}
