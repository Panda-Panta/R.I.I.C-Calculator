import { describe, expect, it } from 'vitest'
import { OPERATOR_MAP } from './operators'
import { compileOperatorInventory, selectUnlockedSkills } from './operatorInventory'
import { resolveOperatorCharId } from './operatorIdentifiers'
import { readFileSync } from 'node:fs'

describe('v078 logistics skill stages', () => {
  it.each([
    ['char_393_toledo', '德·托莱多', ['hire_spd_cost[113]'], ['hire_spd_cost[122]', 'dorm_hireToRecAll[002]']],
    ['char_4232_hbound', '旅骨', ['recycle_spd&cost[000]'], ['recycle_spd&cost[010]', 'workshop_formula_device[080]']],
    ['char_4231_clemnt', '克莱门莎', ['meet_spd&cost[110]'], ['meet_spd&cost[110]', 'meet_spd&cost_char[000]']],
  ])('selects independent unlocked slots for %s', (id, name, initial, promoted) => {
    const operator = OPERATOR_MAP.get(id as string)
    expect(operator?.name).toBe(name)
    expect(selectUnlockedSkills(operator!, 0, 1).map(skill => skill.buffId)).toEqual(initial)
    expect(selectUnlockedSkills(operator!, 1, 1).map(skill => skill.buffId)).toEqual(initial)
    expect(selectUnlockedSkills(operator!, 2, 1).map(skill => skill.buffId)).toEqual(promoted)
  })
})

describe('v079 logistics records at normal inventory entry points', () => {
  it.each([
    { name: '塔露拉', id: 'char_4247_oxi', initial: ['train_spd_doubleProf[302]'], promoted: ['train_spd_doubleProf[302]', 'train_spd_branches[000]'] },
    { name: '冻河', id: 'char_4244_tocka', initial: ['trade_ord_spd&share[100]', 'dorm_rec_all&unfull[100]'], promoted: ['trade_ord_spd&share[110]', 'dorm_rec_all&unfull[100]'] },
    { name: '国度', id: 'char_4246_dminon', initial: ['recycle_spd&cost[100]', 'power_rec_spd[018]'], promoted: ['recycle_spd&cost[110]', 'power_rec_spd[018]'] },
    { name: '奥尔佳', id: 'char_4245_alga', initial: ['meet_spd&sami[200]'], promoted: ['meet_spd&sami[210]'] },
    { name: '行铃', id: 'char_4170_hdbell', initial: ['recycle_spd&cost[001]'], promoted: ['recycle_spd&cost[011]'] },
    { name: '镜匠', id: 'char_4169_caledo', initial: ['workshop_formula_probability[1111]'], promoted: ['workshop_formula_probability[1121]', 'workshop_formula_drop[050]'] },
  ])('loads $name with independent stages and its shipped avatar', ({ name, id, initial, promoted }) => {
    const operator = OPERATOR_MAP.get(id)!
    expect(operator.name).toBe(name)
    expect(resolveOperatorCharId(name)).toBe(id)
    expect(selectUnlockedSkills(operator, 0, 1).map(skill => skill.buffId)).toEqual(initial)
    expect(selectUnlockedSkills(operator, 1, 1).map(skill => skill.buffId)).toEqual(initial)
    expect(selectUnlockedSkills(operator, 2, 1).map(skill => skill.buffId)).toEqual(promoted)
    const inventory = compileOperatorInventory([{ operator: name, elitePhase: 2, level: 1 }])
    expect(inventory.valid).toBe(true)
    expect(inventory.operators[0]?.charId).toBe(id)
    const avatar = readFileSync(new URL(`../../public/avatar/${name}.webp`, import.meta.url))
    expect(avatar.subarray(0, 4).toString()).toBe('RIFF')
    expect(avatar.subarray(8, 12).toString()).toBe('WEBP')
    for (const skill of operator.skills) {
      const icon = readFileSync(new URL(`../../public/building_skill/${skill.skillIcon}.webp`, import.meta.url))
      expect(icon.subarray(8, 12).toString(), skill.skillIcon).toBe('WEBP')
    }
  })
})
