import { describe, expect, it } from 'vitest'
import { nextMowerRunRecoveryMicros, prepareMowerRunEntry } from './mowerRunLifecycle'
import { MowerTask, MowerTaskQueue, MOWER_TASK_TYPES as T, toMowerMicros } from './mowerTaskQueue'

const nowMicros = toMowerMicros(.5)
const ideal = { adjustForRunOrders: false }
const cases = [false, true].flatMap(alpha => [T.RUN_ORDER, T.REFRESH_TIME].map(type => ({ alpha, type })))

function staleOrderQueue(type = T.RUN_ORDER) {
  const queue = new MowerTaskQueue()
  const order = new MowerTask({ time: 0, type, metadata: 'room_1_1' })
  const downshift = new MowerTask({ time: 1, type: T.SHIFT_OFF, plan: { central: ['GladiiaCover'] } })
  queue.tasks.push(order, downshift)
  return { queue, order, downshift }
}

describe('ideal run-order isolation at native run recovery', () => {
  it.each(cases)('retains a future downshift when only an ideal order is stale, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue, downshift } = staleOrderQueue(type)
    const plan = structuredClone(downshift.plan)
    prepareMowerRunEntry(queue, nowMicros, alpha, ideal)
    expect(queue.tasks).toContain(downshift)
    expect(downshift.timeMicros).toBe(toMowerMicros(1))
    expect(downshift.plan).toEqual(plan)
    expect(queue.tasks.some(task => task.type === T.NOT_SPECIFIC && task.timeMicros === nowMicros)).toBe(true)
  })

  it.each(cases)('keeps the native stale-order recovery when the option is omitted, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue, order, downshift } = staleOrderQueue(type)
    prepareMowerRunEntry(queue, nowMicros, alpha)
    // Native REFRESH_TIME is preserved; alpha excludes it from stale detection.
    const retainedRefresh = type === T.REFRESH_TIME
    expect(queue.tasks.includes(order)).toBe(retainedRefresh)
    expect(queue.tasks.includes(downshift)).toBe(retainedRefresh && alpha)
    expect(queue.tasks).toHaveLength(retainedRefresh ? 2 : 1)
    const seed = queue.tasks.find(task => task.type === T.NOT_SPECIFIC)
    if (retainedRefresh && alpha) expect(seed).toBeUndefined()
    else expect(seed?.timeMicros).toBe(nowMicros)
  })

  it.each(cases)('still rebuilds stale ordinary work and preserves mastery in ideal mode, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue, downshift } = staleOrderQueue(type)
    const staleWork = new MowerTask({ time: 0, type: T.SHIFT_OFF, plan: { central: ['Gladiia'] } })
    const mastery = new MowerTask({ time: 24, type: T.SKILL_UPGRADE })
    const futureOrder = new MowerTask({ time: .75, type: T.RUN_ORDER, metadata: 'room_1_2' })
    queue.tasks.push(staleWork, mastery, futureOrder)
    prepareMowerRunEntry(queue, nowMicros, alpha, ideal)
    expect(queue.tasks).not.toContain(staleWork)
    expect(queue.tasks).not.toContain(downshift)
    expect(queue.tasks).toContain(mastery)
    expect(queue.tasks.includes(futureOrder)).toBe(alpha)
    expect(queue.tasks.some(task => task.type === T.NOT_SPECIFIC && task.timeMicros === nowMicros)).toBe(true)
  })

  it.each(cases)('waits for the ordinary deadline instead of repeatedly recovering an ideal stale order, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue } = staleOrderQueue(type)
    expect(nextMowerRunRecoveryMicros(queue, nowMicros, alpha, ideal)).toBe(toMowerMicros(1))
  })

  it.each(cases)('keeps the native recovery deadline when the option is omitted, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue } = staleOrderQueue(type)
    expect(nextMowerRunRecoveryMicros(queue, nowMicros, alpha)).toBe(type === T.REFRESH_TIME ? toMowerMicros(1) : nowMicros + 1)
  })

  it.each(cases)('still immediately recovers stale ordinary work in ideal mode, alpha=$alpha type=$type.key', ({ alpha, type }) => {
    const { queue } = staleOrderQueue(type)
    queue.tasks.push(new MowerTask({ time: 0, type: T.SHIFT_OFF, plan: { central: ['Gladiia'] } }))
    expect(nextMowerRunRecoveryMicros(queue, nowMicros, alpha, ideal)).toBe(nowMicros + 1)
  })
})
