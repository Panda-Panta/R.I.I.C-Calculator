// Complete-batch order reads from Mower alpha f19abfa3 (MIT).
import {MowerTask,MOWER_TASK_TYPES as T,isMowerRunOrderTask,fromMowerMicros,type MowerTaskQueue} from './mowerTaskQueue'
import {protectMowerAlphaTasks} from './mowerAlphaTaskProtection'
import {protectMowerSupportSwaps,scheduleMowerTasks,type MowerTaskSchedulingOptions} from './mowerTaskScheduling'
import type {RunOrderPlanningState,RunOrderPlanningSeam} from './mowerRunOrderPlanning'
import type {MowerNativeIOYield} from './mowerRunOrderBridge'
import type {MowerRoomReturn} from './mowerTaskExecutor'

/** Ideal wakes and disabled mastery never reserve a read; strict releases do. */
export function mowerOrderReadPriorityTasks(tasks:readonly MowerTask[],nowMicros:number,options:MowerTaskSchedulingOptions={},scope:'startup'|'tail'='tail'):MowerTask[]{
 return tasks.filter(task=>!task.executionFailure&&task.timeMicros<=nowMicros+60_000_000&&(
  options.adjustForRunOrders!==false&&task.type===T.RUN_ORDER&&(scope==='startup'||!!task.metadata)||
  options.enableMastery!==false&&task.type===T.SWAP_SUPPORT||
  task.strictMoodLimit&&Object.keys(task.plan).length>0))
}

/** Keep unread refresh objects/timestamps while the same priority gate suspends dispatch. */
export function mowerOrderReadDispatchTasks(tasks:readonly MowerTask[],nowMicros:number,options:MowerTaskSchedulingOptions={}):MowerTask[]{
 const blocked=mowerOrderReadPriorityTasks(tasks,nowMicros,options).length>0
 return tasks.filter(task=>!task.executionFailure&&(!blocked||task.type!==T.REFRESH_TIME))
}
export function nextMowerOrderReadTask(queue:MowerTaskQueue,nowMicros:number,options:MowerTaskSchedulingOptions={}):MowerTask|undefined {
 return mowerOrderReadDispatchTasks(queue.tasks,nowMicros,options)[0]
}

export interface MowerRunOrderTailPreparationSeam extends RunOrderPlanningSeam {
 resumeFailures():void
}
export interface MowerRunOrderTailSeam extends MowerRunOrderTailPreparationSeam {
 /** The caller preserves a failed refresh or consumes its successful observation. */
 readRoom(room:string,refresh:MowerTask):Generator<MowerNativeIOYield,boolean,void>
}

/** Native agent_arrange reads after the last room's back(), before metadata. */
export function* executeMowerArrangementOrderTail(steps:Generator<MowerRoomReturn,boolean,void>,task:MowerTask,readTail:()=>Generator<MowerNativeIOYield,void,void>):Generator<MowerRoomReturn,boolean,void>{
 let next=steps.next(),attempted=false
 while(!next.done){
  yield next.value
  if(!attempted&&!next.value.nativeRunOrderIO&&!Object.keys(task.plan).length&&![T.RUN_ORDER,T.FIAMMETTA].includes(task.type)){
   attempted=true
   yield* readTail()
  }
  next=steps.next()
 }
 return next.value
}

function protectReadPriorities(queue:MowerTaskQueue,nowMicros:number,options:MowerTaskSchedulingOptions):void {
 // Remove ideal execution wakes first. Real REFRESH_TIME observations still
 // consume the existing protection budget, including the strict-release lead.
 const active=queue.tasks.filter(task=>!task.executionFailure&&(options.adjustForRunOrders!==false||task.type!==T.RUN_ORDER))
 const readOptions={...options,adjustForRunOrders:true}
 if(options.alpha)protectMowerAlphaTasks(active,nowMicros,readOptions)
 else protectMowerSupportSwaps(active,nowMicros,readOptions)
 queue.sort()
}

export function prepareMowerRunOrderTail(state:RunOrderPlanningState,seam:MowerRunOrderTailPreparationSeam):boolean {
 if(!state.runOrderRooms.length||!Object.keys(state.plan).filter(room=>room.includes('dormitory')).every(room=>seam.currentDormOccupants(room)?.length===5))return false
 seam.resumeFailures()
 for(const room of state.runOrderRooms){
  const pending=state.queue.tasks.find(task=>isMowerRunOrderTask(task)&&(task.metadata===room||room in task.plan))
  if(!pending)state.queue.tasks.push(new MowerTask({time:fromMowerMicros(seam.nowMicros()),type:T.REFRESH_TIME,metadata:room}))
 }
 return true
}

export function* executeMowerRunOrderTail(state:RunOrderPlanningState,seam:MowerRunOrderTailSeam,lastArrangedRoom?:string):Generator<MowerNativeIOYield,void,void>{
 if(!prepareMowerRunOrderTail(state,seam))return
 const refreshes=state.queue.tasks.filter(task=>task.type===T.REFRESH_TIME&&!task.executionFailure&&task.timeMicros<=seam.nowMicros()&&state.runOrderRooms.includes(task.metadata))
 refreshes.sort((a,b)=>Number(b.metadata===lastArrangedRoom)-Number(a.metadata===lastArrangedRoom))
 let observedAny=false
 for(const refresh of refreshes){
  if(observedAny)protectReadPriorities(state.queue,seam.nowMicros(),seam.scheduling)
  if(mowerOrderReadPriorityTasks(state.queue.tasks,seam.nowMicros(),seam.scheduling).length)break
  observedAny=true
  yield* seam.readRoom(refresh.metadata,refresh)
 }
 if(observedAny){
  const conflict=scheduleMowerTasks(state.queue.tasks,seam.nowMicros(),{...seam.scheduling,configuredDelayMinutes:state.configuredDelayMinutes,experimental:false})
  seam.onScheduling?.(conflict)
 }
}
