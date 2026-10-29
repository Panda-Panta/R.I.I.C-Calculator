import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createDefaultWorkspace } from '../workbench/defaults'
import { allocateCombinationSkeleton, regroupCombination } from './combinationAllocation'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { formedCombinations } from './combinationIntegrity'
import type { CombinationPool, CombinationVariant } from './combinationModel'

const empty = (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
const passiveNames = ['杜林', '桃金娘', '褐果']
const supportNames = ['赫默', '白面鸮', '星源']
const cycle = 'existing-production-cycle'
const grouped = (name: string): MowerSlot => ({ ...empty(), occupant: { kind: 'operator', operatorId: id(name) }, groupId: cycle })
const pool = (...variants: CombinationVariant[]): CombinationPool => ({ values: variants.map((variant, index) => ({
  variant, status: 'evaluated', perCapita: 100 - index, totalGain: 100 - index, productionCount: 2,
  supportCount: variant.placements.length - 2, diagnostics: [],
})), diagnostics: [], enumeratedCount: variants.length })

/** Enumerate the actual Rhine production pair with and without its three physical supports. */
function fixture() {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(base.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 2, product: 'gold', slots: [empty(), empty()] })
  Object.assign(base.mainPlan.facilities.factory, { level: 3, slots: [empty()] })
  Object.assign(base.mainPlan.facilities.train, { level: 3, slots: [empty(), empty()] })
  const names = ['多萝西', '娜斯提', ...supportNames, ...passiveNames, '歌蕾蒂娅', '安哲拉', '幽灵鲨', '斯卡蒂', '乌尔比安', '深巡']
  const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
  const variants = enumerateCombinationVariants(base, inventory).filter(variant => variant.definitionId === 'rhine_lab' &&
    ['多萝西', '娜斯提'].every(name => variant.placements.some(p => p.roomId === 'room_1_1' && p.operatorId === id(name))))
  const large = variants.find(variant => variant.placements.length === 5 && supportNames.every(name => variant.optionalOperatorIds.includes(id(name))))!
  const small = variants.find(variant => variant.placements.length === 2)!
  const trainingBase = structuredClone(base)
  Object.assign(trainingBase.mainPlan.facilities.factory, { level: 0, slots: [] })
  const training = enumerateCombinationVariants(trainingBase, inventory).find(variant => variant.definitionId === 'rhine_lab' &&
    variant.placements.length === 3 && variant.placements.some(p => p.roomId === 'train' && p.operatorId === id('赫默')) &&
    ['多萝西', '娜斯提'].every(name => variant.placements.some(p => p.roomId === 'room_1_1' && p.operatorId === id(name))))!
  expect(large).toBeDefined(); expect(small).toBeDefined()
  expect(training).toBeDefined()
  base.mainPlan.facilities.room_1_1.slots = ['安哲拉', '幽灵鲨'].map(grouped)
  Object.assign(base.mainPlan.facilities.room_1_2, { type: 'manufacture', level: 2, product: 'exp', slots: ['斯卡蒂', '乌尔比安'].map(grouped) })
  Object.assign(base.mainPlan.facilities.central, { level: 1, slots: [grouped('歌蕾蒂娅')] })
  Object.assign(base.mainPlan.facilities.room_1_3, { type: 'trading', level: 1, product: 'money', slots: [grouped('深巡')] })
  const auxiliaries = large.placements.filter(p => p.roomId === 'factory' || p.roomId === 'train')
  expect(auxiliaries).toHaveLength(3)
  auxiliaries.forEach((placement, index) => {
    base.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!.occupant = { kind: 'operator', operatorId: id(passiveNames[index]!) }
  })
  return { base, inventory, large, small, training, auxiliaries }
}

describe('automatic passive auxiliary primary preservation', () => {
  it('keeps the complete small Rhine relief variant instead of absorbing three passive primaries', () => {
    const { base, inventory, large, small, auxiliaries } = fixture(), before = structuredClone(base)
    const result = allocateCombinationSkeleton(base, pool(large, small), 0, { preservePassiveAuxiliaryPrimary: true })
    expect(result.variants.map(variant => variant.id)).toEqual([`${small.id}:backup`])
    expect(result.variants[0]!.placements).toHaveLength(2)
    expect(result.variants[0]!.optionalOperatorIds).toEqual(small.optionalOperatorIds)
    expect(result.workspace.mainPlan.facilities.room_1_1.slots.map(slot => slot.replacements[0])).toEqual(small.placements.map(p => p.operatorId))
    for (const p of auxiliaries) expect(result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]).toEqual(before.mainPlan.facilities[p.roomId].slots[p.slotIndex])
    expect(Object.values(result.workspace.mainPlan.facilities).flatMap(room => room.slots).filter(slot => slot.groupId === cycle)).toHaveLength(6)
    expect(formedCombinations(result.workspace, inventory).some(combination => combination.definitionId === 'rhine_lab' && combination.role === 'backup')).toBe(true)
    const runtime = compiledScheduleToRuntimeConfig(compileRosterSchedule(result.workspace))
    expect(runtime.positions.filter(position => passiveNames.some(name => id(name) === position.primary)).map(position => position.permanent)).toEqual([true, true, true])
    expect(base).toEqual(before)
  })

  it.each([undefined, false])('preserves existing generic allocation when policy is %s', preservePassiveAuxiliaryPrimary => {
    const { base, large, small, auxiliaries } = fixture()
    const result = allocateCombinationSkeleton(base, pool(large, small), 0, { preservePassiveAuxiliaryPrimary })
    expect(result.variants.map(variant => variant.id)).toEqual([`${large.id}:backup`])
    for (const p of auxiliaries) expect(result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.groupId).toBe(cycle)
    expect(Object.values(result.workspace.mainPlan.facilities).flatMap(room => room.slots).filter(slot => slot.groupId === cycle)).toHaveLength(9)
  })

  it('protects an empty auxiliary primary that will be filled after skeleton allocation', () => {
    const { base, large, small, auxiliaries } = fixture()
    for (const p of auxiliaries) base.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.occupant = { kind: 'empty' }
    const result = allocateCombinationSkeleton(base, pool(large, small), 0, { preservePassiveAuxiliaryPrimary: true })
    expect(result.variants.map(variant => variant.id)).toEqual([`${small.id}:backup`])
    for (const p of auxiliaries) expect(result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]).toEqual(empty())
  })

  it('retains explicit auxiliary recovery groups and their complete supported variant', () => {
    const { base, large, auxiliaries } = fixture()
    for (const p of auxiliaries) base.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.groupId = cycle
    const result = allocateCombinationSkeleton(base, pool(large), 0, { preservePassiveAuxiliaryPrimary: true })
    expect(result.variants.map(variant => variant.id)).toEqual([`${large.id}:backup`])
    for (const p of auxiliaries) {
      const slot = result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]!
      expect(slot.groupId).toBe(cycle); expect(slot.replacements).toEqual([p.operatorId])
    }
  })

  it('can remap a complete support variant to an explicitly grouped training slot', () => {
    const { base, training } = fixture(), before = structuredClone(base)
    base.mainPlan.facilities.train.slots[1]!.groupId = cycle
    const result = allocateCombinationSkeleton(base, pool(training), 0, { preservePassiveAuxiliaryPrimary: true })
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0]!.placements.find(p => p.roomId === 'train')?.slotIndex).toBe(1)
    expect(result.workspace.mainPlan.facilities.train.slots[0]).toEqual(before.mainPlan.facilities.train.slots[0])
    expect(result.workspace.mainPlan.facilities.train.slots[1]!.groupId).toBe(cycle)
    expect(result.workspace.mainPlan.facilities.train.slots[1]!.replacements).toEqual([id('赫默')])
  })

  it('still places the actual stationary Pozemka supports as main occupants for a relief core', () => {
    const base = createDefaultWorkspace()
    for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
    Object.assign(base.mainPlan.facilities.room_1_1, { type: 'trading', level: 2, product: 'money', slots: [empty(), empty()] })
    Object.assign(base.mainPlan.facilities.factory, { level: 3, slots: [empty()] })
    Object.assign(base.mainPlan.facilities.train, { level: 3, slots: [empty(), empty()] })
    const names = ['鸿雪', '图耶', ...passiveNames, '能天使', '吉星']
    const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
    const variant = enumerateCombinationVariants(base, inventory).find(variant => variant.definitionId === 'pozemka_durin' &&
      variant.placements.length === 5 && passiveNames.every(name => variant.optionalOperatorIds.includes(id(name))))!
    expect(variant).toBeDefined()
    base.mainPlan.facilities.room_1_1.slots.forEach((slot, index) => { slot.occupant = { kind: 'operator', operatorId: id(['能天使', '吉星'][index]!) } })
    const result = allocateCombinationSkeleton(base, pool(variant), 0, { preservePassiveAuxiliaryPrimary: true })
    expect(result.variants).toHaveLength(1)
    for (const p of result.variants[0]!.placements.filter(p => p.roomId === 'factory' || p.roomId === 'train')) {
      expect(p.role).toBe('main')
      expect(result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]).toEqual({ ...empty(), occupant: { kind: 'operator', operatorId: p.operatorId } })
    }
  })

  it.each(['position', 'operator'] as const)('retains existing %s locks while choosing the complete production-only variant', lock => {
    const { base, large, small, auxiliaries } = fixture(), p = auxiliaries[0]!, before = structuredClone(base)
    const locks = lock === 'position' ? { lockedPositions: new Set([`${p.roomId}:${p.slotIndex}`]) } : { lockedOperators: new Set([id(passiveNames[0]!)]) }
    const result = allocateCombinationSkeleton(base, pool(large, small), 0, { ...locks, preservePassiveAuxiliaryPrimary: true })
    expect(result.variants.map(variant => variant.id)).toEqual([`${small.id}:backup`])
    expect(result.workspace.mainPlan.facilities[p.roomId].slots[p.slotIndex]).toEqual(before.mainPlan.facilities[p.roomId].slots[p.slotIndex])
    expect(base).toEqual(before)
  })

  it('does not allow regrouping to acquire previously passive primary slots', () => {
    const { base, inventory, large, small } = fixture(), before = structuredClone(base)
    expect(regroupCombination(base, inventory, large, 'backup', { preservePassiveAuxiliaryPrimary: true })).toBeNull()
    const ordinary = regroupCombination(base, inventory, small, 'backup', { preservePassiveAuxiliaryPrimary: true })
    expect(ordinary).not.toBeNull()
    expect(ordinary!.mainPlan.facilities.room_1_1.slots.map(slot => slot.replacements[0])).toEqual(small.placements.map(p => p.operatorId))
    expect(regroupCombination(base, inventory, large, 'backup')).not.toBeNull()
    expect(base).toEqual(before)
  })
})
