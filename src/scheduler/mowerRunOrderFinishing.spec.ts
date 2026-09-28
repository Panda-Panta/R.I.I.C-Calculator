import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-run-order-finishing-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue,type MowerTaskPlan} from './mowerTaskQueue'
import {
 finishMowerRunOrderArrangement,type MowerRunOrderFinishingState,type MowerRunOrderFinishingRequest,
 type MowerRunOrderFinishingObservation,
} from './mowerRunOrderFinishing'
function record(raw:unknown):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid native fixture object')
 return raw as Record<string,unknown>
}
function string(raw:unknown):string{if(typeof raw!=='string')throw new Error('Invalid native fixture string');return raw}
function finite(raw:unknown):number{if(typeof raw!=='number'||!Number.isFinite(raw))throw new Error('Invalid native fixture number');return raw}
function plan(raw:unknown):MowerTaskPlan{
 return Object.fromEntries(Object.entries(record(raw)).map(([room,names])=>{
  if(!Array.isArray(names))throw new Error('Invalid native fixture plan')
  return [room,names.map(string)]
 }))
}
function observation(raw:unknown){
 const value=record(raw)
 if(!Object.prototype.hasOwnProperty.call(value,'value'))throw new Error('Native observation value is mandatory')
 return {
  kind:string(value.kind),elapsedMicros:finite(value.elapsedMicros),value:value.value,
  error:value.error===undefined?undefined:string(value.error),planAfter:value.planAfter===undefined?undefined:plan(value.planAfter),
 }
}
function requestFields(request:MowerRunOrderFinishingRequest):Record<string,unknown>{
 switch(request.kind){
  case 'drone':return {room:request.room,not_customize:request.notCustomize,...(request.notReturn===undefined?{}:{not_return:request.notReturn}),...(request.skipEnter===undefined?{}:{skip_enter:request.skipEnter})}
  case 'sleep':return {seconds:request.seconds}
  case 'find-bill-accelerate':return {name:request.name}
  case 'back':return {interval:request.intervalSeconds}
  case 'restore-room':return {room:request.room,plan:structuredClone(request.plan),skip_enter:request.skipEnter}
  case 'notify-missed-order':return {message:request.message,level:request.level}
  default:return {}
 }
}
describe('actual alpha agent_arrange finishing AST tail 7895-7970',()=>{
 it.each(native.cases)('matches every field of $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(native.actualAst.sliceStart).toBe(7895)
  expect(native.actualAst.sliceEnd).toBe(7970)
  const input=test.input,type=Object.values(T).find(type=>type.key===input.taskType)
  if(!type)throw new Error('Unknown native fixture task type')
  let clock=input.nowMicros,observationIndex=0
  const current=new MowerTask({time:input.taskSeconds/3600,type,plan:plan(input.taskRemainingPlan),metadata:'room_1_1',adjusted:input.adjusted})
  const queue=new MowerTaskQueue()
  queue.tasks=(input.headSeconds===null?[]:[new MowerTask({time:input.headSeconds/3600,type:T.NOT_SPECIFIC})]).concat(current)
  const originals=[...queue.tasks],originalPlan=input.originalPlan===null?null:plan(input.originalPlan)
  const state:MowerRunOrderFinishingState={
   task:current,queue,restoration:plan(input.restoration),lastRoom:input.lastRoom,originalPlan,
   activePlan:plan(input.activePlan),runOrderRooms:input.runOrderRooms,runOrderBufferSeconds:input.bufferSeconds,
   configuredDelayMinutes:input.configuredDelayMinutes,droneRoom:input.droneRoom,droneCountLimit:input.droneCountLimit,
   waitingScenes:input.waitingScenes,flags:{...input.flags},
  }
  const observations=input.observations.map(observation),trace:Record<string,unknown>[]=[]
  const generator=finishMowerRunOrderArrangement(state,{nowMicros:()=>clock,nativeName:id=>id})
  let error:{message:string}|null=null
  try{
   let next=generator.next()
   while(!next.done){
    const request=next.value,observed=observations[observationIndex++]
    if(!observed)throw new Error('Missing explicit native observation for '+request.kind)
    expect(observed.kind).toBe(request.kind)
    clock+=observed.elapsedMicros
    trace.push({kind:request.kind,request:requestFields(request),value:structuredClone(observed.value),nowMicros:clock})
    if(observed.error!==undefined)next=generator.throw(new Error(observed.error))
    else{
     const reply:MowerRunOrderFinishingObservation={kind:request.kind,observedAtMicros:clock,value:observed.value,...(observed.planAfter===undefined?{}:{planAfter:observed.planAfter})}
     next=generator.next(reply)
    }
   }
  }catch(caught){error={message:caught instanceof Error?caught.message:String(caught)}}
  expect(observationIndex).toBe(observations.length)
  expect({
   error,nowMicros:clock,taskPlan:current.plan,flags:state.flags,
   currentTaskRetained:queue.tasks.some(task=>task===current),snapshotPlanAssigned:originalPlan!==null&&current.plan===originalPlan,
   restoration:state.restoration,
   tasks:queue.tasks.map(task=>({
    type:task.type.key,timeMicros:task.timeMicros,metadata:task.metadata,adjusted:task.adjusted,plan:task.plan,
    originalIndex:originals.includes(task)?originals.indexOf(task):null,restorationPlanIdentity:task.plan===state.restoration,
   })),trace,
  }).toEqual(test.output)
 })
})
