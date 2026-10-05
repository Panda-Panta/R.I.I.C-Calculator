import { describe, expect, it } from 'vitest'
import { advanceRoster, createRosterRuntime, nextRosterActionHours, settleRoster, type RuntimeConfig, type RuntimeState } from './rosterRuntime'
import { getMowerSourceRuntime } from './mowerSourceRuntime'
import { MowerTask, MOWER_TASK_TYPES as T } from './mowerTaskQueue'
import { mowerConfirmedRecoveryTarget } from './mowerDormRecovery'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'

const rates = { workRate: () => 1, recoveryRate: () => 4 }
const room = 'dormitory_1'

function fixture(adjustForRunOrders?: boolean, extraIdle: Record<string, number> = {}) {
  const keepers = ['Manager', 'Resident1', 'Resident2']
  const config: RuntimeConfig = {
    positions: [
      { id: 'room_1_1_0', roomId: 'room_1_1', primary: 'A', candidates: ['R'], lowerLimit: 0, upperLimit: 24, shiftOffThreshold: 15 },
      ...keepers.map((primary, index) => ({ id: room + '_' + index, roomId: room, primary, candidates: [], permanent: true, dormitory: true })),
    ],
    beds: [{ id: room + '_3', roomId: room, vip: true }, { id: room + '_4', roomId: room, vip: false }],
    initialMorale: { A: 24, R: 24, Incoming: 7, Other: 8, ...extraIdle },
    idleOperators: ['Incoming', 'Other', ...Object.keys(extraIdle)],
    mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] },
    mowerTaskScheduling: { adjustForRunOrders },
    mowerDeviceTiming: { roomReturnMicros: 500_000 },
    mowerRunLoopClock: { minimumClockStepMicros: 1, notificationSleepMicros: 1_000_000 },
    mowerSourcePlan: {
      room_1_1: [{ agent: 'A', group: '', replacement: ['R'] }],
      [room]: [...keepers.map(agent => ({ agent, group: '', replacement: [] })), ...['Free', 'Free'].map(agent => ({ agent, group: '', replacement: [] }))],
    },
    mowerSourceRules: { workaholic: [], exhaustRequire: [], restInFull: [], lowPriority: [], refreshDrained: [], lingMode: 0 },
  }
  const state = createRosterRuntime(config), source = getMowerSourceRuntime(state)
  source.initial = false
  state.bedOccupants[room + '_4'] = 'Other'
  source.data.operators.Incoming!.mood = 7; source.data.operators.Incoming!.timeStampMicros = 0
  for (const [index, name] of [...keepers, '', 'Other'].entries()) if (name) {
    const op = source.data.operators[name]!
    op.currentRoom = room; op.currentIndex = index; op.mood = state.morale[name] ?? 24; op.timeStampMicros = 0
  }
  source.data.operators.A!.currentRoom = 'room_1_1'; source.data.operators.A!.currentIndex = 0
  source.data.operators.Manager!.singleRecoveryManager = true
  return { state, source }
}

function finish(state: RuntimeState, task: MowerTask) {
  const source = getMowerSourceRuntime(state)
  for (let step = 0; step < 30 && source.queue.tasks.includes(task); step++) {
    settleRoster(state, rates)
    if (source.queue.tasks.includes(task)) advanceRoster(state, nextRosterActionHours(state, rates), rates)
  }
  expect(source.queue.tasks).not.toContain(task)
  expect(source.error).toBeFalsy()
}

describe('ideal dorm ordering after Free selection', () => {
  it('establishes recovery on first selection and reuses it for an identical backup arrangement', () => {
    const { state, source } = fixture(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    const incoming = source.data.operators.Incoming!, other = source.data.operators.Other!
    expect(state.bedOccupants[room + '_3']).toBe('Incoming')
    expect(incoming.dormRecoveryRoom).toBe(room)
    expect(incoming.dormRecoveryIndex).toBe(3)
    const version = other.dormPositionVersion
    const repeat = new MowerTask({ time: state.time, plan: { [room]: ['Current', 'Current', 'Current', 'Current', 'Current'] } })
    source.queue.tasks.push(repeat); finish(state, repeat)
    expect(other.dormPositionVersion).toBe(version)
    expect(state.bedOccupants[room + '_4']).toBe('Other')
    expect(incoming.dormRecoveryRoom).toBe(room)
  })

  it('keeps the native first-selection and later recovery-ordering boundary by default', () => {
    const { state, source } = fixture()
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    expect(source.data.operators.Incoming!.dormRecoveryRoom).toBe('')
    const other = source.data.operators.Other!, version = other.dormPositionVersion
    const repeat = new MowerTask({ time: state.time, plan: { [room]: ['Current', 'Current', 'Current', 'Current', 'Current'] } })
    source.queue.tasks.push(repeat); finish(state, repeat)
    expect(other.dormPositionVersion).toBeGreaterThan(version)
    expect(source.data.operators.Incoming!.dormRecoveryRoom).toBe(room)
  })

  it.each([false, true])('does not invent recovery for an unobserved Free card (unregistered=%s)', unregistered => {
    const { state, source } = fixture(false)
    const name = unregistered ? id('伺夜') : 'Incoming'
    if (unregistered) {
      source.data.operators.Incoming!.workaholic = true
      state.config.availableIdleOperators = [name]
      state.morale[name] = 7
      expect(source.data.operators[name]).toBeUndefined()
    } else {
      source.data.operators.Incoming!.mood = 24
      source.data.operators.Incoming!.timeStampMicros = undefined
    }
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    const incoming = source.data.operators[name]!
    expect(state.bedOccupants[room + '_3']).toBe(name)
    expect(incoming.timeStampMicros).toBeDefined()
    expect(incoming.mood).toBeLessThan(24)
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBeUndefined()
    const repeat = new MowerTask({ time: state.time, plan: { [room]: ['Current', 'Current', 'Current', 'Current', 'Current'] } })
    source.queue.tasks.push(repeat); finish(state, repeat)
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBe(name)
  })

  it('keeps a completed limited card out of a newly selected Free bed', () => {
    const { state, source } = fixture(false)
    const incoming = source.data.operators.Incoming!, alternative = id('伺夜')
    incoming.upperLimit = 7; incoming.restMoodLimit = true
    source.data.operators.R!.workaholic = true
    state.config.availableIdleOperators = [alternative]; state.morale[alternative] = 9
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    expect(state.bedOccupants[room + '_3']).toBe(alternative)
    expect(incoming.currentRoom).toBe('')
    expect(incoming.dormRecoveryRoom).toBe('')
  })

  it('revalidates a Free card when temporary observation reaches its custom rest limit', () => {
    const { state, source } = fixture(false)
    const incoming = source.data.operators.Incoming!
    incoming.upperLimit = 8; incoming.restMoodLimit = true
    state.morale.Incoming = 9
    expect(incoming.mood).toBe(7)
    expect(source.data.restMoodComplete('Incoming')).toBe(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]
    // Run the real temporary confirmation and final observation, stopping at the device return.
    settleRoster(state, rates)
    expect(incoming.mood).toBe(9)
    expect(source.data.restMoodComplete('Incoming')).toBe(true)
    const confirmed = {
      bedName: state.bedOccupants[room + '_3'],
      markerRoom: incoming.dormRecoveryRoom,
      recoveryTarget: mowerConfirmedRecoveryTarget(source.data, room, 'Manager'),
    }
    expect(confirmed.bedName, JSON.stringify(confirmed)).not.toBe('Incoming')
    expect(confirmed.markerRoom).toBe('')
    expect(confirmed.recoveryTarget).toBeUndefined()
  })

  it('revalidates a second stale limited card after a named recovery target becomes Free', () => {
    const { state, source } = fixture(false, { Next: 9, Final: 10 })
    state.morale.Incoming = 9
    for (const name of ['Incoming', 'Next']) {
      const op = source.data.operators[name]!
      op.mood = 7; op.timeStampMicros = 0; op.upperLimit = 8; op.restMoodLimit = true
      expect(source.data.restMoodComplete(name)).toBe(false)
    }
    source.data.operators.Final!.mood = 10; source.data.operators.Final!.timeStampMicros = 0
    source.data.operators.R!.workaholic = true
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Incoming', 'Current'] } })
    source.queue.tasks = [first]
    settleRoster(state, rates)
    for (const name of ['Incoming', 'Next']) {
      expect(source.data.operators[name]!.mood).toBe(9)
      expect(source.data.restMoodComplete(name)).toBe(true)
    }
    expect(state.bedOccupants[room + '_3']).toBe('Final')
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBe('Final')
    for (const name of ['Incoming', 'Next']) {
      expect(source.data.operators[name]!.currentRoom).toBe('')
      expect(source.data.operators[name]!.dormRecoveryRoom).toBe('')
    }
  })

  it('clears a stale below-full cache after actual temporary confirmation observes full morale', () => {
    const { state, source } = fixture(false)
    state.morale.Incoming = 24
    source.data.operators.R!.workaholic = true
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    expect(source.data.operators.Incoming!.mood).toBe(24)
    expect(source.data.operators.Incoming!.dormRecoveryRoom).toBe('')
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBeUndefined()
  })

  it('confirms a new manager movement version instead of reusing the old marker', () => {
    const { state, source } = fixture(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    source.queue.tasks = [first]; finish(state, first)
    const manager = source.data.operators.Manager!, version = manager.dormPositionVersion
    const move = new MowerTask({ time: state.time, plan: { [room]: ['Resident1', 'Manager', 'Current', 'Current', 'Current'] } })
    source.queue.tasks.push(move); finish(state, move)
    expect(manager.currentIndex).toBe(1)
    expect(manager.dormPositionVersion).toBeGreaterThan(version)
    expect(source.data.operators.Incoming!.dormRecoveryFixed).toEqual([['Manager', 1, manager.dormPositionVersion]])
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBe('Incoming')
  })

  it('preserves a pending restoration without fabricating another recovery transaction', () => {
    const { state, source } = fixture(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    first.dormRecoveryRestore = [room]
    source.queue.tasks = [first]; finish(state, first)
    expect(first.dormRecoveryRestore).toEqual([])
    expect(source.data.recoveryOrderVersion).toBe(0)
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBeUndefined()
  })

  it('does not reorder recovery before an upcoming explicit VIP overwrite', () => {
    const { state, source } = fixture(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Current', 'Current', 'Current', 'Free', 'Current'] } })
    const upcoming = new MowerTask({ time: .5 / 3600, plan: { [room]: ['Current', 'Current', 'Current', 'R', 'Current'] } })
    const version = source.data.operators.Other!.dormPositionVersion
    source.queue.tasks = [first, upcoming]
    settleRoster(state, rates)
    expect(state.bedOccupants[room + '_3']).toBe('Incoming')
    expect(source.data.operators.Other!.dormPositionVersion).toBe(version)
    expect(source.data.recoveryOrderVersion).toBe(0)
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBeUndefined()
    expect(source.queue.tasks).toContain(upcoming)
    expect(upcoming.timeMicros).toBe(500_000)
  })

  it('orders a concrete plan once and leaves an already confirmed target untouched', () => {
    const { state, source } = fixture(false)
    const first = new MowerTask({ type: T.SELF_CORRECTION, plan: { [room]: ['Manager', 'Resident1', 'Resident2', 'Incoming', 'Other'] } })
    source.queue.tasks = [first]; finish(state, first)
    expect(source.data.recoveryOrderVersion).toBe(1)
    expect(mowerConfirmedRecoveryTarget(source.data, room, 'Manager')).toBe('Incoming')
    const version = source.data.operators.Other!.dormPositionVersion
    const repeat = new MowerTask({ time: state.time, plan: { [room]: ['Manager', 'Resident1', 'Resident2', 'Incoming', 'Other'] } })
    source.queue.tasks.push(repeat); finish(state, repeat)
    expect(source.data.recoveryOrderVersion).toBe(1)
    expect(source.data.operators.Other!.dormPositionVersion).toBe(version)
  })
})
