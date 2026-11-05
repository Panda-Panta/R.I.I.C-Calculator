import { describe, expect, it } from 'vitest'
import type { MowerBackupGroupTask } from '../domain/mowerBackupGroupTasks'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { simulateSchedule } from '../simulator/scheduleSimulation'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from './compileRosterSchedule'
import { mowerForcedGroupCovers, syncMowerBackupGroupTasks } from './mowerBackupGroupTasks'
import { planMowerMetadata } from './mowerMetadata'
import { MowerOperatorState } from './mowerOperatorState'
import { runMowerReplacementCheck } from './mowerReplacementCheck'
import { MowerDormState, MowerSchedulingData } from './mowerSchedulingData'
import { MowerTask, MowerTaskQueue, MOWER_TASK_TYPES as T, toMowerMicros } from './mowerTaskQueue'
import { scheduleMowerTasks } from './mowerTaskScheduling'

function restingGroup(task: MowerBackupGroupTask) {
  const data = new MowerSchedulingData({
    alpha: true,
    nowMicros: 0,
    plan: { central: ['A'], contact: ['B'], dormitory_1: ['Free', 'Free'] },
    dorms: [
      new MowerDormState(['dormitory_1', 0], 'A', toMowerMicros(2)),
      new MowerDormState(['dormitory_1', 1], 'B', toMowerMicros(2)),
    ],
    operators: {
      A: new MowerOperatorState({
        name: 'A', room: 'central', index: 0, group: 'g', replacement: ['C'], operatorType: 'high',
        currentRoom: 'dormitory_1', currentIndex: 0, mood: 18, timeStampMicros: 0,
      }),
      B: new MowerOperatorState({
        name: 'B', room: 'contact', index: 0, group: 'g', replacement: ['D'], operatorType: 'high',
        currentRoom: 'dormitory_1', currentIndex: 1, mood: 18, timeStampMicros: 0,
      }),
      C: new MowerOperatorState({ name: 'C', currentRoom: 'central', currentIndex: 0, operatorType: 'low' }),
      D: new MowerOperatorState({ name: 'D', currentRoom: 'contact', currentIndex: 0, operatorType: 'low' }),
    },
    planConditions: [true],
    backupGroupTasks: [[task]],
    groupShiftState: { g: true },
  })
  return { data, queue: new MowerTaskQueue(), issued: new Set<string>() }
}

describe('Mower backup group tasks', () => {
  it.each([
    ['once', true],
    ['while_active', false],
    ['forced', false],
  ] as const)('executes an imported group departure in %s mode through simulation', (mode, returns) => {
    const raw = {
      plan1: {
        central: { plans: [
          { agent: '芬', group: '轮班', replacement: ['香草'] },
          { agent: '克洛丝', group: '轮班', replacement: ['芙蓉'] },
        ] },
        dormitory_1: { plans: Array.from({ length: 5 }, () => ({ agent: 'Free' })) },
      },
      backup_plans: [{ name: '整组休息', trigger: 'True', group_tasks: [{ group: '轮班', mode }] }],
    }
    const names = [id('芬'), id('克洛丝')]
    const schedule = compileRosterSchedule(importMowerJson(JSON.stringify(raw)), {
      operatorMorale: Object.fromEntries(names.map(name => [name, 18])),
    })
    const report = simulateSchedule(schedule, { schedulingModel: 'mower-alpha', sampleHours: 4 })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.events.filter(event => event.type === 'shift-off').map(event => event.operators)).toEqual([names])
    expect(report.events.filter(event => event.type === 'shift-on').map(event => event.operators)).toEqual(returns ? [names] : [])
  })

  it('issues a single return task and retains it through metadata rebuilding', () => {
    const { data, queue, issued } = restingGroup({ group: 'g', action: 'on', mode: 'once' })
    syncMowerBackupGroupTasks(data, queue, issued, [])
    const request = queue.tasks[0]!
    expect(request.plan).toEqual({ central: ['A'], contact: ['B'] })
    planMowerMetadata(data, queue)
    syncMowerBackupGroupTasks(data, queue, issued, [])
    expect(queue.tasks.filter(task => task.backupGroupRequest)).toEqual([request])

    const parked = [request]
    queue.tasks = []
    data.planConditions = [false]
    syncMowerBackupGroupTasks(data, queue, issued, parked)
    expect(parked).toEqual([])
    data.planConditions = [true]
    syncMowerBackupGroupTasks(data, queue, issued, [])
    expect(queue.tasks.filter(task => task.backupGroupRequest)).toHaveLength(1)
  })

  it('reserves the current covers during forced rest and restores normal returns on exit', () => {
    const { data, queue, issued } = restingGroup({ group: 'g', action: 'off', mode: 'forced' })
    expect(mowerForcedGroupCovers(data).names).toEqual(new Set(['C', 'D']))
    planMowerMetadata(data, queue)
    expect(queue.tasks.filter(task => task.type === T.SHIFT_ON)).toEqual([])
    data.planConditions = [false]
    syncMowerBackupGroupTasks(data, queue, issued, [])
    expect(mowerForcedGroupCovers(data).names.size).toBe(0)
    planMowerMetadata(data, queue)
    expect(queue.tasks.find(task => task.type === T.SHIFT_ON)?.plan).toMatchObject({ central: ['A'], contact: ['B'] })
  })

  it.each([false, true])('keeps forced rest while replacing its own exhausted cover, real reservation=%s', reserved => {
    const { data, queue } = restingGroup({ group: 'g', action: 'off', mode: 'forced' })
    data.operators.A!.replacement = ['C', 'E']
    data.operators.E = new MowerOperatorState({ name: 'E', operatorType: 'low', mood: 24, timeStampMicros: 0 })
    const task = new MowerTask()
    task.replacementCheck = { target: { room: 'central', index: 0, owner: 'A', cover: 'C' }, revision: 0 }
    if (reserved) {
      const pending = new MowerTask({ type: T.SELF_CORRECTION, plan: { central: ['E'] } })
      pending.executionRetained = true
      queue.tasks.push(pending)
    }
    const done = runMowerReplacementCheck(data, queue, task, { readRoom: () => ({ agent: 'C', mood: 0 }) })
    expect(done).toBe(!reserved)
    if (reserved) expect(task.executionFailure?.reason).toContain('其他任务预约')
    else expect(queue.tasks[0]?.plan).toEqual({ central: ['E'] })
    expect(data.groupIsResting('g')).toBe(true)
  })

  it('keeps a deferred group request isolated so deactivation cancels its complete arrangement', () => {
    const { data, queue, issued } = restingGroup({ group: 'g', action: 'off', mode: 'while_active' })
    const ordinary = new MowerTask({ type: T.SHIFT_OFF, plan: { central: ['C'], dormitory_1: ['A'] } })
    const requested = new MowerTask({ type: T.SHIFT_OFF, plan: { contact: ['D'], dormitory_2: ['B'] } })
    requested.backupGroupRequest = { backup: 0, group: 'g', action: 'off', mode: 'while_active' }
    const order = new MowerTask({ type: T.RUN_ORDER, time: .001, metadata: 'room_1_1' })
    queue.tasks = [ordinary, requested, order]
    scheduleMowerTasks(queue.tasks, 0, { alpha: true })
    expect(ordinary.plan).toEqual({ central: ['C'], dormitory_1: ['A'] })
    data.planConditions = [false]
    syncMowerBackupGroupTasks(data, queue, issued, [])
    expect(queue.tasks).not.toContain(requested)
    expect(queue.tasks.flatMap(task => Object.keys(task.plan))).not.toContain('dormitory_2')
  })
})
