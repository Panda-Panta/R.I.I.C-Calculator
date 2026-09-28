import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {MowerTask} from './mowerTaskQueue'
describe('native skip flags after blocked correction',()=>{
 it('retains an 80-second task without entering notification sleep when two rooms require 90 seconds',()=>{
  const ws=createDefaultWorkspace()
  for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
  for(const [room,primary,cover] of [['room_1_1','芬','香草'],['room_1_2','米格鲁','克洛丝']] as const){
   ws.mainPlan.facilities[room!].slots=[{occupant:{kind:'operator',operatorId:primary!},groupId:null,replacements:[cover!]}]
  }
  const s=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws)))
  s.occupants={room_1_1_0:id('香草'),room_1_2_0:id('克洛丝')}
  const source=getMowerSourceRuntime(s)
  for(const op of Object.values(source.data.operators)){
   op.mood=24;op.timeStampMicros=0;op.depletionRate=0
   const physical=Object.entries(s.occupants).find(([,name])=>name===op.name)
   op.currentRoom=physical?physical[0].slice(0,physical[0].lastIndexOf('_')):'';op.currentIndex=physical?0:-1
  }
  source.initial=false;source.firstInit=false
  const next=new MowerTask({time:80/3600});source.queue.tasks=[next]
  settleMowerSource(s,{workRate:()=>1,recoveryRate:()=>2})
  expect(source.queue.tasks).toEqual([next])
  expect(source.runReturn).toBeUndefined()
  expect(nextMowerSourceActionHours(s)).toBe(80/3600)
 })
})
