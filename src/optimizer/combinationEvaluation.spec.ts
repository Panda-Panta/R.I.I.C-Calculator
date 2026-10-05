import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { buildCombinationPool, evaluateCombinationVariant } from './combinationEvaluation'

const inventory = (names: string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(o => names.some(name => id(name) === o.operator)))

describe('whole combination efficiency', () => {
  it('ranks available perception before higher-efficiency families, preferring optional Ebenholz', () => {
    const pool = buildCombinationPool(createDefaultWorkspace(), inventory(['迷迭香', '絮雨', '黑键', '多萝西']))
    const evaluated = pool.values.filter(v => v.status === 'evaluated')
    expect(evaluated.some(v => v.variant.definitionId === 'rhine_lab')).toBe(true)
    expect(evaluated[0]!.variant.definitionId).toBe('pure_perception')
    expect(evaluated[0]!.variant.optionalOperatorIds).toContain(id('黑键'))
    const firstOther = evaluated.findIndex(v => v.variant.definitionId !== 'pure_perception')
    expect(evaluated.slice(firstOther).every(v => v.variant.definitionId !== 'pure_perception')).toBe(true)
  })

  it('does not require the optional Blackkey maximum skill stage to prefer his available variant', () => {
    const inputs = fullCatalogIdleInventory().filter(o => ['迷迭香', '絮雨', '黑键'].some(name => id(name) === o.operator))
    Object.assign(inputs.find(o => o.operator === id('黑键'))!, { elitePhase: 0, level: 1 })
    const owned = compileOperatorInventory(inputs)
    const first = buildCombinationPool(createDefaultWorkspace(), owned).values.find(v => v.status === 'evaluated')!
    expect(first.variant.optionalOperatorIds).toContain(id('黑键'))
    expect(owned.operators.find(o => o.charId === id('黑键'))!.skills.every(s => s.unlockPhase === 0)).toBe(true)
  })

  it('calculates Cangtai complete teams as 35, 75 and 110 skill percent', () => {
    const base = createDefaultWorkspace()
    const owned = inventory(['苍苔', '砾', '斑点'])
    const variants = enumerateCombinationVariants(base, owned).filter(v => v.definitionId === 'cantabile_metalcraft' && v.placements.every(p => p.roomId === 'room_1_1'))
    const values = variants.map(v => evaluateCombinationVariant(base, owned, v))
    const gains = values.map(v => v.perCapita! * v.productionCount).sort((a, b) => a - b)
    expect(gains).toEqual([35, 70, 75, 110])
    expect(values.every(v => v.status === 'evaluated')).toBe(true)
  })

  it('scores Nasti using actually stationed Rhine supporters', () => {
    const base = createDefaultWorkspace()
    const owned = inventory(['多萝西', '娜斯提', '伊芙利特'])
    const values = buildCombinationPool(base, owned).values.filter(v => v.variant.definitionId === 'rhine_lab' && v.variant.optionalOperatorIds.includes(id('娜斯提')) &&
      v.variant.placements.find(p => p.operatorId === id('多萝西'))?.roomId === 'room_1_1')
    const simple = values.find(v => !v.variant.optionalOperatorIds.includes(id('伊芙利特')))!
    const supported = values.find(v => v.variant.optionalOperatorIds.includes(id('伊芙利特')))!
    expect(simple.status).toBe('evaluated')
    expect(supported.perCapita! - simple.perCapita!).toBeCloseTo(1.5)
  })

  it('evaluates low-stage cores without borrowing locked maximum skills', () => {
    const base = createDefaultWorkspace()
    const owned = compileOperatorInventory([{ operator: '多萝西', elitePhase: 0, level: 1 }])
    const value = buildCombinationPool(base, owned).values.find(v => v.variant.definitionId === 'rhine_lab')!
    expect(value.status).toBe('evaluated')
    // Dorothy E0 has a category counter but no unlocked Rhine additive skill of her own.
    expect(value.perCapita).toBe(0)
    const two = compileOperatorInventory([{ operator: '多萝西', elitePhase: 0, level: 1 }, { operator: '白面鸮', elitePhase: 0, level: 1 }])
    const supported = buildCombinationPool(base, two).values.find(v => v.variant.definitionId === 'rhine_lab' && v.variant.optionalOperatorIds.includes(id('白面鸮')))!
    // Ptilopsis alpha contributes 15%, Dorothy's counter contributes 5%: 20 / 2.
    expect(supported.perCapita).toBe(10)
  })
})
