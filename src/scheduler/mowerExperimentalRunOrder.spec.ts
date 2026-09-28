import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-experimental-run-order-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,type MowerTaskPlan} from './mowerTaskQueue'
import {
 syncMowerExperimentalRunOrderTasks,planMowerExperimentalRunOrder,runMowerExperimentalTradeSegment,
 deferMowerExperimentalDormBeforeRunOrder,mowerExperimentalArrangementRooms,shouldDeferMowerExperimentalArrangementRoom,
 type MowerExperimentalRunOrderState,type MowerExperimentalRunOrderSeam,type MowerExperimentalRunOrderGenerator,
 type MowerExperimentalFacilityState,
} from './mowerExperimentalRunOrder'
interface TaskInput {timeMicros:number;type:string;metadata:string;plan:MowerTaskPlan;strict:boolean;adjusted:boolean}
interface Reading {absoluteDueMicros:number;enterMicros:number;interfaceMicros:number;cacheMicros:number;readMicros:number;returnMicros:number;facilityStateAfter:MowerExperimentalFacilityState|null}
interface Input {
 action:'sync'|'plan'|'solver'|'defer'|'arrange';nowMicros:number;configuredDelayMinutes:number;enableMastery:boolean;grandet:boolean;width:number;height:number
 plan:Record<string,{replacement:string[]}[]>;runOrderRooms:Record<string,Record<string,unknown>>;products:Record<string,string>;
 facilityStates:Record<string,MowerExperimentalFacilityState>;readings:Record<string,Reading[]>;tasks:TaskInput[];
 droneRoom:string|null;droneSteps:{result:boolean|null;elapsedMicros:number;updates?:Record<string,number>}[];
 dormDurations:Record<string,number[]>;experimental:boolean;room:string;taskIndex:number;restoration:MowerTaskPlan;
}
function inputOf(raw:unknown):Input{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid oracle object')
 const value=raw as Input
 if(!['sync','plan','solver','defer','arrange'].includes(value.action)||!Number.isSafeInteger(value.nowMicros)||!Array.isArray(value.tasks))throw new Error('Invalid oracle protocol')
 return value
}
function taskOf(input:TaskInput):MowerTask{
 const type=Object.values(T).find(t=>t.key===input.type)
 if(!type)throw new Error('Unknown actual native task type')
 const task=new MowerTask({type,metadata:input.metadata,plan:structuredClone(input.plan),strictMoodLimit:input.strict,adjusted:input.adjusted})
 task.timeMicros=input.timeMicros;return task
}
function run(raw:unknown){
 const input=inputOf(raw);let clock=input.nowMicros,droneIndex=0,currentRead:Reading|undefined,currentRoom=''
 const trace:Record<string,unknown>[]=[],queue=new MowerTaskQueue(),readIndices:Record<string,number>={}
 queue.tasks=input.tasks.map(taskOf);const originals=[...queue.tasks],queueIdentity=queue.tasks
 let result:boolean|null=null,roomOrder:string[]|undefined,state:MowerExperimentalRunOrderState|undefined
 const originalRooms=structuredClone(input.runOrderRooms??{})
 const deferral={
  experimental:input.experimental,nowMicros:()=>clock,
  observedDormDurationSeconds:(room:string)=>{
   const samples=(input.dormDurations[room]??[]).slice(-8);trace.push({kind:'estimate-dorm',room,samples});return samples
  },
 }
 if(input.action==='defer'||input.action==='arrange'){
  const task=queue.tasks[input.taskIndex]!
  if(input.action==='defer')result=deferMowerExperimentalDormBeforeRunOrder(task,queue,input.room,deferral)
  else{
   roomOrder=mowerExperimentalArrangementRooms(task)
   result=shouldDeferMowerExperimentalArrangementRoom(task,queue,input.room,structuredClone(input.restoration),deferral)
  }
 }else{
  state={width:input.width,height:input.height,activeProducts:input.products,facilityStates:structuredClone(input.facilityStates),runOrderRooms:{...originalRooms},
   planning:{plan:input.plan,runOrderRooms:Object.keys(input.runOrderRooms),queue,configuredDelayMinutes:input.configuredDelayMinutes,droneRoom:input.droneRoom,flags:{planned:false,todoTask:false,collectNotification:false}}}
  const seam:MowerExperimentalRunOrderSeam={
   nowMicros:()=>clock,nativeName:id=>id,
   currentDormOccupants:()=>{throw new Error('Experimental entry must not scan dorm occupancy')},
   scheduling:{grandet:input.grandet,enableMastery:input.enableMastery,dormDurations:input.dormDurations},
   onScheduling:conflict=>trace.push({kind:'scheduling',nowMicros:clock,argDelayMinutes:5,configuredDelayMinutes:input.configuredDelayMinutes,
    conflict:conflict?conflict.map(task=>({type:task.type.key,metadata:task.metadata})):null}),
  }
  function drain<R>(generator:MowerExperimentalRunOrderGenerator<R>):R{
   let next=generator.next()
   while(!next.done){
    const request=next.value;let value:unknown=null
    let taskTimeUpdates:{task:MowerTask;timeMicros:number}[]|undefined
    switch(request.kind){
     case 'enter-room':{
      const readings=input.readings[request.room]!,index=readIndices[request.room]??0
      currentRead=readings[Math.min(index,readings.length-1)]!;currentRoom=request.room;readIndices[request.room]=index+1
      clock+=currentRead.enterMicros;trace.push({...request,nowMicros:clock});break
     }
     case 'wait-interface':clock+=currentRead!.interfaceMicros;trace.push({...request,nowMicros:clock});break
     case 'cache-trade-page':
      clock+=currentRead!.cacheMicros;value={facilityStateAfter:structuredClone(currentRead!.facilityStateAfter)}
      trace.push({...request,facilityStateAfter:currentRead!.facilityStateAfter,nowMicros:clock});break
     case 'read-order':
      clock+=currentRead!.readMicros;value=currentRead!.absoluteDueMicros
      trace.push({...request,absoluteDueMicros:value,nowMicros:clock});break
     case 'return-main':
      clock+=currentRead!.returnMicros;trace.push({...request,room:currentRoom,nowMicros:clock});break
     case 'drone':{
      const steps=input.droneSteps
      if(!steps.length)throw new Error('Explicit native drone result required')
      const step=steps[Math.min(droneIndex,steps.length-1)]!;droneIndex++;clock+=step.elapsedMicros;value=step.result
      taskTimeUpdates=[]
      for(const [room,timeMicros] of Object.entries(step.updates??{}))
       for(const task of queue.tasks)if(task.type===T.RUN_ORDER&&task.metadata.includes(room))taskTimeUpdates.push({task,timeMicros})
      trace.push({...request,result:value,nowMicros:clock});break
     }
    }
    next=generator.next({kind:request.kind,value,observedAtMicros:clock,taskTimeUpdates})
   }
   return next.value
  }
  if(input.action==='sync')syncMowerExperimentalRunOrderTasks(state,seam)
  else if(input.action==='plan')drain(planMowerExperimentalRunOrder(state,seam,input.room))
  else{
   const outcome=drain(runMowerExperimentalTradeSegment(state,seam))
   if(outcome.tailShouldRun)trace.push({kind:'fia-tail',nowMicros:clock},{kind:'exhaust-tail',nowMicros:clock})
  }
 }
 return {
  result,nowMicros:clock,tasks:queue.tasks.map(task=>({type:task.type.key,timeMicros:task.timeMicros,metadata:task.metadata,plan:task.plan,strict:task.strictMoodLimit,adjusted:task.adjusted,
   originalIndex:originals.includes(task)?originals.indexOf(task):null})),
  queueIdentityRetained:queue.tasks===queueIdentity,trace,...(roomOrder?{roomOrder}:{}),
  ...(state?{
   runOrderRooms:Object.keys(state.runOrderRooms),roomStates:state.runOrderRooms,
   roomValueIdentity:Object.fromEntries(Object.entries(state.runOrderRooms).map(([room,value])=>[room,value===originalRooms[room]])),
   facilityStates:state.facilityStates,dormAccessCount:0,droneCount:droneIndex,
   tailReached:{fia:trace.some(x=>x.kind==='fia-tail'),exhaust:trace.some(x=>x.kind==='exhaust-tail')},
  }:{}),
 }
}
describe('actual pinned alpha experimental run-order entries and dorm deferral',()=>{
 it.each(native.cases)('matches all source effects, clock, requests and object identity: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(run(test.input)).toEqual(test.output)
 })
 it('rejects a stale observation without inventing elapsed time',()=>{
  const input=inputOf(native.cases.find(x=>x.input.action==='plan'&&x.name.includes('first-replacement'))!.input)
  const queue=new MowerTaskQueue()
  const state:MowerExperimentalRunOrderState={width:input.width,height:input.height,activeProducts:{},facilityStates:{},runOrderRooms:input.runOrderRooms,
   planning:{plan:input.plan,queue,runOrderRooms:Object.keys(input.runOrderRooms),configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}}
  const generator=planMowerExperimentalRunOrder(state,{nowMicros:()=>100,nativeName:id=>id,currentDormOccupants:()=>undefined,scheduling:{grandet:true,enableMastery:true}},input.room)
  const next=generator.next();expect(next.done).toBe(false)
  expect(()=>generator.next({kind:'enter-room',value:null,observedAtMicros:0})).toThrow('advanced scheduler wall clock')
  expect(queue.tasks).toHaveLength(0)
 })
 it('requires the observed cache snapshot rather than assuming the configured product',()=>{
  const input=inputOf(native.cases.find(x=>x.name==='cache-first-discovers-orundum-read-and-back-complete-but-no-task')!.input)
  const queue=new MowerTaskQueue()
  const state:MowerExperimentalRunOrderState={width:input.width,height:input.height,activeProducts:{},facilityStates:{},runOrderRooms:input.runOrderRooms,
   planning:{plan:input.plan,queue,runOrderRooms:Object.keys(input.runOrderRooms),configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}}
  const generator=planMowerExperimentalRunOrder(state,{nowMicros:()=>0,nativeName:id=>id,currentDormOccupants:()=>undefined,scheduling:{grandet:true,enableMastery:true}},input.room)
  expect(generator.next().value).toEqual({kind:'enter-room',room:input.room})
  expect(generator.next({kind:'enter-room',value:null,observedAtMicros:0}).value).toEqual({kind:'wait-interface',room:input.room,requestedIntervalMicros:1000000,accelerateTemplate:'bill_accelerate'})
  expect(generator.next({kind:'wait-interface',value:null,observedAtMicros:0}).value).toEqual({kind:'cache-trade-page',room:input.room,facility:'trade'})
  expect(()=>generator.next({kind:'cache-trade-page',value:null,observedAtMicros:0})).toThrow('actual facility state')
  expect(queue.tasks).toHaveLength(0)
 })
})
