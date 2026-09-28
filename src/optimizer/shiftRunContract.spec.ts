import { calculate } from '../engine/calculate'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { simulateSchedule } from '../simulator/scheduleSimulation'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTimeout as yieldToRunner } from 'node:timers/promises'

// annotate flushes pending task updates and awaits the IPC acknowledgement.
// A fixed delay cannot guarantee this before a long synchronous generation.
import { OPERATORS } from '../domain/operators'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { captureOrder, getOrderDistribution } from '../rules/orderRules'
import { generateMolecularCandidates } from './molecularSynthesis'
import { configureRunOrder } from './configureRunOrder'

const owned = OPERATORS.map(o => ({ operator: o.name, elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2, level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90 }))

// Give progress RPC a turn between synchronous generation/simulation cases.
beforeEach(() => yieldToRunner(5))
afterEach(() => yieldToRunner(5))

describe('shift-run branch contract', () => {
  it('constructs ten distinct physically valid branches before simulation', async ({ annotate }) => {
    await annotate('同步计算前确认测试进度已送达')
    const candidates = generateMolecularCandidates(createDefaultWorkspace(), owned, compileOperatorInventory(owned), { seed: 20260919, branchCount: 10 })
    expect(candidates).toHaveLength(10)
    const fingerprints = candidates.map(c => JSON.stringify(Object.values(c.workspace.mainPlan.facilities).map(r => [r.roomId,r.slots.map(s => [s.occupant,s.replacements])])))
    expect(new Set(fingerprints).size).toBe(10)
    for (const candidate of candidates) expect(compileRosterSchedule(candidate.workspace).diagnostics.filter(d=>d.severity==='error')).toEqual([])
  }, 180000)
  it('keeps Pepe and Closure available outside their trade run-order path', async ({ annotate }) => {
    await annotate('同步计算前确认测试进度已送达')
    expect(isShiftRunOperator(id('但书'))).toBe(true)
    expect(isShiftRunOperator(id('龙舌兰'))).toBe(true)
    expect(isShiftRunOperator(id('佩佩'))).toBe(false)
    expect(isShiftRunOperator(id('可露希尔'))).toBe(false)
    expect(isShiftRunOperator(id('U-Official'))).toBe(false)
  })
  it.each(['closure', 'pepe'] as const)('accepts %s order acquisition', mode => {
    expect(getOrderDistribution(3, 'normal', mode)[0]?.mode).toBe(mode)
  })
  it('allows U-Official conversion and keeps duration-changing modes locked at start', async ({ annotate }) => {
    await annotate('同步计算前确认测试进度已送达')
    const base = getOrderDistribution(1)[0]!
    expect(captureOrder(base, { uOfficial: true }, 1).kind).toBe('uOfficial')
    for (const capture of [{ closure: true }, { pepe: true }]) expect(() => captureOrder(base, capture, 1)).toThrow(/mode/)
  })
  it.each(['佩佩', '可露希尔', 'U-Official'])('accepts imported %s trading mains and backups', name => {
    for (const primary of [true, false]) {
      const ws = createDefaultWorkspace()
      const slot = ws.mainPlan.facilities.room_3_1.slots[0]!
      slot.occupant = { kind: 'operator', operatorId: id(primary ? name : '芬') }
      slot.replacements = primary ? [] : [id(name)]
      expect(compileRosterSchedule(ws).diagnostics.some(d => d.code === 'UNSUPPORTED_SPECIAL_ORDER')).toBe(false)
    }
  })
  it.each([1, 2, 3])('generates executable runners plus ordinary backups at trade level %i', async level => {
    await yieldToRunner(250)
    const ws = createDefaultWorkspace()
    const room = ws.mainPlan.facilities.room_3_1
    room.level = level
    room.slots = room.slots.slice(0, level)
    const candidates = generateMolecularCandidates(ws, owned, compileOperatorInventory(owned), { seed: 42, branchCount: 2 })
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      const schedule = compileRosterSchedule(candidate.workspace)
      const policy = schedule.runOrderPolicies.find(p => p.roomId === room.roomId)
      expect(policy?.orderedOperatorIds).toEqual(level === 3 ? [id('但书'), id('龙舌兰')] : [id('但书')])
      const trade = candidate.workspace.mainPlan.facilities[room.roomId]
      expect(trade.slots[0]!.replacements[0]).toBe(id('但书'))
      if (level === 3) expect(trade.slots[1]!.replacements[0]).toBe(id('龙舌兰'))
      const runtime = compiledScheduleToRuntimeConfig(schedule)
      expect(runtime.positions.filter(p => p.roomId === room.roomId).every(p => p.candidates.length > 0 && p.candidates.every(x => !isShiftRunOperator(x)))).toBe(true)
      for (const r of Object.values(candidate.workspace.mainPlan.facilities).filter(r => r.type === 'trading')) {
        const mains = r.slots.flatMap(s => s.occupant.kind === 'operator' ? [s.occupant.operatorId] : [])
        expect(mains.some(x => ['但书', '龙舌兰'].map(id).includes(id(x)))).toBe(false)
      }
    }
  }, 60000)
  it.each([['佩佩', 0, 1000], ['可露希尔', 2, 1200], ['U-Official', 2, 1000]] as const)('calculates %s above the default static shift-run flag', (name, gold, lmd) => {
    const config = createDefaultConfig()
    const room = createRoom('T', 'trading')
    room.operatorIds = [id(name)]
    config.rooms = [room]
    const result = calculate(config).trading[0]!
    expect(result.goldConsumed / result.orders).toBeCloseTo(gold)
    expect(result.lmd / result.orders).toBeCloseTo(lmd)
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.factory.slots[0]!.occupant = { kind: 'operator', operatorId: id(name) }
    expect(compileRosterSchedule(workspace).diagnostics.some(d => d.code === 'UNSUPPORTED_SPECIAL_ORDER')).toBe(false)
  })
  it.each([1, 2, 3])('executes generated level %i ideal rewards without physical swaps', async level => {
    await yieldToRunner(250)
    const workspace = createDefaultWorkspace()
    const room = workspace.mainPlan.facilities.room_3_1
    room.level = level
    room.slots = room.slots.slice(0, level)
    const generated = generateMolecularCandidates(workspace, owned, compileOperatorInventory(owned), { seed: 42, branchCount: 1 })[0]!
    const schedule = compileRosterSchedule(generated.workspace)
    schedule.rooms = schedule.rooms.filter(r => r.roomId === room.roomId)
    schedule.restPools = []
    schedule.fiammettaPolicies = []
    const result = simulateSchedule(schedule, { sampleHours: 24, recordSegments: true,
      consumptionOverrides: Object.fromEntries(OPERATORS.map(o => [o.charId, 0])),
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 20260919 } })
    expect(result.success).toBe(true)
    const events = result.production!.events
    const insertions = events.filter(e => e.type === 'run-order-ideal')
    const restorations = events.filter(e => e.type === 'run-order-restored')
    expect(insertions.length).toBeGreaterThan(0)
    expect(restorations).toHaveLength(0)
    expect(insertions.every(e => e.operatorIds?.includes(id('但书')))).toBe(true)
    const orders = events.filter(e => e.type === 'order-completed').map(e => e.order!)
    expect(orders.some(o => o.kind === 'proviso')).toBe(true)
    if (level === 3) expect(orders.some(o => o.kind === 'tequila')).toBe(true)
    expect(orders.every(o => ['proviso', 'tequila'].includes(o.kind))).toBe(true)
    for (const segment of result.segments) {
      const assigned = Object.values(segment.occupants)
      expect(assigned.filter(x => x === id('但书')).length).toBeLessThanOrEqual(1)
      expect(assigned.filter(x => x === id('龙舌兰')).length).toBeLessThanOrEqual(1)
    }
  }, 60000)
  it('accepts runners with the unlocked elite 0 reward skills', async ({ annotate }) => {
    await annotate('同步计算前确认测试进度已送达')
    const ws = createDefaultWorkspace()
    for (const room of Object.values(ws.mainPlan.facilities).filter(r => r.type === 'trading')) {
      room.slots.forEach((slot, i) => { slot.occupant = { kind: 'operator', operatorId: id(['芬', '克洛丝', '空爆'][i]!) } })
    }
    const inventory = compileOperatorInventory(['但书', '龙舌兰'].map(operator => ({ operator, elitePhase: 0, level: 1 })))
    expect(configureRunOrder(ws, inventory)).toBe(true)
    expect(ws.mainPlan.facilities.room_3_1.slots[0]!.replacements[0]).toBe(id('但书'))
  })
  it('configures only owned runners without blocking ordinary rosters', async ({ annotate }) => {
    await annotate('同步计算前确认测试进度已送达')
    const ws = createDefaultWorkspace()
    const inventory = compileOperatorInventory(owned.filter(o => o.operator !== '但书'))
    for (const room of Object.values(ws.mainPlan.facilities).filter(r=>r.type==='trading')) {
      room.slots.forEach((s,i)=>{s.occupant={kind:'operator',operatorId:id(['芬','克洛丝','空爆'][i]!)}})
    }
    expect(configureRunOrder(ws,inventory)).toBe(true)
    expect(ws.mainPlan.facilities.room_3_1.slots.flatMap(s=>s.replacements)).toEqual([id('龙舌兰')])
  }, 60000)
  it('keeps a manually configured Pepe runner in its own trading slot', () => {
    const ws = createDefaultWorkspace()
    const room = ws.mainPlan.facilities.room_3_1
    for (const trading of Object.values(ws.mainPlan.facilities).filter(value => value.type === 'trading')) {
      trading.slots.forEach((slot, index) => { slot.occupant = { kind: 'operator', operatorId: id(['芬', '克洛丝', '空爆'][index]!) } })
    }
    room.slots[0]!.replacements = [id('佩佩'), id('能天使')]
    const inventory = compileOperatorInventory(owned)
    expect(configureRunOrder(ws, inventory)).toBe(true)
    expect(room.slots[0]!.replacements).toEqual([id('佩佩'), id('能天使')])
    expect(room.slots[1]!.replacements[0]).toBe(id('但书'))
    expect(room.slots[2]!.replacements[0]).toBe(id('龙舌兰'))
  })
})
