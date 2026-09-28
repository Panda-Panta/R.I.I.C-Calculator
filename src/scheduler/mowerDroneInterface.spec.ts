import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-drone-interface-alpha.json'
import {
 waitMowerDroneInterface,tapMowerDroneAccelerate,
 type MowerDroneInterfaceRequest,type MowerDroneInterfaceGenerator,
} from './mowerDroneInterface'
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid native fixture object')
 return value as Record<string,unknown>
}
function string(value:unknown):string{if(typeof value!=='string')throw new Error('Invalid native string');return value}
function number(value:unknown):number{if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid native number');return value}
function fields(request:MowerDroneInterfaceRequest):Record<string,unknown>{
 switch(request.kind){
  case 'find':return {name:request.name}
  case 'sleep':return request.seconds===undefined?{}:{seconds:request.seconds}
  case 'tap':return {target:request.target,interval:request.intervalSeconds}
 }
}
describe('actual pinned complete drone-interface helper AST and timed_step decorator',()=>{
 it.each(native.cases)('compares all actions, clock, return identity, errors and timing finally: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(native.actualFunctions).toEqual({
   _wait_drone_interface:{start:4176,end:4224},_tap_drone_accelerate:{start:4747,end:4778},
  })
  const input=test.input
  let clock=input.nowMicros,index=0,result:unknown=null,lastResponse:unknown=null,error:{name:string;message:string}|null=null
  const trace:Record<string,unknown>[]=[]
  const seam={
   nowMicros:()=>clock,
   onTimingEnter:(name:'order_navigation')=>trace.push({kind:'timing-enter',name,nowMicros:clock}),
   onTimingLeave:(name:'order_navigation')=>trace.push({kind:'timing-leave',name,nowMicros:clock}),
  }
  const interval=input.intervalSeconds===null?{}:{intervalSeconds:input.intervalSeconds}
  const generator:MowerDroneInterfaceGenerator=input.helper==='wait'
   ?waitMowerDroneInterface({width:input.width,height:input.height},seam,{
    ...interval,accelerateTemplate:input.accelerateTemplate,pageTemplate:input.pageTemplate,
   })
   :tapMowerDroneAccelerate(seam,{
    ...interval,accelerateTemplate:string(input.accelerateTemplate),allInTemplate:input.allInTemplate,
    ...(input.maxRetry===null?{}:{maxRetry:input.maxRetry}),
   })
  const observations=input.observations.map(record)
  try{
   let next=generator.next()
   while(!next.done){
    const request=next.value,observation=observations[index++]
    if(!observation)throw new Error('Missing explicit native observation for '+request.kind)
    expect(observation.kind).toBe(request.kind)
    clock+=number(observation.elapsedMicros)
    trace.push({kind:request.kind,request:fields(request),value:structuredClone(observation.value),nowMicros:clock})
    if(observation.error!==undefined){
     const failure=new Error(string(observation.error));failure.name='RuntimeError'
     next=generator.throw(failure)
    }else{
     lastResponse=observation.value
     next=generator.next({kind:request.kind,value:lastResponse,observedAtMicros:clock})
    }
   }
   result=next.value
  }catch(caught){
   error=caught instanceof Error?{name:caught.name,message:caught.message}:{name:'UnknownError',message:String(caught)}
  }
  expect(index).toBe(observations.length)
  expect({result,error,nowMicros:clock,trace,returnResponseIdentity:input.helper==='tap'&&error===null&&result===lastResponse}).toEqual(test.output)
 })
 it('rejects an observation from a different wall clock while leaving the timing frame',()=>{
  const events:string[]=[]
  const generator=waitMowerDroneInterface({width:1920,height:1080},{
   nowMicros:()=>100,onTimingEnter:()=>events.push('enter'),onTimingLeave:()=>events.push('leave'),
  })
  generator.next()
  expect(()=>generator.next({kind:'find',value:null,observedAtMicros:99})).toThrow('advanced scheduler wall clock')
  expect(events).toEqual(['enter','leave'])
 })
 it('does not invent missing accelerator observations as a successful page',()=>{
  const generator=tapMowerDroneAccelerate({nowMicros:()=>100},{accelerateTemplate:'bill_accelerate',allInTemplate:'all_in'})
  generator.next()
  expect(()=>generator.next({kind:'find',value:undefined,observedAtMicros:100})).toThrow('Explicit matching')
 })
})
