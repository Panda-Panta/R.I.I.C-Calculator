import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-task-scheduling-alpha.json'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {scheduleMowerTasks,type MowerTaskSchedulingOptions} from './mowerTaskScheduling'
function lists<T>(source:Record<string,unknown>,isValue:(value:unknown)=>value is T):Record<string,T[]> {
 return Object.fromEntries(Object.entries(source).map(([key,value])=>{
  if(!Array.isArray(value)||!value.every(isValue))throw new Error('Invalid native fixture list: '+key)
  return [key,value.filter(isValue)]
 }))
}
describe('actual full alpha task queue scheduling',()=>{
 it.each(native.cases.filter(test=>test.input.grandet!==false))('matches $name',test=>{
  const input=test.input
  const tasks=input.tasks.map(task=>new MowerTask({time:task.seconds/3600,type:T[task.type as keyof typeof T],plan:lists(task.plan,(value):value is string=>typeof value==='string'),metadata:task.metadata,adjusted:task.adjusted,strictMoodLimit:task.strict}))
  const original=[...tasks]
  const options:MowerTaskSchedulingOptions={...input,maintenance:input.maintenance?input.maintenance.map(time=>time*1_000_000) as [number,number]:undefined,dormDurations:lists(input.dormDurations,(value):value is number=>typeof value==='number')}
  const conflict=scheduleMowerTasks(tasks,input.nowMicros,options)
  expect({tasks:tasks.map(task=>({originalIndex:original.indexOf(task),timeMicros:task.timeMicros,type:task.type.key,metadata:task.metadata,adjusted:task.adjusted,plan:task.plan})),conflict:conflict?conflict.map(task=>original.indexOf(task)):null}).toEqual(test.output)
 })
})

import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
it('uses native scheduling before selecting the next task in the source run loop',()=>{
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 for(const [room,operatorId] of [['room_1_1','芬'],['room_1_2','米格鲁'],['room_1_3','香草']] as const)ws.mainPlan.facilities[room].slots=[{occupant:{kind:'operator',operatorId},groupId:null,replacements:[]}]
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(state)
 source.initial=false
 const down=new MowerTask({time:-1/3_600_000_000,type:T.SHIFT_OFF,plan:{room_1_1:['Current'],room_1_2:['Current'],room_1_3:['Current']}})
 const order=new MowerTask({time:100/3600,type:T.RUN_ORDER,metadata:'room_1_1'})
 source.queue.tasks=[down,order]
 settleMowerSource(state,{workRate:()=>1,recoveryRate:()=>2})
 expect(source.execution).toBeUndefined()
 expect(source.queue.tasks[0]).toBe(order)
 expect(down.timeMicros).toBe(101_000_000)
 expect(nextMowerSourceActionHours(state)).toBe(100/3600)
})
