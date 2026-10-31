import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { OperatorEfficiencyResult } from '../engine/operatorRules'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { MowerTaskQueue, toMowerMicros } from '../scheduler/mowerTaskQueue'
import {
  collectMowerInfraNotification, collectMowerTodoList,
  type MowerNotificationGenerator, type MowerNotificationRequest,
} from '../scheduler/mowerNotification'
import type { RunOrderIORequest } from '../scheduler/mowerRunOrderPlanning'
import * as simulation from '../simulator/scheduleSimulation'
import * as production from '../simulator/productionTimeline'
import type { ProductionFrame } from '../simulator/productionTimeline'
import { createDefaultWorkspace } from '../workbench/defaults'
import { createMainRosterDutyObservationClock } from './mainRosterDutyObservationClock'

const TRADE = 'room_1_1', MANUFACTURE = 'room_1_2', SECOND = 'room_1_3'
const evaluation = (efficiencyPercent = 100): OperatorEfficiencyResult => ({ efficiencyPercent,
  staffBonus: 0, skillBonus: 0, operatorNames: [], details: [], unquantifiedSkills: [], quality: 'normal',
  specialOrder: 'none', operatorContributions: [], roomContributions: [] })

/** Hand-set live frames: no schedule/calendar, full production host, H or F is run. */
function fixture(options: {
  seed?: number; level?: 1 | 2 | 3; physical?: string[]; references?: string[]; secondRoom?: boolean
  manufacture?: boolean; manufactureProduct?: 'gold' | 'exp' | 'fragment'; manufactureLevel?: 1 | 2 | 3; recycleLevel?: 0 | 1 | 2 | 3
} = {}) {
  const workspace = createDefaultWorkspace(), level = options.level ?? 1
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const physical = (options.physical ?? []).map(id), references = (options.references ?? []).map(id)
  Object.assign(workspace.mainPlan.facilities.room_1_1, { type: 'trading', product: 'money', level,
    slots: physical.map(operatorId => ({ occupant: { kind: 'operator', operatorId }, groupId: null, replacements: [] })) })
  if (options.secondRoom) Object.assign(workspace.mainPlan.facilities.room_1_3, { type: 'trading', product: 'money', level: 3 })
  if (options.manufacture) Object.assign(workspace.mainPlan.facilities.room_1_2, { type: 'manufacture', product: options.manufactureProduct ?? 'gold', level: options.manufactureLevel ?? 1 })
  workspace.mainPlan.facilities.recycle.level = options.recycleLevel ?? 0
  const schedule = compileRosterSchedule(workspace, { idleOperators: [] })
  schedule.runOrderPolicies = references.length ? [{ roomId: TRADE, orderedOperatorIds: references }] : []
  const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  state.config.mowerDeviceTiming = { roomReturnMicros: 500_000 }
  const config = createDefaultConfig(), trade = createRoom(TRADE, 'trading')
  trade.level = level; trade.operatorIds = physical; trade.operatorCount = physical.length
  config.rooms = [trade]; config.controlOperatorIds = []; config.facilities.recycle = options.recycleLevel ?? 0
  const owned = new Set([...physical, ...references])
  config.operatorRecords = inventoryOperatorRecords(compileOperatorInventory(fullCatalogIdleInventory().filter(entry => owned.has(entry.operator))))
  if (options.secondRoom) { const second = createRoom(SECOND, 'trading'); second.level = 3; config.rooms.push(second) }
  if (options.manufacture) {
    const manufacture = createRoom(MANUFACTURE, 'manufacture'); manufacture.level = options.manufactureLevel ?? 1
    manufacture.product = options.manufactureProduct ?? 'gold'; config.rooms.push(manufacture)
  }
  const frame: ProductionFrame = { time: 0, config, active: new Set(physical), morale: new Map(physical.map(actor => [actor, 24])),
    evaluations: Object.fromEntries(config.rooms.map(room => [room.id, evaluation()])) }
  const clock = (extra = {}) => createMainRosterDutyObservationClock(schedule, state, () => frame, { seed: options.seed ?? 42, ...extra })
  return { workspace, schedule, state, frame, clock }
}
type Fixture = ReturnType<typeof fixture>
type Clock = ReturnType<typeof createMainRosterDutyObservationClock>

function advance(input: Fixture, clock: Clock, hours: number, maximum = 1) {
  const end = input.state.time + hours
  let count = 0
  while (input.state.time < end - 1e-10) {
    if (++count > 2000) throw new Error('Unit timer did not advance')
    const dt = clock.nextStep(Math.min(maximum, end - input.state.time), offset => ({ ...input.frame, time: input.state.time + offset }))
    expect(dt).toBeGreaterThan(0)
    clock.advance(dt, input.frame); input.state.time += dt; input.frame.time = input.state.time
    clock.settle(input.frame)
  }
}
function read(input: Fixture, clock: Clock, request: RunOrderIORequest = { kind: 'read-order', room: TRADE, useDigitReader: true }) {
  const work = clock.rates.mowerRunOrderIO!(request, input.state)
  if (!('observe' in work)) throw new Error('Direct observation expected')
  return work
}
function notify(input: Fixture, clock: Clock, request: MowerNotificationRequest) {
  const work = clock.rates.mowerNotificationIO!(request, input.state)
  if (!('observe' in work)) throw new Error('Direct observation expected')
  if (work.delayMicros) advance(input, clock, work.delayMicros / 3_600_000_000)
  return { observation: work.observe(), delayMicros: work.delayMicros }
}
function collect(input: Fixture, clock: Clock) {
  const state = { queue: new MowerTaskQueue(), flags: { todoTask: false, collectNotification: false, planned: false }, lastTodoMicros: null as number | null,
    collectRecycle: !!input.frame.config.facilities.recycle }
  const seam = { nowMicros: () => toMowerMicros(input.state.time) }, delays: number[] = []
  const drive = (generator: MowerNotificationGenerator) => {
    let next = generator.next()
    while (!next.done) { const result = notify(input, clock, next.value); delays.push(result.delayMicros); next = generator.next(result.observation) }
  }
  drive(collectMowerInfraNotification(state, seam))
  drive(collectMowerTodoList(state, seam))
  drive(collectMowerTodoList(state, seam))
  return { state, delays }
}

beforeEach(() => {
  vi.spyOn(simulation, 'simulateSchedule').mockImplementation(() => { throw new Error('No real calendar/H/F permitted') })
  vi.spyOn(production, 'createProductionTimeline').mockImplementation(() => { throw new Error('No full production host permitted') })
})
afterEach(() => vi.restoreAllMocks())

describe('seeded duty observation host (0 real H/F)', () => {
  it('preserves unfinished work across shifts and reads the actual current-efficiency deadline', () => {
    const input = fixture(), clock = input.clock()
    advance(input, clock, 1)
    const pendingRead = read(input, clock)
    input.frame.evaluations[TRADE] = evaluation(200)
    clock.settle(input.frame)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ baseMinutes: 144, remainingBaseMinutes: 84, completedOrders: 0 })
    expect(pendingRead.observe()).toEqual({ observedAtMicros: toMowerMicros(1), absoluteDueMicros: toMowerMicros(1.7) })
    advance(input, clock, .7)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ remainingBaseMinutes: 144, pendingOrders: 1, completedOrders: 1 })
  })

  it('uses the Native seeded per-room order sequence without an income or production report', () => {
    const input = fixture({ level: 3 }), clock = input.clock(), sequence = [clock.snapshot().trading[TRADE]!.baseMinutes]
    for (const hours of [3.5, 4.6, 2.4]) { advance(input, clock, hours); sequence.push(clock.snapshot().trading[TRADE]!.baseMinutes) }
    expect(sequence).toEqual([210, 276, 144, 210])
    expect(clock.diagnostics).toContainEqual({ code: 'DUTY_OBSERVATION_SEED', message: '42' })
    expect(clock).not.toHaveProperty('report'); expect(clock).not.toHaveProperty('ledger')
    expect(clock.snapshot()).not.toHaveProperty('income')
  })

  it('keeps room streams independent of other facilities and exposes a different original seed', () => {
    const first = fixture({ level: 3 }), paired = fixture({ level: 3, secondRoom: true }), different = fixture({ level: 3, seed: 2026 })
    paired.frame.config.rooms.reverse()
    const a = first.clock(), b = paired.clock(), c = different.clock()
    expect(c.snapshot().trading[TRADE]!.baseMinutes).toBe(144)
    advance(first, a, 13); advance(paired, b, 13)
    expect(a.snapshot().trading[TRADE]).toEqual(b.snapshot().trading[TRADE])
    expect(c.diagnostics).toContainEqual({ code: 'DUTY_OBSERVATION_SEED', message: '2026' })
  })

  it('locks acquisition mode across a staffing change, then opens the next mode after completion', () => {
    const input = fixture({ physical: ['佩佩'] }), clock = input.clock()
    advance(input, clock, 1)
    input.frame.active.clear(); input.frame.config.rooms[0]!.operatorIds = []
    input.frame.evaluations[TRADE] = evaluation(500); clock.settle(input.frame)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ mode: 'pepe', remainingBaseMinutes: 210 })
    expect(read(input, clock).observe().absoluteDueMicros).toBe(toMowerMicros(4.5))
    advance(input, clock, 3.5)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ mode: 'gold', pendingOrders: 1, remainingBaseMinutes: 144 })
  })

  it('uses actual skill stages and ideal acquisition references without altering physical occupancy', () => {
    const low = fixture({ references: ['可露希尔'] })
    low.frame.config.operatorRecords = inventoryOperatorRecords(compileOperatorInventory([{ operator: '可露希尔', elitePhase: 0, level: 1 }]))
    expect(low.clock().snapshot().trading[TRADE]!.mode).toBe('gold')
    const high = fixture({ references: ['可露希尔'] }), clock = high.clock()
    expect(clock.snapshot().trading[TRADE]!.mode).toBe('closure')
    expect(high.state.occupants).toEqual({}); expect(high.frame.config.rooms[0]!.operatorIds).toEqual([])
  })

  it('stops both finite queues, preserves stock, and restarts only on delayed shared notification collection', () => {
    const input = fixture({ manufacture: true }), clock = input.clock()
    advance(input, clock, 60, 60)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ capacity: 6, pendingOrders: 6, completedOrders: 6, remainingBaseMinutes: null })
    expect(clock.snapshot().manufacturing[MANUFACTURE]).toMatchObject({ capacityWeight: 24, pendingItems: 12, storedWeight: 24 })
    expect(read(input, clock).observe().absoluteDueMicros).toBe(toMowerMicros(60))
    const before = input.state.time, result = collect(input, clock)
    expect(input.state.time - before).toBeCloseTo(4 / 3600, 10)
    expect(result.delays.filter(delay => delay > 0)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000])
    expect(result.state.flags.todoTask).toBe(true); expect(clock.rates.mowerTodoListVisible!()).toBe(false)
    expect(clock.snapshot().trading[TRADE]).toMatchObject({ pendingOrders: 0, completedOrders: 6 })
    expect(clock.snapshot().trading[TRADE]!.remainingBaseMinutes).toBeLessThan(144)
    expect(clock.snapshot().manufacturing[MANUFACTURE]).toMatchObject({ pendingItems: 0, storedWeight: 0, awaitingPayment: false })
  })

  it('exposes a real manufacturing badge and Native collection delay before trade capacity is reached', () => {
    const input = fixture({ manufacture: true }), clock = input.clock()
    advance(input, clock, 1.2)
    expect(clock.snapshot().manufacturing[MANUFACTURE]!.pendingItems).toBe(1)
    expect(clock.snapshot().trading[TRADE]!.pendingOrders).toBe(0)
    expect(notify(input, clock, { kind: 'detect-notification' }).observation.value).toEqual({ control: 'infra_notification' })
    const callback = read(input, clock, { kind: 'return-main', room: TRADE })
    expect(callback.delayMicros).toBe(500_000); expect(input.state.time).toBeCloseTo(1.2, 10)
    const before = input.state.time
    collect(input, clock)
    expect(input.state.time - before).toBeCloseTo(3 / 3600, 10)
    expect(clock.snapshot().manufacturing[MANUFACTURE]!.pendingItems).toBe(0)
    expect(clock.rates.mowerClueIO).toBeTypeOf('function')
  })

  it('locates a varying-efficiency boundary by the same midpoint work equation without changing time', () => {
    const input = fixture(), clock = input.clock(), before = clock.snapshot()
    const dt = clock.nextStep(3, offset => ({ ...input.frame, evaluations: { [TRADE]: evaluation(100 + 100 * offset) } }))
    // h * (1 + h/2) = 144/60, so the first positive root is sqrt(5.8)-1.
    expect(dt).toBeCloseTo(Math.sqrt(5.8) - 1, 12)
    expect(input.state.time).toBe(0); expect(clock.snapshot()).toEqual(before)
  })

  it('keeps fragment formula selection explicit and carries partial manufacturing progress', () => {
    const input = fixture({ manufacture: true, manufactureProduct: 'fragment', manufactureLevel: 3 })
    const clock = input.clock({ fragmentFormulaByRoom: { [MANUFACTURE]: 'fragment-device' } })
    advance(input, clock, .5)
    expect(clock.snapshot().manufacturing[MANUFACTURE]).toMatchObject({ formula: { id: 'fragment-device' }, remainingBaseMinutes: 30, pendingItems: 0 })
    input.frame.evaluations[MANUFACTURE] = evaluation(200); clock.settle(input.frame); advance(input, clock, .25)
    expect(clock.snapshot().manufacturing[MANUFACTURE]).toMatchObject({ pendingItems: 1, remainingBaseMinutes: 60 })
  })

  it('keeps recycle warehouse state and includes it in the shared Native notification collection', () => {
    const input = fixture({ recycleLevel: 1 }), clock = input.clock()
    advance(input, clock, 1200, 1200)
    expect(clock.snapshot().recycle).toMatchObject({ capacity: 5, pendingItems: 5, completedItems: 5 })
    collect(input, clock)
    expect(clock.snapshot().recycle).toMatchObject({ pendingItems: 0, collectedItems: 5, completedItems: 5 })
    advance(input, clock, 1)
    expect(clock.snapshot().recycle!.remainingBaseHours).toBeLessThan(48)
  })

  it('refuses a drone lifecycle instead of silently using a zero balance as a prediction', () => {
    const input = fixture(), clock = input.clock(), work = clock.rates.mowerTodoTaskIO!({ kind: 'drone', room: TRADE }, input.state)
    if (!('next' in work)) throw new Error('Expected Native drone generator')
    expect(() => work.next()).toThrow('drone task requested in none-drone observation calendar')
  })

  it.each([-1, 0x100000000, NaN, 1.5])('rejects an invalid original seed %s before installing observations', seed => {
    const input = fixture({ seed })
    expect(() => input.clock()).toThrow('invalid observation seed')
  })

  it('rejects product changes and unknown efficiencies without replacing prior progress', () => {
    const input = fixture(), clock = input.clock(), before = clock.snapshot()
    input.frame.config.rooms[0]!.strategy = 'orundum'
    expect(() => clock.settle(input.frame)).toThrow('product switching')
    input.frame.config.rooms[0]!.strategy = 'gold'; input.frame.evaluations[TRADE] = evaluation(NaN)
    expect(() => clock.advance(1, input.frame)).toThrow('unknown efficiency')
    expect(clock.snapshot()).toEqual(before)
  })
})
