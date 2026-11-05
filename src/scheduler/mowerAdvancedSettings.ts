import type { RosterWorkspace } from '../domain/roster'
import type { SimulationAssumptions } from './types'

export const MOWER_MIN_RESTING_THRESHOLD = .35

export function isMowerGroupRestingThresholds(value: unknown): value is Record<string, number> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([group, ratio]) => !!group.trim() && typeof ratio === 'number'
      && Number.isFinite(ratio) && ratio >= MOWER_MIN_RESTING_THRESHOLD && ratio <= 1)
}

/** Plan-exported settings; explicit simulator options take precedence. */
export function mowerAdvancedAssumptions(workspace: RosterWorkspace): Partial<SimulationAssumptions> {
  const raw = workspace.compatibility.unrecognizedFields.advanced_settings
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('高级设置必须为对象')
  const fields = {
    dorm_isolation: 'dormIsolation',
    resting_threshold: 'restingThreshold', group_resting_thresholds: 'groupRestingThresholds', rescue_threshold: 'rescueThreshold',
    free_room: 'freeRoom', group_rest_in_full_on_mood_gap: 'groupRestInFullOnMoodGap',
    group_mood_gap_threshold_minutes: 'groupMoodGapThresholdMinutes',
    group_mood_gap_max_extra_wait_hours: 'groupMoodGapMaxExtraWaitHours',
    group_mood_gap_exclusions: 'groupMoodGapExclusions',
    merge_interval: 'mergeIntervalMinutes', fia_fool: 'fiammettaFool',
    fia_threshold: 'fiammettaThreshold', drone_interval: 'droneIntervalHours',
    drone_count_limit: 'droneCountLimit',
  } as const
  const result: Record<string, unknown> = {}
  for (const [source, target] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(raw, source)) result[target] = (raw as Record<string, unknown>)[source]
  }
  return result as Partial<SimulationAssumptions>
}
