import type { DutyPredictionComparison } from './mainRosterDutyCalibration'

export interface MainRosterDutyAccuracyThresholds {
  meanAbsoluteWorkHours: number
  maxAbsoluteWorkHours: number
  maxAbsoluteRestHours: number
  maxAbsoluteIdleHours: number
  /** Additional per-operator limits default to 0.5h for legacy four-field callers. */
  maxAbsoluteExhaustedHours?: number
  maxAbsolutePhysicalWorkHours?: number
  maxAbsoluteMainWorkHours?: number
  maxAbsoluteSubstituteWorkHours?: number
}

export interface MainRosterDutyAccuracyAcceptance {
  status: 'accepted' | 'rejected' | 'unavailable'
  thresholds: Required<MainRosterDutyAccuracyThresholds>
  issues: string[]
}

const DEFAULT_THRESHOLDS: Required<MainRosterDutyAccuracyThresholds> = {
  meanAbsoluteWorkHours: .1,
  maxAbsoluteWorkHours: .5,
  maxAbsoluteRestHours: .5,
  maxAbsoluteIdleHours: .5,
  maxAbsoluteExhaustedHours: .5,
  maxAbsolutePhysicalWorkHours: .5,
  maxAbsoluteMainWorkHours: .5,
  maxAbsoluteSubstituteWorkHours: .5,
}

const metricKeys = ['meanAbsoluteWorkHours', 'maxAbsoluteWorkHours', 'maxAbsoluteRestHours', 'maxAbsoluteIdleHours'] as const
const addedMetricKeys = ['maxAbsoluteExhaustedHours', 'maxAbsolutePhysicalWorkHours', 'maxAbsoluteMainWorkHours', 'maxAbsoluteSubstituteWorkHours'] as const
const timeKeys = ['mainWorkHours', 'substituteWorkHours', 'workHours', 'exhaustedHours', 'restHours', 'idleHours'] as const
// Match the comparator's report conservation tolerance, not an accuracy allowance.
const TIME_CONSERVATION_EPS = 1e-5
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0
// Only arithmetic roundoff is tolerated; this is not an additional hour budget.
const close = (left: number, right: number) => Math.abs(left - right)
  <= 16 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right))

/**
 * Stricter explicit model validation only; Native eligibility and default
 * roster selection remain separate. The effective-work mean keeps its active
 * denominator, while rest/idle and fatigue/physical/role maxima inspect every
 * operator. Upstream active-only summaries are still checked for consistency.
 * This cannot grant schedule/joint parity; score/resource errors are separate.
 * Missing or inconsistent evidence is unavailable, never a zero-error pass.
 */
export function evaluateMainRosterDutyAccuracy(
  comparison: DutyPredictionComparison,
  thresholds: MainRosterDutyAccuracyThresholds = DEFAULT_THRESHOLDS,
): MainRosterDutyAccuracyAcceptance {
  const supplied = { ...thresholds }, issues: string[] = []
  // Default only omitted new fields. An explicitly supplied invalid value and
  // any absent original required field must remain unavailable.
  const resolved: Required<MainRosterDutyAccuracyThresholds> = { ...supplied,
    maxAbsoluteExhaustedHours: Object.prototype.hasOwnProperty.call(supplied, 'maxAbsoluteExhaustedHours') ? supplied.maxAbsoluteExhaustedHours! : DEFAULT_THRESHOLDS.maxAbsoluteExhaustedHours,
    maxAbsolutePhysicalWorkHours: Object.prototype.hasOwnProperty.call(supplied, 'maxAbsolutePhysicalWorkHours') ? supplied.maxAbsolutePhysicalWorkHours! : DEFAULT_THRESHOLDS.maxAbsolutePhysicalWorkHours,
    maxAbsoluteMainWorkHours: Object.prototype.hasOwnProperty.call(supplied, 'maxAbsoluteMainWorkHours') ? supplied.maxAbsoluteMainWorkHours! : DEFAULT_THRESHOLDS.maxAbsoluteMainWorkHours,
    maxAbsoluteSubstituteWorkHours: Object.prototype.hasOwnProperty.call(supplied, 'maxAbsoluteSubstituteWorkHours') ? supplied.maxAbsoluteSubstituteWorkHours! : DEFAULT_THRESHOLDS.maxAbsoluteSubstituteWorkHours,
  }
  const finish = (status: MainRosterDutyAccuracyAcceptance['status']): MainRosterDutyAccuracyAcceptance => ({
    status, thresholds: resolved, issues,
  })
  for (const key of [...metricKeys, ...addedMetricKeys]) {
    if (!nonnegative(resolved[key])) issues.push(`DUTY_ACCURACY_THRESHOLD_INVALID:${key}`)
  }
  if (issues.length) return finish('unavailable')
  if (!comparison || comparison.status !== 'comparable') {
    issues.push(`DUTY_ACCURACY_COMPARISON_UNAVAILABLE:${comparison?.status ?? 'missing'}`)
    return finish('unavailable')
  }
  const summary = comparison.activeWorkerErrors
  if (!summary || !Number.isInteger(summary.count) || summary.count <= 0) {
    issues.push('DUTY_ACCURACY_ACTIVE_WORKER_COUNT_INVALID')
    return finish('unavailable')
  }
  for (const key of [...metricKeys, 'maxWorkFractionPercentagePoints'] as const) {
    if (!nonnegative(summary[key])) issues.push(`DUTY_ACCURACY_METRIC_UNAVAILABLE:${key}`)
  }
  if (issues.length) return finish('unavailable')
  if (!Array.isArray(comparison.operators)) {
    issues.push('DUTY_ACCURACY_OPERATOR_ROWS_UNAVAILABLE')
    return finish('unavailable')
  }
  const seen = new Set<string>()
  let smallestTotal = Infinity, largestTotal = 0
  for (const row of comparison.operators) {
    if (!row || typeof row.operatorId !== 'string' || !row.operatorId || seen.has(row.operatorId)
      || typeof row.activeWorker !== 'boolean') {
      issues.push('DUTY_ACCURACY_OPERATOR_ID_OR_ACTIVITY_INVALID')
      return finish('unavailable')
    }
    seen.add(row.operatorId)
    for (const key of timeKeys) {
      const error = row.hours?.[key]
      if (!error || !nonnegative(error.predicted) || !nonnegative(error.observed)
        || !finite(error.difference) || !nonnegative(error.absolute)
        || !close(error.difference, error.predicted - error.observed)
        || !close(error.absolute, Math.abs(error.difference))
        || (error.observed === 0 ? error.relative !== null
          : !finite(error.relative) || !close(error.relative, error.difference / error.observed))) {
        issues.push(`DUTY_ACCURACY_OPERATOR_HOURS_INVALID:${row.operatorId}:${key}`)
        return finish('unavailable')
      }
    }
    // The comparator already enforces these invariants for produced reports.
    // Retain them at this boundary for modified/deserialized comparisons too.
    for (const side of ['predicted', 'observed'] as const) {
      const hours = row.hours, total = hours.workHours[side] + hours.exhaustedHours[side] + hours.restHours[side] + hours.idleHours[side]
      if (!finite(total) || Math.abs(hours.mainWorkHours[side] + hours.substituteWorkHours[side] - hours.workHours[side]) > TIME_CONSERVATION_EPS) {
        issues.push(`DUTY_ACCURACY_OPERATOR_TIME_NOT_CONSERVED:${row.operatorId}:${side}`)
        return finish('unavailable')
      }
      smallestTotal = Math.min(smallestTotal, total); largestTotal = Math.max(largestTotal, total)
    }
    // Match calibration's physical-duty definition, including zero-morale work.
    const physicalWorker = row.hours.workHours.predicted + row.hours.exhaustedHours.predicted > 1e-5
      || row.hours.workHours.observed + row.hours.exhaustedHours.observed > 1e-5
    if (row.activeWorker !== physicalWorker || !finite(row.workFractionPercentagePoints)) {
      issues.push(`DUTY_ACCURACY_OPERATOR_ACTIVITY_INVALID:${row.operatorId}`)
      return finish('unavailable')
    }
  }
  // Each endpoint can be within one EPS of the common requested sample. Its
  // actual duration/window provenance is owned by the paired comparator.
  if (largestTotal <= 0 || (largestTotal - smallestTotal > 2 * TIME_CONSERVATION_EPS
    && !close(largestTotal - smallestTotal, 2 * TIME_CONSERVATION_EPS))) {
    issues.push('DUTY_ACCURACY_OPERATOR_SAMPLE_MISMATCH')
    return finish('unavailable')
  }
  const active = comparison.operators.filter(row => row.activeWorker)
  if (active.length !== summary.count) {
    issues.push('DUTY_ACCURACY_ACTIVE_WORKER_COUNT_MISMATCH')
    return finish('unavailable')
  }
  const activeMeasured = {
    meanAbsoluteWorkHours: active.reduce((sum, row) => sum + row.hours.workHours.absolute, 0) / active.length,
    maxAbsoluteWorkHours: Math.max(...active.map(row => row.hours.workHours.absolute)),
    maxAbsoluteRestHours: Math.max(...active.map(row => row.hours.restHours.absolute)),
    maxAbsoluteIdleHours: Math.max(...active.map(row => row.hours.idleHours.absolute)),
    maxWorkFractionPercentagePoints: Math.max(...active.map(row => Math.abs(row.workFractionPercentagePoints))),
  }
  for (const key of [...metricKeys, 'maxWorkFractionPercentagePoints'] as const) {
    if (!nonnegative(activeMeasured[key]) || !close(summary[key]!, activeMeasured[key])) {
      issues.push(`DUTY_ACCURACY_SUMMARY_INCONSISTENT:${key}`)
    }
  }
  if (issues.length) return finish('unavailable')
  const rows = comparison.operators
  const measured = { ...activeMeasured,
    maxAbsoluteRestHours: Math.max(...rows.map(row => row.hours.restHours.absolute)),
    maxAbsoluteIdleHours: Math.max(...rows.map(row => row.hours.idleHours.absolute)),
    maxAbsoluteExhaustedHours: Math.max(...rows.map(row => row.hours.exhaustedHours.absolute)),
    // Opposite signed work/exhaustion errors can cancel physically; absolute
    // component errors must not be added before this joint difference.
    maxAbsolutePhysicalWorkHours: Math.max(...rows.map(({ hours }) => Math.abs(
      hours.workHours.predicted + hours.exhaustedHours.predicted - (hours.workHours.observed + hours.exhaustedHours.observed)))),
    maxAbsoluteMainWorkHours: Math.max(...rows.map(row => row.hours.mainWorkHours.absolute)),
    maxAbsoluteSubstituteWorkHours: Math.max(...rows.map(row => row.hours.substituteWorkHours.absolute)),
  }
  for (const key of [...metricKeys, ...addedMetricKeys]) {
    if (measured[key] > resolved[key] && !close(measured[key], resolved[key])) {
      issues.push(`DUTY_ACCURACY_THRESHOLD_EXCEEDED:${key}:${measured[key]}>${resolved[key]}`)
    }
  }
  return finish(issues.length ? 'rejected' : 'accepted')
}
