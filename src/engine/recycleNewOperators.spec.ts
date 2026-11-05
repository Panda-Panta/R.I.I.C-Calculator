import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { currentMoraleRates } from './morale'
import { evaluateOperators } from './operatorRules'
import { evaluateRecycleEfficiency } from './supportFacilitySkills'

const HANDBELL = 'char_4170_hdbell'
const DOMINION = 'char_4246_dminon'

function configAtStage(operator: string, elitePhase: number) {
  const inventory = compileOperatorInventory([{ operator, elitePhase, level: 1 }])
  expect(inventory.diagnostics).toEqual([])
  const config = createDefaultConfig()
  config.operatorRecords = inventoryOperatorRecords(inventory)
  config.facilities.recycle = 3
  config.facilityOperatorIds.recycle = [operator]
  return config
}

describe('v079 recycling skills', () => {
  it.each([HANDBELL, DOMINION])('uses exactly the unlocked recycling version for %s', operator => {
    for (const [phase, efficiency] of [[0, 141], [1, 141], [2, 151]] as const) {
      const config = configAtStage(operator, phase)
      const result = evaluateRecycleEfficiency(config)
      expect(result.efficiencyPercent).toBe(efficiency)
      expect(result.hoursPerMaterial).toBeCloseTo(48 / (efficiency / 100))
      expect(result).toMatchObject({ capacity: 10, operatorCapacity: 2 })
    }
  })

  it('adds skill and staffed bonuses for two distinct operators, while preserving physical capacity', () => {
    const config = configAtStage(HANDBELL, 2)
    config.facilityOperatorIds.recycle = [HANDBELL, DOMINION]
    expect(evaluateRecycleEfficiency(config).efficiencyPercent).toBe(182)
    config.facilities.recycle = 2
    expect(evaluateRecycleEfficiency(config).efficiencyPercent).toBe(162)
    config.facilities.recycle = 1
    config.operatorMorale[DOMINION] = 0
    expect(() => evaluateRecycleEfficiency(config)).toThrow('staffing exceeds facility level capacity')
  })

  it.each([HANDBELL, DOMINION])('disables %s speed for an exhausted or absent worker and an unbuilt facility', operator => {
    const config = configAtStage(operator, 2)
    expect(evaluateRecycleEfficiency(config, { activeIds: new Set() }).efficiencyPercent).toBe(120)
    config.operatorMorale[operator] = 0
    expect(evaluateRecycleEfficiency(config).efficiencyPercent).toBe(120)
    config.operatorMorale[operator] = 24
    config.zeroMoraleOperatorIds = [operator]
    config.workaholicOperatorIds = [operator]
    expect(evaluateRecycleEfficiency(config).efficiencyPercent).toBe(120)
    config.facilities.recycle = 0
    expect(evaluateRecycleEfficiency(config)).toEqual({
      efficiencyPercent: 0, hoursPerMaterial: null, capacity: 0, operatorCapacity: 0, details: [],
    })
  })

  it.each([0, 2])('keeps Dominion E%s morale reduction personal and limited to recycling', phase => {
    const config = configAtStage(DOMINION, phase)
    config.facilityOperatorIds.recycle = [DOMINION, HANDBELL]
    expect(currentMoraleRates(config).rates).toMatchObject({ [DOMINION]: .9, [HANDBELL]: 1 })
    config.operatorMorale[DOMINION] = 0
    expect(currentMoraleRates(config).rates[DOMINION]).toBeUndefined()
    expect(currentMoraleRates(config).rates[HANDBELL]).toBe(1)
    config.operatorMorale[DOMINION] = 24
    config.facilities.recycle = 0
    expect(currentMoraleRates(config).rates[DOMINION]).toBeUndefined()
    config.facilityOperatorIds.recycle = []
    config.rooms[6]!.operatorIds = [DOMINION]
    expect(currentMoraleRates(config).rates[DOMINION]).toBe(1)
  })

  it.each([0, 2])('uses Dominion E%s power skill independently of its recycling speed and morale skill', phase => {
    const config = configAtStage(DOMINION, phase)
    config.facilityOperatorIds.recycle = []
    const power = config.rooms[6]!
    power.operatorIds = [DOMINION]
    const result = evaluateOperators(power, config)
    expect(result.skillBonus).toBe(15)
    expect(result.unquantifiedSkills).toEqual([])
    expect(currentMoraleRates(config).rates[DOMINION]).toBe(1)
    config.zeroMoraleOperatorIds = [DOMINION]
    expect(evaluateOperators(power, config).skillBonus).toBe(0)
  })

  it('rejects an added prerequisite on a known new skill instead of dropping it', () => {
    const config = configAtStage(DOMINION, 2)
    const operator = config.operatorRecords![DOMINION]!
    const skill = operator.skills.find(skill => skill.roomType === 'RECYCLE')!
    config.operatorRecords = {
      [DOMINION]: { ...operator, skills: [{ ...skill, description: `${skill.description}；需要其他干员同站` }] },
    }
    expect(() => evaluateRecycleEfficiency(config)).toThrow('Unquantified recycle skill')
  })
})
