import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import * as moraleRules from '../engine/morale'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { mowerExhaustGroups, mowerOrdinaryCoordinationNeeded } from '../scheduler/mowerExhaustPolicy'
import { mowerGetRestingPlan, mowerResting } from '../scheduler/mowerOrdinaryPlanning'
import { MowerTaskQueue, type MowerTaskPlan } from '../scheduler/mowerTaskQueue'
import { nextMowerMoodPlanningWake } from '../scheduler/mowerPlanningWake'
import { projectRosterConfig } from './rosterProjection'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'

const inventory = compileOperatorInventory(fullCatalogIdleInventory())
const slot = (name: string, groupId: string | null = null, replacements: string[] = []): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(name) }, groupId, replacements: replacements.map(id),
})
function emptyWorkspace() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) room.slots = []
  return workspace
}
describe('warmup recognition uses owned stages and the working facility', () => {
  it.each([
    ['机械师', 'manufacture', 0, false], ['机械师', 'manufacture', 2, true],
    ['阿罗玛', 'manufacture', 0, false], ['阿罗玛', 'manufacture', 2, true],
    ['刻俄柏', 'manufacture', 0, false], ['刻俄柏', 'manufacture', 2, true],
    ['芬', 'manufacture', 0, true], ['芬', 'trading', 1, false],
    ['稀音', 'manufacture', 0, true], ['克洛丝', 'dormitory', 1, false],
    ['空构', 'power', 0, true], ['空构', 'power', 2, true], ['空构', 'manufacture', 2, false],
    ['伊内丝', 'meeting', 0, false], ['伊内丝', 'meeting', 2, true], ['伊内丝', 'contact', 2, false],
    ['砾', 'manufacture', 2, false],
  ] as const)('%s in %s phase %i is warmup=%s', (name, facility, elitePhase, expected) => {
    const owned = compileOperatorInventory([{ operator: name, elitePhase, level: 1 }])
    expect(owned.valid).toBe(true)
    expect(isWarmupOperatorInFacility(name, facility, owned)).toBe(expected)
    expect(isWarmupOperatorInFacility(id(name), facility, owned)).toBe(expected)
  })
  it('does not fall back to maximum catalog skills for unowned or invalid inventory', () => {
    expect(isWarmupOperatorInFacility('机械师', 'manufacture', compileOperatorInventory([]))).toBe(false)
    expect(isWarmupOperatorInFacility('机械师', 'manufacture', { ...inventory, valid: false })).toBe(false)
  })
})

describe('generated primary warmup policy', () => {
  it('merges aliases without changing slots, group bindings or other policies and is idempotent', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'core', ['砾']), slot('槐琥', 'core', ['维伊'])]
    workspace.mainPlan.facilities.room_1_1.slots[0]!.metadata = { locked: true, custom: { value: 7 } }
    workspace.mainPlan.facilities.central.slots = [{ ...slot('琴柳', 'core', ['夕']), groupBindings: [{ groupId: 'another', replacements: [id('令')], metadata: { retained: true } }] }]
    workspace.mainPlan.conf.exhaust_require = ['机械师', id('机械师'), 'unknown-existing']
    workspace.mainPlan.conf.rest_in_full = ['阿罗玛']
    workspace.mainPlan.conf.resting_priority = ['阿罗玛']
    workspace.mainPlan.conf.resting_standby = ['阿罗玛', '砾']
    const before = structuredClone(workspace), beforeInventory = structuredClone(inventory)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(true)
    expect(result.addedExhaustOperatorIds).toEqual([id('阿罗玛')])
    expect(workspace.mainPlan.conf.exhaust_require).toEqual(['机械师', 'unknown-existing', id('阿罗玛')])
    expect(workspace.mainPlan.facilities).toEqual(before.mainPlan.facilities)
    expect({ ...workspace.mainPlan.conf, exhaust_require: [] }).toEqual({ ...before.mainPlan.conf, exhaust_require: [] })
    expect(inventory).toEqual(beforeInventory)
    const once = structuredClone(workspace)
    expect(applyGeneratedWarmupPolicy(workspace, inventory).addedExhaustOperatorIds).toEqual([])
    expect(workspace).toEqual(once)
  })
  it('handles manufacture, power and meeting together, ignoring dormant rooms and wrong facilities', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('机械师')]
    workspace.mainPlan.facilities.room_1_3.slots = [slot('空构')]
    workspace.mainPlan.facilities.meeting.slots = [slot('伊内丝')]
    workspace.mainPlan.facilities.room_3_1.slots = [slot('芬')]
    workspace.mainPlan.facilities.room_1_2.level = 0
    workspace.mainPlan.facilities.room_1_2.slots = [slot('稀音')]
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(new Set(result.addedExhaustOperatorIds)).toEqual(new Set(['机械师', '空构', '伊内丝'].map(id)))
    expect(workspace.mainPlan.conf.exhaust_require).not.toContain(id('稀音'))
    expect(workspace.mainPlan.conf.exhaust_require).not.toContain(id('芬'))
  })
  it('skips explicit permanent workers without deleting existing flags or blocking peers', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'core'), slot('砾', 'core')]
    workspace.mainPlan.conf.workaholic = ['阿罗玛']
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.skippedPermanentOperatorIds).toEqual([id('阿罗玛')])
    expect(workspace.mainPlan.conf.exhaust_require).toEqual([])
    workspace.mainPlan.conf.exhaust_require = ['阿罗玛']
    applyGeneratedWarmupPolicy(workspace, inventory)
    expect(workspace.mainPlan.conf.exhaust_require).toEqual(['阿罗玛'])
  })
  it('keeps exhaustion policy when a real nonpositive snapshot can become depleting', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.central.slots = ['重岳', '临光', '红', '杜宾', '坚雷'].map(name => slot(name))
    workspace.mainPlan.facilities.room_1_1.slots = ['刻俄柏', '黍', '斑点'].map(name => slot(name, 'core'))
    // A fixed declared resource snapshot; this is not a simulated future trajectory.
    workspace.compatibility.unrecognizedFields.efficiencyResources = { worldlyFireworks: 120 }
    const before = projectRosterConfig(workspace)
    before.operatorRecords = inventoryOperatorRecords(inventory)
    expect(moraleRules.currentMoraleRates(before).rates[id('刻俄柏')]).toBeCloseTo(-0.05)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.addedExhaustOperatorIds).toEqual([id('刻俄柏')])
    expect(result.valid).toBe(true)
    expect(result.skippedPermanentOperatorIds).toEqual([])
    workspace.mainPlan.facilities.central.slots[0] = slot('阿米娅')
    const after = projectRosterConfig(workspace)
    after.operatorRecords = inventoryOperatorRecords(inventory)
    expect(moraleRules.currentMoraleRates(after).rates[id('刻俄柏')]).toBeCloseTo(0.30)
    expect(applyGeneratedWarmupPolicy(workspace, inventory).valid).toBe(true)
    expect(workspace.mainPlan.conf.exhaust_require).toEqual([id('刻俄柏')])
  })
  it('uses the warmup operator actual stage without requiring an unrelated primary inventory record', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'core'), slot('砾', 'core')]
    const owned = compileOperatorInventory([{ operator: '阿罗玛', elitePhase: 2, level: 1 }])
    const result = applyGeneratedWarmupPolicy(workspace, owned)
    expect(result.valid).toBe(true)
    expect(result.addedExhaustOperatorIds).toEqual([id('阿罗玛')])
    expect(workspace.mainPlan.conf.exhaust_require).toEqual([id('阿罗玛')])
  })
  it.each(['second', null])('diagnoses even one extra binding (%s) without unbinding or changing flags', groupId => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [{ ...slot('阿罗玛', 'first', ['砾']), groupBindings: [{ groupId, replacements: [id('维伊')] }] }]
    const before = structuredClone(workspace)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(false)
    expect(result.unsupportedMultiGroupPrimaries).toEqual([expect.objectContaining({ operatorId: id('阿罗玛'), roomId: 'room_1_1', slotIndex: 0 })])
    expect(workspace).toEqual(before)
  })
  it('does not mutate an invalid inventory input or silently use maximum stages', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛')]
    const before = structuredClone(workspace)
    expect(applyGeneratedWarmupPolicy(workspace, { ...inventory, valid: false }).diagnostics).toContainEqual(expect.objectContaining({ severity: 'error' }))
    expect(workspace).toEqual(before)
  })
  it('rechecks the same inventory object when the actual warmup skill is newly unlocked', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛')]
    const owned = compileOperatorInventory([{ operator: '阿罗玛', elitePhase: 0, level: 1 }])
    expect(applyGeneratedWarmupPolicy(workspace, owned).addedExhaustOperatorIds).toEqual([])
    expect(workspace.mainPlan.conf.exhaust_require).toEqual([])
    owned.operators = compileOperatorInventory([{ operator: '阿罗玛', elitePhase: 2, level: 1 }]).operators
    expect(applyGeneratedWarmupPolicy(workspace, owned).addedExhaustOperatorIds).toEqual([id('阿罗玛')])
  })
  it('retains multiple mandatory group members and explains the native earliest-member limit', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('稀音', 'capacity'), slot('刻俄柏', 'capacity')]
    const before = structuredClone(workspace.mainPlan.facilities)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(true)
    expect(new Set(result.addedExhaustOperatorIds)).toEqual(new Set(['稀音', '刻俄柏'].map(id)))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'WARMUP_GROUP_EARLIEST_EXHAUST', severity: 'warning' }))
    expect(workspace.mainPlan.facilities).toEqual(before)
  })
})

describe('warmup backup roles are not silently labelled exhausted', () => {
  it('reports ordinary low candidates including additional bindings and preserves their flags and order', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [{ ...slot('砾', 'main', ['稀音']), groupBindings: [{ groupId: 'other', replacements: [id('刻俄柏')] }] }]
    workspace.mainPlan.conf.exhaust_require = ['稀音']
    const before = structuredClone(workspace)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(false)
    expect(new Set(result.unsupportedWarmupBackups.map(position => position.operatorId))).toEqual(new Set(['稀音', '刻俄柏'].map(id)))
    expect(result.addedExhaustOperatorIds).toEqual([])
    expect(workspace).toEqual(before)
  })
  it('distinguishes actual primary references and excludes dorm refresh and run-order lists', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'core', ['砾']), slot('砾', 'core', ['阿罗玛'])]
    workspace.mainPlan.facilities.dormitory_1.slots = [slot('菲亚梅塔', null, ['机械师', '稀音'])]
    workspace.mainPlan.facilities.room_3_1.slots = [slot('伺夜', null, ['但书', '龙舌兰'])]
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.unsupportedWarmupBackups).toEqual([])
    expect(result.addedExhaustOperatorIds).toEqual([id('阿罗玛')])
  })
  it('does not treat an occupant in an unbuilt room as a high primary', () => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('砾', null, ['稀音'])]
    workspace.mainPlan.facilities.room_1_2.level = 0
    workspace.mainPlan.facilities.room_1_2.slots = [slot('稀音')]
    expect(applyGeneratedWarmupPolicy(workspace, inventory).unsupportedWarmupBackups).toEqual([
      expect.objectContaining({ operatorId: id('稀音'), roomId: 'room_1_1', slotIndex: 0 }),
    ])
  })
  it.each([false, true])('rejects a dorm primary that the native planner can use as warmup manufacture relief (alpha=%s)', alpha => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('斑点', 'shared', ['芬'])]
    workspace.mainPlan.facilities.dormitory_1.slots = [slot('芬', 'shared', ['杜林']), ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))]
    const before = structuredClone(workspace)
    const compiled = compileRosterSchedule(workspace)
    expect(compiled.diagnostics).toEqual([])
    const config = compiledScheduleToRuntimeConfig(compiled)
    config.mowerAlpha = alpha
    const data = getMowerSourceRuntime(createRosterRuntime(config)).data
    for (const op of Object.values(data.operators)) {
      op.currentRoom = op.room
      op.currentIndex = op.index
      op.timeStampMicros = data.nowMicros
      op.mood = op.name === id('斑点') ? 10 : 24
    }
    const plan: MowerTaskPlan = {}
    expect(data.operators[id('芬')]!.isHigh()).toBe(true)
    expect(data.operators[id('芬')]!.exhaustRequire).toBe(false)
    expect(mowerGetRestingPlan(data, [id('斑点'), id('芬')], [], plan)).toBe(true)
    expect(plan.room_1_1).toEqual([id('芬')])
    expect(plan.dormitory_1?.[0]).toBe(id('杜林'))
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(false)
    expect(result.unsupportedWarmupBackups).toEqual([{ operatorId: id('芬'), roomId: 'room_1_1', slotIndex: 0 }])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_WARMUP_PRIMARY_REPLACEMENT', severity: 'error' }))
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_WARMUP_BACKUP')).toBe(false)
    expect(result.addedExhaustOperatorIds).toEqual([])
    expect(workspace).toEqual(before)
  })
  it.each([false, true])('requires the referenced warmup primary to be covered by the same binding group (extra=%s)', extra => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('砾', extra ? 'warmup' : 'other', extra ? [] : ['阿罗玛'])]
    if (extra) workspace.mainPlan.facilities.room_1_1.slots[0]!.groupBindings = [{ groupId: 'other', replacements: [id('阿罗玛')] }]
    workspace.mainPlan.facilities.room_1_2.slots = [slot('阿罗玛', 'warmup', ['维伊'])]
    const positions = structuredClone(workspace.mainPlan.facilities)
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_WARMUP_PRIMARY_REPLACEMENT' }))
    expect(result.addedExhaustOperatorIds).toEqual([id('阿罗玛')])
    expect(workspace.mainPlan.facilities).toEqual(positions)
  })
  it.each([false, true])('does not use explicit workaholic as proof that a warmup replacement is covered (primary=%s)', primary => {
    const workspace = emptyWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots = [slot('砾', 'whole', ['阿罗玛']), ...(primary ? [slot('阿罗玛', 'whole')] : [])]
    workspace.mainPlan.conf.workaholic = ['阿罗玛']
    const result = applyGeneratedWarmupPolicy(workspace, inventory)
    expect(result.valid).toBe(false)
    expect(result.addedExhaustOperatorIds).toEqual([])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: primary ? 'UNSUPPORTED_WARMUP_PRIMARY_REPLACEMENT' : 'UNSUPPORTED_WARMUP_BACKUP' }))
    expect(workspace.mainPlan.conf.exhaust_require).toEqual([])
  })
})

it('the compiled Mower group skips ordinary threshold rest after only its warmup primary gains exhaustion', () => {
  const workspace = emptyWorkspace()
  workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'whole', ['维伊']), slot('砾', 'whole', ['斑点'])]
  workspace.mainPlan.conf.resting_priority = ['阿罗玛']
  workspace.mainPlan.conf.resting_standby = ['阿罗玛']
  workspace.mainPlan.facilities.dormitory_1.slots = [slot('闪灵'), { occupant: { kind: 'free' }, groupId: null, replacements: [] }, { occupant: { kind: 'free' }, groupId: null, replacements: [] }]
  const runtime = () => {
    const compiled = compileRosterSchedule(workspace)
    expect(compiled.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    const config = compiledScheduleToRuntimeConfig(compiled)
    const data = getMowerSourceRuntime(createRosterRuntime(config)).data
    // A controlled observed state, created through the real compiler/runtime.
    for (const op of Object.values(data.operators)) {
      op.currentRoom = op.room
      op.currentIndex = op.index
      op.timeStampMicros = data.nowMicros
      op.mood = op.name === id('砾') ? 10 : 24
    }
    return data
  }
  const before = runtime()
  expect(mowerExhaustGroups(before).has('whole')).toBe(false)
  expect(mowerOrdinaryCoordinationNeeded(before, [id('砾')])).toBe(true)
  expect(mowerResting(before, new MowerTaskQueue())).not.toEqual({})
  const slotsBefore = structuredClone(workspace.mainPlan.facilities)
  expect(applyGeneratedWarmupPolicy(workspace, inventory).addedExhaustOperatorIds).toEqual([id('阿罗玛')])
  const after = runtime()
  expect(after.operators[id('阿罗玛')]!.exhaustRequire).toBe(true)
  expect(after.operators[id('阿罗玛')]!.isHigh()).toBe(true)
  expect(after.operators[id('阿罗玛')]!.restingPriority).toBe('low')
  expect(after.operators[id('砾')]!.exhaustRequire).toBe(false)
  expect(mowerExhaustGroups(after)).toEqual(new Set(['whole']))
  expect(mowerOrdinaryCoordinationNeeded(after, [id('砾')])).toBe(false)
  expect(mowerResting(after, new MowerTaskQueue())).toEqual({})
  expect(workspace.mainPlan.facilities).toEqual(slotsBefore)
})

it('native exhaustion remains configured at zero drain and creates a wake when drain becomes positive', () => {
  const workspace = emptyWorkspace()
  workspace.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', 'whole', ['维伊']), slot('砾', 'whole', ['斑点'])]
  expect(applyGeneratedWarmupPolicy(workspace, inventory).valid).toBe(true)
  const compiled = compileRosterSchedule(workspace)
  expect(compiled.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
  const runtime = createRosterRuntime(compiledScheduleToRuntimeConfig(compiled))
  const data = getMowerSourceRuntime(runtime).data
  for (const op of Object.values(data.operators)) {
    op.currentRoom = op.room
    op.currentIndex = op.index
    op.timeStampMicros = data.nowMicros
    op.mood = runtime.morale[op.name] = op.name === id('砾') ? 10 : 24
  }
  // Controlled rate changes exercise the real native wake rule, without a full F run.
  let drain = 0
  const rates = { workRate: (operatorId: string) => operatorId === id('阿罗玛') ? drain : 0, recoveryRate: () => 2 }
  expect(data.operators[id('阿罗玛')]!.exhaustRequire).toBe(true)
  expect(mowerExhaustGroups(data)).toEqual(new Set(['whole']))
  expect(mowerOrdinaryCoordinationNeeded(data, [id('砾')])).toBe(false)
  expect(nextMowerMoodPlanningWake(runtime, data, rates)).toBeUndefined()
  drain = 0.5
  expect(nextMowerMoodPlanningWake(runtime, data, rates)).toEqual({ timeMicros: 44 * 3_600_000_000, names: [id('阿罗玛')] })
  expect(data.operators[id('阿罗玛')]!.exhaustRequire).toBe(true)
  expect(mowerExhaustGroups(data)).toEqual(new Set(['whole']))
})
