import { describe, expect, it } from 'vitest'
import { resolveOperatorCharId } from '../workbench/compat/mowerJson'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, advanceRoster, createRosterRuntime, nextRosterActionHours, nextRosterEventHours, settleRoster, type RuntimeRates, type RuntimeState } from './rosterRuntime'
import { getMowerSourceRuntime } from './mowerSourceRuntime'
import { MOWER_TASK_TYPES as T, MowerTask, toMowerMicros } from './mowerTaskQueue'

const gladiia = resolveOperatorCharId('歌蕾蒂娅')
const dusk = resolveOperatorCharId('夕')
const aroma = resolveOperatorCharId('阿罗玛')
const gravel = resolveOperatorCharId('砾')
const keepers = ['闪灵', '夜莺', '杜林', '安比尔'].map(resolveOperatorCharId)
const rates = { workRate: () => 24, recoveryRate: () => 4 }
const planningRates = { workRate: () => 1, recoveryRate: () => 4 }
const thresholdRates = { workRate: () => 8, recoveryRate: () => 4 }

interface FixtureOptions { exhaustPeer?: boolean; workaholic?: boolean; missingReplacement?: boolean; missingBed?: boolean }

function fixture(initialMorale = 1, options: FixtureOptions = {}) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) room.slots = []
  workspace.mainPlan.facilities.central.slots = [{ occupant: { kind: 'operator', operatorId: gladiia }, groupId: options.exhaustPeer ? 'group' : null, replacements: [dusk] }]
  workspace.mainPlan.facilities.dormitory_1.slots = [
    ...keepers.map(operatorId => ({ occupant: { kind: 'operator' as const, operatorId }, groupId: null, replacements: [] })),
    { occupant: { kind: 'free' }, groupId: null, replacements: [] },
  ]
  if (options.exhaustPeer) {
    workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: aroma }, groupId: 'group', replacements: [gravel] }]
    workspace.mainPlan.facilities.dormitory_1.slots[3] = { occupant: { kind: 'free' }, groupId: null, replacements: [] }
    workspace.mainPlan.conf.exhaust_require = [aroma]
  }
  if (options.missingReplacement) workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: dusk }, groupId: null, replacements: [] }]
  if (options.workaholic) workspace.mainPlan.conf.workaholic = [gladiia]
  if (options.missingBed) workspace.mainPlan.facilities.dormitory_1.slots[4] = { occupant: { kind: 'operator', operatorId: resolveOperatorCharId('克洛丝') }, groupId: null, replacements: [] }
  // Keep the native Free-bed correction satisfiable even when the configured
  // replacement is already working elsewhere and cannot cover the central slot.
  const idleOperators = options.missingReplacement ? [resolveOperatorCharId('Castle-3')] : []
  const schedule = compileRosterSchedule(workspace, { operatorMorale: { [gladiia]: initialMorale, [aroma]: initialMorale }, idleOperators })
  const config = compiledScheduleToRuntimeConfig(schedule)
  config.mowerAlpha = false
  return config
}

function finishImmediateShift(state: RuntimeState) {
  for (let step = 0; step < 20 && !Object.values(state.bedOccupants).includes(gladiia); step++) {
    const hours = nextRosterActionHours(state, rates)
    if (!Number.isFinite(hours) || state.time + hours > 5 / 3600) break
    advanceRoster(state, hours, rates)
    settleRoster(state, rates)
  }
}

function generatedShift(state: RuntimeState) {
  const source = getMowerSourceRuntime(state)
  for (let step = 0; step < 20; step++) {
    const task = source.queue.tasks.find(task => task.type === T.SHIFT_OFF)
    if (task) return task
    const hours = nextRosterActionHours(state, rates)
    if (!Number.isFinite(hours) || state.time + hours > 5 / 3600) break
    advanceRoster(state, hours, rates)
    settleRoster(state, rates)
  }
  throw new Error('Ordinary planning did not generate a downshift: ' + JSON.stringify(source.trace))
}

function completeInitialPlanning(state: RuntimeState, eventRates: RuntimeRates = planningRates) {
  const source = getMowerSourceRuntime(state)
  settleRoster(state, eventRates)
  for (let step = 0; step < 20; step++) {
    if (source.runFlags?.collectNotification && !source.execution && !source.phaseExecution && !source.runReturn) return source
    const hours = nextRosterActionHours(state, eventRates)
    if (!Number.isFinite(hours) || state.time + hours > 5 / 3600) break
    advanceRoster(state, hours, eventRates)
    settleRoster(state, eventRates)
  }
  throw new Error('Initial planning did not finish: ' + JSON.stringify(source.trace))
}

/** Follow the actual simulation's integration/dispatch boundary without a report. */
function advanceThroughSourceEvents(state: RuntimeState, endHours: number, eventRates: RuntimeRates = thresholdRates) {
  let steps = 0
  for (; steps < 100 && state.time < endHours; steps++) {
    if (nextRosterActionHours(state, eventRates) === 0) settleRoster(state, eventRates)
    const hours = Math.min(endHours - state.time, nextRosterEventHours(state, eventRates))
    expect(Number.isFinite(hours) && hours > 0, JSON.stringify({ time: state.time, trace: getMowerSourceRuntime(state).trace })).toBe(true)
    advanceRoster(state, hours, eventRates)
    if (nextRosterActionHours(state, eventRates) === 0) settleRoster(state, eventRates)
  }
  expect(state.time, 'Planning wakes must progress instead of repeating at the same clock').toBeCloseTo(endHours, 10)
  return steps
}

describe('default Mower downshift before Gladiia fatigue', () => {
  it('actually rests a positive-morale worker when a replacement and bed are available', () => {
    const state = createRosterRuntime(fixture())
    expect(state.morale[gladiia]).toBe(1)
    settleRoster(state, rates)
    finishImmediateShift(state)
    expect(getMowerSourceRuntime(state).data.alpha).toBe(false)
    expect(state.occupants.central_0).toBe(dusk)
    expect(state.bedOccupants.dormitory_1_4).toBe(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(0)
    expect(state.diagnostics.some(d => d.code === 'group-blocked')).toBe(false)
  })

  it('preserves the automatically generated downshift due in an ideal run-order runtime', () => {
    const config = fixture()
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    const source = getMowerSourceRuntime(state)
    expect(state.morale[gladiia]).toBe(1)
    settleRoster(state, rates)

    const downshift = generatedShift(state)
    expect(downshift.plan.central).toEqual([dusk])
    expect(downshift.plan.dormitory_1?.[4]).toBe(gladiia)
    expect(downshift.strictMoodLimit).toBe(false)
    expect(downshift.backupShiftActive).toBe(false)
    expect(downshift.productShiftLocked).toBe(false)
    expect(source.data.operators[gladiia]!.group).toBe('')
    expect(source.data.operators[gladiia]!.exhaustRequire).toBe(false)
    expect(source.execution).toBeUndefined()
    expect(state.diagnostics.some(d => d.code === 'group-blocked')).toBe(false)
    const generatedDue = downshift.timeMicros
    expect(generatedDue).toBe(toMowerMicros(state.time))
    // A real observed run-order wake arrives after ordinary planning and before
    // dispatch. Both the task and the original downshift retain their identities.
    const order = new MowerTask({ time: 60 / 3600, type: T.RUN_ORDER, metadata: 'room_1_1' })
    order.observedOrderDueMicros = toMowerMicros(240 / 3600)
    source.queue.tasks.push(order)
    finishImmediateShift(state)
    const evidence = JSON.stringify({
      timeSeconds: state.time * 3600,
      physicalMood: state.morale[gladiia],
      cachedMood: source.data.operators[gladiia]!.currentMood(source.data.nowMicros),
      downshiftDueSeconds: downshift.time * 3600,
      orderDueSeconds: order.time * 3600,
      occupants: state.occupants,
      beds: state.bedOccupants,
    })
    expect.soft(downshift.timeMicros, evidence).toBe(generatedDue)
    expect.soft(state.occupants.central_0, evidence).toBe(dusk)
    expect.soft(state.bedOccupants.dormitory_1_4, evidence).toBe(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(0)
  })

  it('retains the independent planning fallback when only an ideal order is pending', () => {
    const config = fixture(16)
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const baseline = createRosterRuntime(config)
    const baselineSource = completeInitialPlanning(baseline)
    const baselineFallback = baselineSource.queue.tasks.filter(task => task.type === T.NOT_SPECIFIC && task.timeMicros > baselineSource.data.nowMicros)
    expect(baselineFallback).toHaveLength(1)

    const state = createRosterRuntime(config)
    const order = new MowerTask({ time: 1, type: T.RUN_ORDER, metadata: 'room_1_1' })
    order.observedOrderDueMicros = toMowerMicros(1.05)
    getMowerSourceRuntime(state).queue.tasks.push(order)
    const source = completeInitialPlanning(state)
    const fallback = source.queue.tasks.filter(task => task.type === T.NOT_SPECIFIC && task.timeMicros > source.data.nowMicros)
    expect(source.queue.tasks).toContain(order)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(15)
    expect(source.queue.tasks.some(task => task.type === T.SHIFT_OFF)).toBe(false)
    expect(fallback, JSON.stringify(source.queue.tasks.map(task => ({ type: task.type.key, dueHours: task.time })))).toHaveLength(1)
    expect(fallback[0]!.timeMicros).toBe(baselineFallback[0]!.timeMicros)
  })

  it.each(['FIAMMETTA', 'SKILL_UPGRADE', 'SWAP_SUPPORT'] as const)('retains %s protection against a redundant planning fallback', type => {
    const config = fixture(16)
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    const protectedTask = new MowerTask({ time: 1, type: T[type] })
    getMowerSourceRuntime(state).queue.tasks.push(protectedTask)
    const source = completeInitialPlanning(state)
    expect(source.queue.tasks).toContain(protectedTask)
    expect(protectedTask.timeMicros).toBe(toMowerMicros(1))
    expect(source.queue.tasks.some(task => task.type === T.NOT_SPECIFIC && task.timeMicros > source.data.nowMicros)).toBe(false)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(15)
  })

  it.each([false, true])('wakes from the real ordinary morale threshold before fatigue, with future order=%s', withOrder => {
    const config = fixture(16)
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    if (withOrder) {
      const order = new MowerTask({ time: 2.4, type: T.RUN_ORDER, metadata: 'room_1_1' })
      order.observedOrderDueMicros = toMowerMicros(2.45)
      getMowerSourceRuntime(state).queue.tasks.push(order)
    }
    completeInitialPlanning(state)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(15)
    // At 8/hour, 16 morale naturally reaches 15 at .125h and zero at 2h.
    // Physical integration alone must not leave her working until the 2.5h poll.
    const steps = advanceThroughSourceEvents(state, 2.1)
    const evidence = JSON.stringify({ time: state.time, morale: state.morale[gladiia], occupants: state.occupants, beds: state.bedOccupants, trace: getMowerSourceRuntime(state).trace })
    expect.soft(state.occupants.central_0, evidence).toBe(dusk)
    expect.soft(Object.values(state.bedOccupants), evidence).toContain(gladiia)
    expect.soft(state.morale[gladiia], evidence).toBeGreaterThan(0)
    expect(steps).toBeLessThan(40)
  })

  it('waits for the mandatory exhaust member rather than the ordinary threshold of its peer', () => {
    const config = fixture(16, { exhaustPeer: true })
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    const source = completeInitialPlanning(state)
    expect(source.data.operators[gladiia]!.exhaustRequire).toBe(false)
    expect(source.data.operators[aroma]!.exhaustRequire).toBe(true)
    expect(source.data.operators[gladiia]!.group).toBe(source.data.operators[aroma]!.group)
    advanceThroughSourceEvents(state, 1)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(state.occupants.room_1_1_0).toBe(aroma)
    // The mandatory member reaches lowerLimit+2 at 1.75h. The real exhaust
    // planner can then create the group downshift, while both still have morale.
    advanceThroughSourceEvents(state, 1.9)
    expect.soft(state.occupants.central_0).toBe(dusk)
    expect.soft(state.occupants.room_1_1_0).toBe(gravel)
    expect.soft(Object.values(state.bedOccupants)).toEqual(expect.arrayContaining([gladiia, aroma]))
    expect(state.morale[gladiia]).toBeGreaterThan(0)
    expect(state.morale[aroma]).toBeGreaterThan(0)
  })

  it('retains a decimal-rate planning alarm across production substeps just before its microsecond due', () => {
    const config = fixture(21.9269478315)
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, adjustForRunOrders: false }
    const state = createRosterRuntime(config)
    const source = completeInitialPlanning(state)
    const decimalRates: RuntimeRates = { workRate: () => 3.2, recoveryRate: () => 4, thresholds: () => [4, 8, 12, 16, 18, 20] }
    expect(nextRosterActionHours(state, decimalRates)).toBeLessThan(2.5)
    expect(source.planningWake?.names).toEqual([gladiia])

    // Order production can divide the same morale interval into small positive
    // segments. These are real advances, with the usual physical skill bands.
    let substeps = 0
    while (source.planningWake && (source.planningWake.timeMicros - toMowerMicros(state.time)) / 3_600_000_000 > .1) {
      expect(substeps++).toBeLessThan(40)
      advanceRoster(state, Math.min(.1, nextRosterEventHours(state, decimalRates)), decimalRates)
      nextRosterActionHours(state, decimalRates)
    }
    expect(source.planningWake).toBeDefined()
    const dueMicros = source.planningWake!.timeMicros
    advanceRoster(state, (dueMicros - 1) / 3_600_000_000 - state.time, decimalRates)
    expect(toMowerMicros(state.time)).toBe(dueMicros - 1)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(state.morale[gladiia]).toBeCloseTo(15, 8)

    const remaining = nextRosterActionHours(state, decimalRates)
    const evidence = JSON.stringify({ dueMicros, nowMicros: source.data.nowMicros, mood: state.morale[gladiia], planningWake: source.planningWake, remaining, trace: source.trace })
    expect.soft(source.planningWake, evidence).toEqual({ timeMicros: dueMicros, names: [gladiia] })
    expect.soft(remaining, evidence).toBe(1 / 3_600_000_000)
    advanceThroughSourceEvents(state, (dueMicros + 5_000_000) / 3_600_000_000, decimalRates)
    expect.soft(state.occupants.central_0, evidence).toBe(dusk)
    expect.soft(Object.values(state.bedOccupants), evidence).toContain(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(0)
  })

  it.each([
    { label: 'position threshold only', bands: [] },
    { label: 'physical skill bands', bands: [4, 8, 12, 16, 18, 20] },
  ])('keeps an absolute alarm across fractional physical crossings: $label', ({ bands }) => {
    const config = fixture(21.9269478315)
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, adjustForRunOrders: false }
    const state = createRosterRuntime(config)
    const decimalRates: RuntimeRates = { workRate: () => 3.2, recoveryRate: () => 4, thresholds: () => bands }
    const source = completeInitialPlanning(state, decimalRates)
    nextRosterActionHours(state, decimalRates)
    expect(source.planningWake).toEqual({ timeMicros: 7_792_816_311, names: [gladiia] })

    // Follow actual morale boundaries, including the fractional physical 15
    // crossing. Do not jump directly to the alarm or overwrite physical mood.
    let steps = 0
    while (state.morale[gladiia]! > 15) {
      expect(steps++).toBeLessThan(20)
      const hours = nextRosterEventHours(state, decimalRates)
      expect(Number.isFinite(hours) && hours > 0).toBe(true)
      advanceRoster(state, hours, decimalRates)
      if (state.morale[gladiia]! > 15) {
        nextRosterActionHours(state, decimalRates)
        expect.soft(source.planningWake?.timeMicros, JSON.stringify({ time: state.time, mood: state.morale[gladiia], nowMicros: source.data.nowMicros })).toBe(7_792_816_311)
      }
    }
    expect(state.morale[gladiia]).toBe(15)
    expect(getMowerSourceRuntime(state).data.nowMicros).toBe(7_792_816_310)
    expect(source.planningWake?.timeMicros).toBe(7_792_816_311)

    const remaining = nextRosterActionHours(state, decimalRates)
    const evidence = JSON.stringify({ time: state.time, mood: state.morale[gladiia], nowMicros: source.data.nowMicros, planningWake: source.planningWake, remaining })
    expect.soft(remaining, evidence).toBe(1 / 3_600_000_000)
    expect.soft(source.planningWake, evidence).toEqual({ timeMicros: 7_792_816_311, names: [gladiia] })
    advanceThroughSourceEvents(state, (7_792_816_311 + 5_000_000) / 3_600_000_000, decimalRates)
    expect.soft(state.occupants.central_0, evidence).toBe(dusk)
    expect.soft(Object.values(state.bedOccupants), evidence).toContain(gladiia)
    expect(state.morale[gladiia]).toBeGreaterThan(0)
  })

  it('keeps workaholics outside ordinary threshold wakes', () => {
    const config = fixture(16, { workaholic: true })
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    const source = completeInitialPlanning(state)
    expect(source.data.operators[gladiia]!.workaholic).toBe(true)
    const steps = advanceThroughSourceEvents(state, .3)
    expect(state.occupants.central_0).toBe(gladiia)
    expect(source.trace.some(task => task.type === T.SHIFT_OFF.key)).toBe(false)
    expect(source.queue.tasks.some(task => task.type === T.SHIFT_OFF)).toBe(false)
    expect(steps).toBeLessThan(10)
  })

  it.each(['replacement', 'bed'] as const)('retains occupants and makes bounded progress when the %s is unavailable', resource => {
    const config = fixture(16, { missingReplacement: resource === 'replacement', missingBed: resource === 'bed' })
    config.mowerTaskScheduling = { ...config.mowerTaskScheduling, ...{ adjustForRunOrders: false } }
    const state = createRosterRuntime(config)
    const source = completeInitialPlanning(state)
    if (resource === 'replacement') {
      expect(source.data.operators[gladiia]!.replacement).toEqual([dusk])
      expect(state.occupants.room_1_1_0).toBe(dusk)
    }
    const steps = advanceThroughSourceEvents(state, .3)
    expect(state.occupants.central_0).toBe(gladiia)
    if (resource === 'replacement') expect(state.occupants.room_1_1_0).toBe(dusk)
    expect(Object.values(state.bedOccupants)).not.toContain(gladiia)
    expect(source.trace.some(task => task.type === T.SHIFT_OFF.key)).toBe(false)
    expect(source.queue.tasks.some(task => task.type === T.SHIFT_OFF)).toBe(false)
    expect(steps).toBeLessThan(40)
    expect(source.queue.tasks.length).toBeLessThan(5)
  })
})
