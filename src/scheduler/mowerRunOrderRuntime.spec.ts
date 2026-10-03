import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,advanceRoster,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'

function scenario(){
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:['但书']}]
 ws.mainPlan.conf.workaholic=['芬']
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(state)
 source.queue.tasks=[new MowerTask({time:-1/3600})]
 const observations:{kind:string;timeMicros:number}[]=[],phases:string[]=[]
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>({
  delayMicros:request.kind==='enter-room'?200_000:request.kind==='read-order'?300_000:request.kind==='return-main'?500_000:0,
  observe:()=>{observations.push({kind:request.kind,timeMicros:toMowerMicros(s.time)});return {observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:900_123_456}:{})}}
 })}
 const settle=()=>settleMowerSource(state,rates,phase=>{phases.push(phase);return false})
 function finishIO(){
  for(let limit=20;source.execution||source.phaseExecution;limit--){
   if(limit<=0)throw new Error('I/O failed to terminate')
   advanceRoster(state,nextMowerSourceActionHours(state),rates);settle()
  }
 }
 return {state,source,observations,phases,settle,finishIO}
}
describe('ideal order wakes in source runtime',()=>{
 it('keeps observed deadlines and the shared morale clock across I/O wakes',()=>{
  const {state,source,observations,phases,settle,finishIO}=scenario()
  settle();finishIO()
  const task=source.queue.find({type:T.RUN_ORDER,metadata:'room_1_1'})!
  expect(task.timeMicros).toBe(720_123_456)
  expect(task.observedOrderDueMicros).toBe(900_123_456)
  expect(toMowerMicros(state.time)).toBe(1_000_000)
  expect(state.morale.char_123_fang).toBeCloseTo(24-1/3600,10)
  expect(observations).toEqual([{kind:'enter-room',timeMicros:200_000},{kind:'wait-interface',timeMicros:200_000},{kind:'read-order',timeMicros:500_000},{kind:'return-main',timeMicros:1_000_000}])
  expect(phases.filter(p=>p==='BEGINNING')).toHaveLength(1)
 })
 it('refreshes a deadline and consumes the original refresh task identity',()=>{
  const {source,settle,finishIO}=scenario()
  const selected=new MowerTask({type:T.REFRESH_TIME,metadata:'room_1_1',time:-1/3600})
  source.queue.tasks=[selected];settle();finishIO()
  expect(source.queue.tasks).not.toContain(selected)
  expect(source.queue.tasks.filter(t=>t.type===T.RUN_ORDER)).toHaveLength(1)
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
