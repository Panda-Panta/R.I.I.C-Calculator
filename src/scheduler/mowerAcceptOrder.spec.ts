import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-accept-order-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask} from './mowerTaskQueue'
import {acceptMowerTradeOrders,type MowerAcceptOrderRequest} from './mowerAcceptOrder'
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

function fields(request:MowerAcceptOrderRequest):Record<string,unknown>{
 switch(request.kind){
  case 'cache-trade-page':return {room:request.room,facility:request.facility}
  case 'find-order-ready':return {name:request.name,scope:request.scope}
  case 'sleep':return {seconds:request.seconds}
  case 'has-distinct-buff':return {scores:request.scores}
  case 'is-stable-buff':return {scores:request.scores,newScores:request.newScores}
  case 'save-screencap':return {category:request.category}
  case 'tap-accept-order':return {target:request.target,intervalSeconds:request.intervalSeconds}
  default:return {}
 }
}
describe('actual pinned accept_order AST 7752-7783',()=>{
 it.each(native.cases)('matches all trace, clock, state and exception fields: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(native.actualAst).toEqual({function:'accept_order',line:7752,endLine:7783})
  const input=test.input
  const type=Object.values(T).find(t=>t.key===input.taskType)
  const task=input.taskType===null?null:new MowerTask({type:type??T.NOT_SPECIFIC,metadata:input.metadata})
  const state={task,width:input.width,height:input.height},originalTask=state.task
  let clock=input.nowMicros,index=0,result:unknown=null,error:{message:string}|null=null
  const steps=observations(input.observations),trace:Record<string,unknown>[]=[]
  const generator=acceptMowerTradeOrders(state,{nowMicros:()=>clock})
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
  expect(index).toBe(steps.length)
  expect({result,error,nowMicros:clock,trace,flags:input.flags,lastTodoMicros:input.lastTodoMicros,
   taskRetained:state.task===originalTask,queueRetained:true}).toEqual(test.output)
 })
 it('rejects observations before the host clock has advanced',()=>{
  const generator=acceptMowerTradeOrders({task:null,width:1920,height:1080},{nowMicros:()=>100})
  generator.next()
  expect(()=>generator.next({kind:'find-order-ready',value:null,observedAtMicros:99})).toThrow('advanced scheduler wall clock')
 })
 it('requires an explicit response rather than silently assuming a missing ready button',()=>{
  const generator=acceptMowerTradeOrders({task:null,width:1920,height:1080},{nowMicros:()=>100})
  generator.next()
  expect(()=>generator.next({kind:'find-order-ready',value:undefined,observedAtMicros:100})).toThrow('Explicit matching')
 })
})
