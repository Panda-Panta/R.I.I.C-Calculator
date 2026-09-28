import {describe,it,expect} from 'vitest'
import native from '../../validation/mower-output-2026-09-27/mower-clue-lifecycle-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES} from './mowerTaskQueue'
import {executeMowerClueNew,runMowerClueFlow,setMowerPartyTime,type MowerClueLifecycleState} from './mowerClueLifecycle'

describe('actual pinned clue lifecycle at explicit device observation boundaries',()=>{
 it.each(native.cases)('$name',fixture=>{
  const input=fixture.input,queue=new MowerTaskQueue()
  queue.tasks=input.tasks.map(task=>new MowerTask({time:task.timeMicros/3_600_000_000,type:Object.values(MOWER_TASK_TYPES).find(t=>t.key===task.type)}))
  const originals=[...queue.tasks]
  const state:MowerClueLifecycleState={queue,flags:{...input.flags},partyTimeMicros:input.partyTimeMicros,dataPartyTime:input.dataPartyTime,
   lastClueMicros:input.lastClueMicros,leifengMode:input.leifengMode,clueCount:input.clueCount,clueCountLimit:input.clueCountLimit,
   mall:{...input.mall},waitingScenes:input.waitingScenes}
  let clock=input.nowMicros,index=0,error:string|null=null,result:null=null
  const trace:unknown[]=[],seam={nowMicros:()=>clock}
  try{
   if(input.mode==='setter')setMowerPartyTime(state,input.partyTimeMicros,seam)
   else{
    const generator=input.mode==='flow'?runMowerClueFlow(state,seam):executeMowerClueNew(state,seam)
    let next=generator.next()
    while(!next.done){
     const request=next.value,observation=input.observations[index++]
     if(!observation)throw new Error('Missing native observation for '+request.kind)
     expect(observation.kind).toBe(request.kind)
     clock+=observation.elapsedMicros
     const {kind,...fields}=request
     trace.push({kind,request:fields,value:structuredClone(observation.value),nowMicros:clock})
     next='error' in observation
      ?generator.throw(new Error(observation.error))
      :generator.next({kind:request.kind,value:observation.value,observedAtMicros:clock})
    }
    result=next.value
   }
  }catch(caught){error=caught instanceof Error?caught.message:String(caught)}
  expect(index).toBe(input.observations.length)
  expect({result,error,nowMicros:clock,trace,partyTimeMicros:state.partyTimeMicros,dataPartyTime:state.dataPartyTime,
   lastClueMicros:state.lastClueMicros,flags:state.flags,
   tasks:queue.tasks.map(t=>({type:t.type.key,timeMicros:t.timeMicros,plan:t.plan,metadata:t.metadata})),
   originalTaskReferencesRetained:originals.every((task,n)=>queue.tasks[n]===task),
  }).toEqual(fixture.output)
 })
 it('rejects a missing observation rather than reporting an empty successful device response',()=>{
  const queue=new MowerTaskQueue(),state:MowerClueLifecycleState={queue,flags:{planned:false,todoTask:false,collectNotification:false},
   partyTimeMicros:null,dataPartyTime:null,lastClueMicros:null,leifengMode:false,clueCount:0,clueCountLimit:9,
   mall:{maaMallEnable:false,maaMallMode:'maa'},waitingScenes:[]}
  const generator=executeMowerClueNew(state,{nowMicros:()=>10})
  expect(generator.next().value).toEqual({kind:'navigate',scene:'INFRA_MAIN'})
  // Native clue_new catches device exceptions and asks the recording seam to save them.
  expect(generator.next({kind:'navigate',value:null,observedAtMicros:9}).value).toMatchObject({kind:'save-exception'})
  expect(state.dataPartyTime).toBe(null)
 })
})
