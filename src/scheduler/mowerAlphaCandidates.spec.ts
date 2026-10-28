import { prepareMowerRelease } from './mowerRelease'
import { projectMowerArrangements } from './mowerObservations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mowerAlphaDormCandidates, mowerAlphaFillPlan, planMowerAlphaDormFill, mowerDormTaskReservations } from './mowerAlphaCandidates'
import * as dorm from './mowerAlphaDorm'
import { MowerTask, MowerTaskQueue, MOWER_TASK_TYPES as T, toMowerMicros } from './mowerTaskQueue'
import { MowerOperatorState } from './mowerOperatorState'
import { MowerSchedulingData, MowerDormState } from './mowerSchedulingData'

afterEach(() => vi.restoreAllMocks())

function inventoryData() {
  const operators = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
    const name = `idle-${index}`
    return [name, new MowerOperatorState({ name, mood: 24, timeStampMicros: 0 })]
  }))
  operators.owner = new MowerOperatorState({ name: 'owner', room: 'room_1_1', currentRoom: 'room_1_1',
    operatorType: 'high', replacement: ['idle-150'] })
  return new MowerSchedulingData({ alpha: true, operators, plan: { train: ['', ''], dormitory_1: Array(5).fill('Free') }, dorms: [], nowMicros: 0 })
}

describe('large-library dorm candidate ordering', () => {
  it('computes each candidate tier at most twice in one selection pass', () => {
    const data = inventoryData()
    const replacement = data.operators.owner!.replacement
    let membershipReads = 0
    Object.defineProperty(data.operators.owner!, 'replacement', { get: () => { membershipReads++; return replacement } })
    const tier = vi.spyOn(dorm, 'alphaRestingTier')
    const candidates = mowerAlphaDormCandidates(data)
    expect(candidates.filling).toHaveLength(200)
    expect(candidates.filling[0]).toBe('idle-0')
    expect(candidates.filling.slice(1, 4)).toEqual(['idle-1', 'idle-2', 'idle-3'])
    expect(tier.mock.calls.length).toBeLessThanOrEqual(400)
    expect(membershipReads).toBeLessThanOrEqual(3)
  })

  it('recomputes ordering after policy, replacement membership and observed mood change', () => {
    const data = inventoryData()
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-0')
    data.operators.owner!.replacement = []
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-0')
    data.restingPriorityNames.push('idle-90')
    // Personal-cap workers have no recovery priority even when explicitly listed.
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-0')
    data.operators['idle-90']!.mood = 23
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-90')
    data.operators['idle-80']!.mood = 12
    expect(mowerAlphaDormCandidates(data).recovering).toEqual(['idle-90','idle-80'])
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-80')
    expect(mowerAlphaDormCandidates(data, new Set(['idle-80'])).filling[0]).toBe('idle-90')
  })
})


function takeoverData() {
  const operators = {
    owner: new MowerOperatorState({ name: 'owner', room: 'room_1_1', index: 0,
      currentRoom: 'room_1_1', currentIndex: 0, operatorType: 'high', replacement: ['R'],
      mood: 24, timeStampMicros: 0 }),
    R: new MowerOperatorState({ name: 'R', mood: 0, timeStampMicros: 0 }),
    S: new MowerOperatorState({ name: 'S', room: 'room_1_2', index: 0, operatorType: 'high',
      restingPriority: 'standby', currentRoom: 'dormitory_1', currentIndex: 0,
      mood: 24, timeStampMicros: 0 })
  }
  return new MowerSchedulingData({ alpha: true, freeRoom: false, nowMicros: 0,
    operators, priorityReplacement: ['R'], standbyNames: ['S'],
    plan: { room_1_1: ['owner'], room_1_2: ['S'], dormitory_1: ['Free'] },
    dorms: [new MowerDormState(['dormitory_1', 0], 'S', 0)] })
}


describe('native priority replacement bed takeover', () => {
  it.each([false,true])('reserves confirmed targets from completed rooms during a partial arrangement (retained=%s)',retained=>{
    const data=takeoverData(),task=new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['Current']}})
    task.executionRetained=retained
    task.groupShiftExpected={['dormitory_1\0'+'0']:'R',['room_1_2\0'+'0']:'S'}
    const reservations=mowerDormTaskReservations(data,[task])
    expect(reservations.names).toEqual(new Set(['R','S']))
    expect(reservations.slots).toEqual(new Set(['dormitory_1\0'+'0']))
    expect(mowerAlphaFillPlan(data,[task])).toEqual({})
    expect(task.plan).toEqual({room_1_1:['Current']})
  })
  it.each([false, true])('takes a standby bed with free room disabled (emptyOnly=%s)', emptyOnly => {
    const data = takeoverData(), queue = new MowerTaskQueue()
    const task = planMowerAlphaDormFill(data, queue, emptyOnly)
    expect(task?.plan.dormitory_1).toEqual(['R'])
    expect(task?.timeMicros).toBe(0)
    expect(data.dorms[0]!.name).toBe('S')
    expect(data.operators.R!.currentRoom).toBe('')
  })
  it('keeps the old return task and occupied bed until takeover execution', () => {
    const data = takeoverData(), queue = new MowerTaskQueue()
    const returning = new MowerTask({ type: T.SHIFT_ON, time: 4, plan: { room_1_2: ['S'] } })
    queue.tasks.push(returning)
    const task = planMowerAlphaDormFill(data, queue)
    expect(task?.plan.dormitory_1).toEqual(['R'])
    expect(queue.tasks).toContain(returning)
    expect(returning.plan).toEqual({ room_1_2: ['S'] })
    expect(returning.time).toBe(4)
    expect(data.dorms[0]!.name).toBe('S')
    expect(data.operators.S!.currentRoom).toBe('dormitory_1')
  })
  it('retains a displaced standby group anchor while another primary is recovering', () => {
    const data = takeoverData()
    data.operators.S!.group = 'g'
    data.operators.B = new MowerOperatorState({ name: 'B', room: 'room_1_2', index: 1,
      group: 'g', operatorType: 'high', restingPriority: 'high', mood: 3, timeStampMicros: 0,
      currentRoom: 'dormitory_1', currentIndex: 1 })
    data.plan.room_1_2!.push('B')
    data.plan.dormitory_1!.push('Free')
    data.dorms.push(new MowerDormState(['dormitory_1', 1], 'B', toMowerMicros(5)))
    const task = planMowerAlphaDormFill(data, new MowerTaskQueue())
    expect(task?.plan.dormitory_1).toEqual(['B', 'R'])
    expect(task?.plan.room_1_2).toBeUndefined()
    expect(data.dorms.map(bed => bed.name)).toEqual(['S', 'B'])
  })
  it('enforces protected tiers even if the physical-slot helper permits the bed', () => {
    const data = takeoverData()
    data.freeRoom = true
    data.restingPriorityNames.push('S')
    data.operators.S!.mood = 23
    vi.spyOn(dorm, 'alphaSlotTakable').mockReturnValue(true)
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue())).toBeUndefined()
  })
  it('uses the same takeover in the shared fill projection', () => {
    expect(mowerAlphaFillPlan(takeoverData(), []).dormitory_1).toEqual(['R'])
  })
  it.each(['high', 'low'] as const)('reuses a completed %s dynamic primary bed', priority => {
    const data = takeoverData()
    data.freeRoom = true
    data.operators.S!.restingPriority = priority
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue())?.plan.dormitory_1).toEqual(['R'])
  })
  it('reuses a completed priority replacement bed after its recovery priority is released', () => {
    const data = takeoverData()
    data.freeRoom = true
    data.operators.S!.operatorType = 'low'
    data.operators.owner!.replacement.push('S')
    data.priorityReplacement.push('S')
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue())?.plan.dormitory_1).toEqual(['R'])
  })
  it.each(['name', 'slot', 'excluded'] as const)('preserves %s reservations', kind => {
    const data = takeoverData(), queue = new MowerTaskQueue()
    if (kind === 'excluded') { data.freeRoom = true; data.freeRoomExclusions.push('S') }
    else queue.tasks.push(new MowerTask({ type: T.SHIFT_OFF, time: 1,
      plan: kind === 'name' ? { room_1_1: ['R'] } : { dormitory_1: ['Free'] } }))
    expect(planMowerAlphaDormFill(data, queue)).toBeUndefined()
  })
  it.each([false, true])('does not invent measured mood for unknown replacements (estimate=%s)', estimated => {
    const data = takeoverData()
    data.operators.R!.timeStampMicros = undefined
    if (estimated) data.dormMoodEstimates.set('R', [2, 0])
    const task = planMowerAlphaDormFill(data, new MowerTaskQueue(), true)
    expect(task?.plan.dormitory_1).toEqual(estimated ? ['R'] : undefined)
    expect(data.operators.R!.timeStampMicros).toBeUndefined()
  })
  it('does not name unregistered cards in an occupied-bed takeover', () => {
    const data = takeoverData()
    data.operators.R!.timeStampMicros = undefined
    data.unregisteredIdleNames.push('unknown-card')
    data.restingPriorityNames.push('unknown-card')
    data.dormMoodEstimates.set('unknown-card', [1, 0])
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue(), true)).toBeUndefined()
  })
  it('rejects expired card estimates for occupied beds', () => {
    const data = takeoverData()
    data.operators.R!.timeStampMicros = undefined
    data.dormMoodEstimates.set('R', [2, -toMowerMicros(1)])
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue())).toBeUndefined()
  })
  it.each([0, 20])('requires measured low mood for ordinary takeover (mood=%s)', mood => {
    const data = takeoverData()
    data.priorityReplacement = []
    data.standbyNames = []
    data.operators.S!.operatorType = 'low'
    data.operators.S!.mood = 10
    data.operators.R!.mood = mood
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue())?.plan.dormitory_1)
      .toEqual(mood <= 19.2 ? ['R'] : undefined)
  })
  it('restricts empty-only occupied-bed takeover to priority replacements', () => {
    const data = takeoverData()
    data.priorityReplacement = []
    data.operators.S!.operatorType = 'low'
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue(), true)).toBeUndefined()
  })
  it('keeps filling an ordinary empty bed with free room disabled', () => {
    const data = takeoverData()
    data.dorms[0]!.reset()
    data.operators.S!.currentRoom = 'room_1_2'
    data.priorityReplacement = []
    expect(planMowerAlphaDormFill(data, new MowerTaskQueue(), true)?.plan.dormitory_1).toEqual(['R'])
  })
})

describe('recovery identity from every configured binding',()=>{
 function data(){
  return new MowerSchedulingData({alpha:true,nowMicros:0,plan:{work:['Follower'],dormitory_1:['Free']},dorms:[new MowerDormState(['dormitory_1',0],'Idle',toMowerMicros(3))],operators:{
   Follower:new MowerOperatorState({name:'Follower',room:'work',index:0,currentRoom:'work',currentIndex:0,operatorType:'high',group:'a',replacement:['First'],groupBindings:[{group:'a',replacement:['First']},{group:'b',replacement:['Secondary']}],mood:24,timeStampMicros:0}),
   First:new MowerOperatorState({name:'First',mood:24,timeStampMicros:0}),
   Secondary:new MowerOperatorState({name:'Secondary',mood:5,timeStampMicros:0}),
   Idle:new MowerOperatorState({name:'Idle',mood:10,timeStampMicros:0,currentRoom:'dormitory_1',currentIndex:0}),
  }})
 }
 it.each([false,true])('admits an additional-column replacement ahead of idle occupants (priority=%s)',priority=>{
  const state=data();if(priority)state.priorityReplacement=['Secondary']
  expect(dorm.alphaRestingTier(state,'Secondary')).toBe(priority?3:5)
  expect(planMowerAlphaDormFill(state,new MowerTaskQueue(),priority)?.plan.dormitory_1).toEqual(['Secondary'])
  expect(state.operators.Follower!.replacement).toEqual(['First'])
 })
 it('ranks a recovering additional-column candidate above a lower-mood ordinary idle candidate',()=>{
  const state=data();state.operators.OtherIdle=new MowerOperatorState({name:'OtherIdle',mood:4,timeStampMicros:0})
  expect(mowerAlphaDormCandidates(state).recovering).toEqual(['Secondary','OtherIdle'])
 })
 it('keeps that identity when the currently selected binding changes',()=>{
  const state=data(),owner=state.operators.Follower!
  owner.replacement=['Secondary'];expect(dorm.alphaRestingTier(state,'Secondary')).toBe(5)
  owner.replacement=['First'];expect(dorm.alphaRestingTier(state,'Secondary')).toBe(5)
 })
 it('keeps Fiammetta exchange targets out of ordinary replacement identity',()=>{
  const state=data();state.operators.Follower!.nativeName='菲亚梅塔'
  expect(dorm.alphaRestingTier(state,'Secondary')).toBe(6)
  expect(planMowerAlphaDormFill(state,new MowerTaskQueue())).toBeUndefined()
 })
})

describe('future releases and recovery priority', () => {
  function dataWithVacancy() {
    const data = takeoverData()
    data.operators.S!.restingPriority = 'high'
    data.operators.S!.mood = 5
    data.operators.S!.currentRoom = 'dormitory_2'
    data.standbyNames = []
    data.priorityReplacement = []
    data.plan.dormitory_2 = ['Free']
    data.dorms = [new MowerDormState(['dormitory_1', 0]), new MowerDormState(['dormitory_2', 0], 'S', toMowerMicros(4))]
    return data
  }
  it('moves the high priority resident before admitting the lower priority replacement', () => {
    const data = dataWithVacancy(), queue = new MowerTaskQueue()
    const release = new MowerTask({ type: T.RELEASE_DORM, time: 4, plan: { dormitory_2: ['Free'] }, metadata: 'S' })
    queue.tasks.push(release)
    const fill = planMowerAlphaDormFill(data, queue, true)
    expect(fill?.plan).toEqual({ dormitory_1: ['S'], dormitory_2: ['R'] })
    expect(queue.tasks).toContain(release)
    expect(release.time).toBe(4)
    expect(release.plan).toEqual({ dormitory_2: ['Free'] })
    expect(data.operators.S!.currentRoom).toBe('dormitory_2')
    expect(planMowerAlphaDormFill(data, queue, true)).toBeUndefined()
    const moved = projectMowerArrangements(data, [fill!.plan])
    moved.nowMicros = release.timeMicros
    expect(prepareMowerRelease(moved, queue, release)).toBe(false)
    expect(release.plan).toEqual({})
    expect(moved.currentOperator('dormitory_2', 0)?.name).toBe('R')
  })
  it.each(['due', 'strict', 'retained', 'product', 'unnamed'] as const)('keeps %s releases reserved', kind => {
    const data = dataWithVacancy(), queue = new MowerTaskQueue()
    const release = new MowerTask({ type: T.RELEASE_DORM, time: kind === 'due' ? 0 : 4, plan: { dormitory_2: ['Free'] }, metadata: kind === 'unnamed' ? '' : 'S' })
    release.strictMoodLimit = kind === 'strict'
    release.executionRetained = kind === 'retained'
    release.productShiftLocked = kind === 'product'
    queue.tasks.push(release)
    const fill = planMowerAlphaDormFill(data, queue, true)
    expect(fill?.plan.dormitory_2).toBeUndefined()
  })
})
