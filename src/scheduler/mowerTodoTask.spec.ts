import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-todo-task-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue} from './mowerTaskQueue'
import {executeMowerTodoTask,type MowerTodoTaskState} from './mowerTodoTask'
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid native fixture object')
 return value as Record<string,unknown>
}
function string(value:unknown):string{if(typeof value!=='string')throw new Error('Invalid native string');return value}
function number(value:unknown):number{if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid native number');return value}
function task(raw:unknown):MowerTask{
 const value=record(raw),type=Object.values(T).find(t=>t.key===value.type)
 if(!type)throw new Error('Invalid task type')
 return new MowerTask({time:number(value.timeMicros)/3_600_000_000,type,metadata:string(value.metadata)})
}
describe('actual selected default infra_main todo-task AST 1230-1264',()=>{
 it.each(native.cases)('compares all actions, timestamps, flags, queue identity and errors: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(native.actualAst.selectedBranch).toEqual([1230,1264])
  const i=test.input,queue=new MowerTaskQueue()
  queue.tasks=i.tasks.map(task)
  const originals=[...queue.tasks]
  const state:MowerTodoTaskState={
   queue,flags:{...i.flags},enableParty:i.enableParty,lastClueMicros:i.lastClueMicros,
   droneRoom:i.droneRoom,runOrderRooms:i.runOrderRooms,droneTimeMicros:i.droneTimeMicros,droneIntervalHours:i.droneIntervalHours,
   reloadRooms:i.reloadRooms,reloadTimeMicros:i.reloadTimeMicros,maaGapHours:i.maaGapHours,
  }
  let clock=i.nowMicros,index=0,result:unknown=null,error:{message:string}|null=null
  const trace:Record<string,unknown>[]=[],steps=i.observations.map(record)
  const generator=executeMowerTodoTask(state,{nowMicros:()=>clock})
  try{
   let next=generator.next()
   while(!next.done){
    const request=next.value,observation=steps[index++]
    if(!observation)throw new Error('Missing explicit native observation for '+request.kind)
    expect(observation.kind).toBe(request.kind)
    clock+=number(observation.elapsedMicros)
    const fields=request.kind==='drone'?{room:request.room}:request.kind==='reload'?{rooms:request.rooms}:{}
    trace.push({kind:request.kind,request:fields,value:structuredClone(observation.value),nowMicros:clock})
    if(observation.error!==undefined)next=generator.throw(new Error(string(observation.error)))
    else{
     if(observation.appendTasks!==undefined){
      if(!Array.isArray(observation.appendTasks))throw new Error('Invalid native appended tasks')
      queue.tasks.push(...observation.appendTasks.map(task))
     }
     next=generator.next({kind:request.kind,value:observation.value,observedAtMicros:clock})
    }
   }
   result=next.value
  }catch(caught){error={message:caught instanceof Error?caught.message:String(caught)}}
  expect(index).toBe(steps.length)
  expect({
   result,error,nowMicros:clock,trace,lastClueMicros:state.lastClueMicros,droneTimeMicros:state.droneTimeMicros,
   reloadTimeMicros:state.reloadTimeMicros,flags:state.flags,
   tasks:queue.tasks.map(t=>({timeMicros:t.timeMicros,type:t.type.key,metadata:t.metadata,originalIndex:originals.includes(t)?originals.indexOf(t):null})),
  }).toEqual(test.output)
 })
 it('requires the actual inner reload_time rather than guessing it from action duration',()=>{
  const state:MowerTodoTaskState={
   queue:new MowerTaskQueue(),flags:{todoTask:false,collectNotification:false,planned:true},
   enableParty:false,lastClueMicros:null,droneRoom:null,runOrderRooms:[],droneTimeMicros:null,droneIntervalHours:3,
   reloadRooms:[],reloadTimeMicros:null,maaGapHours:3,
  }
  const generator=executeMowerTodoTask(state,{nowMicros:()=>100})
  expect(generator.next().value).toEqual({kind:'reload',rooms:[]})
  expect(()=>generator.next({kind:'reload',value:null,observedAtMicros:100})).toThrow('Inner reload_time observation')
  expect(state.flags.todoTask).toBe(false)
 })
})
