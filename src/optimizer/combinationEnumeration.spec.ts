import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { enumerateCombinationVariants } from './combinationEnumeration'

const inventory = (names: string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(o => names.some(name => id(name) === o.operator)))

describe('complete core and optional enumeration', () => {
  it('enumerates only pure perception even when all former fireworks cores are owned', () => {
    const variants = enumerateCombinationVariants(createDefaultWorkspace(), inventory(['迷迭香', '絮雨', '黑键', '乌有', '夕', '令']))
    expect(variants.some(v => v.definitionId === 'perception_fireworks')).toBe(false)
    const pure = variants.filter(v => v.definitionId === 'pure_perception')
    expect(pure.length).toBeGreaterThan(0)
    expect(pure.every(v => v.coreOperatorIds.length === 2 && v.coreOperatorIds.includes(id('迷迭香')) && v.coreOperatorIds.includes(id('絮雨')))).toBe(true)
    expect(pure.some(v => v.optionalOperatorIds.includes(id('黑键')))).toBe(true)
    expect(pure.every(v => !v.placements.some(p => ['乌有', '夕', '令'].some(name => p.operatorId === id(name))))).toBe(true)
  })
  it.each([2, 3])('enumerates experience automation on %i built power stations', powerCount => {
    const base = createDefaultWorkspace()
    for (const room of Object.values(base.mainPlan.facilities)) {
      if (room.type === 'manufacture') room.product = 'exp'
    }
    if (powerCount === 2) { base.mainPlan.facilities.room_3_3.level = 0; base.mainPlan.facilities.room_3_3.slots = [] }
    const values = enumerateCombinationVariants(base, inventory(['温蒂', '森蚺', '承曦格雷伊', 'Lancet-2']))
      .filter(v => v.definitionId === 'automation')
    expect(values.length).toBeGreaterThan(0)
    expect(values.every(v => v.placements.filter(p => base.mainPlan.facilities[p.roomId].type === 'manufacture')
      .every(p => base.mainPlan.facilities[p.roomId].product === 'exp'))).toBe(true)
    expect(values.every(v => v.placements.find(p => p.operatorId === id('森蚺')) &&
      base.mainPlan.facilities[v.placements.find(p => p.operatorId === id('森蚺'))!.roomId].type === (powerCount === 2 ? 'central' : 'manufacture'))).toBe(true)
  })
  it('keeps zero, one and two metalcraft supporters without permutation duplicates', () => {
    const base = createDefaultWorkspace()
    const before = structuredClone(base)
    const variants = enumerateCombinationVariants(base, inventory(['苍苔', '砾', '斑点']))
      .filter(v => v.definitionId === 'cantabile_metalcraft' && v.placements.every(p => p.roomId === 'room_1_1'))
    expect(variants.map(v => v.optionalOperatorIds.length).sort()).toEqual([0, 1, 1, 2])
    expect(new Set(variants.map(v => v.id)).size).toBe(4)
    expect(base).toEqual(before)
  })

  it('adds currently unlocked standardization members for Mizuki', () => {
    const variants = enumerateCombinationVariants(createDefaultWorkspace(), inventory(['水月', '香草', '杰西卡']))
      .filter(v => v.definitionId === 'mizuki_standardization')
    expect(variants.some(v => v.optionalOperatorIds.includes(id('香草')) && v.optionalOperatorIds.includes(id('杰西卡')))).toBe(true)
  })

  it('builds Nasti presence plans without a three-person admission threshold', () => {
    const variants = enumerateCombinationVariants(createDefaultWorkspace(), inventory(['多萝西', '娜斯提', '伊芙利特']))
      .filter(v => v.definitionId === 'rhine_lab')
    expect(variants.some(v => v.optionalOperatorIds.includes(id('娜斯提')) && !v.optionalOperatorIds.includes(id('伊芙利特')))).toBe(true)
    const supported = variants.find(v => v.optionalOperatorIds.includes(id('娜斯提')) && v.optionalOperatorIds.includes(id('伊芙利特')))
    expect(supported).toBeDefined()
    expect(supported!.placements.some(p => p.operatorId === id('伊芙利特'))).toBe(true)
  })

  it('keeps Karlan optional members restricted to Cliffheart and Swire Alter', () => {
    const variants = enumerateCombinationVariants(createDefaultWorkspace(), inventory(['银灰', '孑', '灵知', '崖心', '琳琅诗怀雅', '雪雉', '古米', '月见夜']))
      .filter(v => v.definitionId === 'karlan')
    expect(variants.some(v => v.optionalOperatorIds.includes(id('崖心')))).toBe(true)
    expect(variants.every(v => v.optionalOperatorIds.every(ref => [id('崖心'), id('琳琅诗怀雅')].includes(ref)))).toBe(true)
  })
})
