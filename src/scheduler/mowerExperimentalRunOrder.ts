/**
 * Experimental run-order room/product reconciliation, plan/read/trade entry and
 * defer_dorm_before_run_order, alpha c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88 (MIT, Copyright 2021 Nano).
 * Product observations and actual dorm-duration samples are explicit; no yield fitting.
 * Fia/exhaust tails and the complete experimental dorm/product lifecycle remain caller responsibilities.
 */
import {MOWER_TASK_TYPES as T,MowerTask,toMowerMicros,type MowerTaskQueue,type MowerTaskPlan} from './mowerTaskQueue'
import {scheduleMowerTasks,type MowerTaskSchedulingOptions} from './mowerTaskScheduling'
import {
 observeNativeRunOrderTime,getDefaultRunOrderAdjustRoom,
 type RunOrderPlanningState,type RunOrderPlanningSeam,type RunOrderIORequest,type RunOrderIOObservation,type RunOrderTradeResult,
} from './mowerRunOrderPlanning'
const TRADE_AGENTS=['但书','龙舌兰','佩佩','可露希尔']
export interface MowerExperimentalFacilityState {product?:string;facility?:string;updated_at?:string}
export interface MowerExperimentalRunOrderState {
 planning:RunOrderPlanningState
 width:number;height:number
 /** Native effective product target and actual last observed page are distinct. */
 activeProducts:Readonly<Record<string,string|undefined>>
 facilityStates:Record<string,MowerExperimentalFacilityState>
 /** Keep each surviving room's native state object identity when rebuilding the map. */
 runOrderRooms:Record<string,Record<string,unknown>>
}
export interface MowerExperimentalRunOrderSeam extends RunOrderPlanningSeam {
 scheduling:Pick<MowerTaskSchedulingOptions,'grandet'|'enableMastery'|'maintenance'|'dormDurations'>
}
export type MowerExperimentalRunOrderRequest=
 |Exclude<RunOrderIORequest,{kind:'wait-interface'}|{kind:'read-order'}>
 |{kind:'wait-interface';room:string;requestedIntervalMicros:1_000_000;accelerateTemplate:'bill_accelerate'}
 |{kind:'read-order';room:string;useDigitReader:true;region:[[number,number],[number,number]]}
 |{kind:'cache-trade-page';room:string;facility:'trade'}
export interface MowerExperimentalRunOrderObservation {
 kind:MowerExperimentalRunOrderRequest['kind'];observedAtMicros:number;value:unknown
 taskTimeUpdates?:RunOrderIOObservation['taskTimeUpdates']
}
export type MowerExperimentalRunOrderGenerator<R>=Generator<MowerExperimentalRunOrderRequest,R,MowerExperimentalRunOrderObservation>
function check(seam:MowerExperimentalRunOrderSeam,request:MowerExperimentalRunOrderRequest,observation:MowerExperimentalRunOrderObservation):void{
 if(!observation||observation.kind!==request.kind||!Object.prototype.hasOwnProperty.call(observation,'value')||observation.value===undefined)
  throw new Error('Explicit matching experimental run-order observation is required; None is null')
 if(!Number.isSafeInteger(observation.observedAtMicros)||observation.observedAtMicros!==seam.nowMicros())
  throw new Error('Experimental run-order observation must describe the advanced scheduler wall clock')
 for(const update of observation.taskTimeUpdates??[]){
  if(!Number.isSafeInteger(update.timeMicros))throw new Error('Invalid observed task deadline')
  update.task.timeMicros=update.timeMicros
 }
}
function* observed(seam:MowerExperimentalRunOrderSeam,request:MowerExperimentalRunOrderRequest):
 MowerExperimentalRunOrderGenerator<MowerExperimentalRunOrderObservation>{
 const observation=yield request;check(seam,request,observation);return observation
}
export function syncMowerExperimentalRunOrderTasks(state:MowerExperimentalRunOrderState,seam:Pick<MowerExperimentalRunOrderSeam,'nativeName'>):void{
 const previous=state.runOrderRooms
 state.runOrderRooms=Object.fromEntries(Object.entries(state.planning.plan).filter(([room,slots])=>
  room.startsWith('room')&&state.activeProducts[room]!=='orundum'&&state.facilityStates[room]?.product!=='orundum'&&
  slots.some(slot=>slot.replacement.some(id=>TRADE_AGENTS.includes(seam.nativeName(id)))),
 ).map(([room])=>[room,previous[room]??{}]))
 state.planning.runOrderRooms=Object.keys(state.runOrderRooms)
 const invalid=new Set(state.planning.queue.tasks.filter(task=>
  [T.RUN_ORDER,T.REFRESH_TIME].includes(task.type)&&!!task.metadata&&!(task.metadata in state.runOrderRooms),
 ))
 const tasks=state.planning.queue.tasks;tasks.splice(0,tasks.length,...tasks.filter(task=>!invalid.has(task)))
}
function cacheSnapshot(state:MowerExperimentalRunOrderState,room:string,value:unknown):void{
 if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,'facilityStateAfter'))
  throw new Error('Explicit actual facility state after the page cache is required')
 const snapshot=(value as {facilityStateAfter:unknown}).facilityStateAfter
 if(snapshot===null){delete state.facilityStates[room];return}
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new Error('Invalid actual facility-state snapshot')
 const product=(snapshot as {product?:unknown}).product
 if(product!==undefined&&typeof product!=='string')throw new Error('Actual facility product must be an explicit string')
 state.facilityStates[room]=snapshot as MowerExperimentalFacilityState
}
function* readTime(state:MowerExperimentalRunOrderState,seam:MowerExperimentalRunOrderSeam,room:string):
 MowerExperimentalRunOrderGenerator<number>{
 const native=observeNativeRunOrderTime(state.planning,seam,room)
 let next=native.next()
 while(!next.done){
  const request=next.value
  if(request.kind==='read-order'){
   const cached=yield* observed(seam,{kind:'cache-trade-page',room,facility:'trade'})
   cacheSnapshot(state,room,cached.value)
  }
  const outward:MowerExperimentalRunOrderRequest=request.kind==='wait-interface'?{...request,accelerateTemplate:'bill_accelerate'}:
   request.kind==='read-order'?{...request,region:[[Math.trunc(state.width*650/2496),Math.trunc(state.height*660/1404)],[Math.trunc(state.width*815/2496),Math.trunc(state.height*710/1404)]]}:request
  const observation=yield* observed(seam,outward)
  if(request.kind==='read-order'&&(typeof observation.value!=='number'||!Number.isSafeInteger(observation.value)))
   throw new Error('Explicit observed absolute order deadline in microseconds is required')
  next=native.next({
   observedAtMicros:observation.observedAtMicros,
   ...(request.kind==='read-order'?{absoluteDueMicros:observation.value as number}:{}),
  })
 }
 return next.value
}
export function* planMowerExperimentalRunOrder(state:MowerExperimentalRunOrderState,seam:MowerExperimentalRunOrderSeam,room:string):
 MowerExperimentalRunOrderGenerator<MowerTask|undefined>{
 syncMowerExperimentalRunOrderTasks(state,seam)
 if(!(room in state.runOrderRooms)||state.planning.queue.find({type:T.RUN_ORDER,metadata:room}))return
 const names=state.planning.plan[room]!.map(slot=>TRADE_AGENTS.some(agent=>slot.replacement.some(id=>seam.nativeName(id).includes(agent)))?slot.replacement[0]!:'Current')
 const timeMicros=yield* readTime(state,seam,room)
 syncMowerExperimentalRunOrderTasks(state,seam)
 if(!(room in state.runOrderRooms))return
 const task=new MowerTask({type:T.RUN_ORDER,metadata:room,plan:{[room]:names}})
 task.timeMicros=timeMicros;state.planning.queue.tasks.push(task);return task
}
function schedule(state:MowerExperimentalRunOrderState,seam:MowerExperimentalRunOrderSeam):[MowerTask,MowerTask]|undefined{
 const result=scheduleMowerTasks(state.planning.queue.tasks,seam.nowMicros(),{
  ...seam.scheduling,experimental:true,configuredDelayMinutes:state.planning.configuredDelayMinutes,
 })
 seam.onScheduling?.(result);return result
}
/** Native experimental trade section. Caller supplies experimental-aware drone I/O and runs tails when indicated. */
export function* runMowerExperimentalTradeSegment(state:MowerExperimentalRunOrderState,seam:MowerExperimentalRunOrderSeam):
 MowerExperimentalRunOrderGenerator<RunOrderTradeResult>{
 syncMowerExperimentalRunOrderTasks(state,seam)
 let droneCount=0
 if(Object.keys(state.runOrderRooms).length){
  // Source uses list(run_order_rooms), since reading a page may rebuild membership.
  for(const room of Object.keys(state.runOrderRooms))yield* planMowerExperimentalRunOrder(state,seam,room)
  let conflict=schedule(state,seam),maximum=3
  const count=Object.keys(state.runOrderRooms).length
  if(count>=3){
   const dp=[0,0,1];for(let i=3;i<=count;i++)dp[i]=3*dp[i-1]!+2*dp[i-2]!
   maximum=Math.min(dp[count]!*1.25,15)
  }
  while(conflict!==undefined&&droneCount<=maximum){
   const room=getDefaultRunOrderAdjustRoom(state.planning,conflict)
   if(room===undefined)return {tailShouldRun:false,reason:'adjust-room-none',droneCount}
   const observation=yield* observed(seam,{kind:'drone',room,adjustTime:true})
   if(observation.value!==null&&typeof observation.value!=='boolean')throw new Error('Explicit native drone False/None result is required')
   conflict=schedule(state,seam);droneCount+=1
   if(observation.value!==null&&!observation.value)return {tailShouldRun:false,reason:'drone-false',droneCount}
  }
 }
 return {tailShouldRun:true,reason:'completed',droneCount}
}
export interface MowerExperimentalDormDeferralSeam {
 experimental:boolean;nowMicros():number
 /** Actual recent wall-clock room samples in seconds, oldest to newest; [] means native cold start. */
 observedDormDurationSeconds(room:string):readonly number[]
}
const DORM_TYPES=[T.SHIFT_OFF,T.SHIFT_ON,T.RE_ORDER,T.RELEASE_DORM,T.FILL_DORM,T.NOT_SPECIFIC]
export function deferMowerExperimentalDormBeforeRunOrder(
 task:MowerTask,queue:MowerTaskQueue,room:string,seam:MowerExperimentalDormDeferralSeam,
):boolean{
 const rooms=Object.keys(task.plan)
 if(!room.startsWith('dormitory_')||!DORM_TYPES.includes(task.type)||!rooms.length||!rooms.every(r=>r.startsWith('dormitory_'))||
  !seam.experimental||task.strictMoodLimit||task.type===T.FILL_DORM||task.adjusted)return false
 const now=seam.nowMicros(),order=[...queue.tasks].filter(t=>t.type===T.RUN_ORDER).sort((a,b)=>a.timeMicros-b.timeMicros)[0]
 // Native short-circuits before reading duration if there is no order.
 if(!order)return false
 const samples=seam.observedDormDurationSeconds(room).slice(-8)
 if(samples.some(value=>!Number.isFinite(value)))throw new Error('Explicit finite dorm-duration observations are required')
 const minutes=Math.max(90,.75*60,Math.max(0,...samples)*1.2+15)/60
 if(now+toMowerMicros(minutes/60)<=order.timeMicros)return false
 task.timeMicros=Math.max(now,order.timeMicros)+1_000_000
 queue.sort();return true
}
export function mowerExperimentalArrangementRooms(task:MowerTask):string[]{
 return Object.keys(task.plan).sort((a,b)=>Number(a.startsWith('dormitory_'))-Number(b.startsWith('dormitory_'))||
  (a.startsWith('dormitory_')&&b.startsWith('dormitory_')?Number(a.split('_')[1])-Number(b.split('_')[1]):0))
}
/** The original task/remaining plan and new_plan identity are retained by the caller. */
export function shouldDeferMowerExperimentalArrangementRoom(
 task:MowerTask,queue:MowerTaskQueue,room:string,restoration:MowerTaskPlan,seam:MowerExperimentalDormDeferralSeam,
):boolean{
 return seam.experimental&&Object.keys(restoration).length===0&&deferMowerExperimentalDormBeforeRunOrder(task,queue,room,seam)
}
