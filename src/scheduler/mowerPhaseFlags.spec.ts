import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
const rates={workRate:()=>1,recoveryRate:()=>2}
function scenario(){
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:[]}]
 ws.mainPlan.conf.workaholic=['芬']
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(state)
 const task=new MowerTask();task.timeMicros=-1;source.queue.tasks=[task]
 return{state,source,task}
}
describe('default infra_main phase flags follow native execution',()=>{
 it('skips all phases at the actual one-minute pending-task gate after consuming the selected task',()=>{
  const {state,source,task}=scenario(),next=new MowerTask({time:50/3600})
  source.queue.tasks.push(next)
  settleMowerSource(state,rates)
  expect(source.queue.tasks).not.toContain(task)
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
  expect(source.runReturn).toBeUndefined()
 })
 it('latches planned and todo before notification sleep, then completes notification after waking',()=>{
  const {state,source}=scenario()
  settleMowerSource(state,rates)
  expect(source.runReturn).toEqual({wakeMicros:1_000_000,finishFallback:true})
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:false})
  state.time=1/3600
  settleMowerSource(state,rates)
  expect(source.runReturn).toBeUndefined()
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
 })
 it('RE_ORDER invokes native skip after the final room-return continuation',()=>{
  const {state,source}=scenario(),reorder=new MowerTask({type:T.RE_ORDER,plan:{room_1_1:['Current']}})
  reorder.timeMicros=-1
  source.queue.tasks=[reorder,new MowerTask({time:5})]
  settleMowerSource(state,rates)
  expect(source.execution).toBeDefined()
  state.time=source.execution!.wakeMicros/3_600_000_000
  settleMowerSource(state,rates)
  expect(source.execution).toBeUndefined()
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
  expect(source.runReturn).toBeUndefined()
 })
})
