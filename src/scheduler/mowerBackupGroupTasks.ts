import type { MowerBackupGroupTask } from '../domain/mowerBackupGroupTasks'
import type { MowerSchedulingData } from './mowerSchedulingData'
import { mowerArrangementGroupTransitions } from './mowerSharedGroups'
import { fromMowerMicros, MowerTask, MOWER_TASK_TYPES as T, type MowerTaskQueue } from './mowerTaskQueue'
import { mowerUrgentPendingSupporters, mowerUrgentRecallBlocked } from './mowerUrgentRecovery'
import { MowerShiftPreviewError } from './mowerNativeErrors'

// Group requests follow Mower's backup_group_tasks.py (MIT, Copyright 2021 Nano).
export interface MowerBackupGroupRequest extends MowerBackupGroupTask {
  backup: number
}

export class MowerForcedRestBlocked extends MowerShiftPreviewError {
  constructor(readonly groups: string[]) {
    super(`副表要求整组强制下班，等待副表退出：${groups.join('、')}`)
  }
}

function activeRequests(data: MowerSchedulingData): MowerBackupGroupRequest[] {
  return data.backupGroupTasks.flatMap((tasks, backup) =>
    data.planConditions[backup] ? tasks.map(task => ({ ...task, backup })) : [],
  )
}

export function mowerHeldRestGroups(data: MowerSchedulingData, forcedOnly = false): Set<string> {
  return new Set(activeRequests(data).filter(task =>
    task.action === 'off' && (task.mode === 'forced' || !forcedOnly && task.mode === 'while_active'),
  ).map(task => task.group))
}

export function validateMowerGroupTasks(data: MowerSchedulingData): void {
  const directions = new Map<string, MowerBackupGroupTask['action']>()
  for (const { group, action } of activeRequests(data)) {
    if (directions.has(group) && directions.get(group) !== action) {
      throw new Error(`生效副表对同一绑组安排了相反的上下班任务：${group}`)
    }
    directions.set(group, action)
    if (!data.shiftGroupMembers(group).some(name => data.isGroupShiftAnchor(data.operators[name]!))) {
      throw new Error(`绑组任务找不到工作主班：${group}`)
    }
  }
}

const requestKey = ({ backup, group, action, mode }: MowerBackupGroupRequest) => JSON.stringify([backup, group, action, mode])

/** Queue group requests independently from the room overlay, against physical occupancy. */
export function syncMowerBackupGroupTasks(
  data: MowerSchedulingData, queue: MowerTaskQueue, issued: Set<string>, parked: MowerTask[],
): void {
  const requests = activeRequests(data)
  validateMowerGroupTasks(data)
  const active = new Set(requests.map(requestKey))
  const keep = (task: MowerTask) => !task.backupGroupRequest || active.has(requestKey(task.backupGroupRequest))
    || task.arrangementStarted || task.backupShiftActive || Object.keys(task.groupShiftExpected).length > 0
  queue.tasks = queue.tasks.filter(keep)
  parked.splice(0, parked.length, ...parked.filter(keep))
  for (const key of issued) if (!active.has(key)) issued.delete(key)

  for (const request of requests) {
    const { group, action, mode } = request
    const key = requestKey(request)
    if (mode === 'once' && issued.has(key)) continue
    if ([...queue.tasks, ...parked].some(task =>
      task.backupGroupRequest?.group === group && task.backupGroupRequest.action === action,
    )) continue
    if (data.groupIsResting(group) === (action === 'off')) {
      issued.add(key)
      continue
    }
    const members = data.shiftGroupMembers(group)
    if (action === 'off' && mowerUrgentRecallBlocked(data, members, mowerUrgentPendingSupporters(queue.tasks))) continue
    const anchor = members.find(name => data.isGroupShiftAnchor(data.operators[name]!))!
    const task = new MowerTask({
      time: fromMowerMicros(data.nowMicros),
      type: action === 'off' ? T.EXHAUST_OFF : T.SHIFT_ON,
      metadata: action === 'off' ? anchor : '',
    })
    task.backupGroupRequest = request
    if (action === 'on') for (const name of members) {
      const operator = data.operators[name]!
      if (!data.plan[operator.room]) continue
      const row = task.plan[operator.room] ??= Array(data.plan[operator.room]!.length).fill('Current')
      row[operator.index] = name
    }
    queue.tasks.push(task)
    issued.add(key)
  }
  filterMowerHeldReturns(data, queue)
}

/** Drop only unstarted derived returns. Coordination and confirmed arrangements keep ownership. */
export function filterMowerHeldReturns(data: MowerSchedulingData, queue: MowerTaskQueue): void {
  const held = mowerHeldRestGroups(data)
  if (!held.size) return
  for (const task of [...queue.tasks]) {
    if (task.type !== T.SHIFT_ON || task.retainsExecution || task.backupGroupRequest || task.exhaustSupport
      || task.backupShiftActive || task.arrangementStarted || task.productShiftLocked || task.dormRecoveryRestore.length
      || Object.keys(task.groupShiftExpected).length) continue
    const blocked = Object.entries(mowerArrangementGroupTransitions(data, task.plan))
      .filter(([group, resting]) => !resting && held.has(group))
      .flatMap(([group]) => data.shiftGroupMembers(group))
    if (!blocked.length) continue
    const members = new Set(blocked)
    for (const [room, row] of Object.entries(task.plan)) {
      row.forEach((name, index) => {
        if (members.has(name) || room.startsWith('dorm') && members.has(data.currentOperator(room, index)?.name ?? '')) {
          row[index] = 'Current'
        }
      })
      if (row.every(name => name === 'Current')) delete task.plan[room]
    }
    if (!Object.keys(task.plan).length) queue.consume(task)
    else {
      delete task.backupShiftIntent
      delete task.backupShiftConditions
      task.groupShiftTransitions = {}
    }
  }
}

/** A forced rest keeps the occupied cover slots available to this group alone. */
export function mowerForcedGroupCovers(data: MowerSchedulingData, ownSlot?: string): { names: Set<string>; slots: Set<string> } {
  const names = new Set<string>()
  const slots = new Set<string>()
  for (const group of mowerHeldRestGroups(data, true)) {
    if (!data.groupIsResting(group)) continue
    for (const name of data.shiftGroupMembers(group)) {
      const operator = data.operators[name]!
      const slot = operator.room + '\0' + operator.index
      if (slot === ownSlot) continue
      const cover = data.currentOperator(operator.room, operator.index)
      if (!cover || cover.name === name) continue
      names.add(cover.name)
      slots.add(slot)
    }
  }
  return { names, slots }
}
