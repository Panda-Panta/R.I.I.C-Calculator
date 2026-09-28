import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-global-rest-policy-alpha.json'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {planMowerMetadata} from './mowerMetadata'
import {MowerTaskQueue,toMowerMicros} from './mowerTaskQueue'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'

describe('native global rest settings reach runtime metadata',()=>{
 it.each(native.cases)('matches actual alpha decisions for $id',test=>{
  const ws=createDefaultWorkspace(),input=test.input,names:Record<string,string>={H:id('芬'),J:id('米格鲁'),L:id('香草')}
  for(const facility of Object.values(ws.mainPlan.facilities))facility.slots=[]
  ws.mainPlan.facilities.room_1_1.slots=input.plan.room_1_1.map(slot=>({occupant:{kind:'operator',operatorId:names[slot.agent]!},groupId:slot.group||null,replacements:['香草']}))
  ws.mainPlan.facilities.dormitory_1.slots=[...['杜林','闪灵'].map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]})),...Array.from({length:3},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]}))]
  const globals=input.globalConfig
  const assumptions=Object.assign({},{
   freeRoom:input.config.free_room,
   groupRestInFullOnMoodGap:globals.group_rest_in_full_on_mood_gap,
   groupMoodGapMaxExtraWaitHours:globals.group_mood_gap_max_extra_wait_hours,
   mergeIntervalMinutes:globals.merge_interval,
  })
  const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws,assumptions))),data=getMowerSourceRuntime(state).data
  data.powerPlantCount=input.powerPlantCount
  for(const source of input.operators){
   const op=data.operators[names[source.name]!]!
   op.currentRoom=source.current_room;op.currentIndex=source.current_index
   op.mood=source.mood;op.timeStampMicros=0;op.depletionRate=source.depletion_rate
  }
  for(const source of input.dorm){const bed=data.dorms.find(b=>b.position[1]===source.position[1])!;bed.name=names[source.name]!;bed.timeMicros=toMowerMicros(source.completedAtHours)}
  const queue=new MowerTaskQueue()
  planMowerMetadata(data,queue)
  expect(queue.tasks.map(task=>({type:task.type.key,timeMicros:task.timeMicros}))).toEqual(test.output.map(task=>({type:task.type,timeMicros:task.timeMicros})))
 })
 it.each([-1,25,Infinity,NaN])('rejects a max extra wait outside the native 0..24 range: %s',value=>{
  const schedule=compileRosterSchedule(createDefaultWorkspace(),Object.assign({},{groupMoodGapMaxExtraWaitHours:value}))
  expect(schedule.diagnostics).toContainEqual(expect.objectContaining({code:'INVALID_ASSUMPTION',path:'assumptions.groupMoodGapMaxExtraWaitHours'}))
 })
})
