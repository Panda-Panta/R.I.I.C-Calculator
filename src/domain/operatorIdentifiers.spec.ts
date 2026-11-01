import { describe, expect, it } from 'vitest'
import { findOperatorByName, getOperatorName, resolveOperatorCharId, restoreOperatorMowerName } from './operatorIdentifiers'

describe('operator identifier names', () => {
  it('uses the same catalog name for IDs, exact names and case-insensitive appellations', () => {
    for (const identifier of ['char_102_texas', '德克萨斯', 'Texas', 'tExAs']) {
      expect(getOperatorName(identifier)).toBe('德克萨斯')
    }
  })

  it('preserves the existing empty and case-sensitive placeholder display contract', () => {
    for (const identifier of [null, undefined, '']) expect(getOperatorName(identifier)).toBe('')
    for (const identifier of ['Free', 'free']) expect(getOperatorName(identifier)).toBe('Free')
    for (const identifier of ['Current', 'current']) expect(getOperatorName(identifier)).toBe('Current')
    expect(getOperatorName('FREE')).toBe('FREE')
    expect(getOperatorName('CURRENT')).toBe('CURRENT')
  })

  it('preserves unknown identifiers and does not trim or normalize ID case', () => {
    for (const identifier of ['CustomOperator_999', '未知干员X', ' Texas ', 'CHAR_102_TEXAS']) {
      expect(getOperatorName(identifier)).toBe(identifier)
    }
  })

  it('keeps exact name lookup narrower than display normalization', () => {
    expect(findOperatorByName('德克萨斯')?.charId).toBe('char_102_texas')
    for (const name of ['Texas', 'char_102_texas', '未知干员X', ' 德克萨斯 ']) {
      expect(findOperatorByName(name)).toBeUndefined()
    }
  })

  it('keeps ID resolution and Mower restoration distinct from display normalization', () => {
    expect(resolveOperatorCharId('tExAs')).toBe('char_102_texas')
    expect(restoreOperatorMowerName('char_102_texas')).toBe('德克萨斯')
    expect(restoreOperatorMowerName('Texas')).toBe('Texas')
    for (const identifier of ['free', 'current', 'CustomOperator_999']) {
      expect(resolveOperatorCharId(identifier)).toBe(identifier)
      expect(restoreOperatorMowerName(identifier)).toBe(identifier)
    }
  })
})
