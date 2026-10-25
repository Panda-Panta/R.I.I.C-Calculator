// Startup observations from Mower alpha f19abfa3 (MIT). Ideal orders never
// reserve roster execution, insert runners, or spend collision-adjustment drones.
import {observeNativeRunOrderTime,type RunOrderPlanningState,type RunOrderPlanningSeam,type RunOrderGenerator} from './mowerRunOrderPlanning'
import {rethrowMowerInfraFatal} from './mowerNativeErrors'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {mowerOrderReadPriorityTasks} from './mowerRunOrderTail'

export interface MowerRunOrderStartupSeam extends RunOrderPlanningSeam {
 maintenancePaused():boolean
 /** Must read actual occupancy and every occupied slot's mood during this visit. */
 readMood(room:string):void
 onReadFailure(room:string,error:unknown):void
}

function fits(state:RunOrderPlanningState,seam:MowerRunOrderStartupSeam):boolean {
 return mowerOrderReadPriorityTasks(state.queue.tasks,seam.nowMicros(),seam.scheduling,'startup').length===0
}

/** Reuse the ordinary I/O protocol; the strict mood read follows confirmed entry. */
function* observeStartupRoom(state:RunOrderPlanningState,seam:MowerRunOrderStartupSeam,room:string):RunOrderGenerator<number>{
 const reader=observeNativeRunOrderTime(state,seam,room)
 let next=reader.next()
 while(!next.done){
  const request=next.value,observation=yield request
  next=reader.next(observation)
  if(request.kind==='enter-room')seam.readMood(room)
 }
 return next.value
}

export function* executeMowerRunOrderStartup(startup:{startupRunOrderCheckPending?:boolean},state:RunOrderPlanningState,seam:MowerRunOrderStartupSeam):RunOrderGenerator<void>{
 if(startup.startupRunOrderCheckPending===false)return
 startup.startupRunOrderCheckPending=false
 if(state.queue.tasks.some(task=>task.type===T.RUN_ORDER)||seam.maintenancePaused())return
 const provisional:MowerTask[]=[]
 for(const room of state.runOrderRooms){
  if(!fits(state,seam))break
  if(state.queue.tasks.some(task=>task.type===T.REFRESH_TIME&&task.metadata===room&&task.executionFailure))continue
  try{
   const timeMicros=yield* observeStartupRoom(state,seam,room)
   const dueMicros=timeMicros+toMowerMicros(state.configuredDelayMinutes/60)
   // A completed ideal order is already owned by production/collection.
   if(dueMicros<=seam.nowMicros())continue
   const task=new MowerTask({type:T.RUN_ORDER,metadata:room})
   task.timeMicros=timeMicros;task.observedOrderDueMicros=dueMicros;provisional.push(task)
  }catch(error){
   rethrowMowerInfraFatal(error);seam.onReadFailure(room,error)
   try{
    const returned=yield {kind:'return-main',room}
    if(!Number.isSafeInteger(returned.observedAtMicros)||returned.observedAtMicros!==seam.nowMicros())throw new Error('Startup return must describe the advanced scheduler wall clock')
   }catch(returnError){rethrowMowerInfraFatal(returnError);seam.onReadFailure(room,returnError)}
  }
 }
 const deadline=seam.nowMicros()+toMowerMicros(Math.max(10,state.configuredDelayMinutes*2)/60)
 for(const task of provisional)if(task.timeMicros<=deadline&&!state.queue.tasks.some(existing=>existing.type===T.RUN_ORDER&&existing.metadata===task.metadata)){
  state.queue.tasks.push(task)
  state.queue.tasks=state.queue.tasks.filter(existing=>existing.type!==T.REFRESH_TIME||existing.metadata!==task.metadata||!!existing.executionFailure)
 }
 state.queue.sort()
}

export function mowerStartupMoodSignature(data:MowerSchedulingData,room:string):string {
 return JSON.stringify(Object.values(data.operators).filter(op=>op.currentRoom===room).map(op=>[op.name,op.currentIndex,op.timeStampMicros]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
}

/** Only unchanged, fresh actual samples may replace the initial repeated visit. */
export function canReuseMowerStartupMood(data:MowerSchedulingData,room:string,signature:string|undefined):boolean {
 return signature!==undefined&&signature===mowerStartupMoodSignature(data,room)&&Object.values(data.operators).filter(op=>op.currentRoom===room).every(op=>{
  const age=toMowerMicros(['歌蕾蒂娅','见行者'].includes(op.nativeName)?.5:2.5)
  return !op.moodIsPrediction&&Number.isFinite(op.mood)&&op.mood>=0&&op.mood<=24&&op.timeStampMicros!==undefined&&op.timeStampMicros<=data.nowMicros&&op.timeStampMicros>data.nowMicros-age
 })
}
