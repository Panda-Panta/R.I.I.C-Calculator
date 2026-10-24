import { describe, expect, it } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { OPERATOR_MAP } from '../domain/operators'
import type { AppConfig, OutputRoom } from '../domain/types'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { simulateSchedule } from '../simulator/scheduleSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'
import { buildRiicGlobalContext } from './globalContext'
import { currentMoraleRates } from './morale'
import { evaluateOperators } from './operatorRules'
import { evaluateTradeOrderCapacity } from './orderCapacity'

function config(provider: string, phase = 2) {
  const result = createDefaultConfig()
  result.rooms = []
  result.controlOperatorIds = []
  result.operatorRecords = inventoryOperatorRecords(compileOperatorInventory([{ operator: provider, elitePhase: phase, level: 1 }]))
  return result
}
function room(c: AppConfig, type: OutputRoom['type'], names: string[], roomId = 'target') {
  const r = createRoom(roomId, type)
  r.operatorIds = names.map(id)
  r.operatorCount = r.operatorIds.length
  r.specialOrder = 'none'
  c.rooms.push(r)
  return r
}
const contribution = (c: AppConfig, r: OutputRoom, name: string) =>
  evaluateOperators(r, c).operatorContributions.find(item => item.operatorId === id(name))!.skillBonus
function liveCapacity(c: AppConfig, r: OutputRoom) {
  const active = new Set([...c.controlOperatorIds, ...r.operatorIds].filter(operator => !c.zeroMoraleOperatorIds.includes(operator)))
  return evaluateTradeOrderCapacity(r, c, active, evaluateOperators(r, c, active)).limit
}
function removeSkill(c: AppConfig, provider: string, buffId: string) {
  const operator = c.operatorRecords?.[id(provider)] ?? OPERATOR_MAP.get(id(provider))!
  c.operatorRecords = { ...c.operatorRecords, [operator.charId]: { ...operator, skills: operator.skills.filter(skill => skill.buffId !== buffId) } }
}

describe('selected control skill stages reach capacity and copy consumers', () => {
  it.each([0, 1, 2])('gates Gnosis precision on E%s in efficiency and live capacity', phase => {
    const c = config('灵知', phase)
    c.controlOperatorIds = [id('灵知')]
    const trade = room(c, 'trading', ['琳琅诗怀雅', '讯使'])
    expect(contribution(c, trade, '琳琅诗怀雅')).toBe(phase === 2 ? 52 : 28)
    expect(liveCapacity(c, trade)).toBe(phase === 2 ? 18 : 12)
    expect(contribution(c, trade, '讯使')).toBe(phase === 2 ? 0 : 15)
  })

  it('keeps highest-stage Jaye partner capacity aligned with an E0 Gnosis snapshot', () => {
    const c = config('灵知', 0)
    c.controlOperatorIds = [id('灵知')]
    const trade = room(c, 'trading', ['孑', '讯使'])
    // Courier grants +2 capacity: 12 - floor(15% / 10) = 11; Jaye gets 44%.
    expect(contribution(c, trade, '孑')).toBe(44)
    expect(liveCapacity(c, trade)).toBe(11)
  })

  it.each([0, 1, 2])('uses Walter E%s +1/+2 in both capacity consumers', phase => {
    const c = config('维什戴尔', phase)
    c.controlOperatorIds = [id('维什戴尔')]
    const trade = room(c, 'trading', ['赫德雷', '琳琅诗怀雅'])
    const grant = phase === 2 ? 2 : 1
    // Only Walter grants capacity here; Swire supplies the 4% conversion.
    expect(contribution(c, trade, '琳琅诗怀雅')).toBe(20 + grant * 4)
    expect(liveCapacity(c, trade)).toBe(10 + grant)
  })

  it.each([0, 1, 2])('gates Viviana E%s before Waai Fu copying and preserves recipient grants', phase => {
    const c = config('薇薇安娜', phase)
    c.controlOperatorIds = [id('薇薇安娜')]
    const factory = room(c, 'manufacture', ['槐琥', '砾'])
    expect(contribution(c, factory, '槐琥')).toBe(phase === 2 ? 40 : 35)
    expect(contribution(c, factory, '砾')).toBe(phase === 2 ? 42 : 35)
  })

  it.each(['absent', 'other-facility', 'exhausted', 'skill-missing'] as const)('does not grant inactive control effects: %s', state => {
    for (const [provider, buff, type, recipients] of [
      ['灵知', 'control_tra_limit&spd[000]', 'trading', ['琳琅诗怀雅', '讯使']],
      ['维什戴尔', 'control_meeting&ord[001]', 'trading', ['赫德雷', '琳琅诗怀雅']],
      ['薇薇安娜', 'control_prod_fraction[000]', 'manufacture', ['槐琥', '砾']],
    ] as const) {
      const c = config(provider)
      const target = room(c, type, [...recipients])
      const baseline = evaluateOperators(target, c)
      const capacity = type === 'trading' ? liveCapacity(c, target) : undefined
      if (state === 'other-facility') c.facilityOperatorIds.reception = [id(provider)]
      else if (state !== 'absent') c.controlOperatorIds = [id(provider)]
      if (state === 'exhausted') c.zeroMoraleOperatorIds = [id(provider)]
      if (state === 'skill-missing') {
        removeSkill(c, provider, buff)
        if (provider === '维什戴尔') removeSkill(c, provider, 'control_meeting&ord[000]')
      }
      expect(evaluateOperators(target, c).efficiencyPercent, provider).toBe(baseline.efficiencyPercent)
      if (type === 'trading') expect(liveCapacity(c, target), provider).toBe(capacity)
    }
  })
})

describe('Senshi cuisine uses his independent unlocked provider slot', () => {
  it.each([0, 1, 2])('applies E%s cuisine to manufacture and trade without changing provider data', phase => {
    const c = config('森西', phase)
    c.facilities.dormitories = [5]
    c.facilityOperatorIds.dormitories = [[id('森西')]]
    const factory = room(c, 'manufacture', ['玛露西尔'])
    const trade = room(c, 'trading', ['齐尔查克'])
    const snapshot = JSON.stringify(c.operatorRecords)
    const amount = phase === 2 ? 5 : 0
    expect(buildRiicGlobalContext(c).monsterCuisine).toBe(amount)
    for (const target of [factory, trade]) {
      const withProvider = evaluateOperators(target, c).efficiencyPercent
      const without = structuredClone(c)
      without.facilityOperatorIds.dormitories = [[]]
      expect(withProvider - evaluateOperators(target, without).efficiencyPercent).toBe(amount)
    }
    expect(JSON.stringify(c.operatorRecords)).toBe(snapshot)
  })

  it('keeps zero-morale resting cuisine, explicit overrides and dormitory scope independent', () => {
    const c = config('森西')
    c.facilities.dormitories = [5]
    c.facilityOperatorIds.dormitories = [[id('森西')]]
    c.zeroMoraleOperatorIds = [id('森西')]
    c.operatorMorale[id('森西')] = 0
    expect(buildRiicGlobalContext(c, new Set()).monsterCuisine).toBe(5)
    c.facilityOperatorIds.dormitories = [[]]
    c.facilityOperatorIds.reception = [id('森西')]
    expect(buildRiicGlobalContext(c).monsterCuisine).toBe(0)
    c.efficiencyResources.monsterCuisine = 7
    expect(buildRiicGlobalContext(c).monsterCuisine).toBe(7)
  })
})

describe('Lappland live order limit keeps the named physical same-room condition at every stage', () => {
  it.each([0, 1, 2])('checks E%s Texas presence before generic capacity parsing', phase => {
    const c = config('拉普兰德', phase)
    const trade = room(c, 'trading', ['拉普兰德'])
    expect(liveCapacity(c, trade)).toBe(10)
    c.facilityOperatorIds.reception = [id('德克萨斯')]
    expect(liveCapacity(c, trade)).toBe(10)
    c.facilityOperatorIds.reception = []
    trade.operatorIds.push(id('缄默德克萨斯'))
    expect(liveCapacity(c, trade)).toBe(10)
    trade.operatorIds[1] = id('德克萨斯')
    expect(liveCapacity(c, trade)).toBe(phase === 2 ? 14 : 12)
    // The condition is physical presence; Texas's own fatigue does not remove Lappland's grant.
    c.zeroMoraleOperatorIds = [id('德克萨斯')]
    expect(liveCapacity(c, trade)).toBe(phase === 2 ? 14 : 12)
    c.zeroMoraleOperatorIds = [id('拉普兰德')]
    expect(liveCapacity(c, trade)).toBe(10)
  })
})

const controlRecoveryProviders = [
  ['陈', '星熊', 'control_mp_cost&faction[000]', .1],
  ['寒芒克洛丝', '炎狱炎熔', 'control_mp_cost&faction[900]', .1],
  ['炎狱炎熔', '寒芒克洛丝', 'control_mp_cost&faction[900]', .1],
  ['濯尘芙蓉', '寒芒克洛丝', 'control_mp_cost&faction[900]', .1],
  ['灰烬', '闪击', 'control_mp_cost&faction[990]', .1],
  ['闪击', '灰烬', 'control_mp_cost&faction[990]', .1],
  ['霜华', '灰烬', 'control_mp_cost&faction[990]', .1],
  ['战车', '灰烬', 'control_mp_cost&faction[990]', .1],
  ['灵知', '银灰', 'control_mp_cost&faction[030]', .1],
  ['早露', '真理', 'control_mp_cost&faction[020]', .1],
  ['吽', '阿', 'control_mp_cost&faction2[000]', .5],
] as const
const otherWorkplaces = ['manufacture', 'trading', 'power', 'office', 'reception', 'recycle'] as const

describe.each(controlRecoveryProviders)('%s control recovery provider boundaries', (provider, peer, buff, grant) => {
  it.each(otherWorkplaces)('does not activate a control skill from %s', workplace => {
    const c = config(provider)
    c.controlOperatorIds = [id(peer)]
    const baseline = currentMoraleRates(c).rates[id(peer)]!
    if (workplace === 'office' || workplace === 'reception' || workplace === 'recycle') {
      c.facilityOperatorIds[workplace] = [id(provider)]
      if (workplace === 'recycle') c.facilities.recycle = 3
    } else room(c, workplace, [provider])
    expect(currentMoraleRates(c).rates[id(peer)]).toBeCloseTo(baseline, 10)
  })

  it('requires the selected control skill while preserving an active matched beneficiary', () => {
    const c = config(provider)
    c.controlOperatorIds = [provider, peer].map(id)
    const working = currentMoraleRates(c).rates[id(peer)]!
    removeSkill(c, provider, buff)
    expect(currentMoraleRates(c).rates[id(peer)]! - working).toBeCloseTo(grant, 10)
  })

  it('does not activate from a dormitory, absence or exhausted provider', () => {
    const c = config(provider)
    c.controlOperatorIds = [id(peer)]
    const baseline = currentMoraleRates(c).rates[id(peer)]!
    c.facilityOperatorIds.dormitories = [[id(provider)], [], [], []]
    expect(currentMoraleRates(c).rates[id(peer)]).toBeCloseTo(baseline, 10)
    c.facilityOperatorIds.dormitories = [[], [], [], []]
    c.controlOperatorIds.push(id(provider))
    c.operatorMorale[id(provider)] = 0
    expect(currentMoraleRates(c).rates[id(peer)]).toBeCloseTo(baseline, 10)
    expect(currentMoraleRates(c).rates[id(provider)]).toBeUndefined()
  })
})

it.each([0, 1, 2])('Hung E%s control recovery requires his unlocked second slot', phase => {
  const c = config('吽', phase)
  c.controlOperatorIds = ['吽', '阿'].map(id)
  const before = currentMoraleRates(c).rates[id('阿')]!
  removeSkill(c, '吽', 'control_mp_cost&faction2[000]')
  expect(currentMoraleRates(c).rates[id('阿')]! - before).toBeCloseTo(phase === 2 ? .5 : 0, 10)
})

function emptyWorkspace() {
  const ws = createDefaultWorkspace()
  for (const facility of Object.values(ws.mainPlan.facilities)) { facility.level = 0; facility.slots = [] }
  return ws
}
const slot = (name: string) => ({ occupant: { kind: 'operator' as const, operatorId: id(name) }, groupId: null, replacements: [] })

describe.each(['mower-default', 'mower-alpha'] as const)('provider boundaries through %s simulation', schedulingModel => {
  it('keeps control consumption unchanged when Chen works in reception', () => {
    const ws = emptyWorkspace()
    ws.mainPlan.facilities.central.level = 5
    ws.mainPlan.facilities.central.slots = [slot('星熊')]
    ws.mainPlan.facilities.meeting.level = 3
    ws.mainPlan.conf.workaholic = ['星熊', '陈'].map(id)
    const options = { schedulingModel, sampleHours: 1 }
    const baseline = simulateSchedule(compileRosterSchedule(ws), options)
    ws.mainPlan.facilities.meeting.slots = [slot('陈')]
    const actual = simulateSchedule(compileRosterSchedule(ws), options)
    expect(baseline.success).toBe(true)
    expect(actual.success, JSON.stringify(actual.diagnostics)).toBe(true)
    expect(actual.operators.find(op => op.operatorId === id('星熊'))!.finalMorale)
      .toBeCloseTo(baseline.operators.find(op => op.operatorId === id('星熊'))!.finalMorale, 8)
  })

  it.each([0, 2])('uses Senshi E%s cuisine in actual manufacturing integration', elitePhase => {
    const ws = emptyWorkspace()
    Object.assign(ws.mainPlan.facilities.room_1_1, { level: 3, type: 'manufacture', product: 'gold', slots: [slot('玛露西尔')] })
    Object.assign(ws.mainPlan.facilities.dormitory_1, { level: 5, slots: [slot('森西')] })
    ws.mainPlan.conf.workaholic = [id('玛露西尔')]
    const actual = simulateSchedule(compileRosterSchedule(ws), {
      schedulingModel, sampleHours: 1,
      operatorInventory: [{ operator: '森西', elitePhase, level: 1 }],
      consumptionOverrides: { [id('玛露西尔')]: 0 },
    })
    expect(actual.success, JSON.stringify(actual.diagnostics)).toBe(true)
    expect(actual.rooms[0]!.averageEfficiencyPercent).toBeCloseTo(elitePhase === 2 ? 136 : 131, 8)
  })
})
