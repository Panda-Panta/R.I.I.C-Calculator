import { describe, expect, it } from 'vitest'
import { createRosterRuntime } from './rosterRuntime'
import { getMowerSourceRuntime, nextMowerSourceActionHours, settleMowerSource } from './mowerSourceRuntime'
import { MowerTask, MOWER_TASK_TYPES as T } from './mowerTaskQueue'
import { MowerBackupRecoveryBlocked } from './mowerBackupDepartureRecovery'
import { parkMowerBackupDepartureRecovery } from './mowerPreviewRecoveryWait'
import { projectMowerArrangements } from './mowerObservations'

const rates = { workRate: () => 1, recoveryRate: () => 4 }

/** One real runtime boundary, with clocks from saved m12; no calendar/H/F. */
function fixture(park = true) {
  const state = createRosterRuntime({
    mowerAlpha: true,
    positions: [
      { id: 'central_0', roomId: 'central', primary: 'A', candidates: ['R'], group: 'g', exhaustRequired: true },
      { id: 'meeting_0', roomId: 'meeting', primary: 'B', candidates: ['S'], group: 'h' },
      { id: 'dormitory_1_0', roomId: 'dormitory_1', primary: 'K', candidates: [], dormitory: true, permanent: true },
    ],
    beds: [{ id: 'dormitory_1_1', roomId: 'dormitory_1', vip: true }],
    initialMorale: { A: 0, B: 2, R: 24, S: 24, K: 24 }, idleOperators: [],
    mowerSourcePlan: {
      central: [{ agent: 'A', group: 'g', replacement: ['R'] }],
      meeting: [{ agent: 'B', group: 'h', replacement: ['S'] }],
      dormitory_1: [{ agent: 'K', group: '', replacement: [] }, { agent: 'Free', group: '', replacement: [] }],
    },
    mowerSourceRules: { workaholic: [], exhaustRequire: ['A'], restInFull: ['B'], lowPriority: [], refreshDrained: [], lingMode: 0 },
    mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] },
    mowerTaskScheduling: { adjustForRunOrders: false },
    mowerRunLoopClock: { minimumClockStepMicros: 1, notificationSleepMicros: 1_000_000 },
  })
  state.time = 18.99408138786184
  const source = getMowerSourceRuntime(state), data = source.data, now = 68_378_692_996
  source.initial = false; source.firstInit = false; source.startupRunOrderCheckPending = false; source.initialStaffingPending = false
  state.occupants = { central_0: 'A', meeting_0: 'S', dormitory_1_0: 'K' }
  state.bedOccupants = { dormitory_1_1: 'B' }
  for (const op of Object.values(data.operators)) { op.setProjectedPosition('', -1); op.timeStampMicros = now; op.depletionRate = 0 }
  for (const [slot, name] of Object.entries({ ...state.occupants, ...state.bedOccupants })) {
    const op = data.operators[name]!
    op.setProjectedPosition(slot.slice(0, slot.lastIndexOf('_')), Number(slot.slice(slot.lastIndexOf('_') + 1)))
    op.mood = state.morale[name]!
  }
  data.dorms[0]!.name = 'B'; data.dorms[0]!.timeMicros = 73_666_542_258
  data.groupShiftState.h = true
  const departure = new MowerTask({ type: T.SHIFT_OFF, plan: { central: ['R'] } })
  departure.timeMicros = 68_063_697_190
  departure.ordinaryCoordination = true; departure.coordinationRequestNames = ['A']
  const reservation = new MowerTask({ time: state.time + 1, type: T.SHIFT_ON, plan: { dormitory_1: ['Current', 'B'] } })
  source.queue.tasks = park ? [departure, reservation] : [reservation]
  if (park) {
    const failure = new MowerBackupRecoveryBlocked(['A'], projectMowerArrangements(data, [departure.plan]), new Set(['central\0' + 0]), new Set())
    expect(parkMowerBackupDepartureRecovery(source, departure, failure)).toBe(true)
    expect(source.waitingRecovery?.[0]?.reason).toBe('departure-bed')
    expect(source.queue.tasks).not.toContain(departure)
  }
  source.runFlags = { planned: true, todoTask: true, collectNotification: true }
  return { state, source, data, departure, reservation, now }
}

describe('preview recovery admission at native run completion (0 H/F)', () => {
  it('admits a released original departure before selecting the existing outer clock', () => {
    const { state, source, departure, reservation, now } = fixture()
    const occupants = { ...state.occupants }, beds = { ...state.bedOccupants }, morale = { ...state.morale }, intent = structuredClone(departure.plan)
    // A completed phase changes a real watched reservation, as m12 planning did.
    source.phaseExecution = { steps: (function* () { source.queue.consume(reservation) })(), wakeMicros: now, skipPlanning: true }
    settleMowerSource(state, rates)
    expect(source.waitingRecovery ?? []).toHaveLength(0)
    expect(source.queue.tasks).toContain(departure)
    expect(departure.executionRetained).toBe(true)
    expect(departure.timeMicros).toBe(68_063_697_190)
    expect(departure.plan).toEqual(intent)
    expect(source.runReturn?.wakeMicros).toBe(now + 1)
    expect(nextMowerSourceActionHours(state)).toBe(1 / 3_600_000_000)
    expect(nextMowerSourceActionHours(state)).toBe(1 / 3_600_000_000)
    expect(state.time).toBe(18.99408138786184)
    expect(state.occupants).toEqual(occupants); expect(state.bedOccupants).toEqual(beds); expect(state.morale).toEqual(morale)
  })

  it('keeps unchanged bed prerequisites parked when only the clock advances', () => {
    const { state, source, departure, now } = fixture(), wait = source.waitingRecovery![0]!
    source.phaseExecution = { steps: (function* () {})(), wakeMicros: now, skipPlanning: true }
    settleMowerSource(state, rates)
    expect(source.waitingRecovery).toContain(wait)
    expect(source.queue.tasks).not.toContain(departure)
    expect(nextMowerSourceActionHours(state)).toBeGreaterThan(0)
    state.time += .25
    expect(source.waitingRecovery).toContain(wait)
    expect(source.queue.tasks).not.toContain(departure)
    expect(departure.timeMicros).toBe(68_063_697_190)
    expect(nextMowerSourceActionHours(state)).toBeGreaterThan(0)
  })

  it('does not treat an unrelated completed reservation as release of the watched bed', () => {
    const { state, source, departure, now } = fixture(), wait = source.waitingRecovery![0]!
    const unrelated = new MowerTask({ time: state.time + 2, type: T.SHIFT_ON, plan: { train: ['Other'] } })
    source.queue.tasks.push(unrelated)
    source.phaseExecution = { steps: (function* () { source.queue.consume(unrelated) })(), wakeMicros: now, skipPlanning: true }
    settleMowerSource(state, rates)
    expect(source.waitingRecovery).toContain(wait)
    expect(source.queue.tasks).not.toContain(departure)
    expect(nextMowerSourceActionHours(state)).toBeGreaterThan(0)
  })

  it('preserves the completed run fallback when there is no parked recovery', () => {
    const { state, source, reservation, now } = fixture(false)
    source.phaseExecution = { steps: (function* () { source.queue.consume(reservation) })(), wakeMicros: now, skipPlanning: true }
    settleMowerSource(state, rates)
    expect(source.waitingRecovery ?? []).toHaveLength(0)
    expect(source.runReturn).toBeUndefined()
    expect(source.queue.tasks).toHaveLength(1)
    expect(source.queue.tasks[0]!.type).toBe(T.NOT_SPECIFIC)
    expect(nextMowerSourceActionHours(state)).toBeCloseTo(2.5, 9)
  })
})
