import {describe,expect,it} from 'vitest'
import {writeFileSync} from 'node:fs'
import {testEvidenceFile} from '../test/evidence'
import {executeMowerRunOrderStartup,type MowerRunOrderStartupSeam} from './mowerRunOrderStartup'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import type {RunOrderPlanningState} from './mowerRunOrderPlanning'
import {MowerExitError,MowerRecognizeError} from './mowerNativeErrors'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,advanceRoster,nextRosterActionHours,settleRoster,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {resolveOperatorCharId} from '../domain/operatorIdentifiers'
import {simulateSchedule} from '../simulator/scheduleSimulation'

function fixture(delay=3){
 const startup={startupRunOrderCheckPending:true},queue=new MowerTaskQueue(),moods:string[]=[],errors:string[]=[],requests:string[]=[]
 const state:RunOrderPlanningState={plan:{room_1_1:[{replacement:['但书']}],room_1_2:[{replacement:['龙舌兰']}]},runOrderRooms:['room_1_1','room_1_2'],queue,configuredDelayMinutes:delay,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}
 const seam:MowerRunOrderStartupSeam={nowMicros:()=>0,currentDormOccupants:()=>undefined,scheduling:{adjustForRunOrders:false,enableMastery:false},maintenancePaused:()=>false,readMood:room=>{moods.push(room)},onReadFailure:room=>errors.push(room)}
 const drive=(deadlines:Record<string,number|Error>={room_1_1:toMowerMicros(13/60),room_1_2:toMowerMicros(2)})=>{
  const steps=executeMowerRunOrderStartup(startup,state,seam)
  let next=steps.next()
  while(!next.done){
   const request=next.value;requests.push(request.kind+':'+request.room)
   const due=deadlines[request.room]
   next=request.kind==='read-order'&&due instanceof Error?steps.throw(due):steps.next({observedAtMicros:0,...(request.kind==='read-order'&&typeof due==='number'?{absoluteDueMicros:due}:{})})
  }
 }
 return {startup,state,seam,queue,moods,errors,requests,drive}
}

describe('f19a once-per-startup ideal order observations',()=>{
 it.each([{delay:3,minutes:10,admitted:true},{delay:3,minutes:10.1,admitted:false},{delay:8,minutes:16,admitted:true},{delay:8,minutes:16.1,admitted:false}])('uses the adjusted execution window: $delay / $minutes',({delay,minutes,admitted})=>{
  const f=fixture(delay),original=new MowerTask({time:-1,type:T.NOT_SPECIFIC,plan:{contact:['A']}})
  f.queue.tasks=[original]
  f.drive({room_1_1:toMowerMicros((minutes+delay)/60),room_1_2:toMowerMicros(2)})
  const orders=f.queue.tasks.filter(task=>task.type===T.RUN_ORDER)
  expect(orders).toHaveLength(admitted?1:0)
  if(admitted)expect(orders[0]).toMatchObject({plan:{},timeMicros:toMowerMicros(minutes/60),observedOrderDueMicros:toMowerMicros((minutes+delay)/60)})
  expect(f.moods).toEqual(['room_1_1','room_1_2'])
  expect(f.queue.tasks).toContain(original);expect(original.time).toBe(-1);expect(original.plan).toEqual({contact:['A']})
  expect(f.queue.tasks.some(task=>task.type===T.REFRESH_TIME)).toBe(false)
  f.drive();expect(f.moods).toHaveLength(2);expect(f.startup.startupRunOrderCheckPending).toBe(false)
 })
 it('admits a due execution wake while leaving an already completed order to ordinary collection',()=>{
  const f=fixture();f.drive({room_1_1:toMowerMicros(2/60),room_1_2:0})
  expect(f.queue.tasks).toHaveLength(1)
  expect(f.queue.tasks[0]).toMatchObject({timeMicros:toMowerMicros(-1/60),observedOrderDueMicros:toMowerMicros(2/60),plan:{}})
 })
 it.each([false,true])('consumes the check when a pre-existing order is present, failed=%s',failed=>{
  const f=fixture(),order=new MowerTask({type:T.RUN_ORDER})
  if(failed)order.executionFailure={reason:'blocked',rooms:[],snapshot:{intent:'',observations:{}}}
  f.queue.tasks=[order];f.drive();f.queue.tasks=[];f.drive()
  expect(f.requests).toEqual([]);expect(f.startup.startupRunOrderCheckPending).toBe(false)
 })
 it('keeps maintenance out of startup reads and never synthesizes a refresh',()=>{
  const f=fixture();f.seam.maintenancePaused=()=>true;f.drive()
  expect(f.requests).toEqual([]);expect(f.queue.tasks).toEqual([])
 })
 it('respects a strict personal-cap operation while failed work and disabled mastery do not block reads',()=>{
  const f=fixture(),release=new MowerTask({time:1/60,type:T.RELEASE_DORM,strictMoodLimit:true,plan:{dormitory_1:['Free']}})
  f.queue.tasks=[release];f.drive();expect(f.requests).toEqual([])
  const g=fixture();release.executionFailure={reason:'waiting',rooms:[],snapshot:{intent:'',observations:{}}}
  g.queue.tasks=[release,new MowerTask({type:T.SWAP_SUPPORT})];g.drive()
  expect(g.moods).toEqual(['room_1_1','room_1_2'])
 })
 it('preserves a failed refresh and checks independent rooms',()=>{
  const f=fixture(),refresh=new MowerTask({type:T.REFRESH_TIME,metadata:'room_1_1'})
  refresh.executionFailure={reason:'waiting for evidence',rooms:['room_1_1'],snapshot:{intent:'',observations:{}}}
  f.queue.tasks=[refresh];f.drive()
  expect(f.moods).toEqual(['room_1_2']);expect(f.queue.tasks).toEqual([refresh])
 })
 it('returns to the main page after a failed read and continues other rooms without making refresh tasks',()=>{
  const f=fixture();f.drive({room_1_1:new MowerRecognizeError('unverified countdown'),room_1_2:toMowerMicros(8/60)})
  expect(f.errors).toEqual(['room_1_1'])
  expect(f.requests).toContain('return-main:room_1_1')
  expect(f.queue.tasks).toHaveLength(1);expect(f.queue.tasks[0]?.metadata).toBe('room_1_2')
  expect(f.queue.tasks.some(task=>task.type===T.REFRESH_TIME)).toBe(false)
 })
 it('does not read the order after a strict mood failure, and propagates fatal exit',()=>{
  const f=fixture();f.seam.readMood=room=>{if(room==='room_1_1')throw new MowerRecognizeError('missing mood')};f.drive()
  expect(f.requests).not.toContain('read-order:room_1_1');expect(f.errors).toEqual(['room_1_1'])
  const g=fixture();expect(()=>g.drive({room_1_1:new MowerExitError('stop')})).toThrow('stop')
 })
})

function runtime(name='芬',returnMicros=500_000){
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 const owner=resolveOperatorCharId(name),replacement=resolveOperatorCharId('砾'),runner=resolveOperatorCharId('但书')
 ws.mainPlan.facilities.room_1_1.type='trading'
 ws.mainPlan.facilities.room_1_1.product='money'
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:owner},groupId:null,replacements:[replacement,runner]}]
 ws.mainPlan.conf.workaholic=[owner]
 const compiled=compileRosterSchedule(ws),config=compiledScheduleToRuntimeConfig(compiled)
 config.mowerTaskScheduling={...config.mowerTaskScheduling,adjustForRunOrders:false}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),reads:{room:string;occupant:string|undefined;time:number}[]=[]
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>({delayMicros:request.kind==='enter-room'?200_000:request.kind==='return-main'?returnMicros:0,observe:()=>{
  if(request.kind==='read-order')reads.push({room:request.room,occupant:s.occupants.room_1_1_0,time:toMowerMicros(s.time)})
  return {observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:toMowerMicros(8/60)}:{})}
 }})}
 const settle=()=>settleRoster(state,rates)
 const step=()=>{advanceRoster(state,nextRosterActionHours(state,rates),rates);settle()}
 const finish=()=>{for(let n=0;n<50&&(source.execution||source.phaseExecution);n++)step();expect(source.execution||source.phaseExecution).toBeUndefined()}
 return {state,source,rates,reads,owner,replacement,runner,compiled,settle,step,finish}
}

describe('formal source runtime and simulation startup wiring',()=>{
 it('observes startup before ordinary staffing and reuses the strict measured sample without refreshing its timestamp',()=>{
  const f=runtime(),task=new MowerTask({type:T.NOT_SPECIFIC,plan:{room_1_1:[f.replacement]}})
  f.source.queue.tasks=[task];f.settle()
  expect(f.state.occupants.room_1_1_0).toBe(f.owner)
  f.finish()
  expect(f.reads[0]?.occupant).toBe(f.owner)
  expect(f.state.occupants.room_1_1_0).toBe(f.replacement)
  expect(f.state.config.mowerTaskScheduling?.adjustForRunOrders).toBe(false)
  expect(f.source.queue.tasks.every(task=>task.type!==T.RUN_ORDER||Object.keys(task.plan).length===0)).toBe(true)
 })
 it('keeps the startup sample age through ordinary initialization',()=>{
  const f=runtime();f.settle();f.finish()
  expect(f.source.initial).toBe(false)
  expect(f.source.data.operators[f.owner]!.timeStampMicros).toBe(200_000)
  expect(f.source.data.operators[f.owner]!.moodIsPrediction).toBe(false)
  expect(f.reads).toHaveLength(1)
 })
 it.each([{name:'芬',delay:toMowerMicros(1),expected:200_000},{name:'歌蕾蒂娅',delay:toMowerMicros(1),expected:toMowerMicros(1)+200_000},{name:'芬',delay:toMowerMicros(3),expected:toMowerMicros(3)+200_000}])('re-reads stale startup mood with the native refresh window for $name',({name,delay,expected})=>{
  const f=runtime(name,delay);f.settle()
  for(let n=0;n<5&&f.source.initial;n++)f.step()
  expect(f.source.initial).toBe(false)
  expect(f.source.data.operators[f.owner]!.timeStampMicros).toBe(expected)
 })
 it('re-reads when a cached startup signature has changed during the room-return boundary',()=>{
  const f=runtime();f.settle();f.step()
  expect(f.source.data.operators[f.owner]!.timeStampMicros).toBe(200_000)
  f.source.data.operators[f.owner]!.currentIndex=1
  f.step()
  expect(f.source.initial).toBe(false)
  expect(f.source.data.operators[f.owner]!.timeStampMicros).toBe(700_000)
 })
 it.each(['prediction','new-sample','future-sample'])('rejects %s startup evidence before skipping the initial read',change=>{
  const f=runtime();f.settle();f.step()
  const op=f.source.data.operators[f.owner]!
  if(change==='prediction')op.moodIsPrediction=true
  else op.timeStampMicros=change==='new-sample'?300_000:900_000
  f.step()
  expect(op.timeStampMicros).toBe(700_000);expect(op.moodIsPrediction).toBe(false)
 })
 it('leaves decision-only replay free of startup order observations',()=>{
  const f=runtime();delete f.rates.mowerRunOrderIO;f.settle();f.finish()
  expect(f.reads).toEqual([])
  expect(f.source.queue.tasks.some(task=>task.type===T.RUN_ORDER)).toBe(false)
  expect(f.state.diagnostics.some(d=>d.code==='mower-run-order-io-unavailable')).toBe(true)
 })
 it.each(['mower-default','mower-alpha'] as const)('runs the complete production simulation under the unchanged %s ideal-order model',schedulingModel=>{
  const f=runtime(),report=simulateSchedule(f.compiled,{sampleHours:.05,schedulingModel,production:{seed:93,runOrderMode:'ideal',droneTarget:'none'}})
  writeFileSync(testEvidenceFile('f19a-startup-'+schedulingModel+'-simulation.json'),JSON.stringify(report,null,2))
  expect(report.success,JSON.stringify(report.diagnostics.slice(-5))).toBe(true)
  expect(report.elapsedHours).toBeCloseTo(.05,8)
  expect(report.production?.assumptions.runOrderMode).toBe('ideal')
  expect(report.production?.events.some(event=>event.type==='native-trade-drone')).toBe(false)
  expect(report.operators.find(op=>op.operatorId===f.runner)?.workHours??0).toBe(0)
  expect(report.diagnostics.some(d=>['SIMULATION_EVENT_LIMIT','SIMULATION_SAME_TIME_ACTION','MOWER_PENDING_TASK_FAILURE'].includes(d.code))).toBe(false)
 })
})
