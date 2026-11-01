import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { OperatorEfficiencyResult } from '../engine/operatorRules'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import type { RunOrderIORequest } from '../scheduler/mowerRunOrderPlanning'
import { planDefaultRunOrder, type RunOrderPlanningState } from '../scheduler/mowerRunOrderPlanning'
import { bridgeMowerNativeIO } from '../scheduler/mowerRunOrderBridge'
import { MowerTaskQueue, toMowerMicros } from '../scheduler/mowerTaskQueue'
import * as simulation from '../simulator/scheduleSimulation'
import type { ProductionFrame } from '../simulator/productionTimeline'
import { createDefaultWorkspace } from '../workbench/defaults'
import { createMainRosterDutyOrderClock } from './mainRosterDutyOrderClock'

const ROOM = 'room_1_1'
const evaluation = (efficiency = 100): OperatorEfficiencyResult => ({ efficiencyPercent: efficiency,
  staffBonus: 0, skillBonus: 0, operatorNames: [], details: [], unquantifiedSkills: [],
  quality: 'normal', specialOrder: 'none', operatorContributions: [], roomContributions: [] })

/** Real compiler/runtime shapes, hand-set frame numbers; no scheduler or G/F/H is executed. */
function fixture(level: 1 | 2 | 3 = 1, references: string[] = [], physical: string[] = [], secondRoom = false) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(workspace.mainPlan.facilities.room_1_1, { type: 'trading', product: 'money', level,
    slots: physical.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] })) })
  if (secondRoom) Object.assign(workspace.mainPlan.facilities.room_1_2, { type: 'trading', product: 'money', level: 1 })
  const schedule = compileRosterSchedule(workspace, { idleOperators: [] })
  schedule.runOrderPolicies = references.length ? [{ roomId: ROOM, orderedOperatorIds: references.map(id) }] : []
  const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  state.config.mowerDeviceTiming = { roomReturnMicros: 500_000 }
  state.mowerUI = { scene: 'INFRA_MAIN', lastRoom: '' }
  const ownedNames = ['佩佩', '可露希尔', '但书', '龙舌兰', 'U-Official', ...physical, ...references]
  const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ownedNames.some(name => id(name) === entry.operator)))
  const config = createDefaultConfig(), trade = createRoom(ROOM, 'trading')
  trade.level = level; trade.operatorIds = physical.map(id); trade.operatorCount = physical.length
  config.rooms = [trade]; config.controlOperatorIds = []; config.operatorRecords = inventoryOperatorRecords(inventory)
  const frame: ProductionFrame = { time: 0, config, active: new Set(physical.map(id)), morale: new Map(physical.map(name => [id(name), 24])),
    evaluations: { [ROOM]: evaluation() } }
  if (secondRoom) {
    const second = createRoom('room_1_2', 'trading'); second.level = 1
    config.rooms.push(second); frame.evaluations.room_1_2 = evaluation(200)
  }
  const clock = () => createMainRosterDutyOrderClock(schedule, state, () => frame)
  return { workspace, schedule, state, frame, clock }
}
type Fixture = ReturnType<typeof fixture>
type Clock = ReturnType<typeof createMainRosterDutyOrderClock>

function step(input: Fixture, clock: Clock, hours: number) {
  clock.advance(hours, input.frame)
  // Only the host changes wall clock; the independent order clock never does.
  input.state.time += hours; input.frame.time = input.state.time
}
function remaining(clock: Clock, expected: number, completedOrders = 0) {
  expect(clock.snapshot()[ROOM]?.remainingBaseMinutes).toBeCloseTo(expected, 9)
  expect(clock.snapshot()[ROOM]?.completedOrders).toBe(completedOrders)
}
function boundary(input: Fixture, clock: Clock, request: RunOrderIORequest) {
  const work = clock.rates.mowerRunOrderIO!(request, input.state)
  if ('next' in work) throw new Error('Expected the Native direct observation boundary')
  return work
}
const readRequest = (): RunOrderIORequest => ({ kind: 'read-order', room: ROOM, useDigitReader: true })

beforeEach(() => {
  vi.spyOn(simulation, 'simulateSchedule').mockImplementation(() => { throw new Error('No real calendar/F/H is allowed') })
})
afterEach(() => vi.restoreAllMocks())

describe('independent expected-order clock (0 real H/F)', () => {
  it('retains unfinished base work across staffing efficiency changes and opens a new order only at completion', () => {
    const input = fixture(), clock = input.clock()
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'gold', efficiencyAffected: true, remainingBaseMinutes: 144, completedOrders: 0 })
    step(input, clock, 1); remaining(clock, 84)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    step(input, clock, .5); remaining(clock, 24)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 100
    step(input, clock, .4); remaining(clock, 144, 1)
  })

  it('uses probability-weighted mean base minutes rather than a fixed shortest order', () => {
    const input = fixture(3), clock = input.clock()
    // .3*144 + .5*210 + .2*276 = 203.4, irrespective of order rewards.
    remaining(clock, 203.4)
    step(input, clock, 1); remaining(clock, 143.4)
  })

  it('carries warmup progress into a sample boundary without resetting it', () => {
    const input = fixture(3), clock = input.clock()
    step(input, clock, 24)
    // 1440 base minutes = 7*203.4 + 16.2; a partial order crosses the boundary.
    remaining(clock, 187.2, 7)
    step(input, clock, .5); remaining(clock, 157.2, 7)
    // Reading a report/sample snapshot has no order-open or reset side effect.
    expect(clock.snapshot()).toEqual(clock.snapshot())
    step(input, clock, .5); remaining(clock, 127.2, 7)
  })

  it('continues excess elapsed time through subsequent orders instead of discarding it', () => {
    const input = fixture(), clock = input.clock()
    step(input, clock, 10)
    // 600 base minutes = 4*144 + 24 minutes of the next order.
    remaining(clock, 120, 4)
  })

  it('preserves the old acquisition mode when a new physical Pepe arrives, then locks Pepe for the next order', () => {
    const input = fixture(), clock = input.clock()
    step(input, clock, 1); remaining(clock, 84)
    input.frame.config.rooms[0]!.operatorIds = [id('佩佩')]; input.frame.config.rooms[0]!.operatorCount = 1
    input.frame.active.add(id('佩佩')); input.frame.morale.set(id('佩佩'), 24)
    input.state.occupants[`${ROOM}_0`] = id('佩佩')
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'gold', efficiencyAffected: true })
    expect(boundary(input, clock, readRequest()).observe().absoluteDueMicros).toBe(toMowerMicros(1.7))
    step(input, clock, .7)
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'pepe', efficiencyAffected: false, completedOrders: 1 })
    remaining(clock, 270, 1)
    step(input, clock, 1); remaining(clock, 210, 1)
  })

  it('does not reselect quality until the previous order is completed', () => {
    const input = fixture(3), clock = input.clock()
    step(input, clock, 1); remaining(clock, 143.4)
    input.frame.evaluations[ROOM]!.quality = 'beta'
    remaining(clock, 143.4)
    step(input, clock, 143.4 / 60)
    // .05*144 + .1*210 + .85*276 = 262.8 for the newly opened beta order.
    remaining(clock, 262.8, 1)
  })

  it('carries elapsed-time surplus across an old ordinary order and newly opened Pepe orders', () => {
    const input = fixture(), clock = input.clock()
    step(input, clock, 1); remaining(clock, 84)
    input.frame.config.rooms[0]!.operatorIds = [id('佩佩')]; input.frame.config.rooms[0]!.operatorCount = 1
    input.frame.active.add(id('佩佩')); input.frame.morale.set(id('佩佩'), 24)
    input.state.occupants[`${ROOM}_0`] = id('佩佩')
    step(input, clock, 6)
    // 360 elapsed minutes = old 84 + new 270 + 6 minutes of the next Pepe order.
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'pepe', efficiencyAffected: false })
    remaining(clock, 264, 2)
  })

  it('keeps each room independent when a single advance crosses only one room completion', () => {
    const input = fixture(1, [], [], true), clock = input.clock()
    step(input, clock, 1)
    remaining(clock, 84)
    expect(clock.snapshot().room_1_2).toMatchObject({ completedOrders: 0, remainingBaseMinutes: 24 })
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    input.frame.evaluations.room_1_2!.efficiencyPercent = 100
    step(input, clock, .5)
    remaining(clock, 24)
    expect(clock.snapshot().room_1_2).toMatchObject({ completedOrders: 1, remainingBaseMinutes: 138 })
  })

  it('selects configured Closure acquisition without inserting ideal operators into physical occupancy', () => {
    const input = fixture(1, ['可露希尔', '但书']), clock = input.clock()
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'closure', efficiencyAffected: true })
    remaining(clock, 144)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    step(input, clock, 1); remaining(clock, 24)
    expect(input.state.occupants).toEqual({})
    expect(input.frame.config.rooms[0]!.operatorIds).toEqual([])
  })

  it('locks Pepe over Closure and keeps its 270-minute work independent of current room efficiency including zero', () => {
    const input = fixture(1, ['可露希尔', '佩佩']), clock = input.clock()
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'pepe', efficiencyAffected: false })
    remaining(clock, 270)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 500
    step(input, clock, 1); remaining(clock, 210)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 0
    step(input, clock, 1); remaining(clock, 150)
    expect(boundary(input, clock, readRequest()).observe().absoluteDueMicros).toBe(toMowerMicros(4.5))
  })

  it.each(['佩佩', '可露希尔'])('does not promote an actual E0 ideal %s to the catalog acquisition skill', operator => {
    const input = fixture(1, [operator])
    input.frame.config.operatorRecords = inventoryOperatorRecords(compileOperatorInventory([{ operator, elitePhase: 0, level: 1 }]))
    const clock = input.clock()
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'gold', efficiencyAffected: true })
    remaining(clock, 144)
  })

  it('distinguishes an inactive physical Pepe from the same actual skill used as an ideal reference', () => {
    const physical = fixture(1, [], ['佩佩'])
    physical.frame.active.clear(); physical.frame.morale.set(id('佩佩'), 0)
    physical.frame.config.operatorMorale[id('佩佩')] = 0; physical.frame.config.zeroMoraleOperatorIds = [id('佩佩')]
    expect(physical.clock().snapshot()[ROOM]).toMatchObject({ mode: 'gold', efficiencyAffected: true })
    const ideal = fixture(1, ['佩佩'], ['佩佩'])
    ideal.frame.active.clear(); ideal.frame.morale.set(id('佩佩'), 0)
    ideal.frame.config.operatorMorale[id('佩佩')] = 0; ideal.frame.config.zeroMoraleOperatorIds = [id('佩佩')]
    expect(ideal.clock().snapshot()[ROOM]).toMatchObject({ mode: 'pepe', efficiencyAffected: false })
  })

  it('keeps orundum mode above configured acquisition references and carries its own base work', () => {
    const input = fixture(3, ['可露希尔', '佩佩'])
    input.schedule.rooms.find(room => room.roomId === ROOM)!.product = 'orundum'
    input.frame.config.rooms[0]!.strategy = 'orundum'
    const clock = input.clock()
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'orundum', efficiencyAffected: true })
    remaining(clock, 120)
    step(input, clock, 1); remaining(clock, 60)
  })

  it('observes current remaining work and current efficiency at the observation instant rather than request creation', () => {
    const input = fixture(), clock = input.clock()
    step(input, clock, 1)
    const read = boundary(input, clock, readRequest())
    expect(read.delayMicros).toBe(0)
    step(input, clock, .25)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    // At t=1.25h, 69 base minutes remain: 1.25 + 69/120 = 1.825h.
    expect(read.observe()).toEqual({ observedAtMicros: toMowerMicros(1.25), absoluteDueMicros: toMowerMicros(1.825) })
  })

  it('matches Native enter/wait/read/return delays, updates only observation UI and lets the host advance time', () => {
    const input = fixture(), clock = input.clock()
    const enter = boundary(input, clock, { kind: 'enter-room', room: ROOM })
    expect(enter.delayMicros).toBe(0)
    expect(input.state.mowerUI!.scene).toBe('INFRA_MAIN')
    expect(enter.observe()).toEqual({ observedAtMicros: 0 })
    expect(input.state.mowerUI).toEqual({ scene: 'INFRA_DETAILS', lastRoom: ROOM })
    const wait = boundary(input, clock, { kind: 'wait-interface', room: ROOM, requestedIntervalMicros: 1_000_000 })
    expect(wait.delayMicros).toBe(0)
    expect(wait.observe()).toEqual({ observedAtMicros: 0 })
    expect(boundary(input, clock, readRequest()).observe()).toEqual({ observedAtMicros: 0, absoluteDueMicros: toMowerMicros(2.4) })
    const returning = boundary(input, clock, { kind: 'return-main', room: ROOM })
    expect(returning.delayMicros).toBe(500_000)
    expect(input.state.time).toBe(0)
    step(input, clock, 500_000 / 3_600_000_000)
    expect(returning.observe()).toEqual({ observedAtMicros: 500_000 })
    expect(input.state.mowerUI).toEqual({ scene: 'INFRA_MAIN', lastRoom: ROOM })
    remaining(clock, 144 - .5 / 60)
  })

  it.each([0, -1, NaN, Infinity])('rejects an unknown ordinary deadline at efficiency %s', efficiency => {
    const input = fixture(), clock = input.clock(), before = clock.snapshot()
    input.frame.evaluations[ROOM]!.efficiencyPercent = efficiency
    const read = boundary(input, clock, readRequest())
    expect(() => read.observe()).toThrow()
    expect(clock.snapshot()).toEqual(before)
  })

  it('pauses ordinary work at zero efficiency without resetting progress and resumes its current deadline', () => {
    const input = fixture(), clock = input.clock()
    step(input, clock, 1); remaining(clock, 84)
    input.frame.evaluations[ROOM]!.efficiencyPercent = 0
    step(input, clock, 2); remaining(clock, 84)
    const unknown = boundary(input, clock, readRequest())
    expect(() => unknown.observe()).toThrow()
    input.frame.evaluations[ROOM]!.efficiencyPercent = 200
    expect(boundary(input, clock, readRequest()).observe().absoluteDueMicros).toBe(toMowerMicros(3.7))
  })

  it.each([-1, NaN, Infinity])('rejects invalid elapsed hours %s without partially advancing orders', hours => {
    const input = fixture(), clock = input.clock(), before = clock.snapshot()
    expect(() => clock.advance(hours, input.frame)).toThrow()
    expect(clock.snapshot()).toEqual(before)
  })

  it('rejects invalid frame efficiency atomically and requires real owned records for ideal acquisition', () => {
    const input = fixture(1, [], [], true), clock = input.clock(), before = clock.snapshot()
    input.frame.evaluations.room_1_2!.efficiencyPercent = NaN
    expect(() => clock.advance(1, input.frame)).toThrow()
    expect(clock.snapshot()).toEqual(before)
    const absent = fixture(1, ['可露希尔'])
    absent.frame.config.operatorRecords = {}
    expect(() => absent.clock()).toThrow()
  })

  it('supplies the real Native planning contract with an absolute due and preserves its three-minute early wake', () => {
    const input = fixture(1, ['但书']), clock = input.clock()
    const planning: RunOrderPlanningState = { plan: { [ROOM]: [{ replacement: [id('但书')] }] },
      runOrderRooms: [ROOM], queue: new MowerTaskQueue(), configuredDelayMinutes: 3, droneRoom: null,
      flags: { planned: false, todoTask: false, collectNotification: false } }
    const task = planDefaultRunOrder(planning, { nowMicros: () => toMowerMicros(input.state.time),
      currentDormOccupants: () => undefined, scheduling: {} }, ROOM)
    const bridge = bridgeMowerNativeIO(task, request => clock.rates.mowerRunOrderIO!(request, input.state))
    let next = bridge.next()
    while (!next.done) {
      step(input, clock, next.value.delayMicros / 3_600_000_000)
      next = bridge.next()
    }
    expect(planning.queue.tasks).toHaveLength(1)
    expect(next.value?.observedOrderDueMicros).toBe(toMowerMicros(2.4))
    expect(next.value?.timeMicros).toBe(toMowerMicros(2.35))
    expect(toMowerMicros(input.state.time)).toBe(500_000)
  })

  it('leaves original job/config/frame and business state untouched and returns defensive snapshots', () => {
    const input = fixture(1, ['可露希尔'])
    const before = structuredClone({ workspace: input.workspace, schedule: input.schedule, state: input.state, frame: input.frame })
    const clock = input.clock()
    clock.advance(1, input.frame)
    expect({ workspace: input.workspace, schedule: input.schedule, state: input.state, frame: input.frame }).toEqual(before)
    const snapshot = clock.snapshot()
    snapshot[ROOM]!.remainingBaseMinutes = 999; snapshot[ROOM]!.mode = 'pepe'
    expect(clock.snapshot()[ROOM]).toMatchObject({ mode: 'closure', remainingBaseMinutes: 84, completedOrders: 0 })
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })
})
