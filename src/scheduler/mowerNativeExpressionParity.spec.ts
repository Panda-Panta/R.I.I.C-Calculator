import {describe,it,expect} from 'vitest'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {createBackupPlanController,evaluateBackupExpression} from './backupPlans'
describe('native Python backup predicate semantics',()=>{
 it('initializes party_time to None rather than inventing an active party',()=>{
  const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(createDefaultWorkspace())))
  expect(evaluateBackupExpression('op_data.party_time',state)).toBe(null)
  expect(evaluateBackupExpression('op_data.party_time is None',state)).toBe(true)
  expect(evaluateBackupExpression('op_data.party_time is not None',state)).toBe(false)
  expect(evaluateBackupExpression('op_data.party_time == True',state)).toBe(false)
 })
 it('evaluates native party predicates but clears restored time on application configuration rebuild',()=>{
  const ws=createDefaultWorkspace()
  ws.compatibility.backupPlans=[{trigger:'op_data.party_time is not None',conf:{workaholic:'芬'}}]
  const schedule=compileRosterSchedule(ws),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,state)
  controller.evaluate('END');expect(controller.active).toEqual([false])
  const data=getMowerSourceRuntime(state).data
  data.partyTime={timeMicros:1000000}
  expect(evaluateBackupExpression('op_data.party_time is not None',state)).toBe(true)
  expect(evaluateBackupExpression('op_data.party_time == True',state)).toBe(false)
  controller.evaluate('END');expect(controller.active).toEqual([true])
  expect(getMowerSourceRuntime(state).data.partyTime??null).toBe(null)
  expect(evaluateBackupExpression('op_data.party_time is not None',state)).toBe(false)
  controller.evaluate('END');expect(controller.active).toEqual([false])
 })
 it.each([['True == 1',true],['False == 0',true],['True != 1',false],['True + 1 == 2',true],['True is 1',false]] as const)('preserves Python bool / number behavior for %s',(expression,expected)=>{
  const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(createDefaultWorkspace())))
  expect(evaluateBackupExpression(expression,state)).toBe(expected)
 })
})


it('evaluates cached mood at the current scheduler clock even when the data snapshot is older',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:['香草']}]
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws)))
 const data=getMowerSourceRuntime(state).data,op=data.operators[id('芬')]!
 op.mood=20;op.timeStampMicros=0;op.depletionRate=1
 data.nowMicros=0;state.time=1
 expect(evaluateBackupExpression("op_data.operators['芬'].current_mood() == 19",state)).toBe(true)
})
