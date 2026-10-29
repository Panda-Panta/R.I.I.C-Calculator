import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { buildRiicGlobalContext } from '../engine/globalContext'
import { createDefaultWorkspace } from '../workbench/defaults'
import { applyCombinationVariant } from './combinationModel'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { formedCombinations } from './combinationIntegrity'
import { projectRosterConfig } from './rosterProjection'
import { allocateCombinationSkeleton } from './combinationAllocation'
import { applySmartDormitoryPolicy } from '../scheduler/smartDormitoryPolicy'
import { createPresencePlacementPlanner } from './presencePlacementPlanner'

const empty = (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
function fixture(names = ['鸿雪', '图耶', '杜林', '桃金娘', '芬']) {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(base.mainPlan.facilities.room_1_2, { type: 'trading', level: 2, product: 'money', slots: [empty(), empty()] })
  Object.assign(base.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 1, product: 'gold', slots: [empty()] })
  Object.assign(base.mainPlan.facilities.factory, { level: 3, slots: [empty()] })
  Object.assign(base.mainPlan.facilities.train, { level: 3, slots: [empty(), empty()] })
  for (const roomId of ['dormitory_1', 'dormitory_2'] as const) Object.assign(base.mainPlan.facilities[roomId], { level: 1, slots: Array.from({ length: 5 }, empty) })
  const entries = fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator))
  return { base, entries, inventory: compileOperatorInventory(entries) }
}

describe('bounded actual-skill dormitory presence placements', () => {
  it('offers both auxiliary and separate-dorm recovery plans for Durin and Myrtle', () => {
    const { base, inventory } = fixture(), before = structuredClone(base), inventoryBefore = structuredClone(inventory)
    const variants = enumerateCombinationVariants(base, inventory).filter(variant => variant.definitionId === 'pozemka_durin' &&
      ['杜林', '桃金娘'].every(name => variant.optionalOperatorIds.includes(id(name))))
    expect(variants.some(variant => variant.placements.filter(placement => ['杜林', '桃金娘'].some(name => id(name) === placement.operatorId))
      .every(placement => ['factory', 'train'].includes(base.mainPlan.facilities[placement.roomId].type)))).toBe(true)
    const dormPlan = variants.find(variant => {
      const rooms = variant.placements.filter(placement => ['杜林', '桃金娘'].some(name => id(name) === placement.operatorId)).map(placement => placement.roomId)
      return rooms.every(room => base.mainPlan.facilities[room].type === 'dormitory') && new Set(rooms).size === 2
    })
    expect(dormPlan).toBeDefined()
    expect(variants.length).toBeLessThanOrEqual(3)
    const placed = applyCombinationVariant(base, dormPlan!)!
    const config = projectRosterConfig(placed); config.operatorRecords = inventoryOperatorRecords(inventory)
    expect(buildRiicGlobalContext(config).durinGoldProductionLines).toBe(2)
    expect(formedCombinations(placed, inventory).some(combination => combination.definitionId === 'pozemka_durin')).toBe(true)
    expect(base).toEqual(before)
    expect(inventory).toEqual(inventoryBefore)
  })

  it('uses the actual Myrtle unlock and keeps an auxiliary alternative', () => {
    const { base, entries } = fixture(['鸿雪', '图耶', '桃金娘', '芬'])
    const variants = (phase: number) => enumerateCombinationVariants(base, compileOperatorInventory(entries.map(entry => entry.operator === id('桃金娘') ?
      { ...entry, elitePhase: phase, level: 1 } : entry))).filter(variant => variant.definitionId === 'pozemka_durin' && variant.optionalOperatorIds.includes(id('桃金娘')))
    expect(variants(0).every(variant => variant.placements.find(placement => placement.operatorId === id('桃金娘'))?.roomId === 'factory')).toBe(true)
    expect(variants(1).some(variant => base.mainPlan.facilities[variant.placements.find(placement => placement.operatorId === id('桃金娘'))!.roomId].type === 'dormitory')).toBe(true)
    expect(variants(1).some(variant => variant.placements.find(placement => placement.operatorId === id('桃金娘'))?.roomId === 'factory')).toBe(true)
  })

  it('does not stack Myrtle under an existing stronger room-wide keeper or relocate that keeper', () => {
    const { base, inventory } = fixture()
    const keeper = base.mainPlan.facilities.dormitory_1.slots[0]!
    keeper.occupant = { kind: 'operator', operatorId: id('杜林') }; keeper.replacements = []; keeper.dormitoryResident = true
    const before = structuredClone(base), variants = enumerateCombinationVariants(base, inventory)
      .filter(variant => variant.definitionId === 'pozemka_durin' && variant.optionalOperatorIds.includes(id('桃金娘')))
    const dormPlans = variants.filter(variant => base.mainPlan.facilities[variant.placements.find(placement => placement.operatorId === id('桃金娘'))!.roomId].type === 'dormitory')
    expect(dormPlans.length).toBeGreaterThan(0)
    expect(dormPlans.every(variant => variant.placements.find(placement => placement.operatorId === id('桃金娘'))?.roomId === 'dormitory_2')).toBe(true)
    expect(variants.every(variant => !variant.placements.some(placement => placement.operatorId === id('杜林')))).toBe(true)
    for (const variant of variants) expect(applyCombinationVariant(base, variant)!.mainPlan.facilities.dormitory_1.slots[0]).toEqual(keeper)
    expect(base).toEqual(before)
  })

  it('does not create a dorm recovery branch when all existing rooms already have the stronger group category', () => {
    const { base, inventory } = fixture(['鸿雪', '图耶', '桃金娘', '杜林', '响石', '芬'])
    for (const [index, roomId] of (['dormitory_1', 'dormitory_2'] as const).entries()) {
      base.mainPlan.facilities[roomId].slots[0]!.occupant = { kind: 'operator', operatorId: id(['杜林', '响石'][index]!) }
    }
    const variants = enumerateCombinationVariants(base, inventory).filter(variant => variant.definitionId === 'pozemka_durin' && variant.optionalOperatorIds.includes(id('桃金娘')))
    expect(variants.length).toBeGreaterThan(0)
    expect(variants.every(variant => ['factory', 'train'].includes(base.mainPlan.facilities[variant.placements.find(placement => placement.operatorId === id('桃金娘'))!.roomId].type))).toBe(true)
  })

  it('keeps user locks and a real recovery bed while providing an auxiliary fallback', () => {
    const { base, inventory } = fixture(['鸿雪', '图耶', '杜林', '芬'])
    const locked = new Set(Array.from({ length: 5 }, (_, index) => `dormitory_1:${index}`))
    base.mainPlan.facilities.dormitory_2.slots.slice(1).forEach(slot => { slot.occupant = { kind: 'current' } })
    const before = structuredClone(base), variants = enumerateCombinationVariants(base, inventory, locked)
      .filter(variant => variant.definitionId === 'pozemka_durin' && variant.optionalOperatorIds.includes(id('杜林')))
    expect(variants.length).toBeGreaterThan(0)
    expect(variants.every(variant => variant.placements.find(placement => placement.operatorId === id('杜林'))?.roomId === 'factory')).toBe(true)
    expect(base).toEqual(before)
  })

  it('does not invent an omitted dormitory and retains complete auxiliary-only presence', () => {
    const { base, inventory } = fixture()
    for (const roomId of ['dormitory_1', 'dormitory_2'] as const) { base.mainPlan.facilities[roomId].level = 0; base.mainPlan.facilities[roomId].slots = [] }
    const variants = enumerateCombinationVariants(base, inventory).filter(variant => variant.definitionId === 'pozemka_durin' &&
      ['杜林', '桃金娘'].every(name => variant.optionalOperatorIds.includes(id(name))))
    expect(variants.length).toBeGreaterThan(0)
    expect(variants.every(variant => variant.placements.every(placement => base.mainPlan.facilities[placement.roomId].type !== 'dormitory'))).toBe(true)
  })

  it('retains generated dorm presence through repeated smart dormitory finishing', () => {
    const { base, inventory, entries } = fixture()
    const variant = enumerateCombinationVariants(base, inventory).find(variant => variant.definitionId === 'pozemka_durin' &&
      ['杜林', '桃金娘'].every(name => variant.placements.some(placement => placement.operatorId === id(name) && base.mainPlan.facilities[placement.roomId].type === 'dormitory')))
    expect(variant).toBeDefined()
    const value = { variant: variant!, status: 'evaluated' as const, perCapita: 1, totalGain: 1, productionCount: 2, supportCount: 2, diagnostics: [] }
    const draft = allocateCombinationSkeleton(base, { values: [value], enumeratedCount: 1, diagnostics: [] }, 0).workspace
    const placements = variant!.placements.filter(placement => base.mainPlan.facilities[placement.roomId].type === 'dormitory')
    for (let index = 0; index < 2; index++) applySmartDormitoryPolicy(draft, { entries })
    for (const placement of placements) {
      const slot = draft.mainPlan.facilities[placement.roomId].slots[placement.slotIndex]!
      expect(slot.occupant).toEqual({ kind: 'operator', operatorId: placement.operatorId })
      expect(slot.dormitoryResident).toBe(true)
    }
  })

  it('uses the actual single-target maximum instead of adding two single providers', () => {
    const { base, inventory } = fixture(['鸿雪', '图耶', 'Lancet-2', '闪灵', '芬'])
    base.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('闪灵') }
    const plans = createPresencePlacementPlanner(base, inventory)([id('Lancet-2')], new Set())
    const dorms = plans.flat().filter(placement => base.mainPlan.facilities[placement.roomId].type === 'dormitory')
    expect(dorms.length).toBeGreaterThan(0)
    expect(dorms.every(placement => placement.roomId === 'dormitory_2')).toBe(true)
  })

  it('does not spend the recovery bed reserved by an earlier provider on another presence member', () => {
    const { base, inventory } = fixture(['鸿雪', '图耶', '褐果', '杜林', '芬'])
    for (const roomId of ['factory', 'train'] as const) base.mainPlan.facilities[roomId].slots.forEach(slot => { slot.occupant = { kind: 'current' } })
    base.mainPlan.facilities.dormitory_2.level = 0; base.mainPlan.facilities.dormitory_2.slots = []
    base.mainPlan.facilities.dormitory_1.slots.slice(2).forEach(slot => { slot.occupant = { kind: 'current' } })
    const plans = createPresencePlacementPlanner(base, inventory)(['褐果', '杜林'].map(id), new Set())
    // The original last-resort physical-presence plan remains legal. An extra
    // recovery plan cannot claim a bed after spending both actual vacancies.
    expect(plans).toHaveLength(1)
    expect(plans[0]!.map(placement => placement.operatorId)).toEqual(['褐果', '杜林'].map(id))
  })
})
