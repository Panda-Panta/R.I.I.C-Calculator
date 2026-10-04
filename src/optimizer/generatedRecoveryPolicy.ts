import type { RosterWorkspace } from '../workbench/model'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'

/** Keep a short mood window from inheriting another group member's early return. */
export function applyGeneratedRecoveryPolicy(workspace: RosterWorkspace): void {
  const schedule = compileRosterSchedule(workspace)
  if (schedule.diagnostics.some(d => d.severity === 'error')) return
  const data = getMowerSourceRuntime(createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))).data
  const operators = Object.values(data.operators)
  const resting = new Set(workspace.mainPlan.conf.rest_in_full)
  for (const op of operators) {
    if (!op.isHigh() || !op.group || op.room.startsWith('dorm') || op.lowerLimit <= 0 || op.workaholic || op.exhaustRequire || op.restInFull || op.restingPriority === 'standby') continue
    if (operators.some(peer => peer.group === op.group && peer.isHigh() && !peer.room.startsWith('dorm') && !peer.workaholic &&
      (peer.lowerLimit !== op.lowerLimit || peer.upperLimit !== op.upperLimit))) resting.add(op.name)
  }
  workspace.mainPlan.conf.rest_in_full = [...resting]
}
