import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-run-order-planning-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,type MowerTaskType,type MowerTaskPlan} from './mowerTaskQueue'
import {
  planDefaultRunOrder,getDefaultRunOrderAdjustRoom,runDefaultTradeSegment,dispatchDefaultRefreshTime,
  type RunOrderPlanSlot,type RunOrderPlanningState,type RunOrderPlanningSeam,type RunOrderGenerator,type RunOrderIOObservation,
} from './mowerRunOrderPlanning'

interface TaskInput {seconds:number;type:MowerTaskType;metadata:string;plan:MowerTaskPlan}
interface Reading {absoluteDueMicros:number;enterMicros:number;interfaceMicros:number;readMicros:number;returnMicros:number}
interface DroneStep {result:boolean|null;elapsedMicros:number;updates:Record<string,number>}
interface Input {
  action:'plan'|'refresh'|'solver'|'adjust';nowMicros:number;configuredDelayMinutes:number;enableMastery:boolean;grandet:boolean
  plan:Record<string,RunOrderPlanSlot[]>;runOrderRooms:string[];dorms:Record<string,string[]|null>
  readings:Record<string,Reading[]>;tasks:TaskInput[];droneRoom:string|null;droneSteps:DroneStep[];room?:string
  pair?:[TaskInput,TaskInput]|null
}
function record(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid native fixture object')
  return raw as Record<string,unknown>
}
function list(raw:unknown):unknown[]{if(!Array.isArray(raw))throw new Error('Invalid native fixture list');return raw}
function text(raw:unknown):string{if(typeof raw!=='string')throw new Error('Invalid native fixture string');return raw}
function number(raw:unknown):number{if(typeof raw!=='number'||!Number.isFinite(raw))throw new Error('Invalid native fixture number');return raw}
function boolean(raw:unknown):boolean{if(typeof raw!=='boolean')throw new Error('Invalid native fixture boolean');return raw}
const names=(raw:unknown)=>list(raw).map(text)
function taskInput(raw:unknown):TaskInput{
  const item=record(raw),type=Object.values(T).find(t=>t.key===item.type)
  if(!type)throw new Error('Unknown native task type')
  return {seconds:number(item.seconds),type,metadata:text(item.metadata),plan:Object.fromEntries(Object.entries(record(item.plan)).map(([room,values])=>[room,names(values)]))}
}
function inputOf(raw:unknown):Input{
  const value=record(raw),action=text(value.action)
  if(!['plan','refresh','solver','adjust'].includes(action))throw new Error('Invalid native fixture action')
  const pair=value.pair===undefined?undefined:value.pair===null?null:list(value.pair).map(taskInput)
  if(pair&&pair.length!==2)throw new Error('Native conflict must contain two tasks')
  return {
    action:action as Input['action'],nowMicros:number(value.nowMicros),configuredDelayMinutes:number(value.configuredDelayMinutes),
    enableMastery:boolean(value.enableMastery),grandet:boolean(value.grandet),
    plan:Object.fromEntries(Object.entries(record(value.plan)).map(([room,slots])=>[room,list(slots).map(slot=>({replacement:names(record(slot).replacement)}))])),
    runOrderRooms:names(value.runOrderRooms),
    dorms:Object.fromEntries(Object.entries(record(value.dorms)).map(([room,occupants])=>[room,occupants===null?null:names(occupants)])),
    readings:Object.fromEntries(Object.entries(record(value.readings)).map(([room,readings])=>[room,list(readings).map(reading=>{
      const read=record(reading)
      return {absoluteDueMicros:number(read.absoluteDueMicros),enterMicros:number(read.enterMicros),interfaceMicros:number(read.interfaceMicros),readMicros:number(read.readMicros),returnMicros:number(read.returnMicros)}
    })])),
    tasks:list(value.tasks).map(taskInput),droneRoom:value.droneRoom===null?null:text(value.droneRoom),
    droneSteps:list(value.droneSteps).map(rawStep=>{
      const step=record(rawStep)
      if(step.result!==null&&typeof step.result!=='boolean')throw new Error('Native drone result must preserve None/False distinction')
      return {result:step.result,elapsedMicros:number(step.elapsedMicros),updates:Object.fromEntries(Object.entries(record(step.updates??{})).map(([room,time])=>[room,number(time)]))}
    }),
    room:value.room===undefined?undefined:text(value.room),pair:pair?[pair[0]!,pair[1]!]:pair,
  }
}
describe('actual alpha default run-order planning and trade orchestration',()=>{
  it.each(native.cases)('matches every field of $name',test=>{
    expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
    const input=inputOf(test.input)
    let clock=input.nowMicros,droneIndex=0,currentRead:Reading|undefined
    const readIndices:Record<string,number>={},trace:Record<string,unknown>[]=[]
    const makeTask=(raw:TaskInput)=>new MowerTask({time:raw.seconds/3600,type:raw.type,metadata:raw.metadata,plan:structuredClone(raw.plan)})
    const queue=new MowerTaskQueue()
    queue.tasks=input.tasks.map(makeTask)
    const originals=[...queue.tasks]
    const state:RunOrderPlanningState={
      plan:input.plan,runOrderRooms:input.runOrderRooms,queue,
      configuredDelayMinutes:input.configuredDelayMinutes,droneRoom:input.droneRoom,
      flags:{planned:false,todoTask:false,collectNotification:false},
    }
    const seam:RunOrderPlanningSeam={
      nowMicros:()=>clock,nativeName:id=>id,
      currentDormOccupants:room=>input.dorms[room]??undefined,
      scheduling:{grandet:input.grandet,enableMastery:input.enableMastery},
      onScheduling:conflict=>trace.push({
        kind:'scheduling',nowMicros:clock,argDelayMinutes:5,configuredDelayMinutes:input.configuredDelayMinutes,
        conflict:conflict?conflict.map(t=>({type:t.type.key,metadata:t.metadata})):null,
      }),
    }
    // Production/wall clock must advance before the generator accepts each observation.
    function drain<Result>(generator:RunOrderGenerator<Result>):Result{
      let next=generator.next()
      while(!next.done){
        const request=next.value
        let observation:RunOrderIOObservation
        switch(request.kind){
          case 'enter-room':{
            const index=readIndices[request.room]??0,readings=input.readings[request.room]!
            currentRead=readings[Math.min(index,readings.length-1)]!
            readIndices[request.room]=index+1
            clock+=currentRead.enterMicros
            trace.push({kind:'enter-room',room:request.room,nowMicros:clock})
            observation={observedAtMicros:clock}
            break
          }
          case 'wait-interface':
            clock+=currentRead!.interfaceMicros
            trace.push({kind:'wait-interface',requestedIntervalMicros:request.requestedIntervalMicros,nowMicros:clock})
            observation={observedAtMicros:clock}
            break
          case 'read-order':
            clock+=currentRead!.readMicros
            trace.push({kind:'read-order',observedAtMicros:clock,absoluteDueMicros:currentRead!.absoluteDueMicros})
            observation={observedAtMicros:clock,absoluteDueMicros:currentRead!.absoluteDueMicros}
            break
          case 'return-main':
            clock+=currentRead!.returnMicros
            trace.push({kind:'return-main',nowMicros:clock})
            observation={observedAtMicros:clock}
            break
          case 'drone':{
            const steps=input.droneSteps
            const step=steps.length?steps[Math.min(droneIndex,steps.length-1)]!:{result:true,elapsedMicros:0,updates:{}}
            droneIndex++
            clock+=step.elapsedMicros
            const taskTimeUpdates:{task:MowerTask;timeMicros:number}[]=[]
            for(const [room,due] of Object.entries(step.updates))
              for(const task of queue.tasks)
                if(task.type===T.RUN_ORDER&&task.metadata.includes(room))taskTimeUpdates.push({task,timeMicros:due})
            trace.push({kind:'drone',room:request.room,adjustTime:request.adjustTime,result:step.result,nowMicros:clock})
            observation={observedAtMicros:clock,droneResult:step.result,taskTimeUpdates}
            break
          }
        }
        next=generator.next(observation)
      }
      return next.value
    }
    let result:string|null=null
    if(input.action==='plan')drain(planDefaultRunOrder(state,seam,input.room!))
    else if(input.action==='refresh')drain(dispatchDefaultRefreshTime(state,seam,queue.tasks[0]!))
    else if(input.action==='solver'){
      const outcome=drain(runDefaultTradeSegment(state,seam))
      if(outcome.tailShouldRun){
        trace.push({kind:'fia-tail',nowMicros:clock})
        trace.push({kind:'exhaust-tail',nowMicros:clock})
      }
    }else if(input.action==='adjust'){
      result=getDefaultRunOrderAdjustRoom(state,input.pair?[makeTask(input.pair[0]),makeTask(input.pair[1])]:input.pair)??null
    }
    expect({
      result,nowMicros:clock,
      tasks:queue.tasks.map(task=>({
        type:task.type.key,timeMicros:task.timeMicros,metadata:task.metadata,plan:task.plan,
        originalIndex:originals.includes(task)?originals.indexOf(task):null,
      })),
      flags:state.flags,tailReached:{fia:trace.some(x=>x.kind==='fia-tail'),exhaust:trace.some(x=>x.kind==='exhaust-tail')},
      droneCount:droneIndex,trace,
    }).toEqual(test.output)
  })
})
