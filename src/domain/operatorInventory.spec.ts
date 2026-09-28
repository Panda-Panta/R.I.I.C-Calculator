import { describe, expect, it } from 'vitest'
import { OPERATORS } from './operators'
import { compileOperatorInventory, fullCatalogIdleInventory, parseOperatorInventory, selectUnlockedSkills } from './operatorInventory'

const op = (name: string) => OPERATORS.find(o => o.name === name)!
describe('owned operator skill stages', () => {
  it('replaces versions within one slot and retains independent slots', () => {
    expect(selectUnlockedSkills(op('温蒂'), 0, 1).map(s => s.buffId)).toEqual(['manu_prod_spd&power[010]'])
    expect(selectUnlockedSkills(op('温蒂'), 2, 1).map(s => s.buffId)).toEqual(['manu_prod_spd&power[020]'])
    expect(selectUnlockedSkills(op('但书'), 0, 1).map(s => s.buffId)).toEqual(['trade_ord_law[000]', 'trade_ord_against[000]'])
    expect(selectUnlockedSkills(op('孑'), 0, 45)).toHaveLength(1)
    expect(selectUnlockedSkills(op('孑'), 1, 1)).toHaveLength(2)
  })
  it('keeps low-stage facilities and observes level 30 unlocks', () => {
    expect(selectUnlockedSkills(op('砾'), 0, 1).map(s => s.roomType)).toEqual(['WORKSHOP'])
    expect(selectUnlockedSkills(op('Lancet-2'), 0, 29)).toHaveLength(1)
    expect(selectUnlockedSkills(op('Lancet-2'), 0, 30)).toHaveLength(2)
    expect(compileOperatorInventory([{operator:'砾', elitePhase:1, level:1}]).operators[0]!.matchesMaximumSkills).toBe(true)
  })
  it('rejects invalid and duplicate records instead of silently inventing ownership', () => {
    const result = compileOperatorInventory([
      {operator:'不存在', elitePhase:0, level:1},
      {operator:'Lancet-2', elitePhase:2, level:1},
      {operator:'芬', elitePhase:0, level:41},
      {operator:'砾', elitePhase:1, level:1},
      {operator:op('砾').charId, elitePhase:0, level:1},
    ])
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(d => d.code)).toEqual(['UNKNOWN_OPERATOR','INVALID_STAGE','INVALID_STAGE','DUPLICATE_OPERATOR'])
  })
  it('parses explicit stages only, with line-specific errors', () => {
    expect(parseOperatorInventory('砾,1,1\nLancet-2，0，30').valid).toBe(true)
    expect(parseOperatorInventory('砾\n温蒂,二,1').diagnostics.map(d => d.line)).toEqual([1,2])
    expect(parseOperatorInventory('').entries).toEqual([])
  })
  it('reproduces all 429 maximum snapshots from the full slot catalog without mutation', () => {
    const before = JSON.stringify(OPERATORS)
    const full=compileOperatorInventory(fullCatalogIdleInventory())
    expect(full.valid).toBe(true)
    expect(full.operators).toHaveLength(429)
    expect(full.operators.every(operator=>operator.matchesMaximumSkills)).toBe(true)
    for (const operator of OPERATORS) {
      const max = operator.rarity <= 2 ? [0,30] : operator.rarity === 3 ? [1,55] : [2,70 + (operator.rarity - 4)*10]
      expect(selectUnlockedSkills(operator,max[0]!,max[1]!).map(s => s.buffId),operator.name).toEqual(operator.skills.map(s => s.buffId))
    }
    expect(OPERATORS).toHaveLength(429)
    expect(JSON.stringify(OPERATORS)).toBe(before)
  })
})

it('supports earlier-stage levels after promotion and preserves the first independent slot', () => {
  expect(selectUnlockedSkills(op('杜林'),0,29)).toHaveLength(1)
  expect(selectUnlockedSkills(op('杜林'),0,30)).toHaveLength(1)
  expect(selectUnlockedSkills(op('杜林'),0,29)[0]!.buffId).not.toBe(selectUnlockedSkills(op('杜林'),0,30)[0]!.buffId)
  expect(compileOperatorInventory([{operator:'菲亚梅塔',elitePhase:0,level:1}]).operators[0]!.matchesMaximumSkills).toBe(true)
  const synthetic={...op('砾'),skillSlots:[[{...op('砾').skills[0]!,unlockPhase:0,unlockLevel:30}]]}
  expect(selectUnlockedSkills(synthetic,1,1)).toHaveLength(1)
})

it('round-trips BOM, blank lines, Chinese separators and tabular cells',()=>{
 const parsed=parseOperatorInventory('\uFEFF砾，1，1\n\nLancet-2\t0\t30')
 expect(parsed.valid).toBe(true)
 expect(parsed.entries).toEqual([{operator:'砾',elitePhase:1,level:1},{operator:'Lancet-2',elitePhase:0,level:30}])
 expect(parseOperatorInventory('\uFEFF'+parsed.entries.map(e=>[e.operator,e.elitePhase,e.level].join(',')).join('\n')).entries).toEqual(parsed.entries)
})
