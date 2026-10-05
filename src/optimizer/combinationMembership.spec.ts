import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { OPERATORS } from '../domain/operators'
import { ATOMIC_UNITS } from './riicAtomicUnits'
import { checkAtomicAvailability } from './molecularSynthesis'

function owned(names: string[], phase = 2) {
  return compileOperatorInventory(names.map(name => {
    const operator = OPERATORS.find(o => o.name === name)!
    return { operator: name, elitePhase: operator.rarity < 3 ? 0 : operator.rarity === 3 ? 1 : phase,
      level: operator.rarity < 3 ? 30 : operator.rarity === 3 ? 55 : phase === 0 ? 1 : 50 } as OwnedOperatorInput
  }))
}

describe('confirmed core and optional membership', () => {
  it('admits Dorothy alone without Silence Alter or three external Rhine operators', () => {
    const value = checkAtomicAvailability(ATOMIC_UNITS.find(a => a.id === 'rhine_lab')!, owned(['多萝西']), 3, 'gold')
    expect(value.available).toBe(true)
    expect(value.coreMembers.map(m => m.name)).toEqual(['多萝西'])
  })

  it('admits owned low-stage cores without promoting their locked skills', () => {
    const inventory = owned(['多萝西'], 0)
    expect(checkAtomicAvailability(ATOMIC_UNITS.find(a => a.id === 'rhine_lab')!, inventory, 3, 'gold').available).toBe(true)
    expect(inventory.operators[0]!.skills.every(skill => skill.unlockPhase === 0)).toBe(true)
  })

  it('admits pure perception without Ebenholz', () => {
    expect(checkAtomicAvailability(ATOMIC_UNITS.find(a => a.id === 'pure_perception')!, owned(['迷迭香', '絮雨']), 3).available).toBe(true)
  })

  it('admits perception and fireworks without making Ebenholz a required core', () => {
    const unit = ATOMIC_UNITS.find(a => a.id === 'perception_fireworks')!
    const value = checkAtomicAvailability(unit, owned(['迷迭香', '絮雨', '乌有', '夕', '令']), 2)
    expect(value.available).toBe(true)
    expect(value.coreMembers.map(m => m.name)).not.toContain('黑键')
    expect(unit.nonCoreMembers?.map(m => m.name)).toContain('黑键')
  })

  it('admits the new Monster Hunter trading pair', () => {
    const unit = ATOMIC_UNITS.find(a => a.name === '怪物猎人')
    expect(unit).toBeDefined()
    expect(checkAtomicAvailability(unit!, owned(['焰狐龙梓兰', '雷狼龙S空爆']), 3).available).toBe(true)
  })

  it('chooses Ambriel as the Laterano-2 third core in two-power layouts', () => {
    const unit = ATOMIC_UNITS.find(a => a.name === '拉特兰商道-2')
    expect(unit).toBeDefined()
    const value = checkAtomicAvailability(unit!, owned(['蕾缪安', '新约能天使', '安比尔']), 2)
    expect(value.available).toBe(true)
    expect(value.coreMembers.map(m => m.name)).toEqual(['蕾缪安', '新约能天使', '安比尔'])
  })

  it('requires exactly three built power rooms for the Archetto alternative', () => {
    const unit = ATOMIC_UNITS.find(a => a.name === '拉特兰商道-2')
    expect(unit).toBeDefined()
    const inventory = owned(['蕾缪安', '新约能天使', '空弦'])
    expect(checkAtomicAvailability(unit!, inventory, 2).available).toBe(false)
    expect(checkAtomicAvailability(unit!, inventory, 3).available).toBe(true)
  })

  it('admits Mizuki alone before checking standardization supporters', () => {
    const unit = ATOMIC_UNITS.find(a => a.name === '水月组')
    expect(unit).toBeDefined()
    expect(checkAtomicAvailability(unit!, owned(['水月']), 3, 'exp').available).toBe(true)
  })

  it('does not make optional Durin resource supporters a core admission gate', () => {
    expect(checkAtomicAvailability(ATOMIC_UNITS.find(a => a.id === 'pozemka_durin')!, owned(['鸿雪', '图耶']), 3).available).toBe(true)
  })
})
