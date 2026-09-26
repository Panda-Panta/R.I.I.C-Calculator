import { describe, it, expect } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { OPERATORS } from '../domain/operators'
import { evaluateOperators } from './operatorRules'
import { currentMoraleRates } from './morale'

const findOpId = (name: string) => OPERATORS.find(o => o.name === name)!.charId

describe('quantification of remaining operator skills (1.2)', () => {
  it('quantifies Gladiia Elite 0/1 cluster hunting skill without unquantified warnings', () => {
    const config = createDefaultConfig()
    const gladiia = OPERATORS.find(o => o.name === '歌蕾蒂娅')!
    // Setup Gladiia with E0 skill
    const e0Skill = {
      buffId: 'control_mp_aegir2[000]',
      name: '集群狩猎·α',
      description: '进驻控制中枢时，控制中枢内所有干员的心情每小时恢复+0.05；基建内（不包含副手及活动室使用者）深海猎人干员获得特殊加成（与部分技能有特殊叠加规则）',
      roomType: 'CONTROL' as const,
      skillIcon: '',
      unlockPhase: 0,
      unlockLevel: 1,
    }
    config.controlOperatorIds = [gladiia.charId]
    config.operatorRecords = {
      [gladiia.charId]: { ...gladiia, skills: [e0Skill] },
    }

    const room = config.rooms.find(r => r.type === 'manufacture')!
    const specter = findOpId('幽灵鲨')
    const ulpian = findOpId('乌尔比安')
    room.operatorIds = [specter, ulpian]

    const result = evaluateOperators(room, config)
    expect(result.unquantifiedSkills).toEqual([])
    // 2 hunters in manufacture * 2 hunters in room * 5% = 20%
    expect(result.skillBonus).toBe(20)
    expect(result.details.some(d => d.includes('歌蕾蒂娅·集群狩猎'))).toBe(true)
  })

  it('quantifies PhonoR-0 resonant chant with Logos in training room', () => {
    const config = createDefaultConfig()
    const phonor = findOpId('PhonoR-0')
    const logos = findOpId('逻各斯')

    const powerRoom = config.rooms.find(r => r.type === 'power')!
    powerRoom.operatorIds = [phonor]

    // Without Logos
    const resultWithout = evaluateOperators(powerRoom, config)
    expect(resultWithout.unquantifiedSkills).not.toContain('PhonoR-0·咒文共鸣')
    const basePower = resultWithout.efficiencyPercent

    // With Logos in training room (which is 协助位 per passive training directive)
    config.facilityOperatorIds.training = [logos]
    config.efficiencyResources.trainingOperatorIds = [logos]
    const resultWith = evaluateOperators(powerRoom, config)
    expect(resultWith.unquantifiedSkills).not.toContain('PhonoR-0·咒文共鸣')
    // Additional +5% from Logos
    expect(resultWith.efficiencyPercent).toBe(basePower + 5)
    expect(resultWith.details.some(d => d.includes('PhonoR-0·咒文共鸣'))).toBe(true)
  })

  it('quantifies Jie Yun ancient witchcraft and witchcraft crystals without unquantified warnings', () => {
    const config = createDefaultConfig()
    const jieyun = findOpId('截云')
    const room = config.rooms.find(r => r.type === 'manufacture')!
    room.operatorIds = [jieyun]

    // Set 15 fireworks -> 3 crystals -> 3 * 2% = 6%
    config.efficiencyResources.worldlyFireworks = 15

    const result = evaluateOperators(room, config)
    expect(result.unquantifiedSkills).toEqual([])
    expect(result.skillBonus).toBe(6)
  })

  it('handles mood drain skills in trading and power without unquantified warnings', () => {
    const config = createDefaultConfig()

    // Firewhistle, Texas in trading
    const tradeRoom = config.rooms.find(r => r.type === 'trading')!
    for (const name of ['火哨', '德克萨斯']) {
      tradeRoom.operatorIds = [findOpId(name)]
      expect(evaluateOperators(tradeRoom, config).unquantifiedSkills).toEqual([])
    }

    // Spuria, THRM-EX in power
    const powerRoom = config.rooms.find(r => r.type === 'power')!
    for (const name of ['空构', 'THRM-EX']) {
      powerRoom.operatorIds = [findOpId(name)]
      expect(evaluateOperators(powerRoom, config).unquantifiedSkills).toEqual([])
    }
  })

  it('keeps Duo Ling and unworked Shu as unquantified efficiency per optimizer contract', () => {
    const config = createDefaultConfig()
    const tradeRoom = config.rooms.find(r => r.type === 'trading')!
    tradeRoom.operatorIds = [findOpId('铎铃')]
    expect(evaluateOperators(tradeRoom, config).unquantifiedSkills).toContain('铎铃·万里传书')

    const manuRoom = config.rooms.find(r => r.type === 'manufacture')!
    manuRoom.operatorIds = [findOpId('黍')]
    expect(evaluateOperators(manuRoom, config).unquantifiedSkills).toContain('黍·春雷响，万物长')
  })

  it('smoothly quantifies worked Shu and teamed Duo Ling without unquantified warnings', () => {
    const config = createDefaultConfig()
    const manuRoom = config.rooms.find(r => r.type === 'manufacture')!
    const shuId = findOpId('黍')
    manuRoom.operatorIds = [shuId]
    config.efficiencyResources.worldlyFireworks = 15 // worked with fireworks

    const manuRes = evaluateOperators(manuRoom, config)
    expect(manuRes.unquantifiedSkills).toEqual([])
    expect(manuRes.skillBonus).toBe(5) // 15 / 3 = 5%

    // Check morale rate: Shu provides -0.1/h to manufacture room
    const moraleRes = currentMoraleRates(config)
    expect(moraleRes.unquantified).toEqual([])
    // Base 1.0 - 0.1 = 0.9/h
    expect(moraleRes.rates[shuId]).toBeCloseTo(0.9)

    // Teamed Duo Ling (e.g. with Jaye or Texas)
    const tradeRoom = config.rooms.find(r => r.type === 'trading')!
    tradeRoom.operatorIds = [findOpId('德克萨斯'), findOpId('铎铃')]
    const tradeRes = evaluateOperators(tradeRoom, config)
    expect(tradeRes.unquantifiedSkills).toEqual([])
  })

  it('quantifies trade order capacity and negotiation skills without unquantified warnings', () => {
    const config = createDefaultConfig()
    const tradeRoom = config.rooms.find(r => r.type === 'trading')!

    for (const name of ['佩佩', '瑰盐', '拉普兰德', '暗索', '桃金娘', '史都华德']) {
      tradeRoom.operatorIds = [findOpId(name)]
      expect(evaluateOperators(tradeRoom, config).unquantifiedSkills).toEqual([])
    }
  })

  it('quantifies Hung Lee agency morale recovery skill in control center without unquantified warnings', () => {
    const config = createDefaultConfig()
    const hmau = findOpId('吽')
    const amiya = findOpId('阿米娅')
    config.controlOperatorIds = [hmau, amiya]
    const result1 = currentMoraleRates(config)
    expect(result1.unquantified).toEqual([])
    // 2 operators in control -> base -0.10/h
    // 1 Lee operator -> Hung all -0.05/h, Lee faction extra -0.20/h
    expect(result1.rates[amiya]).toBeCloseTo(0.85)
    expect(result1.rates[hmau]).toBeCloseTo(0.65)

    // With Aak (who adds +1.5/h to all in control center)
    const aak = findOpId('阿')
    config.controlOperatorIds = [hmau, aak, amiya]
    const result2 = currentMoraleRates(config)
    expect(result2.unquantified).toEqual([])
    // 3 operators in control -> base -0.15/h
    // 2 Lee operators -> Hung all -0.10/h, Lee faction extra -0.40/h
    // Aak adds +1.5/h to all
    expect(result2.rates[amiya]).toBeCloseTo(2.25)
    expect(result2.rates[hmau]).toBeCloseTo(1.85)
  })
})
