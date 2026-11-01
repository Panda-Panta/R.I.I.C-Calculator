import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import * as operatorContext from '../domain/operatorContext'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { OPERATOR_MAP } from '../domain/operators'
import type { OutputRoom } from '../domain/types'
import type { TimeContext } from '../engine/timeDependentSkills'
import { projectControlOutput } from './controlImpact'
import * as projection from './controlImpact'
import { createMainRosterDutyRateProjector, projectMainRosterDutyRates } from './mainRosterDutyRates'
import { DUTY_RESOURCE_KEYS, type MainRosterDutyRateInput } from './mainRosterDutyTypes'

afterEach(() => vi.restoreAllMocks())
const room = (name: string, type: 'manufacture' | 'trading', operators: string[] = []): OutputRoom => ({
  ...createRoom(name, type), specialOrder: 'none', operatorIds: operators.map(id), operatorCount: operators.length,
})
const owned = (names: string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
function input(rooms: OutputRoom[] = [], names: string[] = []): MainRosterDutyRateInput {
  const config = createDefaultConfig(); config.rooms = rooms; config.controlOperatorIds = []
  const inventory = owned(names)
  const snapshot = projectControlOutput({ ...config, operatorRecords: inventoryOperatorRecords(inventory) })
  return { config, inventory, efficiencyPercentByRoom: Object.fromEntries(snapshot.rooms.map(room => [room.roomId, room.efficiencyPercent])),
    outputMode: 'potential', inventoryMode: 'infinite', droneTarget: 'none' }
}
function actual(value: MainRosterDutyRateInput, timeContext?: TimeContext) {
  const shared = projectControlOutput({ ...value.config, operatorRecords: inventoryOperatorRecords(value.inventory) }, { timeContext })
  value.efficiencyPercentByRoom = Object.fromEntries(shared.rooms.map(room => [room.roomId, room.efficiencyPercent]))
  return shared
}

describe('joint-state unweighted duty resource rates', () => {
  it('converts actual manufacture efficiencies to EXP points, gold items and fragments per hour', () => {
    const gold = room('gold', 'manufacture'), exp = room('exp', 'manufacture'), fragments = room('fragment', 'manufacture')
    exp.product = 'exp'; fragments.product = 'fragment'
    const value = input([gold, exp, fragments]); value.efficiencyPercentByRoom = { gold: 240, exp: 300, fragment: 200 }
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.gold).toBeCloseTo(2, 12)
    expect(result.rates.exp).toBeCloseTo(1000, 10)
    expect(result.rates.fragments).toBeCloseTo(2, 12)
    expect(result.rates.orderLmd).toBe(0); expect(result.rates.virtualGold).toBe(0); expect(result.rates.orundum).toBe(0)
  })

  it('uses renewal E[reward]/E[duration] for mixed ordinary orders, not E[reward/duration]', () => {
    const value = input([room('trade', 'trading')]), result = projectMainRosterDutyRates(value)
    const expected = 60 * (.3 * 1000 + .5 * 1500 + .2 * 2000) / (.3 * 144 + .5 * 210 + .2 * 276)
    const wrong = 60 * (.3 * 1000 / 144 + .5 * 1500 / 210 + .2 * 2000 / 276)
    expect(result.status).toBe('quantified'); expect(result.rates.orderLmd).toBeCloseTo(expected, 10)
    expect(Math.abs(result.rates.orderLmd! - wrong)).toBeGreaterThan(.1)
    expect(result.assumptions.join(' ')).toMatch(/renewal|更新过程/)
    expect(result.assumptions.join(' ')).toMatch(/跨.*订单|unfinished|memory/)
    expect(result.assumptions.join(' ')).toMatch(/seed|随机/)
  })

  it('keeps physical gold and Tequila virtual gold separate without scoring either twice', () => {
    const value = input([room('gold', 'manufacture'), room('trade', 'trading', ['龙舌兰'])], ['龙舌兰'])
    const efficiency = value.efficiencyPercentByRoom.trade! / 100
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.gold).toBeCloseTo(60 / 72, 12)
    expect(result.rates.orderLmd).toBeCloseTo(60 * efficiency * 1550 / 203.4, 10)
    expect(result.rates.virtualGold).toBeCloseTo(60 * efficiency * .2 / 203.4, 12)
  })

  it('uses the fixed Pepe duration rather than multiplying its reward by manual/control efficiency', () => {
    const value = input([room('trade', 'trading', ['佩佩'])], ['佩佩', '阿米娅'])
    value.config.rooms[0]!.skillBonus = 400; value.config.controlOperatorIds = [id('阿米娅')]; actual(value)
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(1000 * 60 / 270, 10)
    expect(result.rates.virtualGold).toBeCloseTo(2 * 60 / 270, 12)
    expect(result.rates.gold).toBe(0)
  })

  it('projects a level-three orundum renewal in its own raw unit', () => {
    const trade = room('orundum', 'trading'); trade.strategy = 'orundum'; trade.skillBonus = 50
    const result = projectMainRosterDutyRates(input([trade]))
    expect(result.status).toBe('quantified'); expect(result.rates.orundum).toBeCloseTo(15, 12)
    expect(result.rates.orderLmd).toBe(0); expect(result.rates.virtualGold).toBe(0)
  })

  it('uses actual fresh warmup efficiency without promoting a missing TimeContext to the static cap', () => {
    const value = input([room('manufacture', 'manufacture', ['芬'])], ['芬'])
    const fresh = { workHoursByOperator: new Map([[id('芬'), 0]]), warmupModel: 'continuous' as const }
    const freshSnapshot = actual(value, fresh), freshEfficiency = value.efficiencyPercentByRoom.manufacture!
    const cap = projectControlOutput({ ...value.config, operatorRecords: inventoryOperatorRecords(value.inventory) }).rooms[0]!.efficiencyPercent
    expect(freshEfficiency).toBeLessThan(cap)
    const noAge = projectMainRosterDutyRates(value)
    expect(noAge.status).toBe('quantified')
    expect(noAge.rates.gold).toBeCloseTo(60 / 72 * freshEfficiency / 100, 12)
    value.timeContext = fresh
    expect(projectMainRosterDutyRates(value).rates.gold).toBeCloseTo(freshSnapshot.daily.goldValue / 500 / 24, 12)
  })

  it('uses only the actual working primary or relief state, never their marginal average', () => {
    const value = input([room('manufacture', 'manufacture', ['砾'])], ['砾', '夜烟'])
    value.config.operatorBackups = { [id('砾')]: id('夜烟') }
    const main = projectMainRosterDutyRates(value).rates.gold!
    value.config.rooms[0]!.operatorIds = [id('夜烟')]; actual(value)
    const relief = projectMainRosterDutyRates(value).rates.gold!
    expect(main).not.toBeCloseTo(relief, 9)
    expect(relief).toBeCloseTo(60 / 72 * value.efficiencyPercentByRoom.manufacture! / 100, 12)
    expect(relief).not.toBeCloseTo((main + relief) / 2, 9)
  })

  it.each(['provider-off', 'provider-zero', 'recipient-zero'] as const)('keeps actual whole-base Gladiia state: %s', mode => {
    const value = input([room('one', 'manufacture', ['斯卡蒂', '乌尔比安']), room('two', 'manufacture', ['安哲拉', '幽灵鲨'])],
      ['歌蕾蒂娅', '斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨'])
    value.config.controlOperatorIds = [id('歌蕾蒂娅')]
    if (mode === 'recipient-zero') { value.config.zeroMoraleOperatorIds = [id('斯卡蒂')]; value.config.operatorMorale[id('斯卡蒂')] = 0 }
    actual(value)
    const on = projectMainRosterDutyRates(value)
    if (mode === 'provider-zero') { value.config.zeroMoraleOperatorIds.push(id('歌蕾蒂娅')); value.config.operatorMorale[id('歌蕾蒂娅')] = 0 }
    else { value.config.controlOperatorIds = []; value.config.facilityOperatorIds.dormitories[0] = [id('歌蕾蒂娅')]; value.config.dormitoryOccupantCount = 1 }
    actual(value)
    const off = projectMainRosterDutyRates(value)
    expect(on.status).toBe('quantified'); expect(off.status).toBe('quantified')
    // Four actual manufacturing hunters, two in each room: E2 grants each room 80 points.
    expect(on.rates.gold! - off.rates.gold!).toBeCloseTo(2 * .8 * 60 / 72, 10)
  })

  it('overrides stale maximum snapshots with actual unlocked Proviso skills', () => {
    const value = input([room('trade', 'trading', ['但书'])], ['但书']), originalCatalog = structuredClone(OPERATOR_MAP.get(id('但书'))!)
    value.config.operatorRecords = inventoryOperatorRecords(value.inventory)
    value.inventory = compileOperatorInventory([{ operator: '但书', elitePhase: 0, level: 1 }]); actual(value)
    const result = projectMainRosterDutyRates(value), efficiency = value.efficiencyPercentByRoom.trade! / 100
    expect(result.status).toBe('quantified')
    // Normal L3 orders become alpha Proviso only below four gold: E[reward] = 1850.
    expect(result.rates.orderLmd).toBeCloseTo(60 * efficiency * 1850 / 203.4, 10)
    expect(result.rates.virtualGold).toBe(0)
    expect(OPERATOR_MAP.get(id('但书'))).toEqual(originalCatalog)
  })

  it('keeps low-stage Gladiia global production at the actual alpha skill', () => {
    const value = input([room('one', 'manufacture', ['斯卡蒂', '乌尔比安']), room('two', 'manufacture', ['安哲拉', '幽灵鲨'])],
      ['歌蕾蒂娅', '斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨'])
    value.config.controlOperatorIds = [id('歌蕾蒂娅')]; actual(value)
    const high = projectMainRosterDutyRates(value)
    value.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['歌蕾蒂娅', '斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨'].some(name => id(name) === entry.operator))
      .map(entry => entry.operator === id('歌蕾蒂娅') ? { ...entry, elitePhase: 0, level: 1 } : entry))
    actual(value)
    const low = projectMainRosterDutyRates(value)
    expect(high.rates.gold! - low.rates.gold!).toBeCloseTo(2 * .4 * 60 / 72, 10)
  })

  it('preserves raw rates when shared score weights change', () => {
    const value = input([room('gold', 'manufacture'), room('trade', 'trading')]), initial = projectMainRosterDutyRates(value)
    value.config.productionWeights = { exp: 0, gold: 0, orders: 0, fragments: 9, orundum: 17 }
    expect(projectMainRosterDutyRates(value).rates).toEqual(initial.rates)
    value.config.productionWeights = { exp: 1e300, gold: 1e300, orders: 1e300, fragments: 1e300, orundum: 1e300 }
    expect(projectMainRosterDutyRates(value).rates).toEqual(initial.rates)
  })

  it('keeps an unquantified timed runner separate from a known manufacturing resource', () => {
    const trade = room('trade', 'trading'); trade.specialOrder = 'shiftRun'
    const result = projectMainRosterDutyRates(input([room('gold', 'manufacture'), trade]))
    expect(result.status).toBe('unquantified'); expect(result.rates.gold).toBeCloseTo(60 / 72, 12)
    expect(result.rates.orderLmd).toBeNull(); expect(result.rates.virtualGold).toBeNull()
    expect(result.diagnostics.join(' ')).toMatch(/跑单|shiftRun/)
  })

  it('keeps a real unquantified trade skill unknown despite a numeric partial efficiency', () => {
    const value = input([room('trade', 'trading', ['铎铃'])], ['铎铃']), result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(result.rates.orderLmd).toBeNull()
  })

  it('rejects unsupported trading efficiency differences instead of applying a blanket multiplier', () => {
    const value = input([room('trade', 'trading')]); value.efficiencyPercentByRoom = { trade: 200 }
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(result.rates.orderLmd).toBeNull(); expect(result.rates.virtualGold).toBeNull()
    expect(result.diagnostics.join(' ')).toMatch(/efficiency|效率/)
  })

  it.each([undefined, NaN, Infinity, -1])('keeps absent or invalid actual manufacturing efficiency %s unknown', efficiency => {
    const value = input([room('manufacture', 'manufacture')]); value.efficiencyPercentByRoom = efficiency === undefined ? {} : { manufacture: efficiency }
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(result.rates.gold).toBeNull()
  })

  it('distinguishes genuine zero manufacture production from an unknown rate', () => {
    const manufacture = room('manufacture', 'manufacture'); manufacture.skillBonus = -100
    const value = input([manufacture]); value.efficiencyPercentByRoom = { manufacture: 0 }
    expect(projectMainRosterDutyRates(value)).toMatchObject({ status: 'quantified', rates: { gold: 0 } })
    value.efficiencyPercentByRoom = { manufacture: 100 }
    expect(projectMainRosterDutyRates(value)).toMatchObject({ status: 'quantified', rates: { gold: 60 / 72 } })
  })

  it('does not label an overflowing sum of finite raw rates quantified', () => {
    const one = room('one', 'manufacture'), two = room('two', 'manufacture'); one.product = 'exp'; two.product = 'exp'
    const value = input([one, two]); value.efficiencyPercentByRoom = { one: 2.7e307, two: 2.7e307 }
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(result.rates.exp).toBeNull()
  })

  it.each([['inventoryMode', 'finite'], ['droneTarget', 'gold'], ['outputMode', 'settled']] as const)('rejects unsupported %s without inventing a zero resource vector', (key, unsupported) => {
    const value = input([room('manufacture', 'manufacture')]); Reflect.set(value, key, unsupported)
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(DUTY_RESOURCE_KEYS.every(resource => result.rates[resource] === null)).toBe(true)
  })

  it('requires actual ownership for on-site and external presence, without mutating joint state or inventory', () => {
    const value = input([room('manufacture', 'manufacture', ['砾'])], ['砾']), before = structuredClone(value)
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified'); expect(value).toEqual(before)
    value.config.efficiencyResources.extraWorkplaceOperatorIds = [id('歌蕾蒂娅')]
    const unknown = projectMainRosterDutyRates(value)
    expect(unknown.status).toBe('unquantified'); expect(DUTY_RESOURCE_KEYS.every(resource => unknown.rates[resource] === null)).toBe(true)
    value.config.efficiencyResources.extraWorkplaceOperatorIds = []; value.inventory = compileOperatorInventory([{ operator: '砾', elitePhase: 2, level: 999 }])
    expect(projectMainRosterDutyRates(value).status).toBe('unquantified')
  })

  it('leaves shared projection exceptions unknown instead of returning empty production', () => {
    const value = input([])
    vi.spyOn(projection, 'projectControlOutput').mockImplementation(() => { throw new Error('unsupported-joint-state') })
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('unquantified'); expect(result.diagnostics.join(' ')).toContain('unsupported-joint-state')
  })

  it('builds one actual inventory record snapshot for a trajectory and keeps standalone calls fresh', () => {
    const first = input([room('one', 'manufacture', ['砾'])], ['砾', '夜烟'])
    const second = structuredClone(first); second.config.rooms[0]!.operatorIds = [id('夜烟')]; actual(second)
    first.config.operatorRecords = inventoryOperatorRecords(first.inventory)
    const before = structuredClone(first), records = vi.spyOn(operatorContext, 'inventoryOperatorRecords')
    const projector = createMainRosterDutyRateProjector(first.inventory)
    const one = projector(first), two = projector(second)
    expect(records).toHaveBeenCalledTimes(1)
    expect(first).toEqual(before)
    expect(one).toEqual(projectMainRosterDutyRates(first)); expect(two).toEqual(projectMainRosterDutyRates(second))
    expect(records).toHaveBeenCalledTimes(3)
  })

  it('captures a trajectory inventory snapshot without a cross-call mutable inventory cache', () => {
    const value = input([room('trade', 'trading', ['但书'])], ['但书']), high = structuredClone(value.inventory)
    value.inventory = compileOperatorInventory([{ operator: '但书', elitePhase: 0, level: 1 }]); actual(value)
    const projector = createMainRosterDutyRateProjector(value.inventory), original = projector(value)
    value.inventory.operators[0]!.skills = high.operators[0]!.skills
    value.inventory.operators[0]!.elitePhase = high.operators[0]!.elitePhase
    value.inventory.operators[0]!.level = high.operators[0]!.level
    expect(projector(value)).toEqual(original)
    const fresh = projectMainRosterDutyRates(value)
    expect(fresh.status !== original.status || fresh.rates.orderLmd !== original.rates.orderLmd).toBe(true)
  })
})

describe('configured ideal order policies in joint-state rates', () => {
  function ideal(names: string[], level: 1 | 2 | 3 = 3, occupants: string[] = []) {
    const trade = room('trade', 'trading', occupants); trade.level = level
    const value = input([trade], [...new Set([...names, ...occupants])])
    value.runOrderPolicies = [{ roomId: trade.id, orderedOperatorIds: names.map(id) }]
    return value
  }

  it('prices a configured L1 E2 Proviso as 2000 LMD per 144 base minutes without moving the ideal reference', () => {
    const value = ideal(['但书'], 1), before = structuredClone(value)
    const result = projectMainRosterDutyRates(value)
    expect(result).toMatchObject({ status: 'quantified', rates: { gold: 0, virtualGold: 0 } })
    expect(result.rates.orderLmd).toBeCloseTo(60 * 2000 / 144, 10)
    expect(value).toEqual(before)
    expect(value.config.rooms[0]!.operatorIds).toEqual([])
  })

  it('locks Closure acquisition before ordinary completion captures and applies the actual joint efficiency', () => {
    const value = ideal(['可露希尔', '但书', '龙舌兰', 'U-Official'])
    value.config.rooms[0]!.skillBonus = 150; actual(value)
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * 2.5 * 1200 / 144, 10)
    expect(result.rates.virtualGold).toBeCloseTo(60 * 2.5 * .4 / 144, 10)
    expect(result.rates.gold).toBe(0)
  })

  it.each([0, 350])('gives configured Pepe precedence over Closure and keeps fixed duration at skill bonus %s', bonus => {
    const value = ideal(['可露希尔', '但书', '佩佩', 'U-Official'])
    value.config.rooms[0]!.skillBonus = bonus; actual(value)
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * 1000 / 270, 10)
    expect(result.rates.virtualGold).toBeCloseTo(60 * 2 / 270, 10)
  })

  it('applies configured L3 Tequila to four-gold orders using the shared quality distribution', () => {
    const value = ideal(['龙舌兰']); value.config.rooms[0]!.quality = 'beta'; actual(value)
    const result = projectMainRosterDutyRates(value), duration = .05 * 144 + .1 * 210 + .85 * 276
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * (.05 * 1000 + .1 * 1500 + .85 * 2500) / duration, 10)
    expect(result.rates.virtualGold).toBeCloseTo(60 * .85 / duration, 10)
  })

  it.each([1, 2] as const)('does not enable a configured Tequila at level %s even when quality includes four-gold orders', level => {
    const value = ideal(['龙舌兰'], level); value.config.rooms[0]!.quality = 'beta'; actual(value)
    const result = projectMainRosterDutyRates(value), duration = .05 * 144 + .1 * 210 + .85 * 276
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * (.05 * 1000 + .1 * 1500 + .85 * 2000) / duration, 10)
    expect(result.rates.virtualGold).toBe(0)
  })

  it.each(['ideal-references', 'physical-occupants'] as const)('keeps Proviso and Tequila conversion branches available together for %s', mode => {
    const names = ['但书', '龙舌兰'], value = mode === 'ideal-references' ? ideal(names) : ideal([], 3, names)
    const result = projectMainRosterDutyRates(value), efficiency = value.efficiencyPercentByRoom.trade! / 100
    expect(result.status).toBe('quantified')
    // Proviso changes the 2/3-gold orders; Tequila still changes the original 4-gold branch.
    expect(result.rates.orderLmd).toBeCloseTo(60 * efficiency * 2350 / 203.4, 10)
    expect(result.rates.virtualGold).toBeCloseTo(60 * efficiency * .2 / 203.4, 10)
  })

  it('gives U-Official precedence over both ordinary completion bonuses', () => {
    const value = ideal(['但书', '龙舌兰', 'U-Official']), result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * 1000 / 203.4, 10)
    expect(result.rates.virtualGold).toBe(0)
  })

  it('uses actual low-stage ideal skills instead of a maximum catalog record', () => {
    const value = ideal(['但书'], 1), catalog = structuredClone(OPERATOR_MAP.get(id('但书'))!)
    value.config.operatorRecords = inventoryOperatorRecords(value.inventory)
    value.inventory = compileOperatorInventory([{ operator: '但书', elitePhase: 0, level: 1 }])
    const result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * 1500 / 144, 10)
    expect(OPERATOR_MAP.get(id('但书'))).toEqual(catalog)
    const tequila = ideal(['龙舌兰'])
    tequila.inventory = compileOperatorInventory([{ operator: '龙舌兰', elitePhase: 0, level: 1 }])
    expect(projectMainRosterDutyRates(tequila).rates.orderLmd).toBeCloseTo(60 * 1500 / 203.4, 10)
  })

  it('distinguishes zero-morale physical skills from explicit ideal references', () => {
    const value = ideal([], 1, ['但书'])
    value.config.operatorMorale[id('但书')] = 0; value.config.zeroMoraleOperatorIds = [id('但书')]; actual(value)
    const efficiency = value.efficiencyPercentByRoom.trade! / 100
    expect(projectMainRosterDutyRates(value).rates.orderLmd).toBeCloseTo(60 * efficiency * 1000 / 144, 10)
    value.runOrderPolicies = [{ roomId: 'trade', orderedOperatorIds: [id('但书')] }]
    const before = structuredClone(value), result = projectMainRosterDutyRates(value)
    expect(result.status).toBe('quantified')
    expect(result.rates.orderLmd).toBeCloseTo(60 * efficiency * 2000 / 144, 10)
    expect(value).toEqual(before)
  })

  it('keeps virtual runner rates independent of score weights and captures policy/inventory inputs without mutation', () => {
    const value = ideal(['但书', '龙舌兰']), before = structuredClone(value)
    const projector = createMainRosterDutyRateProjector(value.inventory), initial = projector(value)
    expect(initial.status).toBe('quantified'); expect(value).toEqual(before)
    value.config.productionWeights = { exp: 1e300, gold: 1e300, orders: 1e300, fragments: 1e300, orundum: 1e300 }
    expect(projector(value).rates).toEqual(initial.rates)
    value.config.productionWeights = { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 }
    expect(projector(value).rates).toEqual(initial.rates)
  })

  it.each(['unknown', 'unowned', 'ordinary', 'duplicate-room', 'duplicate-reference', 'nontrading-room', 'invalid-list', 'invalid-policy-array'] as const)
    ('keeps %s policy unknown without discarding known manufacturing output', mode => {
      const value = input([room('gold', 'manufacture'), room('trade', 'trading')], ['砾', '但书'])
      value.runOrderPolicies = [{ roomId: 'trade', orderedOperatorIds: [id('但书')] }]
      if (mode === 'unknown') value.runOrderPolicies[0]!.orderedOperatorIds = ['unknown-reference']
      if (mode === 'unowned') value.runOrderPolicies[0]!.orderedOperatorIds = [id('可露希尔')]
      if (mode === 'ordinary') value.runOrderPolicies[0]!.orderedOperatorIds = [id('砾')]
      if (mode === 'duplicate-room') value.runOrderPolicies = [...value.runOrderPolicies, ...value.runOrderPolicies]
      if (mode === 'duplicate-reference') value.runOrderPolicies[0]!.orderedOperatorIds.push(id('但书'))
      if (mode === 'nontrading-room') value.runOrderPolicies[0]!.roomId = 'gold'
      if (mode === 'invalid-list') Reflect.set(value.runOrderPolicies[0]!, 'orderedOperatorIds', '但书')
      if (mode === 'invalid-policy-array') Reflect.set(value, 'runOrderPolicies', {})
      const result = projectMainRosterDutyRates(value)
      expect(result.status).toBe('unquantified')
      expect(result.rates.orderLmd).toBeNull(); expect(result.rates.virtualGold).toBeNull()
      expect(result.rates.gold).toBeCloseTo(60 / 72, 10)
      expect(result.diagnostics.join(' ')).toMatch(/policy|策略/i)
    })
})
