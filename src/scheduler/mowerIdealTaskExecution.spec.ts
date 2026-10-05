import { describe, expect, it } from 'vitest'
import type { BackupTiming } from './backupPlans'
import { executeMowerTaskArrangement, type MowerTaskExecutionHooks } from './mowerTaskExecutor'
import { MowerTask, MowerTaskQueue, MOWER_TASK_TYPES as T, type MowerTaskPlan, type MowerTaskType } from './mowerTaskQueue'

const cases = [T.RUN_ORDER, T.REFRESH_TIME].flatMap(type => [false, undefined].map(adjustForRunOrders => ({ type, adjustForRunOrders })))

function hooks(phases: BackupTiming[], adjustForRunOrders?: boolean): MowerTaskExecutionHooks {
  return {
    adjustForRunOrders,
    backup: phase => { phases.push(phase); return { changed: false, generated: [] } },
    arrangeRoom: () => {},
    metadata: () => {},
  }
}

function upcomingReturn(type: MowerTaskType, plan: MowerTaskPlan = {}) {
  const queue = new MowerTaskQueue()
  const task = new MowerTask({ time: 0, type: Object.keys(plan).length ? T.SHIFT_OFF : T.NOT_SPECIFIC, plan })
  const order = new MowerTask({ time: 10 / 3600, type, metadata: 'room_1_1' })
  const returning = new MowerTask({ time: 20 / 3600, type: T.SHIFT_ON, plan: { central: ['Gladiia'] } })
  queue.tasks.push(task, order, returning)
  return { queue, task, order, returning }
}

describe('ideal order isolation in actual task execution', () => {
  it.each(cases)('runs the return phase after consuming an empty task only in ideal mode, type=$type.key adjust=$adjustForRunOrders', ({ type, adjustForRunOrders }) => {
    const { queue, task, order, returning } = upcomingReturn(type)
    const phases: BackupTiming[] = []
    expect(executeMowerTaskArrangement(task, queue, hooks(phases, adjustForRunOrders))).toBe(true)
    expect(phases).toEqual(adjustForRunOrders === false ? ['AFTER_PLANNING'] : [])
    expect(queue.tasks).toEqual([order, returning])
    expect(returning.time).toBe(20 / 3600)
  })

  it.each(cases)('runs the same return phase after a completed physical arrangement, type=$type.key adjust=$adjustForRunOrders', ({ type, adjustForRunOrders }) => {
    const { queue, task, returning } = upcomingReturn(type, { central: ['GladiiaCover'] })
    const phases: BackupTiming[] = []
    expect(executeMowerTaskArrangement(task, queue, hooks(phases, adjustForRunOrders))).toBe(true)
    expect(phases).toEqual(adjustForRunOrders === false
      ? ['BEFORE_WORK', 'BEFORE_PLANNING', 'AFTER_PLANNING']
      : ['BEFORE_WORK', 'BEFORE_PLANNING'])
    expect(queue.tasks).toContain(returning)
    expect(returning.time).toBe(20 / 3600)
  })

  it.each(cases)('keeps a preceding ordinary task as the return-phase barrier, type=$type.key adjust=$adjustForRunOrders', ({ type, adjustForRunOrders }) => {
    const { queue, task, returning } = upcomingReturn(type)
    const preceding = new MowerTask({ time: 15 / 3600, type: T.SELF_CORRECTION, plan: { central: ['OtherWorker'] } })
    queue.tasks.splice(2, 0, preceding)
    const phases: BackupTiming[] = []
    expect(executeMowerTaskArrangement(task, queue, hooks(phases, adjustForRunOrders))).toBe(true)
    expect(phases).toEqual([])
    expect(queue.tasks).toContain(preceding)
    expect(queue.tasks).toContain(returning)
  })

  it.each(cases)('anchors a generated ordinary plan independently of an order preceding an active arrangement, type=$type.key adjust=$adjustForRunOrders', ({ type, adjustForRunOrders }) => {
    const queue = new MowerTaskQueue()
    const order = new MowerTask({ time: .5, type, metadata: 'room_1_1' })
    const task = new MowerTask({ time: 1, type: T.SHIFT_OFF, plan: { central: ['GladiiaCover'] } })
    const correction = new MowerTask({ time: 2, type: T.SELF_CORRECTION, plan: { room_1_2: ['TradeCover'] } })
    // The caller supplies the already active arrangement; a new order is pending.
    queue.tasks.push(order, task)
    const execution = hooks([], adjustForRunOrders)
    execution.backup = phase => ({ changed: phase === 'BEFORE_WORK', generated: phase === 'BEFORE_WORK' ? [correction] : [] })
    expect(executeMowerTaskArrangement(task, queue, execution)).toBe(false)
    expect(correction.timeMicros).toBe((adjustForRunOrders === false ? task.timeMicros : order.timeMicros) - 1)
    expect(task.plan).toEqual({ central: ['GladiiaCover'] })
  })

  it.each(cases)('keeps Fiammetta restoration due independent of a pending order, type=$type.key adjust=$adjustForRunOrders', ({ type, adjustForRunOrders }) => {
    const queue = new MowerTaskQueue()
    const order = new MowerTask({ time: .5, type, metadata: 'room_1_1' })
    const task = new MowerTask({ time: 1, type: T.FIAMMETTA, plan: { dormitory_1: ['ChargeTarget', 'Fiammetta'] } })
    const restoration: MowerTaskPlan = { central: ['ChargeTarget'], dormitory_1: ['OriginalResident', 'Fiammetta'] }
    queue.tasks.push(order, task)
    const execution = hooks([], adjustForRunOrders)
    execution.arrangeRoom = () => structuredClone(restoration)
    expect(executeMowerTaskArrangement(task, queue, execution)).toBe(true)
    const restore = queue.tasks.find(current => current.type === T.FIAMMETTA)
    expect(restore?.plan).toEqual(restoration)
    expect(restore?.timeMicros).toBe(adjustForRunOrders === false ? task.timeMicros : order.timeMicros)
  })
})
