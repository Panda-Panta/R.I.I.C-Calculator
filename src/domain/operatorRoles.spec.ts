import { describe, expect, it } from 'vitest'
import { isFiammetta, isProviso, isRunOrderOperator } from './operatorRoles'
import { OPERATORS } from './operators'

describe('operator roles', () => {
  it('recognizes the existing trade runner roster through each supported identifier form', () => {
    for (const name of ['但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official']) {
      const operator = OPERATORS.find(record => record.name === name)!
      expect(operator).toBeDefined()
      for (const identifier of [name, operator.charId, operator.appellation.toUpperCase()]) {
        expect(isRunOrderOperator(identifier), identifier).toBe(true)
      }
    }
  })

  it('recognizes Proviso and Fiammetta without conflating their roles', () => {
    for (const identifier of ['但书', 'char_4032_provs', 'pRoViSo']) {
      expect(isProviso(identifier)).toBe(true)
      expect(isFiammetta(identifier)).toBe(false)
    }
    for (const identifier of ['菲亚梅塔', 'char_300_phenxi', 'fIaMmEtTa']) {
      expect(isFiammetta(identifier)).toBe(true)
      expect(isProviso(identifier)).toBe(false)
    }
  })

  it('rejects empty values, placeholders, unknown names and untrimmed aliases', () => {
    for (const identifier of [null, undefined, '', 'Free', 'free', 'Current', 'current', '德克萨斯', 'Unknown', ' Proviso ']) {
      expect(isRunOrderOperator(identifier)).toBe(false)
      expect(isProviso(identifier)).toBe(false)
      expect(isFiammetta(identifier)).toBe(false)
    }
  })
})
