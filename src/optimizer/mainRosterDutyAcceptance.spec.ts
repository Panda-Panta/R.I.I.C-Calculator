import { describe, expect, it } from 'vitest'
import type { DutyOperatorComparison, DutyPredictionComparison, DutyPredictionError } from './mainRosterDutyCalibration'
import { evaluateMainRosterDutyAccuracy } from './mainRosterDutyAcceptance'

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
    expect(result.thresholds).toEqual(defaults)
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
})
