import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { buildCombinationPool, evaluateCombinationVariant } from './combinationEvaluation'

const inventory = (names: string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(o => names.some(name => id(name) === o.operator)))

describe('whole combination efficiency', () => {
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
