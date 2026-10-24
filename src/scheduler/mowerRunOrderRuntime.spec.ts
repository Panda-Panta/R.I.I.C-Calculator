import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,advanceRoster,settleRoster,nextRosterActionHours,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {retainMowerFailedTask} from './mowerTaskFailure'
import {resolveOperatorCharId as id} from '../domain/operatorIdentifiers'
import {MowerRecognizeError,MowerExitError} from './mowerNativeErrors'

function scenario(orderDue:(state:ReturnType<typeof createRosterRuntime>)=>number=()=>900_123_456){
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:['但书']}]
 ws.mainPlan.conf.workaholic=['芬']
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(state)
 source.queue.tasks=[new MowerTask({time:-1/3600})]
 const observations:{kind:string;timeMicros:number}[]=[],phases:string[]=[]
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>({
  delayMicros:request.kind==='enter-room'?200_000:request.kind==='read-order'?300_000:request.kind==='return-main'?500_000:0,
  observe:()=>{observations.push({kind:request.kind,timeMicros:toMowerMicros(s.time)});return {observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:orderDue(s)}:{})}}
 })}
 const settle=()=>settleMowerSource(state,rates,phase=>{phases.push(phase);return false})
 function finishIO(){
  for(let limit=20;source.execution||source.phaseExecution;limit--){
   if(limit<=0)throw new Error('I/O failed to terminate')
   advanceRoster(state,nextMowerSourceActionHours(state),rates);settle()
  }
 }
 return {state,source,rates,observations,phases,settle,finishIO}
}
describe('ideal order wakes in source runtime',()=>{
 it('keeps observed deadlines and the shared morale clock across I/O wakes',()=>{
  const {state,source,observations,phases,settle,finishIO}=scenario()
  settle();finishIO()
  const task=source.queue.find({type:T.RUN_ORDER,metadata:'room_1_1'})!
  expect(task.timeMicros).toBe(720_123_456)
  expect(task.observedOrderDueMicros).toBe(900_123_456)
  // f19a discards the startup observation beyond its ten-minute execution
  // window, then ordinary planning makes its independent formal observation.
  expect(toMowerMicros(state.time)).toBe(2_000_000)
  expect(state.morale.char_123_fang).toBeCloseTo(24-2/3600,10)
  expect(observations).toEqual([
   {kind:'enter-room',timeMicros:200_000},{kind:'wait-interface',timeMicros:200_000},{kind:'read-order',timeMicros:500_000},{kind:'return-main',timeMicros:1_000_000},
   {kind:'enter-room',timeMicros:1_200_000},{kind:'wait-interface',timeMicros:1_200_000},{kind:'read-order',timeMicros:1_500_000},{kind:'return-main',timeMicros:2_000_000},
  ])
  expect(source.data.operators.char_123_fang!.timeStampMicros).toBe(200_000)
  expect(phases.filter(p=>p==='BEGINNING')).toHaveLength(1)
 })
 it('refreshes a deadline and consumes the original refresh task identity',()=>{
  const {source,settle,finishIO}=scenario()
  const selected=new MowerTask({type:T.REFRESH_TIME,metadata:'room_1_1',time:-1/3600})
  source.queue.tasks=[selected];settle();finishIO()
  expect(source.queue.tasks).not.toContain(selected)
  expect(source.queue.tasks.filter(t=>t.type===T.RUN_ORDER)).toHaveLength(1)
 })
 it('releases ready-order collection while retaining unrelated failed shift work',()=>{
  let ready=false,notifications=0
  const {state,source,rates,settle,finishIO}=scenario(s=>ready?toMowerMicros(s.time):900_123_456)
  settle();finishIO();ready=true
  const blocked=new MowerTask({time:-10,type:T.SHIFT_OFF,plan:{room_1_1:['char_123_fang']}})
  retainMowerFailedTask(state,source.data,blocked,'waiting for a changed replacement observation')
  source.queue.tasks=[blocked,new MowerTask({time:state.time-1/3600})]
  delete source.runReturn
  rates.mowerNotificationIO=request=>({delayMicros:0,observe:()=>{
   if(request.kind==='tap-notification')notifications++
   return {kind:request.kind,observedAtMicros:toMowerMicros(state.time),value:request.kind==='detect-notification'?{ready:true}:null}
  }})
  settle();finishIO()
  expect(notifications).toBe(1)
  expect(source.queue.tasks).toContain(blocked)
  expect(blocked.time).toBe(-10)
  expect(blocked.executionFailure).toBeDefined()
  expect(source.queue.tasks.some(task=>task.type===T.RUN_ORDER)).toBe(false)
  expect(source.error).toBeFalsy()
 })
 it('reports missing order observations for decision-only replay',()=>{
  const {state,source}=scenario()
  settleMowerSource(state,{workRate:()=>1,recoveryRate:()=>2})
  expect(source.queue.find({type:T.RUN_ORDER})).toBeUndefined()
  expect(state.diagnostics.some(d=>d.code==='mower-run-order-io-unavailable')).toBe(true)
 })
 it('ignores legacy temporary staffing plans and wakes at completion without moving the runner',()=>{
  const {state,source,settle}=scenario()
  const task=new MowerTask({type:T.RUN_ORDER,metadata:'room_1_1',plan:{room_1_1:['char_4032_provs']}})
  task.observedOrderDueMicros=900_123_456
  source.queue.tasks=[task,new MowerTask({time:5})];settle()
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(task.plan).toEqual({})
  expect(task.timeMicros).toBe(900_123_456)
  expect(task.wakeOnlyCompletion).toBe(true)
 })
})

function tailScenario(error:Error=new MowerRecognizeError('first room countdown absent')){
 const ws=createDefaultWorkspace();for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 const owner1=id('芬'),owner2=id('香草'),cover1=id('砾'),cover2=id('斑点'),runner=id('但书')
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:owner1},groupId:null,replacements:[cover1,runner]}]
 ws.mainPlan.facilities.room_1_2.slots=[{occupant:{kind:'operator',operatorId:owner2},groupId:null,replacements:[cover2,runner]}]
 ws.mainPlan.conf.workaholic=[owner1,owner2]
 const config=compiledScheduleToRuntimeConfig(compileRosterSchedule(ws));config.mowerTaskScheduling={...config.mowerTaskScheduling,adjustForRunOrders:false}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),trace:{kind:string;room:string}[]=[]
 source.startupRunOrderCheckPending=false
 const task=new MowerTask({type:T.NOT_SPECIFIC,plan:{room_1_1:[cover1],room_1_2:[cover2]}});source.queue.tasks=[task]
 let recovered=false,failedRoom:string|undefined
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>({delayMicros:request.kind==='return-main'?500_000:0,observe:()=>{
  trace.push({kind:request.kind,room:request.room})
  if(request.kind==='enter-room')s.mowerUI={scene:'INFRA_DETAILS',lastRoom:request.room}
  if(request.kind==='return-main')s.mowerUI={scene:'INFRA_MAIN',lastRoom:''}
  if(request.kind==='read-order'){failedRoom??=request.room;if(request.room===failedRoom&&!recovered)throw error}
  return {observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:toMowerMicros(1)}:{})}
 }})}
 const settle=()=>settleRoster(state,rates)
 const step=()=>{advanceRoster(state,nextRosterActionHours(state,rates),rates);settle()}
 const until=(done:()=>boolean)=>{for(let n=0;n<50&&!done();n++){step()}expect(done()).toBe(true)}
 const reads=(room:string)=>trace.filter(event=>event.kind==='read-order'&&event.room===room).length
 return {state,source,task,rates,trace,reads,settle,step,until,get failedRoom(){return failedRoom??'room_1_1'},get independentRoom(){return failedRoom==='room_1_2'?'room_1_1':'room_1_2'},recover:()=>{recovered=true}}
}

describe('ordinary tail independent read failures',()=>{
 it('retains the failed room refresh, returns to main, and reads the next completed-batch room',()=>{
  const f=tailScenario();f.settle()
  f.until(()=>f.reads(f.independentRoom)>0||f.state.diagnostics.some(d=>d.code==='mower-planning-exception'))
  expect(f.task.plan).toEqual({})
  expect(f.reads(f.independentRoom)).toBe(1)
  const failed=f.source.queue.tasks.find(task=>task.type===T.REFRESH_TIME&&task.metadata===f.failedRoom)!
  expect(failed.executionFailure?.reason).toContain('first room countdown absent')
  const deadline=failed.timeMicros,failure=failed.executionFailure
  const first=f.trace.findIndex(event=>event.kind==='read-order'&&event.room===f.failedRoom)
  const returned=f.trace.findIndex((event,index)=>index>first&&event.kind==='return-main'&&event.room===f.failedRoom)
  const second=f.trace.findIndex(event=>event.kind==='enter-room'&&event.room===f.independentRoom)
  expect(returned).toBeGreaterThan(first);expect(second).toBeGreaterThan(returned)
  f.until(()=>!f.source.phaseExecution&&!f.source.execution)
  expect(f.source.queue.tasks.some(task=>task.type===T.RUN_ORDER&&task.metadata===f.independentRoom)).toBe(true)
  for(let n=0;n<3;n++)f.settle()
  advanceRoster(f.state,.01,f.rates);f.settle()
  expect(f.reads(f.failedRoom)).toBe(1)
  expect(failed.timeMicros).toBe(deadline);expect(failed.executionFailure).toBe(failure)
  expect(f.state.diagnostics.some(d=>d.code==='mower-planning-exception')).toBe(false)
  expect(f.state.config.mowerTaskScheduling?.adjustForRunOrders).toBe(false)
 })
 it('keeps the same failed refresh through a failed retry and consumes it only after related evidence and a valid read',()=>{
  const f=tailScenario();f.settle()
  f.until(()=>f.reads(f.independentRoom)>0||f.state.diagnostics.some(d=>d.code==='mower-planning-exception'))
  expect(f.reads(f.independentRoom)).toBe(1)
  f.until(()=>!f.source.phaseExecution&&!f.source.execution)
  const failed=f.source.queue.tasks.find(task=>task.type===T.REFRESH_TIME&&task.metadata===f.failedRoom)!,deadline=failed.timeMicros
  f.state.mowerFacilityProducts={[f.failedRoom]:'gold'};f.settle()
  f.until(()=>f.reads(f.failedRoom)>=2&&!f.source.phaseExecution&&!f.source.execution)
  expect(f.reads(f.failedRoom)).toBe(2)
  expect(f.source.queue.tasks).toContain(failed);expect(failed.timeMicros).toBe(deadline);expect(failed.executionFailure).toBeDefined()
  f.recover();f.state.mowerFacilityProducts={[f.failedRoom]:'exp3'};f.settle()
  f.until(()=>f.reads(f.failedRoom)>=3&&!f.source.phaseExecution&&!f.source.execution)
  expect(f.reads(f.failedRoom)).toBe(3);expect(f.source.queue.tasks).not.toContain(failed)
  expect(f.source.queue.tasks.some(task=>task.type===T.RUN_ORDER&&task.metadata===f.failedRoom&&Object.keys(task.plan).length===0)).toBe(true)
 })
 it('propagates a fatal tail read exit without continuing the independent room',()=>{
  const f=tailScenario(new MowerExitError('device exit'));f.settle()
  expect(()=>{for(let n=0;n<20;n++)f.step()}).toThrow('device exit')
  expect(f.reads(f.independentRoom)).toBe(0)
 })
})
