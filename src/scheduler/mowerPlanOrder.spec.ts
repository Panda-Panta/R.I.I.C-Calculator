import {describe,it,expect} from 'vitest'
import source from './fixtures/mower-plan-field-order-alpha.json'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {createBackupPlanController} from './backupPlans'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
describe('native Pydantic plan order reaches operator/group registration',()=>{
 it('compiles facilities in Plan1 model field order regardless of local UI insertion order',()=>{
  const ws=createDefaultWorkspace()
  const forward=compileRosterSchedule(ws)
  ws.mainPlan.facilities=Object.fromEntries(Object.entries(ws.mainPlan.facilities).reverse()) as typeof ws.mainPlan.facilities
  expect(compileRosterSchedule(ws).rooms.map(room=>room.roomId)).toEqual(source.actualModels.Plan1)
  expect(forward.rooms.map(room=>room.roomId)).toEqual(source.actualModels.Plan1)
 })
 it('registers the central members before production members and retains the same order after a backup init',()=>{
  const ws=createDefaultWorkspace()
  for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
  ws.mainPlan.facilities.central.slots=['焰尾','薇薇安娜'].map(operatorId=>({occupant:{kind:'operator',operatorId},groupId:'红松',replacements:['香草']}))
  ws.mainPlan.facilities.room_3_1.slots=['灰烬','野鬃','远牙'].map(operatorId=>({occupant:{kind:'operator',operatorId},groupId:'红松',replacements:['芬']}))
  for(const [roomId,keepers] of [['dormitory_1',['杜林','闪灵']],['dormitory_2',['流明','车尔尼']]] as const){
   ws.mainPlan.facilities[roomId].slots=[
    ...keepers.map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:'',replacements:[]})),
    ...[2,3,4].map(()=>({occupant:{kind:'free' as const},groupId:'',replacements:[]})),
   ]
  }
  ws.compatibility.backupPlans=[{trigger:'True',conf:{resting_priority:'远牙'}}]
  const schedule=compileRosterSchedule(ws),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  const expected=['焰尾','薇薇安娜','灰烬','野鬃','远牙'].map(id)
  expect(getMowerSourceRuntime(state).data.group('红松')).toEqual(expected)
  const rawConfig=compiledScheduleToRuntimeConfig(schedule)
  rawConfig.mowerSourcePlan=Object.fromEntries(Object.entries(rawConfig.mowerSourcePlan!).reverse())
  expect(getMowerSourceRuntime(createRosterRuntime(rawConfig)).data.group('红松')).toEqual(expected)
  createBackupPlanController(schedule,state).evaluate('END')
  expect(getMowerSourceRuntime(state).data.group('红松')).toEqual(expected)
 })
})
