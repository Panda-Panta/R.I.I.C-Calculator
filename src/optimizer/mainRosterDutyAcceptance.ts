import type { DutyPredictionComparison } from './mainRosterDutyCalibration'

export interface MainRosterDutyAccuracyThresholds {
  meanAbsoluteWorkHours: number
  maxAbsoluteWorkHours: number
  maxAbsoluteRestHours: number
  maxAbsoluteIdleHours: number
}

export interface MainRosterDutyAccuracyAcceptance {
  status: 'accepted' | 'rejected' | 'unavailable'
  thresholds: MainRosterDutyAccuracyThresholds
  issues: string[]
}

const DEFAULT_THRESHOLDS: MainRosterDutyAccuracyThresholds = {
  meanAbsoluteWorkHours: .1,
  maxAbsoluteWorkHours: .5,
  maxAbsoluteRestHours: .5,
  maxAbsoluteIdleHours: .5,
}

const metricKeys = ['meanAbsoluteWorkHours', 'maxAbsoluteWorkHours', 'maxAbsoluteRestHours', 'maxAbsoluteIdleHours'] as const
const timeKeys = ['mainWorkHours', 'substituteWorkHours', 'workHours', 'exhaustedHours', 'restHours', 'idleHours'] as const
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0
// Only arithmetic roundoff is tolerated; this is not an additional hour budget.
const close = (left: number, right: number) => Math.abs(left - right)
  <= 16 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right))

/**
 * Evaluate duty-hour accuracy only, using active-worker summaries from the
 * paired comparison. This cannot grant Native eligibility or schedule/joint
 * parity, and production score/resource errors are separate diagnostics.
 * Missing or inconsistent evidence is unavailable, never a zero-error pass.
 */
export function evaluateMainRosterDutyAccuracy(
  comparison: DutyPredictionComparison,
  thresholds: MainRosterDutyAccuracyThresholds = DEFAULT_THRESHOLDS,
): MainRosterDutyAccuracyAcceptance {
  const resolved = { ...thresholds }, issues: string[] = []
  const finish = (status: MainRosterDutyAccuracyAcceptance['status']): MainRosterDutyAccuracyAcceptance => ({
    status, thresholds: resolved, issues,
  })
  for (const key of metricKeys) {
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
    // Match calibration's physical-duty definition, including zero-morale work.
    const physicalWorker = row.hours.workHours.predicted + row.hours.exhaustedHours.predicted > 1e-5
      || row.hours.workHours.observed + row.hours.exhaustedHours.observed > 1e-5
    if (row.activeWorker !== physicalWorker || !finite(row.workFractionPercentagePoints)) {
      issues.push(`DUTY_ACCURACY_OPERATOR_ACTIVITY_INVALID:${row.operatorId}`)
      return finish('unavailable')
    }
  }
  const active = comparison.operators.filter(row => row.activeWorker)
  if (active.length !== summary.count) {
    issues.push('DUTY_ACCURACY_ACTIVE_WORKER_COUNT_MISMATCH')
    return finish('unavailable')
  }
  const measured = {
    meanAbsoluteWorkHours: active.reduce((sum, row) => sum + row.hours.workHours.absolute, 0) / active.length,
    maxAbsoluteWorkHours: Math.max(...active.map(row => row.hours.workHours.absolute)),
    maxAbsoluteRestHours: Math.max(...active.map(row => row.hours.restHours.absolute)),
    maxAbsoluteIdleHours: Math.max(...active.map(row => row.hours.idleHours.absolute)),
    maxWorkFractionPercentagePoints: Math.max(...active.map(row => Math.abs(row.workFractionPercentagePoints))),
  }
  for (const key of [...metricKeys, 'maxWorkFractionPercentagePoints'] as const) {
    if (!nonnegative(measured[key]) || !close(summary[key]!, measured[key])) {
      issues.push(`DUTY_ACCURACY_SUMMARY_INCONSISTENT:${key}`)
    }
  }
  if (issues.length) return finish('unavailable')
  for (const key of metricKeys) {
    if (measured[key] > resolved[key] && !close(measured[key], resolved[key])) {
      issues.push(`DUTY_ACCURACY_THRESHOLD_EXCEEDED:${key}:${measured[key]}>${resolved[key]}`)
    }
  }
  return finish(issues.length ? 'rejected' : 'accepted')
}
