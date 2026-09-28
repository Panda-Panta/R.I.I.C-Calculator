import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-notification-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue} from './mowerTaskQueue'
import {
 collectMowerInfraNotification,collectMowerTodoList,resetMowerRunFlags,
 type MowerNotificationState,type MowerNotificationRequest,
} from './mowerNotification'
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid native fixture object')
 return value as Record<string,unknown>
}
function string(value:unknown):string{if(typeof value!=='string')throw new Error('Invalid native string');return value}
function number(value:unknown):number{if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid native number');return value}
function observations(value:unknown){
 if(!Array.isArray(value))throw new Error('Invalid explicit observations')
 return value.map(raw=>{
  const value=record(raw)
  if(!Object.prototype.hasOwnProperty.call(value,'value'))throw new Error('Explicit native response required')
  return {kind:string(value.kind),value:value.value,elapsedMicros:number(value.elapsedMicros),error:value.error===undefined?undefined:string(value.error)}
 })
}

function fields(request:MowerNotificationRequest):Record<string,unknown>{
 switch(request.kind){
  case 'sleep':return {seconds:request.seconds}
  case 'tap-notification':return {target:request.target}
  case 'find-collect':return {resource:request.resource,name:request.name}
  case 'tap-collect':return {resource:request.resource,target:request.target}
  case 'tap-close-todo':return {target:request.target}
  default:return {}
 }
}
describe('actual pinned notification branch, todo_list and run flag reset',()=>{
 it.each(native.cases)('matches all trace, clock, state and exception fields: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(native.actualAst.notificationBranch).toEqual([1266,1273])
  expect(native.actualAst.todoList).toEqual([4244,4265])
  expect(native.actualAst.flagReset).toEqual([400,402])
  const input=test.input,queue=new MowerTaskQueue()
  queue.tasks=input.tasks.map(t=>new MowerTask({
   time:t.timeMicros/3_600_000_000,type:Object.values(T).find(type=>type.key===t.type),metadata:t.metadata,
  }))
  const originalTasks=[...queue.tasks]
  const state:MowerNotificationState={queue,flags:{...input.flags},lastTodoMicros:input.lastTodoMicros}
  let clock=input.nowMicros,index=0,result:unknown=null,error:{message:string}|null=null
  const steps=observations(input.observations),trace:Record<string,unknown>[]=[]
  if(input.mode==='reset')resetMowerRunFlags(state.flags)
  else{
   const generator=input.mode==='notification'?collectMowerInfraNotification(state,{nowMicros:()=>clock}):collectMowerTodoList(state,{nowMicros:()=>clock})
   try{
    let next=generator.next()
    while(!next.done){
     const request=next.value,observation=steps[index++]
     if(!observation)throw new Error('Missing actual observation for '+request.kind)
     expect(observation.kind).toBe(request.kind)
     clock+=observation.elapsedMicros
     trace.push({kind:request.kind,request:fields(request),value:structuredClone(observation.value),nowMicros:clock})
     next=observation.error===undefined
      ?generator.next({kind:request.kind,value:observation.value,observedAtMicros:clock})
      :generator.throw(new Error(observation.error))
    }
    result=next.value
   }catch(caught){error={message:caught instanceof Error?caught.message:String(caught)}}
  }
  expect(index).toBe(steps.length)
  expect({result,error,nowMicros:clock,trace,flags:state.flags,lastTodoMicros:state.lastTodoMicros,
   taskRetained:true,queueRetained:queue.tasks.length===originalTasks.length&&queue.tasks.every((t,i)=>t===originalTasks[i]),
  }).toEqual(test.output)
 })
 it('requires explicit notification observations at the host clock',()=>{
  const state:MowerNotificationState={queue:new MowerTaskQueue(),flags:{todoTask:true,collectNotification:false,planned:true},lastTodoMicros:null}
  const generator=collectMowerInfraNotification(state,{nowMicros:()=>100})
  generator.next()
  expect(()=>generator.next({kind:'detect-notification',value:null,observedAtMicros:99})).toThrow('advanced scheduler wall clock')
  expect(state.flags.collectNotification).toBe(false)
 })
 it('notification selected-branch eligibility does not stand in for earlier infra_main phases',()=>{
  const state:MowerNotificationState={queue:new MowerTaskQueue(),flags:{todoTask:true,collectNotification:false,planned:true},lastTodoMicros:null}
  const generator=collectMowerInfraNotification(state,{nowMicros:()=>100})
  expect(generator.next().value).toEqual({kind:'detect-notification'})
  expect(state.flags.collectNotification).toBe(false)
 })
})
