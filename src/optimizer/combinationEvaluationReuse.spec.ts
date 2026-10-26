import { afterEach, describe, expect, it, vi } from 'vitest'
import * as operatorContext from '../domain/operatorContext'
import { compileOperatorInventory, fullCatalogIdleInventory, type OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { buildCombinationPool, evaluateCombinationVariant } from './combinationEvaluation'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { applyCombinationVariant, shiftSnapshot, type CombinationVariant } from './combinationModel'
import * as controlImpact from './controlImpact'
import { projectRosterConfig } from './rosterProjection'

afterEach(() => vi.restoreAllMocks())

function inventory(names: string[]) {
  return compileOperatorInventory(fullCatalogIdleInventory().filter(o => names.some(name => id(name) === o.operator)))
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

function projection(base: RosterWorkspace, owned: OperatorInventory) {
  const config = projectRosterConfig(base)
  config.operatorRecords = operatorContext.inventoryOperatorRecords(owned)
  return controlImpact.projectControlOutput(config)
}

describe('combination evaluation allocation cost', () => {
  it('constructs actual-stage records once for an entire pool', () => {
    const base = createDefaultWorkspace(), owned = inventory(['苍苔', '砾', '斑点'])
    const records = vi.spyOn(operatorContext, 'inventoryOperatorRecords')
    const pool = buildCombinationPool(base, owned)
    expect(pool.values.length).toBeGreaterThan(1)
    expect(pool.values.every(value => value.status === 'evaluated')).toBe(true)
    expect(records).toHaveBeenCalledTimes(1)
  })

  it('does not clone an already isolated main placement just to select the main shift', () => {
    const base = createDefaultWorkspace(), owned = inventory(['苍苔'])
    const variant = enumerateCombinationVariants(base, owned)[0]!
    const clones = vi.spyOn(globalThis, 'structuredClone')
    const value = evaluateCombinationVariant(base, owned, variant, 0)
    expect(value.status).toBe('evaluated')
    expect(value.perCapita).toBe(35)
    // One transactional placement and the four clones within config projection.
    expect(clones.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('reuses records for the standalone evaluator baseline as well', () => {
    const base = createDefaultWorkspace(), owned = inventory(['苍苔'])
    const variant = enumerateCombinationVariants(base, owned)[0]!
    const records = vi.spyOn(operatorContext, 'inventoryOperatorRecords')
    expect(evaluateCombinationVariant(base, owned, variant).status).toBe('evaluated')
    expect(records).toHaveBeenCalledTimes(1)
  })
})

describe('combination evaluation projection equivalence', () => {
  it.each(['main', 'backup'] as const)('preserves the complete %s projection with cross-room support and fixed duty', role => {
    const base = createDefaultWorkspace()
    base.productionWeights = { exp: 3, gold: 7, orders: 2, fragments: 11, orundum: 13 }
    base.mainPlan.facilities.room_2_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('杰西卡') }
    base.mainPlan.conf.workaholic = [id('杰西卡')]
    const variant: CombinationVariant = {
      id: `perception-${role}`, definitionId: 'pure_perception', name: '纯感知信息体系',
      coreOperatorIds: [id('迷迭香'), id('絮雨')], optionalOperatorIds: [id('黑键'), id('琴柳')], policy: {},
      placements: [
        { roomId: 'room_1_1', slotIndex: 0, operatorId: id('迷迭香'), role },
        { roomId: 'contact', slotIndex: 0, operatorId: id('絮雨'), role },
        { roomId: 'room_3_1', slotIndex: 0, operatorId: id('黑键'), role },
        { roomId: 'central', slotIndex: 0, operatorId: id('琴柳'), role },
      ],
    }
    if (role === 'backup') {
      const outgoing = ['砾', '梓兰', '古米', '阿米娅']
      variant.placements.forEach((p, index) => {
        const slot = base.mainPlan.facilities[p.roomId].slots[p.slotIndex]!
        slot.occupant = { kind: 'operator', operatorId: id(outgoing[index]!) }
        slot.groupId = 'cross-room'
      })
    }
    const owned = inventory(['迷迭香', '絮雨', '黑键', '琴柳', '杰西卡', '砾', '梓兰', '古米', '阿米娅'])
    const before = structuredClone({ base, owned, variant })
    const reference = projection(base, owned)
    const expected = projection(shiftSnapshot(applyCombinationVariant(base, variant)!, role), owned)
    expect(expected.complete).toBe(true)
    frozen(base); frozen(owned); frozen(variant)
    const project = vi.spyOn(controlImpact, 'projectControlOutput')
    const value = evaluateCombinationVariant(base, owned, variant, reference.daily.score)
    expect(value.status).toBe('evaluated')
    expect(value.productionCount).toBe(2)
    expect(value.supportCount).toBe(2)
    expect(value.totalGain).toBe(expected.daily.score - reference.daily.score)
    expect(project).toHaveBeenCalledTimes(1)
    expect(project.mock.results[0]!.value).toEqual(expected)
    expect({ base, owned, variant }).toEqual(before)
  })

  it.each(['maximum', 'mixed', 'empty', 'invalid'] as const)('matches isolated evaluations for a %s inventory without changing inputs', kind => {
    const base = createDefaultWorkspace()
    const names = ['迷迭香', '絮雨', '黑键', '多萝西', '娜斯提', '伊芙利特']
    const entries = fullCatalogIdleInventory().filter(o => names.some(name => id(name) === o.operator))
    if (kind === 'mixed') {
      for (const entry of entries.filter(o => ['黑键', '多萝西', '伊芙利特'].some(name => id(name) === o.operator))) {
        entry.elitePhase = 0; entry.level = 1
      }
    }
    const owned = compileOperatorInventory(kind === 'empty' ? [] : kind === 'invalid'
      ? [{ operator: '多萝西', elitePhase: 8, level: 1 }] : entries)
    const before = structuredClone({ base, owned })
    const baseline = projection(base, owned)
    frozen(base); frozen(owned)
    const pool = buildCombinationPool(base, owned)
    expect(pool.enumeratedCount).toBe(pool.values.length)
    expect(pool.values.length > 0).toBe(kind === 'maximum' || kind === 'mixed')
    for (const value of pool.values) {
      expect(value).toEqual(evaluateCombinationVariant(base, owned, value.variant, baseline.daily.score))
    }
    expect({ base, owned }).toEqual(before)
  })

  it('rebuilds records after actual skills change on the same inventory object', () => {
    const base = createDefaultWorkspace(), owned = inventory(['多萝西', '白面鸮'])
    const records = vi.spyOn(operatorContext, 'inventoryOperatorRecords')
    const high = buildCombinationPool(base, owned)
    const low = compileOperatorInventory([
      { operator: '多萝西', elitePhase: 0, level: 1 },
      { operator: '白面鸮', elitePhase: 0, level: 1 },
    ])
    owned.operators.splice(0, owned.operators.length, ...low.operators)
    const after = buildCombinationPool(base, owned)
    const findPair = (pool: typeof high) => pool.values.find(value => value.variant.optionalOperatorIds.includes(id('白面鸮')))!
    expect(findPair(after).perCapita).toBe(10)
    expect(findPair(high).perCapita).toBeGreaterThan(findPair(after).perCapita!)
    expect(records).toHaveBeenCalledTimes(2)
  })
})
