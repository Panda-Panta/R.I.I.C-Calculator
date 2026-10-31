import { describe, expect, it } from 'vitest'
import { resolveDroneCapacity } from '../domain/droneCapacity'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createDroneState } from '../simulator/droneTimeline'
import { createLedger } from '../simulator/resourceLedger'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'
import type { CandidateSimulationJob } from './candidateSimulation'
import { compareMainRosterDutyPrediction, type DutyOperatorComparison, type DutyPredictionComparison, type DutyPredictionError } from './mainRosterDutyCalibration'
import { evaluateMainRosterDutyAccuracy } from './mainRosterDutyAcceptance'
import { integrateMainRosterDutyOutput } from './mainRosterDutyIntegration'

function error(difference = 0, observed = 24): DutyPredictionError {
  const predicted = observed + difference, actualDifference = predicted - observed
  return { predicted, observed, difference: actualDifference, absolute: Math.abs(actualDifference),
    relative: observed === 0 ? null : actualDifference / observed }
}

function worker(operatorId: string, work = 0, rest = 0, idle = 0, activeWorker = true): DutyOperatorComparison {
  const working = activeWorker ? 24 : 0
  return { operatorId, activeWorker,
    hours: { mainWorkHours: error(work, working), substituteWorkHours: error(0, 0),
      workHours: error(work, working), exhaustedHours: error(0, 0), restHours: error(rest),
      idleHours: error(idle, activeWorker ? 24 : 48) },
    workFractionPercentagePoints: 100 * work / 72,
    workRestRatio: { predicted: (working + work) / (24 + rest), observed: working / 24,
      difference: (working + work) / (24 + rest) - working / 24 } }
}

function fixture(overrides: Partial<DutyPredictionComparison> = {}): DutyPredictionComparison {
  return { status: 'comparable', diagnostics: [], operators: [worker('working'), worker('idle', 0, 0, 0, false)],
    activeWorkerErrors: { count: 1, meanAbsoluteWorkHours: 0, maxAbsoluteWorkHours: 0,
      maxAbsoluteRestHours: 0, maxAbsoluteIdleHours: 0, maxWorkFractionPercentagePoints: 0 },
    resources: {}, score: error(0, 100_000),
    nativeQuality: { eligible: true, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] },
    nativeScheduleParity: 'not-established', crossRoomJointParity: 'not-observed', ...overrides }
}

const metricKeys = ['meanAbsoluteWorkHours', 'maxAbsoluteWorkHours', 'maxAbsoluteRestHours', 'maxAbsoluteIdleHours'] as const
const defaults = { meanAbsoluteWorkHours: .1, maxAbsoluteWorkHours: .5, maxAbsoluteRestHours: .5, maxAbsoluteIdleHours: .5 }
const workDefaults = { maxAbsoluteExhaustedHours: .5, maxAbsolutePhysicalWorkHours: .5,
  maxAbsoluteMainWorkHours: .5, maxAbsoluteSubstituteWorkHours: .5 }
const workMetricKeys = ['maxAbsoluteExhaustedHours', 'maxAbsolutePhysicalWorkHours', 'maxAbsoluteMainWorkHours', 'maxAbsoluteSubstituteWorkHours'] as const

type DutyState = { main: number; substitute: number; exhausted: number; rest: number; idle: number }
const exactState: DutyState = { main: 24, substitute: 0, exhausted: 0, rest: 24, idle: 24 }

/** Complete paired report fixtures through the real comparator; no calendar runs. */
function pairedComparison(pairs: Array<{ predicted: DutyState; observed: DutyState }> = [{ predicted: exactState, observed: exactState }]) {
  const workspace = createDefaultWorkspace()
  const ids = ['char_002_amiya', 'char_123_fang', 'char_212_ansel', 'char_236_rope', 'char_237_gravel']
  const workSlots = Object.values(workspace.mainPlan.facilities).filter(room => room.type !== 'dormitory').flatMap(room => room.slots)
  const restSlots = Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory').flatMap(room => room.slots)
  pairs.forEach((pair, index) => {
    const physical = pair.predicted.main + pair.predicted.substitute + pair.predicted.exhausted
      + pair.observed.main + pair.observed.substitute + pair.observed.exhausted
    const slot = physical > 0 ? workSlots.shift()! : restSlots.shift()!
    slot.occupant = { kind: 'operator', operatorId: ids[index]! }
  })
  const job: CandidateSimulationJob = { workspace, assumptions: { idleOperators: [] }, options: {
    schedulingModel: 'mower-alpha', sampleHours: 72, warmupHours: 24, maxStepHours: .25,
    production: { outputMode: 'potential', droneTarget: 'none', seed: 42 },
  } }
  const operator = (state: DutyState, index: number): ScheduleSimulationReport['operators'][number] => ({
    operatorId: ids[index]!, operatorName: ids[index]!, mainWorkHours: state.main, substituteWorkHours: state.substitute,
    workHours: state.main + state.substitute, exhaustedHours: state.exhausted, restHours: state.rest, idleHours: state.idle,
    workFraction: (state.main + state.substitute) / 72, workRestRatio: state.rest ? (state.main + state.substitute) / state.rest : null,
    initialMorale: 24, finalMorale: 24,
  })
  const calendar: ScheduleSimulationReport = { schemaVersion: 1, engine: 'mower-morale-v1', success: true,
    observedHours: 72, elapsedHours: 96,
    inputs: { schedule: compileRosterSchedule(workspace, job.assumptions), options: { ...job.options, recordSegments: true } },
    assumptions: { schedulingModel: 'mower-alpha', warmupHours: 24, sampleHours: 72, maxStepHours: .25,
      warmupModel: 'continuous', restingThreshold: .65, operationDurationHours: 0, dormAtmosphere: 'fixture', singleRecoveryTarget: 'fixture' },
    operators: pairs.map((pair, index) => operator(pair.predicted, index)), rooms: [], events: [], segments: [], diagnostics: [], shiftDeferrals: [] }
  calendar.inputs.schedule.sourceWorkspace.droneCapacity = resolveDroneCapacity(workspace)
  Object.assign(calendar.inputs.schedule.assumptions, { droneRoom: null, runOrderSimulationMode: 'ideal', idealRunOrderWakeOnly: true })
  delete calendar.inputs.options.production
  const native = structuredClone(calendar)
  native.inputs.options = { ...structuredClone(job.options), recordSegments: false }
  native.operators = pairs.map((pair, index) => operator(pair.observed, index))
  native.production = { success: true, ledger: createLedger({}), sample: { completed: { exp: 0, gold: 0, orderLmd: 0 },
    opening: {}, closing: {}, inflows: {}, outflows: {}, net: {} }, materialsConsumed: {}, drones: createDroneState(0, 200),
    manufacturing: [], trading: [], events: [], assumptions: { outputMode: 'potential', inventoryMode: 'unlimited', seed: 42,
      runOrderMode: 'ideal', droneTarget: 'none', droneReserve: 0, collectionIntervalHours: 0, orderSnapshotPolicy: 'fixture' } }
  const projection = integrateMainRosterDutyOutput({ status: 'complete', window: { warmupHours: 24, sampleHours: 72, maxStepHours: .25 },
    sourceKind: 'predicted-schedule', nativeScheduleParity: 'not-established', operators: calendar.operators,
    phases: [{ start: 24, end: 96, jointStateKey: 'fixture', output: { status: 'quantified',
      rates: { exp: 0, gold: 0, orderLmd: 0, virtualGold: 0, fragments: 0, orundum: 0 }, diagnostics: [], assumptions: [] } }],
    diagnostics: [], assumptions: [], cost: { scheduleOnlyCalls: 0, elapsedMs: 0, cpuMs: null, phaseEvaluations: 1 } })
  return compareMainRosterDutyPrediction(job, calendar, native, projection)
}

describe('theoretical duty accuracy acceptance', () => {
  it('rejects a large individual error even when score error and active-worker mean are small', () => {
    const f = fixture({ operators: [worker('outlier', .6, -.6), ...Array.from({ length: 9 }, (_, index) => worker(`exact-${index}`))],
      activeWorkerErrors: { count: 10, meanAbsoluteWorkHours: .06, maxAbsoluteWorkHours: .6,
        maxAbsoluteRestHours: .6, maxAbsoluteIdleHours: 0, maxWorkFractionPercentagePoints: 100 * .6 / 72 } })
    const result = evaluateMainRosterDutyAccuracy(f)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('maxAbsoluteWorkHours'))).toBe(true)
  })

  it('does not dilute active-worker mean error with purely idle operators', () => {
    const f = fixture({ operators: [worker('working', .2, -.2),
      ...Array.from({ length: 99 }, (_, index) => worker(`idle-${index}`, 0, 0, 0, false))],
      activeWorkerErrors: { count: 1, meanAbsoluteWorkHours: .2, maxAbsoluteWorkHours: .2,
        maxAbsoluteRestHours: .2, maxAbsoluteIdleHours: 0, maxWorkFractionPercentagePoints: 100 * .2 / 72 } })
    const result = evaluateMainRosterDutyAccuracy(f)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('meanAbsoluteWorkHours'))).toBe(true)
  })

  it('does not accept a diluted summary that disagrees with the active worker rows', () => {
    const f = fixture({ operators: [worker('working', .2, -.2), worker('idle', 0, 0, 0, false)],
      activeWorkerErrors: { count: 1, meanAbsoluteWorkHours: .1, maxAbsoluteWorkHours: .2,
        maxAbsoluteRestHours: .2, maxAbsoluteIdleHours: 0, maxWorkFractionPercentagePoints: 100 * .2 / 72 } })
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it('accepts all four inclusive default boundaries', () => {
    const f = fixture({ operators: [worker('work-boundary', .5, -.5), worker('rest-idle-boundary', 0, .5, -.5),
      worker('exact-1'), worker('exact-2'), worker('exact-3')],
      activeWorkerErrors: { count: 5, meanAbsoluteWorkHours: .1, maxAbsoluteWorkHours: .5,
        maxAbsoluteRestHours: .5, maxAbsoluteIdleHours: .5, maxWorkFractionPercentagePoints: 100 * .5 / 72 } })
    const result = evaluateMainRosterDutyAccuracy(f)
    expect(result.status).toBe('accepted')
    expect(result.thresholds).toEqual({ ...defaults, ...workDefaults })
    expect(result.issues).toEqual([])
  })

  it('allows subtraction roundoff at an explicit boundary without extending the hour limits', () => {
    const f = fixture({ operators: [worker('working', .3, -.3)],
      activeWorkerErrors: { count: 1, meanAbsoluteWorkHours: .3, maxAbsoluteWorkHours: .3,
        maxAbsoluteRestHours: .3, maxAbsoluteIdleHours: 0, maxWorkFractionPercentagePoints: 100 * .3 / 72 } })
    const thresholds = { ...defaults, meanAbsoluteWorkHours: .3, maxAbsoluteWorkHours: .3, maxAbsoluteRestHours: .3 }
    expect(evaluateMainRosterDutyAccuracy(f, thresholds).status).toBe('accepted')
    thresholds.meanAbsoluteWorkHours = .3 - 1e-9
    expect(evaluateMainRosterDutyAccuracy(f, thresholds).status).toBe('rejected')
  })

  it.each(['maxAbsoluteRestHours', 'maxAbsoluteIdleHours'] as const)('checks %s independently of exact work hours', metric => {
    const f = fixture({ operators: [worker('working', 0, .6, -.6)],
      activeWorkerErrors: { count: 1, meanAbsoluteWorkHours: 0, maxAbsoluteWorkHours: 0,
        maxAbsoluteRestHours: .6, maxAbsoluteIdleHours: .6, maxWorkFractionPercentagePoints: 0 } })
    const result = evaluateMainRosterDutyAccuracy(f)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes(metric))).toBe(true)
  })

  it('reports numeric accuracy separately from Native eligibility and production-score error', () => {
    const f = fixture({ nativeQuality: { eligible: false, strict: false, ordinaryExhaustedHours: 2,
      pendingDeferrals: 1, issues: ['NATIVE_INELIGIBLE'] }, score: error(20_000, 100_000) })
    const before = structuredClone(f), thresholds = { ...defaults }, previousThresholds = structuredClone(thresholds)
    const result = evaluateMainRosterDutyAccuracy(f, thresholds)
    expect(result.status).toBe('accepted')
    expect(result.issues).toEqual([])
    expect(f).toEqual(before)
    expect(thresholds).toEqual(previousThresholds)
    expect(result.thresholds).not.toBe(thresholds)
    expect(f.nativeQuality?.eligible).toBe(false)
    expect(f.nativeScheduleParity).toBe('not-established')
  })

  it.each(['mismatch', 'invalid'] as const)('does not accept comparison status %s with zero error metrics', status => {
    expect(evaluateMainRosterDutyAccuracy(fixture({ status })).status).toBe('unavailable')
  })

  it('does not turn a missing comparison into zero error', () => {
    expect(evaluateMainRosterDutyAccuracy(JSON.parse('null')).status).toBe('unavailable')
  })

  it('does not accept a calendar with no active workers', () => {
    const f = fixture({ operators: [worker('idle', 0, 0, 0, false)], activeWorkerErrors: {
      count: 0, meanAbsoluteWorkHours: null, maxAbsoluteWorkHours: null,
      maxAbsoluteRestHours: null, maxAbsoluteIdleHours: null, maxWorkFractionPercentagePoints: null } })
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it.each([null, undefined, NaN, Infinity, -Infinity, -1])('does not replace unknown or invalid metrics (%s) with zero', value => {
    for (const metric of metricKeys) {
      const f = fixture()
      Object.assign(f.activeWorkerErrors, { [metric]: value })
      expect(evaluateMainRosterDutyAccuracy(f).status, metric).toBe('unavailable')
    }
  })

  it.each([null, undefined, 0, -1, .5, NaN, Infinity])('requires a positive integer active-worker count (%s)', count => {
    const f = fixture()
    Object.assign(f.activeWorkerErrors, { count })
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it('requires the active-worker count to match the measured rows', () => {
    const f = fixture()
    f.activeWorkerErrors.count = 2
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it.each([null, undefined, NaN, Infinity, -Infinity, -1])('does not accept invalid thresholds (%s)', value => {
    for (const metric of metricKeys) {
      const thresholds = Object.assign({ ...defaults }, { [metric]: value })
      expect(evaluateMainRosterDutyAccuracy(fixture(), thresholds).status, metric).toBe('unavailable')
    }
  })

  it('does not fill a partial explicit threshold object with defaults', () => {
    expect(evaluateMainRosterDutyAccuracy(fixture(), JSON.parse('{"meanAbsoluteWorkHours":0.1}')).status).toBe('unavailable')
  })

  it('accepts exact duty under explicit zero thresholds', () => {
    expect(evaluateMainRosterDutyAccuracy(fixture(), {
      meanAbsoluteWorkHours: 0, maxAbsoluteWorkHours: 0, maxAbsoluteRestHours: 0, maxAbsoluteIdleHours: 0,
    }).status).toBe('accepted')
  })

  it.each(['mainWorkHours', 'substituteWorkHours', 'workHours', 'exhaustedHours', 'restHours', 'idleHours'] as const)(
    'does not accept nonfinite or incomplete individual %s evidence behind a zero summary', key => {
      const f = fixture()
      f.operators[0]!.hours[key].predicted = NaN
      expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
      Object.assign(f.operators[0]!.hours, { [key]: null })
      expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
    },
  )

  it('does not accept inconsistent individual absolute errors', () => {
    const f = fixture()
    // Keep the signed error internally correct while a fabricated absolute zero
    // would agree with the otherwise exact aggregate and incorrectly pass.
    Object.assign(f.operators[0]!.hours.workHours, { predicted: 25, difference: 1, relative: 1 / 24 })
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it('does not permit duplicate operator rows to dilute the active mean', () => {
    const f = fixture()
    f.operators.push(structuredClone(f.operators[0]!))
    f.activeWorkerErrors.count = 2
    expect(evaluateMainRosterDutyAccuracy(f).status).toBe('unavailable')
  })

  it('rejects comparator-produced fatigue error split into acceptable rest and idle errors', () => {
    const comparison = pairedComparison([{ observed: exactState,
      predicted: { main: 24, substitute: 0, exhausted: .6, rest: 23.7, idle: 23.7 } }])
    expect(comparison.status).toBe('comparable')
    expect(comparison.activeWorkerErrors.meanAbsoluteWorkHours).toBe(0)
    expect(comparison.activeWorkerErrors.maxAbsoluteRestHours).toBeCloseTo(.3)
    expect(comparison.activeWorkerErrors.maxAbsoluteIdleHours).toBeCloseTo(.3)
    const result = evaluateMainRosterDutyAccuracy(comparison)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('maxAbsoluteExhaustedHours'))).toBe(true)
  })

  it('checks physical work independently when work and exhaustion each stay within their own bounds', () => {
    const comparison = pairedComparison([{ observed: exactState,
      predicted: { main: 24.5, substitute: 0, exhausted: .5, rest: 23.5, idle: 23.5 } },
    ...Array.from({ length: 4 }, () => ({ observed: exactState, predicted: exactState }))])
    expect(comparison.status).toBe('comparable')
    expect(comparison.activeWorkerErrors.meanAbsoluteWorkHours).toBe(.1)
    const result = evaluateMainRosterDutyAccuracy(comparison)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('maxAbsolutePhysicalWorkHours'))).toBe(true)
    expect(result.issues.some(issue => issue.includes('maxAbsoluteExhaustedHours'))).toBe(false)
  })

  it('does not cancel a large main/substitute role swap into zero total work error', () => {
    const comparison = pairedComparison([{ observed: exactState,
      predicted: { main: 0, substitute: 24, exhausted: 0, rest: 24, idle: 24 } }])
    expect(comparison.status).toBe('comparable')
    expect(comparison.activeWorkerErrors.maxAbsoluteWorkHours).toBe(0)
    const result = evaluateMainRosterDutyAccuracy(comparison)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('maxAbsoluteMainWorkHours'))).toBe(true)
    expect(result.issues.some(issue => issue.includes('maxAbsoluteSubstituteWorkHours'))).toBe(true)
  })

  it('checks rest and idle errors for a nonworking dorm operator omitted from the active summary', () => {
    const comparison = pairedComparison([{ observed: exactState, predicted: exactState },
      { observed: { main: 0, substitute: 0, exhausted: 0, rest: 72, idle: 0 },
        predicted: { main: 0, substitute: 0, exhausted: 0, rest: 0, idle: 72 } }])
    expect(comparison.status).toBe('comparable')
    expect(comparison.activeWorkerErrors.count).toBe(1)
    expect(comparison.activeWorkerErrors.maxAbsoluteRestHours).toBe(0)
    const result = evaluateMainRosterDutyAccuracy(comparison)
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes('maxAbsoluteRestHours'))).toBe(true)
    expect(result.issues.some(issue => issue.includes('maxAbsoluteIdleHours'))).toBe(true)
  })

  it('derives signed physical differences before taking absolute error', () => {
    const observed = { main: 24, substitute: 0, exhausted: 1, rest: 23, idle: 24 }
    const comparison = pairedComparison([{ observed,
      predicted: { main: 24.5, substitute: 0, exhausted: .5, rest: 23, idle: 24 } },
    ...Array.from({ length: 4 }, () => ({ observed: exactState, predicted: exactState }))])
    expect(comparison.status).toBe('comparable')
    const result = evaluateMainRosterDutyAccuracy(comparison, { ...defaults, maxAbsolutePhysicalWorkHours: 0 })
    expect(result.status).toBe('accepted')
  })

  it.each(workMetricKeys)('keeps legacy four-field callers compatible and makes %s inclusive and independently configurable', metric => {
    const pair = metric === 'maxAbsoluteMainWorkHours' || metric === 'maxAbsoluteSubstituteWorkHours'
      ? { observed: exactState, predicted: { main: 23.5, substitute: .5, exhausted: 0, rest: 24, idle: 24 } }
      : { observed: exactState, predicted: { main: 24, substitute: 0, exhausted: .5, rest: 23.5, idle: 24 } }
    const comparison = pairedComparison([pair])
    expect(comparison.status).toBe('comparable')
    expect(evaluateMainRosterDutyAccuracy(comparison, defaults).status).toBe('accepted')
    expect(evaluateMainRosterDutyAccuracy(comparison, { ...defaults, [metric]: .5 }).status).toBe('accepted')
    const result = evaluateMainRosterDutyAccuracy(comparison, { ...defaults, [metric]: .5 - 1e-9 })
    expect(result.status).toBe('rejected')
    expect(result.issues.some(issue => issue.includes(metric))).toBe(true)
  })

  it.each([null, undefined, NaN, Infinity, -Infinity, -1])('does not replace explicitly invalid added thresholds (%s) with defaults', value => {
    for (const metric of workMetricKeys) {
      expect(evaluateMainRosterDutyAccuracy(fixture(), Object.assign({ ...defaults }, { [metric]: value })).status, metric).toBe('unavailable')
    }
  })

  it('keeps corrupt time conservation unavailable, while the comparator already rejects such reports', () => {
    const invalid = pairedComparison([{ observed: exactState,
      predicted: { main: 24, substitute: 0, exhausted: 24, rest: 24, idle: 24 } }])
    expect(invalid.status).toBe('invalid')
    expect(evaluateMainRosterDutyAccuracy(invalid).status).toBe('unavailable')
    // Defense for a modified/deserialized comparison, not a producer-reachable report.
    const modified = fixture()
    modified.operators[0]!.hours.exhaustedHours = error(.1, 0)
    expect(evaluateMainRosterDutyAccuracy(modified).status).toBe('unavailable')
  })

  it('keeps inconsistent main plus substitute totals unavailable', () => {
    const modified = fixture()
    modified.operators[0]!.hours.mainWorkHours = error(.1)
    expect(evaluateMainRosterDutyAccuracy(modified).status).toBe('unavailable')
  })

  it('permits the comparator conservation tolerance without turning it into an error threshold allowance', () => {
    const comparison = pairedComparison([{ predicted: exactState,
      observed: { main: 24, substitute: 0, exhausted: 1e-6, rest: 24, idle: 24 } }])
    expect(comparison.status).toBe('comparable')
    expect(evaluateMainRosterDutyAccuracy(comparison).status).toBe('accepted')
  })
})
