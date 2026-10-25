import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from './scheduleAdapter'
import { createRosterRuntime } from './rosterRuntime'
import { createBackupPlanController, evaluateBackupExpression } from './backupPlans'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { simulateSchedule } from '../simulator/scheduleSimulation'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { createProductionTimeline } from '../simulator/productionTimeline'
import { runRosterIncomeSearch } from '../optimizer/rosterIncomeSearch'

function setup(trigger: unknown, overrides: Record<string, unknown> = {}) {
  const workspace = createDefaultWorkspace()
  workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: id('砾') }, groupId: null, replacements: [id('芬')] }]
  workspace.compatibility.backupPlans = [{ name: '源码兼容', trigger, plan: {}, conf: {}, ...overrides }]
  const schedule = compileRosterSchedule(workspace)
  const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  return { workspace, schedule, state }
}

describe('local Mower expression and backup contracts', () => {
  it.each([
    [{left:"op_data.operators['砾'].current_mood()",operator:'>4',right:''}, true],
    [{left:'',operator:'',right:''}, false],
    [{left:"not op_data.operators['砾'].is_resting()",operator:'',right:''}, true],
    [{left:"op_data.operators['砾'].current_room",operator:'==',right:"'room_1_1'"}, true],
    [{left:'4',operator:'<',right:"op_data.operators['砾'].current_mood() < 25"}, true],
    [{left:'2 + 3 * 4',operator:'==',right:'14'}, true],
    [{left:'False and (1 / 0)',operator:'or',right:'True'}, true],
    [{left:'False',operator:'==',right:'(not True)'}, true],
  ])('evaluates serialized Mower expression %j', (trigger, expected) => {
    const {state} = setup(trigger)
    expect(evaluateBackupExpression(trigger, state)).toBe(expected)
  })
  it('recognizes recycle as a working room and an unquoted room operand', () => {
    const {workspace} = setup('False')
    workspace.mainPlan.facilities.recycle.level = 1
    workspace.mainPlan.facilities.recycle.slots = workspace.mainPlan.facilities.room_1_1.slots
    workspace.mainPlan.facilities.room_1_1.slots = []
    const state = createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace)))
    expect(evaluateBackupExpression("op_data.operators['砾'].is_working()", state)).toBe(true)
    expect(evaluateBackupExpression("op_data.operators['砾'].current_room == recycle", state)).toBe(true)
    expect(evaluateBackupExpression("op_data.operators['砾'].is_resting()", state)).toBe(false)
  })
  it('evaluates native party_time as None until a real timestamp is observed', () => {
    const {state} = setup('op_data.party_time')
    expect(evaluateBackupExpression('op_data.party_time', state)).toBe(null)
    expect(evaluateBackupExpression('op_data.party_time is not None', state)).toBe(false)
    expect(evaluateBackupExpression('op_data.party_time is None', state)).toBe(true)
    expect(evaluateBackupExpression('op_data.party_time == True', state)).toBe(false)
  })
  it('does not treat unknown production conditions or executable text as ignorable', () => {
    for(const expression of ["op_data.operators['砾'].unknown()",'globalThis.process.exit()',"__import__('os').system('echo unsafe')"]){
      const {schedule,state}=setup(expression)
      expect(()=>createBackupPlanController(schedule,state)).toThrow()
    }
  })
  it('does not mistake a quoted external name for an external condition', () => {
    const {state}=setup('False')
    expect(evaluateBackupExpression("'op_data.party_time' == 'op_data.party_time'",state)).toBe(true)
  })
  it('rejects deep or oversized expressions without executing imported code', () => {
    const {state}=setup('False')
    expect(evaluateBackupExpression('('.repeat(200)+'True'+')'.repeat(200),state)).toBe(true)
    expect(()=>evaluateBackupExpression('('.repeat(201)+'True'+')'.repeat(201),state)).toThrow(/限制/)
    expect(()=>evaluateBackupExpression('True '.repeat(5000),state)).toThrow(/限制/)
    expect(()=>evaluateBackupExpression('1 / 0',state)).toThrow(/除零/)
  })
  it('keeps a party-dependent backup inactive when no party timestamp has been read', () => {
    const {schedule}=setup({left:'op_data.party_time',operator:'==',right:'True'})
    const report=simulateSchedule(schedule,{sampleHours:.1})
    expect(report.success).toBe(true)
    expect(report.events.filter(e=>e.type==='backup-plan'&&e.active)).toEqual([])
    expect(report.diagnostics.some(d=>d.code==='BACKUP_EXTERNAL_CONDITION_SKIPPED')).toBe(false)
  })
  it('blocks legacy natural run-order requests through both engine and bridge', () => {
    const {workspace,schedule,state}=setup('False')
    const options=JSON.parse('{"sampleHours":1,"production":{"runOrderMode":"natural"}}')
    expect(()=>simulateSchedule(schedule,options)).toThrow(/自然跑单.*禁用/)
    const result=runScheduleSimulationBridge(workspace,options)
    expect(result.report).toBeNull()
    expect(result.error).toMatch(/自然跑单.*禁用/)
    expect(()=>createProductionTimeline(schedule,state,options.production,0,()=>{})).toThrow(/自然跑单.*禁用/)
    expect(()=>runRosterIncomeSearch({baseline:workspace,inventory:[],options})).toThrow(/自然跑单.*禁用/)
  })
})

describe('alpha major maintenance condition', () => {
  it('uses an infinite remaining interval when no maintenance time was supplied', () => {
    const {schedule, state} = setup('op_data.major_maintenance_remaining_hours() <= 0.5')
    expect(evaluateBackupExpression('op_data.major_maintenance_remaining_hours()', state)).toBe(Infinity)
    const controller = createBackupPlanController(schedule, state)
    controller.evaluate('END')
    expect(controller.active).toEqual([false])
    expect(controller.diagnostics).toContainEqual({code: 'MOWER_MAINTENANCE_ASSUMPTION', message: '未提供维护时间，本次模拟没有停服窗口'})
  })

  it('evaluates nested conditions with an explicit remaining interval and ends the window once maintenance starts', () => {
    const {workspace} = setup({left: {left: 'op_data.major_maintenance_remaining_hours()', operator: '<=', right: '0.5'}, operator: 'and', right: "op_data.operators['砾'].is_working()"})
    const schedule = compileRosterSchedule(workspace, {majorMaintenanceStartHours: 1})
    const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const controller = createBackupPlanController(schedule, state)
    state.time = .49
    controller.evaluate('END')
    expect(controller.active).toEqual([false])
    state.time = .5
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    state.time = 2
    expect(evaluateBackupExpression('op_data.major_maintenance_remaining_hours()', state)).toBe(Infinity)
  })

  it('wakes an alpha bridge at the maintenance threshold within its one-second observation cadence', () => {
    const {workspace} = setup('op_data.major_maintenance_remaining_hours() <= 0.003', {conf: {workaholic: '砾'}})
    const result = runScheduleSimulationBridge(workspace, {sampleHours: .007}, {majorMaintenanceStartHours: .005, idleOperators: []})
    expect(result.error).toBeUndefined()
    expect(result.report?.success).toBe(true)
    const activation = result.report?.events.find(event => event.type === 'backup-plan' && event.active)
    expect(activation).toBeDefined()
    expect(activation!.time).toBeGreaterThanOrEqual(.002)
    expect(activation!.time).toBeLessThanOrEqual(.002 + 1.01 / 3600)
    const exit = result.report?.events.find(event => event.type === 'backup-plan' && !event.active)
    expect(exit?.time).toBeGreaterThanOrEqual(.005)
    expect(exit?.time).toBeLessThanOrEqual(.005 + 1.01 / 3600)
  })
})
