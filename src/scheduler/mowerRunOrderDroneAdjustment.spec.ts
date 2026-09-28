import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-run-order-drone-adjustment-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue,type MowerTaskPlan} from './mowerTaskQueue'
import type {RunOrderPlanningState} from './mowerRunOrderPlanning'
import {
 executeMowerTradeDrone,executeMowerTradeDroneAdjustment,adjustMowerTradeOrderTime,
 type MowerTradeDroneAdjustmentState,type MowerTradeDroneAdjustmentSeam,
 type MowerTradeDroneAdjustmentRequest,type MowerTradeDroneAdjustmentObservation,
} from './mowerRunOrderDroneAdjustment'
function record(raw:unknown):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid native fixture object')
 return raw as Record<string,unknown>
}
function string(raw:unknown):string{if(typeof raw!=='string')throw new Error('Invalid fixture string');return raw}
function finite(raw:unknown):number{if(typeof raw!=='number'||!Number.isFinite(raw))throw new Error('Invalid fixture number');return raw}
function plan(raw:unknown):MowerTaskPlan{
 return Object.fromEntries(Object.entries(record(raw)).map(([room,names])=>{
  if(!Array.isArray(names))throw new Error('Invalid fixture plan')
  return [room,names.map(string)]
 }))
}
function observation(raw:unknown){
 const value=record(raw)
 if(!Object.prototype.hasOwnProperty.call(value,'value'))throw new Error('Explicit native observation value is required')
 if(value.removeOriginalIndices!==undefined&&!Array.isArray(value.removeOriginalIndices))throw new Error('Invalid native identity mutation')
 return {
  kind:string(value.kind),elapsedMicros:finite(value.elapsedMicros),value:value.value,
  error:value.error===undefined?undefined:string(value.error),
  removeOriginalIndices:value.removeOriginalIndices===undefined?undefined:(value.removeOriginalIndices as unknown[]).map(finite),
 }
}
function requestFields(request:MowerTradeDroneAdjustmentRequest):Record<string,unknown>{
 switch(request.kind){
  case 'enter-room':return {room:request.room}
  // action labels identify native call sites for the host; source call arguments remain complete.
  case 'tap':return {target:structuredClone(request.target),...(request.intervalSeconds===undefined?{}:{interval:request.intervalSeconds}),...(request.yRate===undefined?{}:{y_rate:request.yRate})}
  case 'wait-interface':return {interval:request.intervalSeconds,...(request.accelerateTemplate===undefined?{}:{accelerate_template:request.accelerateTemplate})}
  case 'find':return {name:request.name}
  case 'read-order':return {region:request.region,use_digit_reader:request.useDigitReader}
  case 'cache-facility-page':return {room:request.room,facility:request.facility}
  case 'tap-drone-accelerate':return {template:request.template,control:request.control}
  case 'return-main':return {scene:'infra-main'}
  default:return {}
 }
}
describe('actual alpha full trade/manufacture drone branches and trade adjust_order_time',()=>{
 it.each(native.cases)('matches every source output field of $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  const input=test.input,queue=new MowerTaskQueue()
  queue.tasks=input.tasks.map(raw=>{
   const type=Object.values(T).find(type=>type.key===raw.type)
   if(!type)throw new Error('Unknown native task type')
   return new MowerTask({time:raw.seconds/3600,type,metadata:raw.metadata,plan:plan(raw.plan)})
  })
  const originals=[...queue.tasks],trace:Record<string,unknown>[]=[]
  let clock=input.nowMicros,observationIndex=0
  const planning:RunOrderPlanningState={
   plan:input.plan,runOrderRooms:input.runOrderRooms,queue,configuredDelayMinutes:input.configuredDelayMinutes,
   droneRoom:input.droneRoom,flags:{planned:false,todoTask:false,collectNotification:false},
  }
  const state:MowerTradeDroneAdjustmentState={
   planning,room:input.room,width:input.width,height:input.height,skipEnter:input.skipEnter,notCustomize:input.notCustomize,
   notReturn:input.notReturn,waitingScenes:input.waitingScenes,droneCountLimit:input.droneCountLimit,
  }
  const seam:MowerTradeDroneAdjustmentSeam={
   nowMicros:()=>clock,scheduling:{grandet:input.grandet,enableMastery:input.enableMastery},
   onScheduling:conflict=>trace.push({
    kind:'scheduling',nowMicros:clock,argDelayMinutes:5,configuredDelayMinutes:input.configuredDelayMinutes,
    conflict:conflict?conflict.map(task=>({type:task.type.key,metadata:task.metadata})):null,
   }),
   onAdjustTarget:room=>trace.push({kind:'adjust-target',room:room??null,nowMicros:clock}),
  }
  const generator=input.action==='drone'?executeMowerTradeDroneAdjustment(state,seam):
   input.action==='normal'?executeMowerTradeDrone(state,seam):adjustMowerTradeOrderTime(state,seam,input.accelerate)
  const observations=input.observations.map(observation)
  let error:{message:string}|null=null,result:false|null=null
  try{
   let next=generator.next()
   while(!next.done){
    const request=next.value,observed=observations[observationIndex++]
    if(!observed)throw new Error('Missing explicit native observation for '+request.kind)
    expect(observed.kind).toBe(request.kind)
    clock+=observed.elapsedMicros
    if(observed.removeOriginalIndices!==undefined){
     const removed=new Set(observed.removeOriginalIndices.map(index=>originals[index]))
     queue.tasks=queue.tasks.filter(task=>!removed.has(task))
    }
    trace.push({kind:request.kind,request:requestFields(request),value:structuredClone(observed.value),nowMicros:clock})
    if(observed.error!==undefined)next=generator.throw(new Error(observed.error))
    else{
     const reply:MowerTradeDroneAdjustmentObservation={kind:request.kind,observedAtMicros:clock,value:observed.value}
     next=generator.next(reply)
    }
   }
   result=next.value
  }catch(caught){error={message:caught instanceof Error?caught.message:String(caught)}}
  expect(observationIndex).toBe(observations.length)
  expect({
   result,error,nowMicros:clock,
   tasks:queue.tasks.map(task=>({type:task.type.key,timeMicros:task.timeMicros,metadata:task.metadata,adjusted:task.adjusted,
    plan:task.plan,originalIndex:originals.includes(task)?originals.indexOf(task):null})),trace,
  }).toEqual(test.output)
 })
})
