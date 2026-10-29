import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { buildRiicGlobalContext } from '../engine/globalContext'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createDefaultWorkspace } from '../workbench/defaults'
import { allocateCombinationSkeleton, regroupCombination } from './combinationAllocation'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { formedCombinations, preservesFormedCombinations } from './combinationIntegrity'
import type { CombinationPool, CombinationVariant } from './combinationModel'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'
import { projectRosterConfig } from './rosterProjection'

const supportNames = ['杜林', '桃金娘', '褐果']
const empty = (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
const pool = (variant: CombinationVariant): CombinationPool => ({ values: [{ variant, status: 'evaluated', perCapita: 1,
  totalGain: 1, productionCount: 2, supportCount: 3, diagnostics: [] }], diagnostics: [], enumeratedCount: 1 })

function fixture(powerCount: 2 | 3 = 2, tradeSize: 2 | 3 = 2, phase = 2) {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(base.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 1, product: 'gold', slots: [empty()] })
  Object.assign(base.mainPlan.facilities.room_1_2, { type: 'trading', level: tradeSize, product: 'money', slots: Array.from({ length: tradeSize }, empty) })
  for (const roomId of (['room_1_3', 'room_2_3', 'room_3_3'] as const).slice(0, powerCount)) {
    Object.assign(base.mainPlan.facilities[roomId], { type: 'power', level: 3, slots: [empty()] })
  }
  Object.assign(base.mainPlan.facilities.factory, { level: 3, slots: [empty()] })
  Object.assign(base.mainPlan.facilities.train, { level: 3, slots: [empty(), empty()] })
  Object.assign(base.mainPlan.facilities.dormitory_1, { level: 1, slots: Array.from({ length: 5 }, (_, index) => ({
    ...empty(), occupant: index < tradeSize ? { kind: 'free' as const } : { kind: 'operator' as const, operatorId: id(['芬', '香草', '翎羽'][index - tradeSize]!) },
  })) })
  const names = ['鸿雪', '图耶', ...(tradeSize === 3 ? ['绮良'] : []), ...supportNames, '芬', '香草', '翎羽', '能天使', '吉星', '海蒂', '麦哲伦', '艾拉', '阿']
  const entries = fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator))
    .map(entry => entry.operator === id('鸿雪') ? { ...entry, elitePhase: phase, level: phase === 2 ? 90 : 1 } : entry)
  const inventory = compileOperatorInventory(entries)
  const variant = enumerateCombinationVariants(base, inventory).find(variant => variant.definitionId === 'pozemka_durin' &&
    variant.placements.filter(placement => placement.roomId === 'room_1_2').length === tradeSize &&
    supportNames.every(name => variant.optionalOperatorIds.includes(id(name))))!
  expect(variant).toBeDefined()
  return { base, inventory, variant, support: variant.placements.filter(placement => supportNames.some(name => id(name) === placement.operatorId)) }
}

describe('generated Pozemka passive presence grouping', () => {
  it.each([[2, 2], [2, 3], [3, 2], [3, 3]] as const)('keeps %i-power/%i-trade auxiliary presence outside the productive recovery group', (powerCount, tradeSize) => {
    const { base, inventory, variant, support } = fixture(powerCount, tradeSize), before = structuredClone(base)
    const result = allocateCombinationSkeleton(base, pool(variant), 0, { enforceRecoveryCapacity: true })
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0]!.placements.every(placement => placement.role === 'main')).toBe(true)
    const draft = result.workspace, trade = draft.mainPlan.facilities.room_1_2
    trade.slots.forEach((slot, index) => { slot.replacements = [id(['能天使', '吉星', '海蒂'][index]!)] })
    expect(trade.slots.every(slot => slot.groupId === trade.slots[0]!.groupId)).toBe(true)
    expect(trade.slots[0]!.groupId).toBeTruthy()
    for (const placement of support) {
      const slot = draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!
      expect(slot.occupant).toEqual({ kind: 'operator', operatorId: placement.operatorId })
      expect(slot.groupId).toBeNull()
    }
    expect(draft.mainPlan.conf.workaholic).toEqual(before.mainPlan.conf.workaholic)
    expect(recoveryGroupCapacityIssues(draft)).toEqual([])
    expect(validatePhysicalRoster(draft)).toEqual([])
    const compiled = compileRosterSchedule(draft)
    expect(compiled.diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
    const runtime = compiledScheduleToRuntimeConfig(compiled)
    expect(runtime.positions.filter(position => supportNames.some(name => id(name) === position.primary)).map(position => position.permanent)).toEqual([true, true, true])
    const config = projectRosterConfig(draft); config.operatorRecords = inventoryOperatorRecords(inventory)
    expect(buildRiicGlobalContext(config).durinGoldProductionLines).toBe(3)
    config.zeroMoraleOperatorIds = supportNames.map(id)
    expect(buildRiicGlobalContext(config).durinGoldProductionLines).toBe(3)
    expect(formedCombinations(draft, inventory).some(combination => combination.definitionId === 'pozemka_durin' && combination.role === 'main')).toBe(true)
    expect(base).toEqual(before)
  })

  it('retains actual support presence when the productive core is allocated as relief', () => {
    const { base, variant, support } = fixture()
    base.mainPlan.facilities.room_1_2.slots.forEach((slot, index) => { slot.occupant = { kind: 'operator', operatorId: id(['能天使', '吉星'][index]!) } })
    const before = structuredClone(base), result = allocateCombinationSkeleton(base, pool(variant), 0)
    expect(result.variants).toHaveLength(1)
    for (const placement of support) {
      const slot = result.workspace.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!
      expect(slot.occupant).toEqual({ kind: 'operator', operatorId: placement.operatorId })
      expect(slot.replacements).toEqual([])
      expect(slot.groupId).toBeNull()
      expect(result.variants[0]!.placements.find(value => value.operatorId === placement.operatorId)?.role).toBe('main')
    }
    expect(result.workspace.mainPlan.facilities.room_1_2.slots.map(slot => slot.replacements[0])).toEqual([id('鸿雪'), id('图耶')])
    expect(base).toEqual(before)
  })

  it.each(['user-cycle', '组合_pozemka_durin_factory:0'] as const)('preserves explicit auxiliary group %s and its ordered replacements', groupId => {
    const { base, variant, support } = fixture(), placement = support[0]!
    const slot = base.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!
    slot.occupant = { kind: 'operator', operatorId: placement.operatorId }; slot.groupId = groupId; slot.replacements = [id('麦哲伦')]
    const before = structuredClone(base)
    const allocated = allocateCombinationSkeleton(base, pool(variant), 0), draft = allocated.workspace
    expect(allocated.variants).toHaveLength(1)
    expect(draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]).toEqual(slot)
    expect(draft.mainPlan.facilities.room_1_2.slots[0]!.groupId).not.toBe(groupId)
    expect(base).toEqual(before)
  })

  it.each(['position', 'operator'] as const)('preserves locked %s support including its existing group', lock => {
    const { base, variant, support } = fixture(), placement = support[0]!
    const slot = base.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!
    slot.occupant = { kind: 'operator', operatorId: placement.operatorId }; slot.groupId = 'locked-user'; slot.replacements = [id('麦哲伦')]
    const locks = lock === 'position' ? { lockedPositions: new Set([`${placement.roomId}:${placement.slotIndex}`]) } : { lockedOperators: new Set([placement.operatorId]) }
    const before = structuredClone(base), allocated = allocateCombinationSkeleton(base, pool(variant), 0, locks), draft = allocated.workspace
    expect(allocated.variants).toHaveLength(1)
    expect(draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]).toEqual(slot)
    expect(draft.mainPlan.facilities.room_1_2.slots[0]!.groupId).not.toBe('locked-user')
    expect(base).toEqual(before)
  })

  it('retains independent auxiliary actors and replacements through whole-core regrouping', () => {
    const { base, inventory, variant, support } = fixture()
    const allocated = allocateCombinationSkeleton(base, pool(variant), 0).workspace
    allocated.mainPlan.facilities.room_1_2.slots.forEach((slot, index) => { slot.replacements = [id(['能天使', '吉星'][index]!)] })
    support.forEach((placement, index) => { allocated.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!.replacements = [id(['麦哲伦', '艾拉', '阿'][index]!)] })
    const before = structuredClone(allocated), draft = regroupCombination(allocated, inventory, variant, 'backup')!
    expect(draft).not.toBeNull()
    support.forEach(placement => expect(draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]).toEqual(before.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]))
    expect(preservesFormedCombinations(allocated, draft, inventory)).toBe(true)
    expect(allocated).toEqual(before)
  })

  it('does not grant the locked E2 virtual-line skill to a low-stage Pozemka', () => {
    const { base, inventory, variant } = fixture(2, 2, 0)
    const draft = allocateCombinationSkeleton(base, pool(variant), 0).workspace
    const config = projectRosterConfig(draft); config.operatorRecords = inventoryOperatorRecords(inventory)
    expect(buildRiicGlobalContext(config).durinGoldProductionLines).toBe(0)
  })

  it('does not change ordinary cross-room recovery grouping of another core', () => {
    const { base, variant } = fixture()
    const ordinary = { ...variant, definitionId: 'ordinary-cross-room', id: 'ordinary-cross-room' }
    const draft = allocateCombinationSkeleton(base, pool(ordinary), 0).workspace
    const groups = ordinary.placements.map(placement => draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!.groupId)
    expect(groups[0]).toBeTruthy()
    expect(new Set(groups).size).toBe(1)
  })
})
