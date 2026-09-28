import {describe,it,expect} from 'vitest'
import native from '../../validation/mower-output-2026-09-27/mower-reload-alpha.json'
import {executeMowerReload,type MowerReloadState} from './mowerReload'
class SourceExit extends Error {override name='MowerExit'}
describe('actual pinned reload input/exception/timestamp boundaries',()=>{
 it.each(native.cases)('$name',fixture=>{
  const input=fixture.input,state:MowerReloadState={rooms:input.rooms,reloadTimeMicros:input.reloadTimeMicros,width:input.width,height:input.height,waitingScenes:input.waitingScenes}
  let clock=input.nowMicros,index=0,result:null=null,error:unknown=null
  const trace:unknown[]=[],errors=new Map<number,Error>()
  const generator=executeMowerReload(state,{nowMicros:()=>clock,isMowerExit:value=>value instanceof SourceExit})
  try{
   let next=generator.next()
   while(!next.done){
    const request=next.value,observation=input.observations[index++]
    if(!observation)throw new Error('Missing actual reload observation for '+request.kind)
    expect(observation.kind).toBe(request.kind)
    clock+=observation.elapsedMicros
    const {kind,...fields}=request
    trace.push({kind,request:fields,value:structuredClone(observation.value),nowMicros:clock})
    if('error' in observation&&observation.error!==undefined){
     const caught=observation.error.type==='MowerExit'?new SourceExit(observation.error.message):new Error(observation.error.message)
     caught.name=observation.error.type;errors.set(observation.error.id,caught)
     next=generator.throw(caught)
    }else next=generator.next({kind:request.kind,value:observation.value,observedAtMicros:clock})
   }
   result=next.value
  }catch(caught){error={type:caught instanceof Error?caught.name:typeof caught,message:caught instanceof Error?caught.message:String(caught),id:[...errors].find(([,value])=>value===caught)?.[0]??null}}
  expect(index).toBe(input.observations.length)
  expect({result,error,nowMicros:clock,reloadTimeMicros:state.reloadTimeMicros,trace}).toEqual(fixture.output)
 })
 it('requires a matching device response and records contract failures',()=>{
  const state:MowerReloadState={rooms:['room_1_1'],reloadTimeMicros:null,width:1920,height:1080,waitingScenes:[]}
  const generator=executeMowerReload(state,{nowMicros:()=>10,isMowerExit:()=>false})
  expect(generator.next().value).toEqual({kind:'enter-room',room:'room_1_1'})
  expect(generator.next({kind:'tap',value:null,observedAtMicros:10}).value).toMatchObject({kind:'save-exception'})
  expect(state.reloadTimeMicros).toBe(null)
 })
})
