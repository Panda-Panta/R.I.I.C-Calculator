import {describe, expect, it} from 'vitest'
import {importMowerJson, exportMowerJson} from '../workbench/compat/mowerJson'
import {validateRosterWorkspace} from '../workbench/validate'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {compileBackupExpression} from './backupExpression'
import {createBackupPlanController} from './backupPlans'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {projectMowerArrangements} from './mowerObservations'
import {resolveOperatorCharId as id} from '../domain/operatorIdentifiers'
import type {SimulationAssumptions} from './types'

const column = (agent: string, replacement: string[] = []) => ({agent, group: '', replacement})
function fixture(plans = [column('桃金娘', ['安赛尔']), column('褐果', ['芙蓉'])]) {
  return {default: 'plan1', plan1: {
    room_1_3: {name: '发电站', plans: [column('阿米娅', ['芬'])]},
    dormitory_1: {name: '', plans: [column('杜林'), ...Array.from({length: 4}, () => column('Free'))]},
  }, backup_plans: [{name: 'temporary training staff', trigger: 'True', plan: {train: {name: '', plans}}, conf: {}}]}
}
function runtime(raw: object, options: Partial<SimulationAssumptions> = {}) {
  const workspace = importMowerJson(JSON.stringify(raw)), base = compileRosterSchedule(workspace, options)
  const config = compiledScheduleToRuntimeConfig(base); config.mowerAlpha = true
  const state = createRosterRuntime(config), controller = createBackupPlanController(base, state)
  return {workspace, base, state, controller}
}

describe('Mower backup-only right-side rooms', () => {
  it('validates omitted training slots without changing the imported main or round trip', () => {
    const raw = {...fixture(), future: {root: ['keep']}}
    Object.assign(raw.plan1.dormitory_1, {futureRoom: {keep: true}})
    Object.assign(raw.backup_plans[0]!, {futureBackup: ['keep']})
    const original=structuredClone(raw),workspace = importMowerJson(JSON.stringify(raw)), before = structuredClone(workspace)
    expect(workspace.mainPlan.facilities.train).toMatchObject({level: 3, slots: []})
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
    expect(workspace).toEqual(before)
    const canonicalTrigger={left:'True',operator:'',right:''}
    const expected={...raw,backup_plans:[{...raw.backup_plans[0]!,trigger:canonicalTrigger}]}
    const output=JSON.parse(exportMowerJson(workspace))
    expect(output).toEqual(expected)
    expect(workspace.compatibility.backupPlans).toEqual(raw.backup_plans)
    const state=createRosterRuntime({positions:[],beds:[]})
    expect(compileBackupExpression(raw.backup_plans[0]!.trigger,new Set()).evaluate(state)).toBe(true)
    expect(compileBackupExpression(output.backup_plans[0].trigger,new Set()).evaluate(state)).toBe(true)
    const native={...expected,backup_plans:[{...expected.backup_plans[0]!,trigger:{...canonicalTrigger,future:{ast:['untouched']}}}]}
    const importedNative=importMowerJson(JSON.stringify(native))
    expect(importedNative.compatibility.backupPlans).toEqual(native.backup_plans)
    expect(JSON.parse(exportMowerJson(importedNative))).toEqual(native)
    const canonicalRoundtrip=JSON.parse(exportMowerJson(importMowerJson(JSON.stringify(output))))
    expect(canonicalRoundtrip).toEqual(output)
    expect(workspace).toEqual(before)
    expect(raw).toEqual(original)
  })

  it('compiles and previews both introduced training positions, then restores the omitted main', () => {
    const {workspace, state, controller} = runtime(fixture()), original = structuredClone(workspace)
    const model = state.mowerShiftModel!, previous = getMowerSourceRuntime(state).data
    const next = model.swap(previous, [true])
    const transition = model.transition(previous, next, [false], [true])
    expect(transition.train).toEqual([id('桃金娘'), id('褐果')])
    expect(projectMowerArrangements(next, [transition]).currentRoom('train')).toEqual([id('桃金娘'), id('褐果')])
    model.activate([true])
    expect(state.config.positions.filter(position => position.roomId === 'train').map(position => position.primary)).toEqual([id('桃金娘'), id('褐果')])
    expect(controller.schedule.rooms.find(room => room.roomId === 'train')?.level).toBe(3)
    model.activate([false])
    expect(controller.schedule.rooms.find(room => room.roomId === 'train')).toMatchObject({level: 3, slots: []})
    expect(state.config.positions.some(position => position.roomId === 'train')).toBe(false)
    expect(workspace).toEqual(original)
  })

  it('executes an explicit task in the training positions introduced by the same backup', () => {
    const raw = fixture()
    Object.assign(raw.backup_plans[0]!, {task: {train: ['桃金娘', '褐果']}})
    const {workspace, state} = runtime(raw)
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
    const model = state.mowerShiftModel!, previous = getMowerSourceRuntime(state).data
    const next = model.swap(previous, [true])
    const transition = model.transition(previous, next, [false], [true])
    expect(transition.train).toEqual([id('桃金娘'), id('褐果')])
    expect(projectMowerArrangements(next, [transition]).currentRoom('train')).toEqual([id('桃金娘'), id('褐果')])
    expect(() => model.activate([true])).not.toThrow()
    const result = runScheduleSimulationBridge(workspace, {sampleHours: .01, recordSegments: true, maxEvents: 200}, {idleOperators: []})
    expect(result.report?.success, result.error ?? JSON.stringify(result.report?.diagnostics)).toBe(true)
    expect(result.report?.segments.some(segment => segment.occupants.train_0 === id('桃金娘') && segment.occupants.train_1 === id('褐果'))).toBe(true)
  })

  it('requires an active room-providing backup before accepting a separate right-side task', () => {
    const taskOnly = {name: 'temporary task', trigger: 'True', plan: {}, task: {train: ['安赛尔', '芙蓉']}, conf: {}}
    const raw = {...fixture(), backup_plans: [taskOnly]}
    const isolated = runtime(raw)
    expect(validateRosterWorkspace(isolated.workspace).criticalErrors.some(issue => issue.message.includes('任务缺少有效排班岗位'))).toBe(true)
    const transition = (state: ReturnType<typeof runtime>['state'], conditions: boolean[]) => {
      const model = state.mowerShiftModel!, previous = getMowerSourceRuntime(state).data
      return model.transition(previous, model.swap(previous, conditions), previous.planConditions, conditions)
    }
    expect(() => transition(isolated.state, [true])).toThrow('任务缺少有效排班岗位')
    const combined = runtime({...fixture(), backup_plans: [fixture().backup_plans[0]!, taskOnly]})
    expect(validateRosterWorkspace(combined.workspace).criticalErrors).toEqual([])
    expect(() => transition(combined.state, [false, true])).toThrow('任务缺少有效排班岗位')
    expect(() => transition(combined.state, [true, true])).not.toThrow()
  })

  it('does not replay or revalidate an executed task when its room-providing backup exits', () => {
    const taskOnly = {name: 'temporary task', trigger: 'True', plan: {}, task: {train: ['桃金娘', '褐果']}, conf: {}}
    const {state, controller} = runtime({...fixture(), backup_plans: [fixture().backup_plans[0]!, taskOnly]})
    const model = state.mowerShiftModel!, initial = getMowerSourceRuntime(state).data
    const entered = model.swap(initial, [true, true])
    const executed = projectMowerArrangements(entered, [model.transition(initial, entered, [false, false], [true, true])])
    model.activate([true, true])
    const remaining = model.swap(executed, [false, true])
    expect(model.transition(executed, remaining, [true, true], [false, true]).train).toBeUndefined()
    model.activate([false, true])
    expect(controller.active).toEqual([false, true])
    expect(state.config.positions.some(position => position.roomId === 'train')).toBe(false)
    const exited = model.swap(remaining, [false, false])
    expect(() => model.transition(remaining, exited, [false, true], [false, false])).not.toThrow()
    expect(() => model.transition(exited, remaining, [false, false], [false, true])).toThrow('任务缺少有效排班岗位')
  })

  it('validates tasks only on activation in the compatibility scheduler', () => {
    const raw = fixture()
    raw.backup_plans[0]!.trigger = "op_data.operators['阿米娅'].current_mood() < 10"
    const workspace = importMowerJson(JSON.stringify({...raw, backup_plans: [...raw.backup_plans, {
      name: 'temporary task', trigger: 'True', task: {train: ['桃金娘', '褐果']},
    }]}))
    const base = compileRosterSchedule(workspace), config = compiledScheduleToRuntimeConfig(base)
    config.mowerAlpha = false
    const state = createRosterRuntime(config), controller = createBackupPlanController(base, state)
    state.morale[id('阿米娅')] = 1
    controller.evaluate('END')
    expect(controller.active).toEqual([true, true])
    expect(state.mowerBackupGenerated?.some(task => task.plan.train?.length === 2)).toBe(true)
    state.morale[id('阿米娅')] = 24
    expect(() => controller.evaluate('END')).not.toThrow()
    expect(controller.active).toEqual([false, true])
    expect(state.mowerBackupGenerated?.some(task => task.plan.train?.length)).toBe(false)
    expect(state.config.positions.some(position => position.roomId === 'train')).toBe(false)
  })

  it('rejects tasks beyond the native training capacity before activation', () => {
    const raw = fixture()
    Object.assign(raw.backup_plans[0]!, {task: {train: ['安赛尔', '芙蓉', '芬']}})
    expect(validateRosterWorkspace(importMowerJson(JSON.stringify(raw))).criticalErrors.some(issue => issue.message.includes('任务房间或岗位数量'))).toBe(true)
    expect(() => runtime(raw)).toThrow('任务房间/槽位错误')
  })

  it.each([undefined, false, true])('activates the no-plan training backup even with retired state %s', present => {
    const raw = fixture()
    raw.backup_plans[0]!.trigger = 'not op_data.facility_has_mastery_plan("train")'
    const original = structuredClone(raw), options = present === undefined ? {} : {initialMorale: 24, masteryPlanPresent: present}
    const originalOptions = structuredClone(options)
    const {workspace, state, controller} = runtime(raw, options)
    const originalWorkspace = structuredClone(workspace)
    expect(controller.diagnostics.find(issue => issue.code === 'MOWER_MASTERY_PLAN_ASSUMPTION')?.message).toContain('固定为无')
    const model = state.mowerShiftModel!, previous = getMowerSourceRuntime(state).data, conditions = model.evaluate(previous)
    expect(conditions).toEqual([true])
    const next = model.swap(previous, conditions), transition = model.transition(previous, next, [false], conditions)
    expect(transition.train).toEqual([id('桃金娘'), id('褐果')])
    expect(projectMowerArrangements(next, [transition]).currentRoom('train')).toEqual([id('桃金娘'), id('褐果')])
    model.activate(conditions)
    expect(state.config.positions.filter(position => position.roomId === 'train').map(position => position.primary)).toEqual([id('桃金娘'), id('褐果')])
    expect(model.evaluate(getMowerSourceRuntime(state).data)).toEqual([true])
    const result = runScheduleSimulationBridge(workspace, {sampleHours: .01, recordSegments: true, maxEvents: 200}, {...options, idleOperators: []})
    expect(result.report?.success, result.error ?? JSON.stringify(result.report?.diagnostics)).toBe(true)
    expect(result.report?.segments.some(segment => segment.occupants.train_0 === id('桃金娘') && segment.occupants.train_1 === id('褐果'))).toBe(true)
    expect(workspace).toEqual(originalWorkspace)
    const canonicalTrigger={left:original.backup_plans[0]!.trigger,operator:'',right:''}
    const output=JSON.parse(exportMowerJson(workspace))
    expect(output).toEqual({...original,backup_plans:[{...original.backup_plans[0]!,trigger:canonicalTrigger}]})
    expect(workspace.compatibility.backupPlans).toEqual(original.backup_plans)
    expect(compileBackupExpression(original.backup_plans[0]!.trigger,new Set()).evaluate(state)).toBe(true)
    expect(compileBackupExpression(output.backup_plans[0].trigger,new Set()).evaluate(state)).toBe(true)
    const canonicalRoundtrip=JSON.parse(exportMowerJson(importMowerJson(JSON.stringify(output))))
    expect(canonicalRoundtrip).toEqual(output)
    expect({raw, options}).toEqual({raw: original, options: originalOptions})
  })

  it.each([undefined, false, true])('leaves a positive mastery-plan backup inactive with retired state %s', present => {
    const raw = fixture()
    raw.backup_plans[0]!.trigger = 'op_data.facility_has_mastery_plan("train")'
    const options = present === undefined ? {} : {initialMorale: 24, masteryPlanPresent: present}
    const {workspace, state, controller} = runtime(raw, options)
    expect(state.mowerShiftModel!.evaluate(getMowerSourceRuntime(state).data)).toEqual([false])
    expect(controller.evaluate('END')).toBe(false)
    expect(controller.active).toEqual([false])
    expect(state.config.positions.some(position => position.roomId === 'train')).toBe(false)
    const result = runScheduleSimulationBridge(workspace, {sampleHours: .01, recordSegments: true, maxEvents: 200}, {...options, idleOperators: []})
    expect(result.report?.success, result.error ?? JSON.stringify(result.report?.diagnostics)).toBe(true)
    expect(result.report?.segments.every(segment => !segment.occupants.train_0 && !segment.occupants.train_1)).toBe(true)
  })

  it.each([['meeting', 2], ['factory', 1], ['contact', 1], ['recycle', 2]] as const)('accepts omitted %s within its native capacity', (room, capacity) => {
    const raw = fixture()
    raw.backup_plans[0]!.plan = {[room]: {name: '', plans: raw.backup_plans[0]!.plan.train.plans.slice(0, capacity)}} as typeof raw.backup_plans[0]['plan']
    const {workspace, state} = runtime(raw)
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
    state.mowerShiftModel!.activate([true])
    expect(state.config.positions.filter(position => position.roomId === room)).toHaveLength(capacity)
  })

  it('rejects newly appended Current until an earlier active overlay establishes the owner', () => {
    const raw = fixture([column('Current')])
    const workspace = importMowerJson(JSON.stringify(raw))
    expect(validateRosterWorkspace(workspace).criticalErrors.some(issue => issue.message.includes('新增岗位不能使用 Current'))).toBe(true)
    const single = runtime(raw)
    expect(() => single.state.mowerShiftModel!.activate([true])).toThrow('新增岗位不能使用 Current')
    const combined = fixture([column('桃金娘', ['安赛尔'])])
    combined.backup_plans.push(raw.backup_plans[0]!)
    const {state} = runtime(combined)
    expect(() => state.mowerShiftModel!.activate([true, true])).not.toThrow()
    expect(state.config.positions.find(position => position.roomId === 'train')?.primary).toBe(id('桃金娘'))
  })

  it.each(['unknown_room', 'room_1_1', 'dormitory_2'])('keeps undeclared non-right-side room %s invalid', room => {
    const raw = fixture()
    raw.backup_plans[0]!.plan = {[room]: {name: '', plans: [column('桃金娘')]}} as typeof raw.backup_plans[0]['plan']
    const workspace = importMowerJson(JSON.stringify(raw))
    expect(validateRosterWorkspace(workspace).criticalErrors.some(issue => issue.message.includes(room))).toBe(true)
    expect(() => runtime(raw)).toThrow()
  })

  it('rejects more than two training positions and permits an empty no-op overlay', () => {
    const tooMany = fixture([column('桃金娘'), column('褐果'), column('安赛尔')])
    expect(validateRosterWorkspace(importMowerJson(JSON.stringify(tooMany))).criticalErrors.some(issue => issue.message.includes('容量'))).toBe(true)
    expect(() => runtime(tooMany)).toThrow()
    const {state, controller} = runtime(fixture([]))
    state.mowerShiftModel!.activate([true])
    expect(controller.schedule.rooms.find(room => room.roomId === 'train')).toMatchObject({level: 3, slots: []})
  })
})
