import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { toRaw } from 'vue'
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers'
import { createDefaultConfig } from '../../domain/defaults'
import { createDefaultWorkspace } from '../defaults'
import { compileMainPlanToAppConfig } from '../adapter'
import { useRosterWorkbenchStore } from '../store'
import { validateRosterWorkspace } from '../validate'
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../../scheduler/rosterRuntime'
import { createBackupPlanController } from '../../scheduler/backupPlans'
import { buildRiicGlobalContext } from '../../engine/globalContext'
import { evaluateRecycleEfficiency } from '../../engine/supportFacilitySkills'
import { exportMowerJson, importMowerJson, promotePreservedRecycleRoom } from './mowerJson'

const recycle = {
  name: '',
  plans: [
    { agent: '旅骨', group: '材料', replacement: ['芬'], custom: { source: 'user' } },
    { agent: '砾', group: '材料', replacement: ['香草'] },
  ],
  position: 'B305',
  retained: { collection: 'manual' },
}

describe('native recycling plan compatibility', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('roundtrips two workers, groups, ordered backups, other plans and unknown metadata', () => {
    const document = {
      default: 'plan2',
      plan2: { recycle, future_room: { opaque: [1, 2] } },
      plan1: { recycle: { ...recycle, plans: [] } },
      backup_plans: [{ trigger: 'True', plan: { recycle: ['芬', '香草'] }, custom: 7 }],
      custom_root: { selected: 'recycle' },
    }
    const workspace = importMowerJson(JSON.stringify(document))
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ type: 'recycle', level: 3 })
    const schedule = compileRosterSchedule(workspace)
    expect(schedule.rooms.find(room => room.roomId === 'recycle')!.slots).toMatchObject([
      { primaryOperatorId: id('旅骨'), groupId: '材料', orderedCandidates: [id('芬')], metadata: { custom: { source: 'user' } } },
      { primaryOperatorId: id('砾'), groupId: '材料', orderedCandidates: [id('香草')] },
    ])
    expect(compiledScheduleToRuntimeConfig(schedule).mowerSourcePlan!.recycle).toMatchObject([
      { agent: id('旅骨'), group: '材料', replacement: [id('芬')] },
      { agent: id('砾'), group: '材料', replacement: [id('香草')] },
    ])
    expect(JSON.parse(exportMowerJson(workspace))).toEqual(document)
  })

  it('keeps an absent recycling room unbuilt and omits it from old native exports', () => {
    const document = { default: 'plan1', plan1: {} }
    const workspace = importMowerJson(JSON.stringify(document))
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ level: 0, slots: [] })
    const config = compileMainPlanToAppConfig(workspace.mainPlan, workspace, createDefaultConfig())
    const schedule = compileRosterSchedule(workspace)
    expect(config.facilities.recycle).toBeUndefined()
    expect(config.facilityOperatorIds.recycle).toBeUndefined()
    expect(schedule.rooms.some(room => room.roomId === 'recycle')).toBe(false)
    expect(compiledScheduleToRuntimeConfig(schedule).mowerRecycleBuilt).toBeUndefined()
    expect(evaluateRecycleEfficiency(config)).toMatchObject({ efficiencyPercent: 0, capacity: 0, hoursPerMaterial: null })
    const withoutRecycle = structuredClone(config)
    delete withoutRecycle.facilities.recycle
    expect(buildRiicGlobalContext(config).engineeringRobots).toBe(buildRiicGlobalContext(withoutRecycle).engineeringRobots)
    // Preserve the existing missing-right-side-room defaults independently.
    expect(workspace.mainPlan.facilities.meeting.level).toBe(3)
    expect(workspace.mainPlan.facilities.factory.level).toBe(3)
    expect(workspace.mainPlan.facilities.contact.level).toBe(3)
    expect(workspace.mainPlan.facilities.train.level).toBe(3)
    expect(JSON.parse(exportMowerJson(workspace))).toEqual(document)
    expect(JSON.parse(exportMowerJson(importMowerJson(exportMowerJson(workspace))))).toEqual(document)
  })

  it('keeps an explicitly listed empty recycling room built', () => {
    const document = { default: 'plan1', plan1: { recycle: { name: '', plans: [] } } }
    const workspace = importMowerJson(JSON.stringify(document))
    const config = compileMainPlanToAppConfig(workspace.mainPlan, workspace, createDefaultConfig())
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ level: 3, slots: [] })
    expect(config.facilities.recycle).toBe(3)
    expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace)).mowerRecycleBuilt).toBe(true)
    expect(evaluateRecycleEfficiency(config)).toMatchObject({ efficiencyPercent: 120, capacity: 10, hoursPerMaterial: 40 })
    expect(JSON.parse(exportMowerJson(workspace))).toEqual(document)
  })

  it.each([0, 1, 2, 3])('honors saved recycling level %i when its main-plan room is absent', level => {
    const document = { default: 'plan1', plan1: {}, facility_levels: { recycle: level } }
    const workspace = importMowerJson(JSON.stringify(document))
    const config = compileMainPlanToAppConfig(workspace.mainPlan, workspace, createDefaultConfig())
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ level, slots: [] })
    expect(config.facilities.recycle).toBe(level || undefined)
    expect(compileRosterSchedule(workspace).rooms.some(room => room.roomId === 'recycle')).toBe(level > 0)
    expect(JSON.parse(exportMowerJson(workspace))).toEqual(document)
  })

  it('allows a backup-only recycling room without building it in the imported main plan', () => {
    const document = {
      default: 'plan1', plan1: {},
      facility_levels: { meeting: 0, factory: 0, contact: 0, train: 0 },
      backup_plans: [{ trigger: 'True', plan: { recycle: { plans: [{ agent: '旅骨', group: '', replacement: [] }] } } }],
    }
    const workspace = importMowerJson(JSON.stringify(document))
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
    expect(workspace.mainPlan.facilities.recycle.level).toBe(0)
    const schedule = compileRosterSchedule(workspace)
    const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const controller = createBackupPlanController(schedule, state)
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    expect(state.config.positions.find(position => position.id === 'recycle_0')?.primary).toBe(id('旅骨'))
    expect(state.config.mowerRecycleBuilt).toBe(true)
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ level: 0, slots: [] })
    expect(JSON.parse(exportMowerJson(workspace))).toEqual(document)
  })

  it('honors explicit local level zero rather than automatically building a room', () => {
    const workspace = importMowerJson(JSON.stringify({ default: 'plan1', plan1: { recycle: { name: '', plans: [], level: 0 } } }))
    expect(workspace.mainPlan.facilities.recycle.level).toBe(0)
    expect(compileRosterSchedule(workspace).rooms.some(room => room.roomId === 'recycle')).toBe(false)
    expect(JSON.parse(exportMowerJson(workspace)).plan1).not.toHaveProperty('recycle')
  })

  it('promotes a preserved old room during workspace load without modifying the caller or other opaque data', () => {
    const candidate = createDefaultWorkspace()
    candidate.compatibility.unrecognizedRooms = { recycle, future: { plans: ['untouched'] } }
    candidate.compatibility.importedPresentRooms = ['central']
    candidate.compatibility.otherPlans = { plan2: { recycle: { unknown: true } } }
    const before = structuredClone(candidate)
    const store = useRosterWorkbenchStore()
    store.loadWorkspace(candidate)
    expect(candidate).toEqual(before)
    expect(store.workspace.mainPlan.facilities.recycle.slots).toHaveLength(2)
    expect(store.workspace.compatibility.unrecognizedRooms).toEqual({ future: { plans: ['untouched'] } })
    expect(store.workspace.compatibility.importedPresentRooms).toContain('recycle')
    const exported = JSON.parse(exportMowerJson(store.workspace))
    expect(exported.plan1.recycle).toEqual(recycle)
    expect(exported.plan2).toEqual(before.compatibility.otherPlans.plan2)
    expect(exported.plan1.future).toEqual({ plans: ['untouched'] })
    promotePreservedRecycleRoom(store.workspace)
    expect(JSON.parse(exportMowerJson(store.workspace))).toEqual(exported)
  })

  it('allows a newly built room to be exported after importing a plan without it', () => {
    const store = useRosterWorkbenchStore()
    store.loadWorkspace(importMowerJson(JSON.stringify({ default: 'plan1', plan1: {} })))
    store.updateFacility('recycle', { level: 1, slots: [{ occupant: { kind: 'operator', operatorId: id('旅骨') }, groupId: null, replacements: [] }] })
    expect(JSON.parse(exportMowerJson(store.workspace)).plan1.recycle.plans[0].agent).toBe('旅骨')
    expect(toRaw(store.workspace.mainPlan.facilities.recycle).level).toBe(1)
  })

  it('retains malformed opaque recycle data without preventing an old workspace from loading', () => {
    const candidate = createDefaultWorkspace()
    candidate.compatibility.unrecognizedRooms = { recycle: { name: '', plans: [null] } }
    const store = useRosterWorkbenchStore()
    expect(() => store.loadWorkspace(candidate)).not.toThrow()
    expect(store.workspace.mainPlan.facilities.recycle.level).toBe(0)
    expect(store.workspace.compatibility.unrecognizedRooms!.recycle).toEqual(candidate.compatibility.unrecognizedRooms.recycle)
    expect(JSON.parse(exportMowerJson(store.workspace)).plan1.recycle).toEqual(candidate.compatibility.unrecognizedRooms.recycle)
  })

  it.each([1, 2, 3])('retains explicit level %i, its actual capacity, and zero additional power cost', level => {
    // Capacity and power do not require a bound rest group in this room-only plan.
    const plans = recycle.plans.slice(0, level === 1 ? 1 : 2).map(plan => ({ ...plan, group: '' }))
    const workspace = importMowerJson(JSON.stringify({
      default: 'plan1', plan1: { recycle: { ...recycle, level, plans } },
      facility_levels: { meeting: 0, factory: 0, contact: 0, train: 0 },
    }))
    const result = validateRosterWorkspace(workspace)
    expect(result.criticalErrors).toEqual([])
    expect(result.power).toMatchObject({ generation: 0, consumption: 0, margin: 0 })
    expect(workspace.mainPlan.facilities.recycle.level).toBe(level)
    expect(JSON.parse(exportMowerJson(workspace)).plan1.recycle.level).toBe(level)
    workspace.mainPlan.facilities.recycle.slots.push({ occupant: { kind: 'operator', operatorId: id('香草') }, groupId: null, replacements: [] })
    expect(validateRosterWorkspace(workspace).criticalErrors.some(issue => issue.code === 'SLOT_OVERFLOW' && issue.roomId === 'recycle')).toBe(true)
  })

  it('registers recycling between training and activity rooms in current native plan order', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.recycle.level = 3
    const rooms = compileRosterSchedule(workspace).rooms.map(room => room.roomId)
    expect(rooms.indexOf('recycle')).toBe(rooms.indexOf('train') + 1)
    expect(rooms.indexOf('gaming_1')).toBe(rooms.indexOf('recycle') + 1)
  })

  it('applies and exits a conditional recycling backup while retaining the independent second position', () => {
    const workspace = importMowerJson(JSON.stringify({
      default: 'plan1', plan1: { recycle, dormitory_1: { name: '', plans: ['杜林', '闪灵', 'Free', 'Free', 'Free'].map(agent => ({ agent, replacement: [], group: '' })) } },
      backup_plans: [{ trigger: "op_data.operators['旅骨'].current_mood() < 10", plan: { recycle: { plans: [{ agent: '芬', group: '替换', replacement: ['香草'] }] } } }],
    }))
    const schedule = compileRosterSchedule(workspace), state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const controller = createBackupPlanController(schedule, state)
    state.morale[id('旅骨')] = 1
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    expect(state.config.positions.find(position => position.id === 'recycle_0')).toMatchObject({ primary: id('芬'), group: '替换', candidates: [id('香草')] })
    expect(state.config.positions.find(position => position.id === 'recycle_1')!.primary).toBe(id('砾'))
    state.morale[id('旅骨')] = 24
    controller.evaluate('END')
    expect(controller.active).toEqual([false])
    expect(state.config.positions.find(position => position.id === 'recycle_0')!.primary).toBe(id('旅骨'))
    expect(workspace.mainPlan.facilities.recycle.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('旅骨') })
  })
})
