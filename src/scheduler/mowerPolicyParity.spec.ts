import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {createBackupPlanController} from './backupPlans'
import {importMowerJson,exportMowerJson,resolveOperatorCharId as id} from '../workbench/compat/mowerJson'

describe('native PlanConfig list policies reach the active scheduler',()=>{
 it('unions all eleven native backup lists and restores their original values on exit',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.conf.resting_standby=['芬']
  ws.mainPlan.conf.resting_priority_replacement=['香草']
  ws.mainPlan.conf.free_room_exclusions=['克洛丝']
  ws.compatibility.backupPlans=[{trigger:"op_data.operators['阿米娅'].current_mood()<10",conf:{
   resting_standby:'芬,米格鲁',resting_priority_replacement:'香草,安赛尔',free_room_exclusions:'克洛丝,芙蓉'
  }}]
  const base=compileRosterSchedule(ws),state=createRosterRuntime(compiledScheduleToRuntimeConfig(base)),controller=createBackupPlanController(base,state)
  state.morale[id('阿米娅')]=1
  controller.evaluate('END')
  expect(controller.schedule.policies.resting_standby).toEqual(['芬','米格鲁'].map(id))
  expect(controller.schedule.policies.resting_priority_replacement).toEqual(['香草','安赛尔'].map(id))
  expect(controller.schedule.policies.free_room_exclusions).toEqual(['克洛丝','芙蓉'].map(id))
  state.morale[id('阿米娅')]=24
  controller.evaluate('END')
  expect(controller.schedule.policies.resting_standby).toEqual([id('芬')])
  expect(controller.schedule.policies.resting_priority_replacement).toEqual([id('香草')])
  expect(controller.schedule.policies.free_room_exclusions).toEqual([id('克洛丝')])
  expect(controller.schedule.diagnostics.filter(d=>d.code==='UNKNOWN_POLICY')).toEqual([])
 })
 it.each([
  {group:'g',policy:'',priority:'standby'},
  {group:'',policy:'',priority:'high'},
  {group:'g',policy:'exhaust_require',priority:'high'},
  {group:'g',policy:'rest_in_full',priority:'high'},
  {group:'g',policy:'workaholic',priority:'high'},
 ])('applies native standby qualification for group=$group policy=$policy',({group,policy,priority})=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:group||null,replacements:['香草']}]
  ws.mainPlan.conf.resting_standby=['芬']
  if(policy)ws.mainPlan.conf[policy]=['芬']
  const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws)))
  const op=getMowerSourceRuntime(state).data.operators[id('芬')]!
  expect(op.restingPriority).toBe(priority)
 })
 it('never enables standby for a low type or a workshop primary in default alpha',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.factory.slots=[{occupant:{kind:'operator',operatorId:'九色鹿'},groupId:'g',replacements:['芬']}]
  ws.mainPlan.conf.resting_standby=['九色鹿','芬']
  const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),data=getMowerSourceRuntime(state).data
  expect(data.operators[id('九色鹿')]!.restingPriority).toBe('high')
  expect(data.operators[id('芬')]!.restingPriority).toBe('low')
 })
})


it('keeps the full 0..24 native mood range after importing balanced ling_xi=0',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.central.slots=[{occupant:{kind:'operator',operatorId:'令'},groupId:null,replacements:[]}]
 const raw=JSON.parse(exportMowerJson(ws));raw.conf.ling_xi=0
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(importMowerJson(JSON.stringify(raw)))))
 const op=getMowerSourceRuntime(state).data.operators[id('令')]!
 expect(op.lowerLimit).toBe(0);expect(op.upperLimit).toBe(24)
})
