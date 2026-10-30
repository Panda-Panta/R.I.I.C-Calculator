import { resolveDroneCapacity } from '../domain/droneCapacity'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { simulationOutputAmounts, scoreSimulationProduction } from '../simulator/productionScore'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import type { CandidateSimulationJob } from './candidateSimulation'
import { evaluateMainRosterDuty, type MainRosterDutyQuality } from './mainRosterDutyEvaluation'
import { DUTY_RESOURCE_KEYS, type DutyResourceKey, type MainRosterDutyProjection } from './mainRosterDutyTypes'

const timeKeys = ['mainWorkHours', 'substituteWorkHours', 'workHours', 'exhaustedHours', 'restHours', 'idleHours'] as const
type TimeKey = typeof timeKeys[number]
export interface DutyPredictionError {
  predicted: number
  observed: number
  difference: number
  absolute: number
  /** Signed fraction; undefined when the observed denominator is zero. */
  relative: number | null
}
export interface DutyOperatorComparison {
  operatorId: string
  activeWorker: boolean
  hours: Record<TimeKey, DutyPredictionError>
  workFractionPercentagePoints: number
  workRestRatio: { predicted: number | null; observed: number | null; difference: number | null }
}
export interface DutyPredictionComparison {
  status: 'comparable' | 'mismatch' | 'invalid'
  diagnostics: string[]
  operators: DutyOperatorComparison[]
  /** Only operators with positive physical work in either calendar enter the mean. */
  activeWorkerErrors: { count: number; meanAbsoluteWorkHours: number | null; maxAbsoluteWorkHours: number | null;
    maxAbsoluteRestHours: number | null; maxAbsoluteIdleHours: number | null; maxWorkFractionPercentagePoints: number | null }
  resources: Partial<Record<DutyResourceKey, DutyPredictionError>>
  score: DutyPredictionError | null
  nativeQuality: MainRosterDutyQuality | null
  nativeScheduleParity: MainRosterDutyProjection['nativeScheduleParity']
  /** Room/individual marginals cannot establish simultaneous cross-room staffing. */
  crossRoomJointParity: 'not-observed'
}
const EPS = 1e-5
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const close = (left: number, right: number) => Math.abs(left - right) <= EPS
const error = (predicted: number, observed: number): DutyPredictionError => ({ predicted, observed,
  difference: predicted - observed, absolute: Math.abs(predicted - observed), relative: observed === 0 ? null : (predicted - observed) / observed })
// Object key order is incidental; array order, including replacement/Fia policy order, is evidence.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}

/** Pure paired-report diagnostics. Never runs a calendar, fits a coefficient or accepts a roster. */
export function compareMainRosterDutyPrediction(
  job: CandidateSimulationJob, calendar: ScheduleSimulationReport, native: ScheduleSimulationReport,
  projection: MainRosterDutyProjection,
): DutyPredictionComparison {
  const result: DutyPredictionComparison = { status: 'invalid', diagnostics: [], operators: [], resources: {}, score: null,
    nativeQuality: null, nativeScheduleParity: projection.nativeScheduleParity, crossRoomJointParity: 'not-observed',
    activeWorkerErrors: { count: 0, meanAbsoluteWorkHours: null, maxAbsoluteWorkHours: null,
      maxAbsoluteRestHours: null, maxAbsoluteIdleHours: null, maxWorkFractionPercentagePoints: null } }
  const fail = (status: 'mismatch' | 'invalid', message: string) => {
    result.status = status; result.diagnostics.push(message); return result
  }
  if (projection.status !== 'estimated' || !projection.predictionEligible || !projection.amounts || !projection.score
    || calendar.production || !native.production?.success || !native.production.sample.completed
    || !calendar.success || !native.success) return fail('invalid', 'DUTY_COMPARISON_REQUIRES_PREDICTION_AND_COMPLETE_NATIVE')
  const source = job.options ?? {}, sample = source.sampleHours ?? 336, warmup = source.warmupHours ?? 0
  const step = source.maxStepHours ?? .25, capacity = source.efficiencyResources?.droneCapacity ?? resolveDroneCapacity(job.workspace)
  const expectedSchedule = compileRosterSchedule(job.workspace, job.assumptions)
  expectedSchedule.sourceWorkspace.droneCapacity = capacity
  expectedSchedule.assumptions.droneRoom = null
  expectedSchedule.assumptions.runOrderSimulationMode = 'ideal'
  expectedSchedule.assumptions.idealRunOrderWakeOnly = !source.experimentalDisableIdealWake
  if (canonical(calendar.inputs.schedule) !== canonical(native.inputs.schedule)
    || canonical(calendar.inputs.schedule) !== canonical(expectedSchedule)) return fail('mismatch', 'DUTY_COMPARISON_SCHEDULE_MISMATCH')
  const normalizeOptions = (options: NonNullable<CandidateSimulationJob['options']>) => {
    const copy = structuredClone(options)
    delete copy.production; delete copy.recordSegments
    copy.schedulingModel ??= 'mower-alpha'
    copy.efficiencyResources = { ...copy.efficiencyResources, droneCapacity: capacity }
    return copy
  }
  if (canonical(normalizeOptions(calendar.inputs.options)) !== canonical(normalizeOptions(native.inputs.options))
    || canonical(normalizeOptions(calendar.inputs.options)) !== canonical(normalizeOptions(source))
    || canonical(native.inputs.options.production) !== canonical(source.production)) return fail('mismatch', 'DUTY_COMPARISON_OPTIONS_OR_SEED_MISMATCH')
  for (const report of [calendar, native]) {
    if (!finite(sample) || sample === 0 || !finite(warmup) || !finite(report.observedHours) || !close(report.observedHours, sample)
      || !finite(report.elapsedHours) || !close(report.elapsedHours, sample + warmup)
      || report.assumptions.sampleHours !== sample || report.assumptions.warmupHours !== warmup
      || report.assumptions.maxStepHours !== step) return fail('mismatch', 'DUTY_COMPARISON_WINDOW_MISMATCH')
  }
  if (!close(projection.coverageHours, sample)) return fail('invalid', 'DUTY_COMPARISON_PREDICTION_COVERAGE')
  const indexed = [calendar, native].map(report => new Map(report.operators.map(operator => [operator.operatorId, operator])))
  if (indexed.some((map, index) => map.size !== [calendar, native][index]!.operators.length)
    || indexed[0]!.size !== indexed[1]!.size || [...indexed[0]!.keys()].some(id => !indexed[1]!.has(id))) {
    return fail('invalid', 'DUTY_COMPARISON_OPERATOR_SET_MISMATCH')
  }
  const rows: DutyOperatorComparison[] = []
  for (const [operatorId, predicted] of indexed[0]!) {
    const observed = indexed[1]!.get(operatorId)!
    for (const operator of [predicted, observed]) {
      if (!timeKeys.every(key => finite(operator[key]))
        || !close(operator.workHours + operator.exhaustedHours + operator.restHours + operator.idleHours, sample)
        || !close(operator.mainWorkHours + operator.substituteWorkHours, operator.workHours)) {
        return fail('invalid', `DUTY_COMPARISON_OPERATOR_TIME_INVALID:${operatorId}`)
      }
    }
    const pRatio = predicted.restHours > EPS ? predicted.workHours / predicted.restHours : null
    const oRatio = observed.restHours > EPS ? observed.workHours / observed.restHours : null
    rows.push({ operatorId, activeWorker: predicted.workHours + predicted.exhaustedHours > EPS || observed.workHours + observed.exhaustedHours > EPS,
      hours: Object.fromEntries(timeKeys.map(key => [key, error(predicted[key], observed[key])])) as Record<TimeKey, DutyPredictionError>,
      workFractionPercentagePoints: 100 * (predicted.workHours - observed.workHours) / sample,
      workRestRatio: { predicted: pRatio, observed: oRatio, difference: pRatio === null || oRatio === null ? null : pRatio - oRatio } })
  }
  const resources: DutyPredictionComparison['resources'] = {}
  // The public output contract includes completion-event premiums and recipe
  // counts that are deliberately absent from the small sample.completed object.
  const completed = simulationOutputAmounts(native)
  for (const key of DUTY_RESOURCE_KEYS) {
    const predicted = projection.amounts[key], observed = completed[key]
    if (finite(predicted) && finite(observed)) resources[key] = error(predicted, observed)
    else result.diagnostics.push(`DUTY_COMPARISON_RESOURCE_UNKNOWN:${key}`)
  }
  try {
    const nativeScore = scoreSimulationProduction(native)
    result.score = error(projection.score.total, nativeScore.total)
  } catch { return fail('invalid', 'DUTY_COMPARISON_SCORE_INVALID') }
  const quality = evaluateMainRosterDuty(native, job.workspace, { sampleHours: sample, warmupHours: warmup })
  result.nativeQuality = { eligible: quality.eligible, strict: quality.strict, ordinaryExhaustedHours: quality.ordinaryExhaustedHours,
    pendingDeferrals: quality.pendingDeferrals, issues: quality.issues }
  const active = rows.filter(row => row.activeWorker)
  if (active.length) result.activeWorkerErrors = { count: active.length,
    meanAbsoluteWorkHours: active.reduce((sum, row) => sum + row.hours.workHours.absolute, 0) / active.length,
    maxAbsoluteWorkHours: Math.max(...active.map(row => row.hours.workHours.absolute)),
    maxAbsoluteRestHours: Math.max(...active.map(row => row.hours.restHours.absolute)),
    maxAbsoluteIdleHours: Math.max(...active.map(row => row.hours.idleHours.absolute)),
    maxWorkFractionPercentagePoints: Math.max(...active.map(row => Math.abs(row.workFractionPercentagePoints))) }
  result.operators = rows; result.resources = resources; result.status = 'comparable'
  return result
}
