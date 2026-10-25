import { describe, expect, it } from 'vitest'
import { advanceRoster, createRosterRuntime, settleRoster, type RuntimeConfig } from './rosterRuntime'
import { getMowerSourceRuntime } from './mowerSourceRuntime'
import { mowerCorrectionPlan } from './mowerCorrection'
import { mowerGroupRecoveryDeadline, mowerRecoveryReady } from './mowerGroupRecovery'
import { planMowerMetadata } from './mowerMetadata'
import { invalidateMowerDormTime, mowerHasMeasuredDormDeparture, mowerRefreshDormTime, mowerUpdateDetail, projectMowerArrangements } from './mowerObservations'
import { MowerTask, MOWER_TASK_TYPES as T, toMowerMicros } from './mowerTaskQueue'
import { prepareMowerRelease } from './mowerRelease'

const room = 'dormitory_1'
const rates = { workRate: () => 1, recoveryRate: () => 4 }
function fixture(mood = 12, upperLimit = 12) {
  const keepers = ['K1', 'K2', 'K3']
  const config: RuntimeConfig = {
    positions: [
      { id: 'room_1_1_0', roomId: 'room_1_1', primary: 'A', candidates: ['R'], group: 'g', upperLimit },
      { id: 'room_1_2_0', roomId: 'room_1_2', primary: 'B', candidates: ['S'], group: 'g' },
      ...keepers.map((primary, index) => ({ id: room + '_' + index, roomId: room, primary, candidates: [], permanent: true, dormitory: true })),
    ],
    beds: [{ id: room + '_3', roomId: room, vip: true }, { id: room + '_4', roomId: room, vip: false }],
    initialMorale: { A: mood, B: 8, R: 24, S: 24, Incoming: 2 }, idleOperators: ['Incoming'],
    mowerAlpha: true,
    mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] },
    mowerTaskScheduling: { adjustForRunOrders: false },
    mowerDeviceTiming: { roomReturnMicros: 500_000 },
    mowerSourcePlan: {
      room_1_1: [{ agent: 'A', group: 'g', replacement: ['R'] }],
      room_1_2: [{ agent: 'B', group: 'g', replacement: ['S'] }],
      [room]: [...keepers.map(agent => ({ agent, group: '', replacement: [] })), ...['Free', 'Free'].map(agent => ({ agent, group: '', replacement: [] }))],
    },
    mowerSourceRules: { workaholic: [], exhaustRequire: [], restInFull: [], lowPriority: [], refreshDrained: [], lingMode: 0 },
  }
  const state = createRosterRuntime(config), source = getMowerSourceRuntime(state)
  source.initial = false; source.firstInit = false
  state.time = 1; source.data.nowMicros = toMowerMicros(1)
  state.occupants.room_1_1_0 = 'R'; state.occupants.room_1_2_0 = 'S'
  state.bedOccupants[room + '_3'] = 'A'; state.bedOccupants[room + '_4'] = 'B'
  for (const [slot, name] of Object.entries({ ...state.occupants, ...state.bedOccupants })) {
    const op = source.data.operators[name]!
    op.currentRoom = slot.slice(0, slot.lastIndexOf('_')); op.currentIndex = Number(slot.slice(slot.lastIndexOf('_') + 1))
    op.mood = state.morale[name] ?? 24; op.timeStampMicros = 0
  }
  source.data.operators.A!.upperLimit = upperLimit
  source.data.operators.A!.depletionRate = -2
  source.data.dorms[0]!.name = 'A'; source.data.dorms[0]!.timeMicros = toMowerMicros(2)
  source.data.dorms[1]!.name = 'B'; source.data.dorms[1]!.timeMicros = toMowerMicros(5)
  source.data.groupShiftState.g = true
  const task = new MowerTask({ time: 1, type: T.RELEASE_DORM, metadata: 'A', plan: { [room]: [...keepers, 'Free', 'B'] } })
  task.backupShiftActive = true
  source.queue.tasks = [task]
  return { state, source, task }
}

function finish(f: ReturnType<typeof fixture>) {
  settleRoster(f.state, rates)
}

describe('confirmed ordinary dorm departure keeps measured morale', () => {
  it.each([12, 24])('stops the old recovery rate after leaving at personal limit %s', upperLimit => {
    const f = fixture(upperLimit, upperLimit), op = f.source.data.operators.A!
    finish(f)
    expect(op.currentRoom).toBe('')
    expect(op.mood).toBe(upperLimit)
    expect(op.timeStampMicros).toBe(toMowerMicros(1))
    expect(op.moodIsPrediction).toBe(false)
    expect(op.depletionRate).toBe(0)
    expect(op.currentMood(toMowerMicros(2))).toBe(upperLimit)
    expect(f.source.data.operators.B!.isResting()).toBe(true)
    expect(f.source.data.groupShiftState.g).toBe(true)
  })

  it('defers a predicted-full ordinary release to the observed recovery deadline', () => {
    const f = fixture(), op = f.source.data.operators.A!
    op.moodIsPrediction = true
    expect(prepareMowerRelease(f.source.data,f.source.queue,f.task)).toBe(false)
    // 84e3926 _prepare_release_dorm_member rejects prediction as evidence and
    // preserves the actual resident until the existing observed recovery due time.
    expect(op.currentRoom).toBe(room)
    expect(f.task.plan).toEqual({})
    expect(f.source.queue.tasks).toContainEqual(expect.objectContaining({type:T.RELEASE_DORM,metadata:'A',timeMicros:toMowerMicros(2)}))
    expect(op.moodIsPrediction).toBe(true)
    const integrated=fixture();integrated.source.data.operators.A!.moodIsPrediction=true
    finish(integrated)
    expect(integrated.source.data.operators.A!.currentRoom).toBe(room)
  })

  it('replaces predicted full mood with the actual observation after an explicit non-release departure',()=>{
    const f=fixture(),op=f.source.data.operators.A!
    f.task.type=T.SELF_CORRECTION;op.moodIsPrediction=true
    finish(f)
    expect(op.currentRoom).toBe('')
    expect(op.mood).toBe(12)
    expect(op.timeStampMicros).toBe(toMowerMicros(1))
    expect(op.moodIsPrediction).toBe(false)
    expect(op.depletionRate).toBe(0)
  })

  it.each([12, 24])('retains completed departure through temporary single recovery ordering at limit %s', upperLimit => {
    const f = fixture(upperLimit, upperLimit), op = f.source.data.operators.A!
    f.source.data.operators.K1!.singleRecoveryManager = true
    f.source.data.operators.Incoming!.mood = 2
    f.source.data.operators.Incoming!.timeStampMicros = 0
    f.source.data.operators.B!.restInFull = true
    finish(f)
    expect(f.source.data.recoveryOrderVersion).toBeGreaterThan(0)
    expect(f.source.data.operators.Incoming!.dormRecoveryRoom).toBe(room)
    expect(op.currentRoom).toBe('')
    expect(op.mood).toBe(upperLimit)
    expect(op.timeStampMicros).toBe(toMowerMicros(1))
    expect(op.moodIsPrediction).toBe(false)
    expect(op.depletionRate).toBe(0)
    expect(f.source.data.operators.B!.isResting()).toBe(true)
    expect(f.source.data.groupShiftState.g).toBe(true)
    expect(f.state.completedRest).toContain('A')
    expect(f.state.bedOccupants[room + '_4']).toBe('B')
    advanceRoster(f.state, 1 / 60, rates)
    finish(f)
    expect(f.source.data.operators.B!.isResting()).toBe(true)
    expect(f.source.data.groupShiftState.g).toBe(true)
  })

  it('reads actual below-limit mood before temporary ordering and restores the unfinished resident', () => {
    const f = fixture(11), op = f.source.data.operators.A!
    f.task.type = T.SELF_CORRECTION
    f.source.data.operators.K1!.singleRecoveryManager = true
    f.source.data.operators.Incoming!.mood = 2
    f.source.data.operators.Incoming!.timeStampMicros = 0
    op.mood = 24; op.moodIsPrediction = true
    finish(f)
    expect(f.source.data.recoveryOrderVersion).toBeGreaterThan(0)
    expect(op.currentRoom).toBe('')
    expect(op.mood).toBe(11)
    expect(op.timeStampMicros).toBeUndefined()
    expect(f.state.completedRest).not.toContain('A')
    expect(f.source.data.operators.B!.isResting()).toBe(true)
    expect(f.state.bedOccupants[room + '_4']).toBe('B')
  })

  it('retains below-limit morale while the ordinary release waits for the saved deadline', () => {
    const f = fixture(11), op = f.source.data.operators.A!
    expect(prepareMowerRelease(f.source.data,f.source.queue,f.task)).toBe(false)
    expect(op.currentRoom).toBe(room)
    expect(op.mood).toBe(11)
    expect(op.timeStampMicros).toBe(0)
    expect(f.source.queue.tasks).toContainEqual(expect.objectContaining({type:T.RELEASE_DORM,metadata:'A',timeMicros:toMowerMicros(2)}))
    const integrated=fixture(11)
    finish(integrated)
    expect(integrated.source.data.operators.A!.currentRoom).toBe(room)
  })
  it('invalidates an underfull cache only after an explicit non-release departure physically completes',()=>{
    const f=fixture(11),op=f.source.data.operators.A!
    f.task.type=T.SELF_CORRECTION
    finish(f)
    expect(op.currentRoom).toBe('')
    expect(op.mood).toBe(11)
    expect(op.timeStampMicros).toBeUndefined()
    expect(f.state.completedRest).not.toContain('A')
  })
})

describe('group full-rest planning and native return dispatch', () => {
  it('lets a completed member leave under idle release while preserving the unfinished group and cap', () => {
    const f = fixture(24, 24), data = f.source.data
    data.freeRoom = true
    data.groupRestInFullOnMoodGap = true
    data.groupMoodGapMaxExtraWaitHours = .5
    data.groupRecoveryFullMembers.g = ['A', 'B']
    data.groupRecoveryReturnMicros.g = toMowerMicros(1)
    finish(f)
    expect(data.operators.A!.currentRoom).toBe('')
    expect(data.operators.B!.isResting()).toBe(true)
    expect(data.groupIsResting('g')).toBe(true)
    expect(data.groupRecoveryReturnMicros.g).toBe(toMowerMicros(1))
    expect(mowerGroupRecoveryDeadline(data, 'g').timeMicros).toBe(toMowerMicros(1.5))
  })

  it('preserves the original gap-cap deadline while executing an already retained early return', () => {
    const f = fixture(24, 24), data = f.source.data
    data.groupRestInFullOnMoodGap = true
    data.groupMoodGapMaxExtraWaitHours = .5
    data.groupRecoveryFullMembers.g = ['A', 'B']
    data.groupRecoveryReturnMicros.g = toMowerMicros(1)
    expect(mowerGroupRecoveryDeadline(data, 'g').timeMicros).toBe(toMowerMicros(1.5))
    const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
    task.backupShiftActive = true
    f.source.queue.tasks = [task]
    // f19 ordinary dispatch (2659-2752) trusts the saved due arrangement;
    // the optional calculated-mood check also excludes protected shifts (1429).
    finish(f)
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(data.operators.A!.currentRoom).toBe('room_1_1')
    expect(data.operators.B!.isResting()).toBe(true)
    expect(data.groupRecoveryReturnMicros.g).toBe(toMowerMicros(1))
    expect(task.executionFailure).toBeUndefined()
    advanceRoster(f.state, .5 / 3600, rates)
    finish(f)
    expect(data.operators.B!.currentRoom).toBe('room_1_2')
  })

  it.each([{explicit:false,excluded:false},{explicit:true,excluded:false},{explicit:false,excluded:true},{explicit:true,excluded:true}])('preserves gap/exclusion/full-rest planning without reblocking a retained return: %j', ({explicit,excluded}) => {
    const f = fixture(24, 24), data = f.source.data
    data.groupRestInFullOnMoodGap = true
    data.groupMoodGapMaxExtraWaitHours = excluded ? 0 : .5
    data.groupMoodGapExclusions = excluded ? ['g'] : []
    data.groupRecoveryFullMembers.g = ['A', 'B']
    data.groupRecoveryReturnMicros.g = toMowerMicros(.5)
    data.operators.B!.restInFull = explicit
    const recovery = mowerGroupRecoveryDeadline(data, 'g')
    expect(recovery.timeMicros).toBe(explicit ? toMowerMicros(5) : excluded ? undefined : toMowerMicros(1))
    if (explicit) expect(recovery.requiredNames).toContain('B')
    const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
    task.backupShiftActive = true
    f.source.queue.tasks = [task]
    finish(f)
    expect(data.operators.A!.currentRoom).toBe('room_1_1')
    advanceRoster(f.state, .5 / 3600, rates)
    finish(f)
    expect(data.operators.B!.currentRoom).toBe('room_1_2')
    expect(data.operators.B!.mood).toBeLessThan(24)
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(task.executionFailure).toBeUndefined()
  })

  it.each([false, true])('rebuilds saved return metadata from the actual explicit full-rest deadline, shared=%s', shared => {
    const f = fixture(24, 24)
    f.source.data.operators.B!.restInFull = true
    if (shared) { f.source.data.operators.B!.groupBindings = [{ group: 'g', replacement: ['S'] }, { group: 'h', replacement: ['S'] }]; f.source.data.groupShiftState.h = false }
    f.source.data.operators.B!.mood = 24
    f.source.data.operators.B!.moodIsPrediction = true
    f.source.data.dorms[1]!.timeMicros = toMowerMicros(1)
    f.state.morale.B = 20
    const oldReturn = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
    f.source.queue.tasks = [oldReturn]
    const slowerRates = { workRate: () => 1, recoveryRate: (name: string) => name === 'B' ? 2 : 4 }
    // An actual room read replaces the stale prediction; native metadata, not
    // an unconditional dispatcher gate, owns the generated future return time.
    invalidateMowerDormTime(f.source.data, room)
    mowerUpdateDetail(f.source.data, 'B', f.state.morale.B, room, 4, true)
    mowerRefreshDormTime(f.source.data, room, 4, 'B', toMowerMicros(3))
    planMowerMetadata(f.source.data, f.source.queue)
    expect(f.source.data.operators.B!.isResting()).toBe(true)
    expect(f.source.data.operators.B!.mood).toBe(20)
    expect(f.source.data.operators.B!.moodIsPrediction).toBe(false)
    expect(mowerGroupRecoveryDeadline(f.source.data, 'g').timeMicros).toBe(toMowerMicros(3))
    const generated = f.source.queue.tasks.find(task => task.type === T.SHIFT_ON && task.plan.room_1_2?.[0] === 'B')!
    expect(generated).toBeDefined()
    expect(generated.timeMicros).toBe(toMowerMicros(3))
    expect(f.source.queue.tasks).not.toContain(oldReturn)
    advanceRoster(f.state, 2, slowerRates)
    settleRoster(f.state, slowerRates)
    advanceRoster(f.state, .5 / 3600, slowerRates)
    settleRoster(f.state, slowerRates)
    expect(f.source.data.operators.B!.currentRoom).toBe('room_1_2')
    expect(f.state.morale.B).toBe(24)
  })

  it.each([T.SELF_CORRECTION, T.RE_ORDER])('keeps the low-priority recovery deadline without reblocking a retained $key return', type => {
    const f = fixture(24, 24)
    const a = f.source.data.operators.A!, b = f.source.data.operators.B!, r = f.source.data.operators.R!
    a.currentRoom = ''; a.currentIndex = -1; a.depletionRate = 0
    r.currentRoom = ''; r.currentIndex = -1
    delete f.state.bedOccupants[room + '_3']; delete f.state.occupants.room_1_1_0
    f.source.data.dorms[0]!.reset()
    b.restingPriority = 'low'
    f.source.data.groupRecoveryFullMembers.g = ['A', 'B']
    expect(mowerGroupRecoveryDeadline(f.source.data, 'g').timeMicros).toBe(toMowerMicros(5))
    const plan = { room_1_1: ['A'], room_1_2: ['B'] }
    const task = new MowerTask({ time: 1, type, plan })
    task.backupShiftActive = true
    f.source.queue.tasks = [task]
    finish(f)
    expect(a.currentRoom).toBe('room_1_1')
    expect(b.isResting()).toBe(true)
    expect(f.source.queue.tasks).toContain(task)
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(task.executionFailure).toBeUndefined()
    advanceRoster(f.state, .5 / 3600, rates)
    finish(f)
    expect(b.currentRoom).toBe('room_1_2')
  })

  it.each(['standby', 'shared'] as const)('returns a completed primary without waiting for an ordinary %s member in an old latch', kind => {
    const f = fixture(24, 24)
    const a = f.source.data.operators.A!, b = f.source.data.operators.B!, r = f.source.data.operators.R!
    a.currentRoom = ''; a.currentIndex = -1; a.depletionRate = 0
    r.currentRoom = ''; r.currentIndex = -1
    delete f.state.bedOccupants[room + '_3']; delete f.state.occupants.room_1_1_0
    f.source.data.dorms[0]!.reset()
    if (kind === 'standby') b.restingPriority = 'standby'
    else { b.groupBindings = [{ group: 'g', replacement: ['S'] }, { group: 'h', replacement: ['S'] }]; f.source.data.groupShiftState.h = true }
    f.source.data.groupRecoveryFullMembers.g = ['A', 'B']
    const plan = mowerCorrectionPlan(f.source.data)
    expect(plan.room_1_1).toEqual(['A'])
    const task = new MowerTask({ time: 1, type: T.SELF_CORRECTION, plan })
    task.backupShiftActive = true
    f.source.queue.tasks = [task]
    finish(f)
    expect(a.currentRoom).toBe('room_1_1')
    expect(b.isResting()).toBe(true)
    expect(task.executionFailure).toBeUndefined()
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(f.source.data.groupRecoveryFullMembers.g ?? []).not.toContain('B')
  })

  it.each(['recovering', 'unknown'] as const)('activates a saved due return backup through native dispatch with %s full-rest observations', status => {
    const f = fixture(24, 24), b = f.source.data.operators.B!
    b.restInFull = true
    f.source.data.planConditions = [true]
    if (status === 'unknown') {
      b.currentRoom = ''; b.currentIndex = -1; b.timeStampMicros = undefined
      delete f.state.bedOccupants[room + '_4']; f.source.data.dorms[1]!.reset()
    }
    const recovery = mowerGroupRecoveryDeadline(f.source.data, 'g')
    expect(recovery.requiredNames).toContain('B')
    expect(recovery.timeMicros).toBe(status === 'unknown' ? undefined : toMowerMicros(5))
    const intent = { room_1_1: ['A'], room_1_2: ['B'] }
    const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: structuredClone(intent) })
    f.source.queue.tasks = [task]
    const activated: boolean[][] = []
    f.state.mowerShiftModel = {
      count: 1,
      evaluate: data => [data.groupIsResting('g')],
      swap: (data, conditions) => Object.assign(projectMowerArrangements(data, []), { planConditions: [...conditions] }),
      transition: () => ({}),
      activate: conditions => { activated.push([...conditions]); f.source.data.planConditions = [...conditions] },
    }
    finish(f)
    // f19 activates the converged backup at ordinary dispatch (2736-2748).
    // Its calculated-mode tap-confirm check is optional and is not this path.
    expect(task.backupShiftConditions).toEqual([false])
    expect(activated).toEqual([[false]])
    expect(f.source.data.planConditions).toEqual([false])
    expect(f.source.queue.tasks).toContain(task)
    expect(task.backupShiftIntent).toEqual(intent)
    expect(task.plan.room_1_2).toEqual(['B'])
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(task.executionFailure).toBeUndefined()
    for (let i = 0; i < 12 && f.source.queue.tasks.includes(task); i++) {
      advanceRoster(f.state, .5 / 3600, rates)
      finish(f)
    }
    expect(f.source.queue.tasks).not.toContain(task)
    expect(activated).toEqual([[false]])
    expect(b.currentRoom).toBe('room_1_2')
    expect(b.moodIsPrediction).toBe(false)
    expect(b.mood).toBeLessThan(24)
  })

  it('preserves an explicitly requested backup return independently of automatic group recovery', () => {
    const f = fixture(24, 24)
    f.source.data.operators.B!.restInFull = true
    const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
    task.backupShiftActive = true
    task.backupExplicitSlots = new Set(['room_1_1\0' + '0', 'room_1_2\0' + '0'])
    f.source.queue.tasks = [task]
    finish(f)
    advanceRoster(f.state, .5 / 3600, rates)
    finish(f)
    expect(f.source.data.operators.B!.currentRoom).toBe('room_1_2')
    expect(f.state.morale.B).toBeLessThan(24)
  })

  it('continues a retained return without repeating the room before its real observation', () => {
    const f = fixture(24, 24)
    f.source.data.operators.B!.restInFull = true
    f.source.data.operators.B!.currentRoom = ''
    f.source.data.operators.B!.currentIndex = -1
    f.source.data.operators.B!.timeStampMicros = undefined
    delete f.state.bedOccupants[room + '_4']
    f.source.data.dorms[1]!.reset()
    const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
    task.backupShiftActive = true
    f.source.queue.tasks = [task]
    settleRoster(f.state, rates)
    expect(f.source.queue.tasks).toContain(task)
    expect(task.timeMicros).toBe(toMowerMicros(1))
    expect(task.executionFailure).toBeUndefined()
    const execution = f.source.execution, traceLength = f.source.trace.length
    expect(execution?.task).toBe(task)
    settleRoster(f.state, rates)
    expect(f.source.execution).toBe(execution)
    expect(f.source.trace).toHaveLength(traceLength)
    expect(f.state.occupants.room_1_2_0).toBe('S')
    // The saved arrangement itself supplies the missing physical observation.
    for (let i = 0; i < 8 && f.source.queue.tasks.includes(task); i++) {
      advanceRoster(f.state, .5 / 3600, rates)
      finish(f)
    }
    expect(f.source.queue.tasks).not.toContain(task)
    expect(task.executionFailure).toBeUndefined()
    expect(f.source.data.operators.B!.currentRoom).toBe('room_1_2')
    expect(f.source.data.operators.B!.mood).toBe(8)
    expect(f.source.data.operators.B!.timeStampMicros).toBe(toMowerMicros(1 + .5 / 3600))
  })

})

describe('ordinary departure observation evidence', () => {
  it.each(['no-task', 'no-plan', 'mismatch', 'unknown', 'prediction', 'below-limit', 'still-present'] as const)('rejects %s as measured completion', evidence => {
    const { source, task } = fixture(), op = source.data.operators.A!
    const observed = ['K1', 'K2', 'K3', 'Incoming', 'B']
    task.plan[room] = [...observed]
    if (evidence === 'no-plan') task.plan = {}
    if (evidence === 'mismatch') observed[4] = 'Other'
    if (evidence === 'unknown') op.timeStampMicros = undefined
    if (evidence === 'prediction') op.moodIsPrediction = true
    if (evidence === 'below-limit') op.mood = 11.9
    if (evidence === 'still-present') { observed[3] = 'A'; task.plan[room] = [...observed] }
    expect(mowerHasMeasuredDormDeparture(source.data, op, room, observed, evidence === 'no-task' ? undefined : task)).toBe(false)
    const temporary = ['K1', 'K2', 'K3', 'Incoming', 'B']
    expect(mowerHasMeasuredDormDeparture(source.data, op, room, observed, evidence === 'no-task' ? undefined : task, temporary)).toBe(false)
  })
})


describe('mandatory full recovery releases read actual recovery before freeing the bed', () => {
  it.each(['explicit', 'delayed'] as const)('keeps an underfull %s member in bed after an old timer expires', mode => {
    const f = fixture(23.8, 24), op = f.source.data.operators.A!
    f.source.data.freeRoom = true; f.state.config.mowerPolicy!.freeRoom = true
    if (mode === 'explicit') op.restInFull = true
    else f.source.data.groupRecoveryFullMembers.g = ['A']
    f.source.data.dorms[0]!.timeMicros = toMowerMicros(1)
    finish(f)
    expect(f.state.bedOccupants[room + '_3']).toBe('A')
    expect(op.currentRoom).toBe(room)
    expect(op.mood).toBe(23.8)
    const pending = f.source.queue.tasks.find(task => task.type === T.RELEASE_DORM && task.metadata === 'A')!
    expect(pending).toBeDefined()
    expect(pending.timeMicros).toBeGreaterThan(toMowerMicros(1))
    expect(pending.timeMicros).toBeLessThanOrEqual(toMowerMicros(1.05))
    advanceRoster(f.state, .05, rates)
    finish(f)
    expect(op.mood).toBe(24)
    expect(op.currentRoom).toBe('')
  })
})


describe.each(['direct', 'queued'] as const)('exhaust refresh after measured full departure: %s', path => {
  it.each(['idle-full', 'working', 'predicted'] as const)('preserves only completed idle evidence when another operator changes room: %s', mode => {
    const f = fixture(24, 24), op = f.source.data.operators.A!
    finish(f)
    expect(op.currentRoom).toBe('')
    expect(op.timeStampMicros).toBe(toMowerMicros(1))
    advanceRoster(f.state, .5 / 3600, rates); finish(f)
    op.exhaustRequire = true
    f.state.config.mowerSourceRules!.refreshDrained = ['S']
    if (mode === 'working') {
      f.state.occupants.room_1_1_0 = 'A'; op.currentRoom = 'room_1_1'; op.currentIndex = 0; op.depletionRate = 1
    }
    if (mode === 'predicted') op.moodIsPrediction = true
    const stamp = op.timeStampMicros
    const move = new MowerTask({ time: f.state.time, type: T.NOT_SPECIFIC, plan: { room_1_2: ['B'] } })
    move.backupShiftActive = true
    const exhaust = new MowerTask({ time: f.state.time + 1, type: T.EXHAUST_OFF, metadata: 'A' })
    f.source.queue.tasks = path === 'queued' ? [move, exhaust] : [move]
    finish(f)
    expect(f.source.queue.tasks).not.toContain(exhaust)
    expect(f.source.data.operators.S!.currentRoom).toBe('')
    if (mode === 'idle-full') expect(op.timeStampMicros).toBe(stamp)
    else expect(op.timeStampMicros).toBeUndefined()
  })
})


it.each(['direct', 'queued'] as const)('keeps measured full departure when the departing operator triggers %s exhaust refresh', path => {
  const f = fixture(24, 24), op = f.source.data.operators.A!
  op.exhaustRequire = true
  f.state.config.mowerSourceRules!.refreshDrained = ['A']
  const exhaust = new MowerTask({ time: f.state.time + 1, type: T.EXHAUST_OFF, metadata: 'A' })
  if (path === 'queued') f.source.queue.tasks.push(exhaust)
  finish(f)
  expect(op.currentRoom).toBe('')
  expect(op.mood).toBe(24)
  expect(op.timeStampMicros).toBe(toMowerMicros(1))
  expect(op.depletionRate).toBe(0)
  expect(op.moodIsPrediction).toBe(false)
  expect(f.source.queue.tasks).not.toContain(exhaust)
})

it('executes an advanced personal-limit release during a group recovery wait', () => {
  const f = fixture(11.879426865, 12), op = f.source.data.operators.A!
  op.restMoodLimit = true
  f.source.data.groupRecoveryFullMembers.g = ['A', 'B']
  f.task.strictMoodLimit = true; f.task.moodLimit = 12
  for (let i = 0; i < 8; i++) { finish(f); advanceRoster(f.state, .5 / 3600, rates) }
  expect(op.isResting()).toBe(false)
  expect(f.source.queue.tasks.filter(task => task.type === T.RELEASE_DORM && task.metadata === 'A')).toEqual([])
  expect(f.state.morale.A).toBeCloseTo(11.879426865)
  expect(f.source.data.restMoodComplete('A')).toBe(true)
  expect(mowerGroupRecoveryDeadline(f.source.data, 'g').timeMicros).toBeDefined()
  expect(f.source.data.operators.B!.isResting()).toBe(true)
  expect(f.source.data.groupShiftState.g).toBe(true)
})

it.each([{ mood: 23.95, history: false, ready: true }, { mood: 23, history: false, ready: false }, { mood: 23.87, history: false, ready: false }, { mood: 23.87, history: true, ready: true }])('keeps observed full-rest readiness separate from retained dispatch: $mood, history=$history', ({ mood, history, ready }) => {
  const f = fixture(23.95, 24)
  f.state.morale.B = mood
  if (history) f.state.config.mowerTaskScheduling!.dormDurations = { [room]: [100] }
  for (const name of ['A', 'B']) f.source.data.operators[name]!.restInFull = true
  invalidateMowerDormTime(f.source.data, room)
  for (const [name, index] of [['A', 3], ['B', 4]] as const) {
    mowerUpdateDetail(f.source.data, name, f.state.morale[name]!, room, index, true)
    mowerRefreshDormTime(f.source.data, room, index, name, toMowerMicros(1 + (24 - f.state.morale[name]!) / 4))
  }
  expect(mowerRecoveryReady(f.source.data, f.source.data.operators.A!, f.state.config.mowerTaskScheduling)).toBe(true)
  expect(mowerRecoveryReady(f.source.data, f.source.data.operators.B!, f.state.config.mowerTaskScheduling)).toBe(ready)
  const task = new MowerTask({ time: 1, type: T.SHIFT_ON, plan: { room_1_1: ['A'], room_1_2: ['B'] } })
  task.backupShiftActive = true
  f.source.queue.tasks = [task]
  // The readiness helper still protects planning/proof callers; f19 excludes
  // this already protected continuation from calculated tap-confirm validation.
  for (let i = 0; i < 8; i++) { finish(f); advanceRoster(f.state, .5 / 3600, rates) }
  expect(f.source.data.operators.A!.currentRoom).toBe('room_1_1')
  expect(f.source.data.operators.B!.currentRoom).toBe('room_1_2')
  expect(f.state.morale.A).toBeLessThan(24)
  expect(f.state.morale.B).toBeLessThan(24)
  expect(f.source.queue.tasks).not.toContain(task)
  expect(task.timeMicros).toBe(toMowerMicros(1))
  expect(task.executionFailure).toBeUndefined()
})
