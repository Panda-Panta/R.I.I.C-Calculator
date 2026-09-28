import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-global-dorm-order-alpha.json'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {createBackupPlanController} from './backupPlans'
function workspace(){
 const ws=createDefaultWorkspace()
 for(const [room,names] of [['dormitory_1',['杜林','闪灵']],['dormitory_2',['流明','车尔尼']]] as const){
  ws.mainPlan.facilities[room].slots=[...names.map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]})),...Array.from({length:3},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]}))]
 }
 return ws
}
describe('native global dorm_order',()=>{
 it.each(native.cases)('matches the real init branch for $name',test=>{
  const schedule=compileRosterSchedule(workspace(),{dormOrder:test.order})
  if(test.error){
   expect(schedule.diagnostics).toContainEqual(expect.objectContaining({code:'INVALID_ASSUMPTION',severity:'error',path:'assumptions.dormOrder',message:test.error}))
  }else{
   expect(schedule.diagnostics.filter(d=>d.severity==='error')).toEqual([])
   const state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
   expect(getMowerSourceRuntime(state).data.dorms.map(d=>d.position[0]+'_'+d.position[1])).toEqual(test.output)
  }
 })
 it('retains the initialized recovery pool order when backup init uses update=True',()=>{
  const ws=workspace();ws.compatibility.backupPlans=[{trigger:'True',conf:{workaholic:'芬'}}]
  const order=native.cases.find(t=>t.name==='reversed')!.order
  const schedule=compileRosterSchedule(ws,{dormOrder:order}),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  const before=getMowerSourceRuntime(state).data.dorms
  createBackupPlanController(schedule,state).evaluate('END')
  expect(getMowerSourceRuntime(state).data.dorms).toBe(before)
  expect(before.map(d=>d.position[0]+'_'+d.position[1])).toEqual(native.cases.find(t=>t.name==='reversed')!.output)
 })
})
