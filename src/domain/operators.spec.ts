import { describe, expect, it } from 'vitest'
import { OPERATORS, factionLabel, OPERATOR_PROFILE_COUNT, OPERATOR_SKILL_COUNT } from './operators'
import generated from '../data/operators.generated.json'

describe('normalized RIIC operator data', () => {
  it('contains only selectable operators with at least one RIIC skill', () => {
    expect(OPERATOR_PROFILE_COUNT).toBe(438)
    expect(factionLabel(OPERATORS.find(op => op.name === '归溟幽灵鲨')!)).toBe('异格者')
    expect(OPERATORS).toHaveLength(OPERATOR_PROFILE_COUNT)
    expect(OPERATORS.every((operator) => operator.skills.length > 0)).toBe(true)
  })

  it('keeps the expected highest-stage skill records', () => {
    expect(OPERATOR_SKILL_COUNT).toBe(770)
    expect(OPERATORS.flatMap((operator) => operator.skills)).toHaveLength(OPERATOR_SKILL_COUNT)
  })

  it('excludes mode-exclusive temporary operators', () => {
    const ids = new Set(OPERATORS.map((operator) => operator.charId))
    expect(ids.has('char_504_rguard')).toBe(false)
    expect(ids.has('char_609_acguad')).toBe(false)
  })

  it('keeps the verified arkntools overlay and all slot stages', () => {
    expect(generated.skillStageCount).toBe(944)
    const aigis = OPERATORS.find((operator) => operator.charId === 'char_4218_aigis')
    expect(aigis?.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        buffId: 'power_rec_spd_P2[999]',
        description: '进驻发电站时，无人机充能速度+15%，如果结城理进驻在制造站，则无人机充能速度额外+5%',
      }),
    ]))
    expect(OPERATORS.map((operator) => operator.charId)).toEqual(expect.arrayContaining([
      'char_4217_makoto',
      'char_4218_aigis',
      'char_4219_yukari',
      'char_4220_kormr',
    ]))
  })
})
