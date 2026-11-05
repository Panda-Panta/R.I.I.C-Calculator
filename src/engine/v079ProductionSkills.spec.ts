import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { OPERATORS } from '../domain/operators'
import { evaluateDormitoryRecovery } from './dormitoryRecovery'
import { evaluateOperators } from './operatorRules'
import { receptionClueEfficiency } from './supportFacilities/receptionClues'

const TOCKA = 'char_4244_tocka'
const ALGA = 'char_4245_alga'
const id = (name: string) => OPERATORS.find(operator => operator.name === name)!.charId

function ownedConfig(operator: string, elitePhase: number) {
  const inventory = compileOperatorInventory([{ operator, elitePhase, level: 1 }])
  expect(inventory.diagnostics).toEqual([])
  const config = createDefaultConfig()
  config.operatorRecords = inventoryOperatorRecords(inventory)
  return config
}

describe('Tocka trading productivity', () => {
  it.each([[0, 15], [1, 15], [2, 20]] as const)('selects one unlocked share skill at phase %s', (phase, perCoworker) => {
    const config = ownedConfig(TOCKA, phase)
    const room = config.rooms.find(candidate => candidate.type === 'trading')!
    for (let coworkers = 0; coworkers <= 2; coworkers++) {
      room.operatorIds = [TOCKA, ...['芬', '香草'].slice(0, coworkers).map(id)]
      const result = evaluateOperators(room, config)
      expect(result.operatorContributions.find(operator => operator.operatorId === TOCKA)?.skillBonus).toBe(perCoworker * coworkers)
      expect(result.unquantifiedSkills).toEqual([])
    }
  })

  it('counts other working operators in the same trading post', () => {
    const config = ownedConfig(TOCKA, 2)
    const room = config.rooms.find(candidate => candidate.type === 'trading')!
    room.operatorIds = [TOCKA, id('芬'), id('香草')]
    config.zeroMoraleOperatorIds = [id('芬')]
    const run = (active?: Set<string>) => evaluateOperators(room, config, active)
      .operatorContributions.find(operator => operator.operatorId === TOCKA)?.skillBonus
    expect(run()).toBe(20)
    expect(run(new Set([TOCKA]))).toBe(0)
    config.rooms.find(candidate => candidate !== room && candidate.type === 'trading')!.operatorIds = [id('芬')]
    room.operatorIds = [TOCKA]
    expect(run()).toBe(0)
    room.operatorIds.push(id('香草'))
    config.zeroMoraleOperatorIds = [TOCKA]
    expect(run()).toBe(0)
  })

  it.each([['火哨', 30], ['吉星', 40]] as const)('retains the existing maximum share bonus for %s', (name, bonus) => {
    const config = createDefaultConfig()
    const room = config.rooms.find(candidate => candidate.type === 'trading')!
    room.operatorIds = [id(name), id('芬'), id('香草')]
    const result = evaluateOperators(room, config)
    expect(result.operatorContributions.find(operator => operator.operatorId === id(name))?.skillBonus).toBe(bonus)
    expect(result.unquantifiedSkills).toEqual([])
  })
})

describe('Tocka dormitory recovery', () => {
  function setup(names = ['冻河', '芬']) {
    const config = ownedConfig(TOCKA, 0)
    config.facilities.dormitories = [5]
    config.facilityOperatorIds.dormitories = [names.map(id)]
    return config
  }

  it.each([[24, 24, .1], [24, 10, .11], [0, 10, .12]] as const)(
    'counts unfinished dorm occupants at provider morale %s and target morale %s',
    (providerMood, targetMood, bonus) => {
      const config = setup()
      const result = evaluateDormitoryRecovery(config, 0, new Map([[TOCKA, providerMood], [id('芬'), targetMood]]), 5000)
      expect(result.rates.get(id('芬'))).toBeCloseTo(4 + bonus)
      expect(result.unquantified).toEqual([])
    },
  )

  it('uses the shared full-morale tolerance and only occupants of this dorm', () => {
    const config = setup()
    config.facilityOperatorIds.dormitories.push([id('香草')])
    config.facilities.dormitories.push(5)
    const morale = new Map([[TOCKA, 23.99999999999], [id('芬'), 10], [id('香草'), 0]])
    expect(evaluateDormitoryRecovery(config, 0, morale, 5000).rates.get(id('芬'))).toBeCloseTo(4.11)
    morale.set(TOCKA, 23.999999)
    expect(evaluateDormitoryRecovery(config, 0, morale, 5000).rates.get(id('芬'))).toBeCloseTo(4.12)
  })

  it.each([['杜林', .25], ['波卜', .23]] as const)('takes the same-category maximum with %s', (peer, bonus) => {
    const config = setup(['冻河', '芬', peer])
    const morale = new Map(config.facilityOperatorIds.dormitories[0]!.map(operator => [operator, 10]))
    const result = evaluateDormitoryRecovery(config, 0, morale, 5000)
    expect(result.rates.get(id('芬'))).toBeCloseTo(4 + bonus)
    expect(result.unquantified).toEqual([])
  })

  it('counts an unfinished Fiammetta while retaining her fixed recovery', () => {
    const config = setup(['冻河', '芬', '菲亚梅塔'])
    const result = evaluateDormitoryRecovery(config, 0, new Map([[TOCKA, 24], [id('芬'), 10], [id('菲亚梅塔'), 10]]), 5000)
    expect(result.rates.get(id('芬'))).toBeCloseTo(4.12)
    expect(result.rates.get(id('菲亚梅塔'))).toBe(2)
  })
})

describe('Alga reception collaboration', () => {
  function setup(phase: number, peer?: string) {
    const ids = [ALGA, ...(peer ? [id(peer)] : [])]
    const inventory = compileOperatorInventory([
      { operator: ALGA, elitePhase: phase, level: 1 },
      ...fullCatalogIdleInventory().filter(entry => ids.includes(entry.operator) && entry.operator !== ALGA),
    ])
    expect(inventory.diagnostics).toEqual([])
    const config = createDefaultConfig()
    config.operatorRecords = inventoryOperatorRecords(inventory)
    config.facilityOperatorIds.reception = ids
    return { config, phases: new Map(inventory.operators.map(operator => [operator.charId, operator.elitePhase])) }
  }

  function skillBonus(scene: ReturnType<typeof setup>): number {
    const { config, phases } = scene
    const record = config.operatorRecords![ALGA]!
    const full = receptionClueEfficiency(config, phases)
    config.operatorRecords = { ...config.operatorRecords, [ALGA]: { ...record, skills: [] } }
    return full - receptionClueEfficiency(config, phases)
  }

  it.each([[0, .1], [1, .1], [2, .3]] as const)('selects the unlocked skill at phase %s', (phase, expected) => {
    expect(skillBonus(setup(phase, '古米'))).toBeCloseTo(expected)
  })

  it.each(['早露', '凛冬', '真理', '古米', '烈夏', '苦艾'])('matches the explicit student tooltip member %s', peer => {
    expect(skillBonus(setup(2, peer))).toBeCloseTo(.3)
  })

  it.each(['怒潮凛冬', '冻河'])('excludes %s from the explicit student tooltip', peer => {
    expect(skillBonus(setup(2, peer))).toBeCloseTo(.1)
  })

  it('requires an awake coworker in the same reception room', () => {
    const scene = setup(2, '古米')
    scene.config.operatorMorale[id('古米')] = 0
    expect(skillBonus(scene)).toBeCloseTo(.1)
    const alone = setup(2)
    alone.config.facilityOperatorIds.office = [id('古米')]
    expect(skillBonus(alone)).toBeCloseTo(.1)
  })

  it.each(['morale', 'exhausted'] as const)('requires the provider to work with %s suppression', mode => {
    const scene = setup(2, '古米')
    if (mode === 'morale') scene.config.operatorMorale[ALGA] = 0
    else scene.config.zeroMoraleOperatorIds = [ALGA]
    expect(skillBonus(scene)).toBe(0)
  })
})
