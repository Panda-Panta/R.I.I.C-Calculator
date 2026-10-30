import { describe, expect, it } from 'vitest'
import { integrateMainRosterDutyOutput } from './mainRosterDutyIntegration'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import { DUTY_RESOURCE_KEYS, type DutyResourceRates, type MainRosterDutyOperatorTimes, type MainRosterDutyPhase, type MainRosterDutyTrajectory } from './mainRosterDutyTypes'

function phase(start: number, end: number, jointStateKey: string, rates: Partial<DutyResourceRates>): MainRosterDutyPhase {
  return { start, end, jointStateKey, output: {
    status: 'quantified', rates: { exp: 0, gold: 0, orderLmd: 0, virtualGold: 0, fragments: 0, orundum: 0, ...rates },
    diagnostics: [], assumptions: ['synthetic whole-base mean resource rate'],
  } }
}

function trajectory(phases: MainRosterDutyPhase[], sampleHours = 8): MainRosterDutyTrajectory {
  return {
    status: 'complete', window: { warmupHours: 0, sampleHours, maxStepHours: .25 }, phases, operators: [],
    sourceKind: 'synthetic-oracle', nativeScheduleParity: 'not-established', diagnostics: [],
    assumptions: ['synthetic integration oracle; not a native or game trajectory'],
    cost: { scheduleOnlyCalls: 0, elapsedMs: 0, cpuMs: null, phaseEvaluations: phases.length },
  }
}

function operator(overrides: Partial<MainRosterDutyOperatorTimes> = {}): MainRosterDutyOperatorTimes {
  return { operatorId: 'synthetic-operator', mainWorkHours: 1, substituteWorkHours: 1, workHours: 2,
    exhaustedHours: 1, restHours: 2, idleHours: 3, ...overrides }
}

describe('integrateMainRosterDutyOutput', () => {
  it('integrates the actual main and substitute whole-base rates before shared daily scoring', () => {
    const input = trajectory([phase(0, 6, 'main', { exp: 20 }), phase(6, 8, 'substitute', { exp: 10 })])
    input.operators = [
      { operatorId: 'main', mainWorkHours: 6, substituteWorkHours: 0, workHours: 6, exhaustedHours: 0, restHours: 2, idleHours: 0 },
      { operatorId: 'backup', mainWorkHours: 0, substituteWorkHours: 2, workHours: 2, exhaustedHours: 0, restHours: 6, idleHours: 0 },
    ]
    const before = structuredClone(input)
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.amounts).toEqual({ exp: 140, gold: 0, orderLmd: 0, virtualGold: 0, fragments: 0, orundum: 0 })
    expect(result.amounts!.exp / result.coverageHours).toBe(17.5)
    expect(result.score?.total).toBe(420)
    expect(result.coverageHours).toBe(8)
    expect(result.jointStateHours).toEqual({ main: 6, substitute: 2 })
    expect(result.operatorDuty[0]).toMatchObject({ workRestRatio: 3, workFraction: .75, physicalWorkFraction: .75 })
    expect(result.operatorDuty[1]).toMatchObject({ workFraction: .25, physicalWorkHours: 2 })
    expect(result.predictionEligible).toBe(false)
    expect(input).toEqual(before)
  })

  it('clips warmup and tail phases and ignores unknown rates wholly outside the sample', () => {
    const input = trajectory([phase(0, 1, 'unknown-warmup', { exp: null }), phase(1, 4, 'first', { exp: 10 }), phase(4, 7, 'second', { exp: 20 })], 4)
    input.window.warmupHours = 2
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(60)
    expect(result.coverageHours).toBe(4)
    expect(result.jointStateHours).toEqual({ first: 2, second: 2 })
  })

  it('can sort rate-bearing phases without changing their source order or claiming to reconstruct causality', () => {
    const input = trajectory([phase(4, 8, 'later', { exp: 20 }), phase(0, 4, 'earlier', { exp: 10 })])
    const before = structuredClone(input)
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(120)
    expect(input).toEqual(before)
  })

  it.each([
    ['gap', [phase(0, 3, 'a', { exp: 10 }), phase(4, 8, 'b', { exp: 10 })], 7],
    ['missing beginning', [phase(1, 8, 'a', { exp: 10 })], 7],
    ['missing end', [phase(0, 7, 'a', { exp: 10 })], 7],
    ['empty', [], 0],
  ] as const)('keeps %s coverage incomplete instead of filling missing hours with zero production', (_name, phases, hours) => {
    const result = integrateMainRosterDutyOutput(trajectory([...phases]))
    expect(result.status).toBe('incomplete')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
    expect(result.coverageHours).toBe(hours)
    expect(result.predictionEligible).toBe(false)
  })

  it.each([
    ['overlap', [phase(0, 5, 'a', { exp: 10 }), phase(4, 8, 'b', { exp: 10 })]],
    ['backwards', [phase(0, 8, 'a', { exp: 10 }), phase(10, 9, 'bad-tail', {})]],
    ['zero length', [phase(0, 8, 'a', { exp: 10 }), phase(9, 9, 'bad-tail', {})]],
    ['negative start', [phase(-1, 8, 'a', { exp: 10 })]],
    ['nonfinite end', [phase(0, Infinity, 'a', { exp: 10 })]],
  ] as const)('rejects %s intervals even when an invalid interval is outside the sample', (_name, phases) => {
    const result = integrateMainRosterDutyOutput(trajectory([...phases]))
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it.each([
    { warmupHours: -1, sampleHours: 8, maxStepHours: .25 },
    { warmupHours: 0, sampleHours: 0, maxStepHours: .25 },
    { warmupHours: 0, sampleHours: NaN, maxStepHours: .25 },
    { warmupHours: 0, sampleHours: 8, maxStepHours: 0 },
    { warmupHours: Number.MAX_VALUE, sampleHours: Number.MAX_VALUE, maxStepHours: .25 },
    { warmupHours: Number.MAX_VALUE, sampleHours: 1, maxStepHours: .25 },
  ])('rejects invalid or unrepresentable sampling windows %#', window => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.window = window
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.score).toBeNull()
  })

  it('rejects a rounded sample endpoint that materially changes the requested duration', () => {
    const input = trajectory([phase(1e16, 1e16 + 4, 'rounded-window', { exp: 1 })], 3)
    input.window.warmupHours = 1e16
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it.each(['incomplete', 'unsupported'] as const)('does not upgrade a %s trajectory from apparently complete phase coverage', status => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.status = status
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe(status === 'incomplete' ? 'incomplete' : 'unquantified')
    expect(result.score).toBeNull()
    expect(result.amounts).toBeNull()
  })

  it('distinguishes synchronized and staggered joint-state rates with identical marginal work fractions', () => {
    const synchronized = trajectory([phase(0, 2, '11', { exp: 140 }), phase(2, 4, '00', { exp: 100 })], 4)
    const staggered = trajectory([phase(0, 2, '10', { exp: 110 }), phase(2, 4, '01', { exp: 100 })], 4)
    synchronized.operators = staggered.operators = ['a', 'b'].map(operatorId => ({
      operatorId, mainWorkHours: 2, substituteWorkHours: 0, workHours: 2, exhaustedHours: 0, restHours: 2, idleHours: 0,
    }))
    const aligned = integrateMainRosterDutyOutput(synchronized), offset = integrateMainRosterDutyOutput(staggered)
    expect(aligned.operatorDuty.map(operator => operator.workFraction)).toEqual([.5, .5])
    expect(offset.operatorDuty.map(operator => operator.workFraction)).toEqual([.5, .5])
    expect(aligned.amounts?.exp).toBe(480)
    expect(offset.amounts?.exp).toBe(420)
  })

  it('keeps supplied interval-average warmup and reset effects instead of multiplying static maximum G by duty fraction', () => {
    const reset = trajectory([phase(0, 4, 'session-1', { exp: 4 }), phase(4, 8, 'session-2', { exp: 4 })])
    const continuous = trajectory([phase(0, 8, 'continuous', { exp: 8 })])
    expect(integrateMainRosterDutyOutput(reset).amounts?.exp).toBe(32)
    expect(integrateMainRosterDutyOutput(continuous).amounts?.exp).toBe(64)
  })

  it('preserves raw units for all six resources and delegates weighting to the shared scorer', () => {
    const input = trajectory([phase(0, 2, 'all-resources', { exp: 3, gold: 2, orderLmd: 5, virtualGold: 1, fragments: 7, orundum: 11 })], 2)
    const result = integrateMainRosterDutyOutput(input, { exp: 2, gold: .1, orders: .5, fragments: 3, orundum: 4 })
    expect(result.amounts).toEqual({ exp: 6, gold: 4, orderLmd: 10, virtualGold: 2, fragments: 14, orundum: 22 })
    expect(result.score).toMatchObject({ weightedExp: 144, weightedGold: 3600, weightedOrders: 60, weightedFragments: 504, weightedOrundum: 1056, total: 5364 })
  })

  it('accepts an explicitly quantified zero rather than treating it as unknown', () => {
    const result = integrateMainRosterDutyOutput(trajectory([phase(0, 8, 'zero', {})]))
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(0)
    expect(result.score?.total).toBe(0)
  })

  it.each(DUTY_RESOURCE_KEYS)('keeps unknown %s null even if its score weight is zero', key => {
    const unknown = phase(0, 8, 'unknown', {})
    unknown.output.rates[key] = null
    const result = integrateMainRosterDutyOutput(trajectory([unknown]), { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 })
    expect(result.status).toBe('unquantified')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
    expect(result.coverageHours).toBe(8)
  })

  it('does not turn a missing optional-score resource into a known zero', () => {
    const missing = phase(0, 8, 'missing', {})
    Reflect.deleteProperty(missing.output.rates, 'virtualGold')
    const result = integrateMainRosterDutyOutput(trajectory([missing]))
    expect(result.status).toBe('unquantified')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it('honors explicit unquantified phase status and carries sample diagnostics and assumptions', () => {
    const unknown = phase(0, 8, 'unknown', {})
    unknown.output.status = 'unquantified'
    unknown.output.diagnostics = ['unquantified joint output']
    unknown.output.assumptions = ['infinite-material continuous potential']
    const result = integrateMainRosterDutyOutput(trajectory([unknown]))
    expect(result.status).toBe('unquantified')
    expect(result.score).toBeNull()
    expect(result.diagnostics).toContain('unquantified joint output')
    expect(result.assumptions).toContain('infinite-material continuous potential')
  })

  it.each(DUTY_RESOURCE_KEYS.flatMap(key => [-1, NaN, Infinity].map(value => ({ key, value }))))('rejects invalid resource rate $key=$value', ({ key, value }) => {
    const invalid = phase(0, 8, 'invalid-rate', {})
    invalid.output.rates[key] = value
    const result = integrateMainRosterDutyOutput(trajectory([invalid]))
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it.each([
    { phases: [phase(0, 8, 'product-overflow', { exp: Number.MAX_VALUE })] },
    { phases: [phase(0, 4, 'sum-a', { exp: Number.MAX_VALUE / 5 }), phase(4, 8, 'sum-b', { exp: Number.MAX_VALUE / 5 })] },
    { phases: [phase(0, 8, 'daily-score-overflow', { exp: 1e307 })] },
  ])('rejects nonfinite rate-duration, accumulated amount or shared score without throwing %#', ({ phases }) => {
    const result = integrateMainRosterDutyOutput(trajectory(phases))
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it.each([{ exp: -1 }, { orders: NaN }, { gold: Infinity }])('keeps invalid shared weights from producing a score %#', weights => {
    const result = integrateMainRosterDutyOutput(trajectory([phase(0, 8, 'a', { exp: 10 })]), weights)
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it('uses compensated accumulation for small contributions alongside a large finite amount', () => {
    const result = integrateMainRosterDutyOutput(trajectory([
      phase(0, 1, 'large', { exp: 1e16 }), phase(1, 2, 'small-1', { exp: 1 }), phase(2, 3, 'small-2', { exp: 1 }),
    ], 3))
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(10000000000000002)
  })

  it('reports W/R, W/T and (W+E)/T separately when idle and exhausted time exist', () => {
    const input = trajectory([phase(0, 8, 'with-idle', { exp: 10 })])
    input.operators = [operator()]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.operatorDuty[0]).toMatchObject({ workHours: 2, exhaustedHours: 1, restHours: 2, idleHours: 3,
      workRestRatio: 1, workFraction: .25, physicalWorkHours: 3, physicalWorkFraction: .375, noRestObserved: false })
    expect(result.operatorDuty[0]!.workFraction).not.toBe(.5)
  })

  it('retains permanent zero-morale physical occupancy and its already supplied joint output', () => {
    const input = trajectory([phase(0, 8, 'physical-zero', { exp: 5 })])
    input.operators = [operator({ mainWorkHours: 0, substituteWorkHours: 0, workHours: 0, exhaustedHours: 8, restHours: 0, idleHours: 0 })]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(40)
    expect(result.operatorDuty[0]).toMatchObject({ workHours: 0, physicalWorkHours: 8, workRestRatio: null,
      workFraction: 0, physicalWorkFraction: 1, noRestObserved: true })
  })

  it('counts main and substitute time as partitions of one operator work time without adding another base rate', () => {
    const input = trajectory([phase(0, 6, 'main', { exp: 20 }), phase(6, 8, 'substitute', { exp: 10 })])
    input.operators = [operator({ mainWorkHours: 6, substituteWorkHours: 2, workHours: 8, exhaustedHours: 0, restHours: 0, idleHours: 0 })]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.amounts?.exp).toBe(140)
    expect(result.operatorDuty[0]).toMatchObject({ workFraction: 1, physicalWorkFraction: 1, workRestRatio: null, noRestObserved: true })
  })

  it.each((['mainWorkHours', 'substituteWorkHours', 'workHours', 'exhaustedHours', 'restHours', 'idleHours'] as const)
    .flatMap(key => [-1, NaN, Infinity].map(value => ({ key, value }))))('rejects invalid operator time $key=$value', ({ key, value }) => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    const invalid = operator()
    invalid[key] = value
    input.operators = [invalid]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.amounts).toBeNull()
    expect(result.score).toBeNull()
  })

  it.each([
    { idleHours: 2 }, { restHours: 3 }, { mainWorkHours: 2 }, { substituteWorkHours: 0 },
    { mainWorkHours: 24, substituteWorkHours: 0, workHours: 24, exhaustedHours: 0, restHours: 8, idleHours: 0 },
  ])('rejects nonconserved sample time or overlapping main/substitute work %#', overrides => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.operators = [operator(overrides)]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.score).toBeNull()
  })

  it.each([
    ['duplicate', 'duplicate'], ['杜林', resolveOperatorCharId('杜林')],
  ])('rejects duplicate physical operator summaries %s / %s', (first, second) => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.operators = [operator({ operatorId: first }), operator({ operatorId: second })]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.operatorDuty).toEqual([])
    expect(result.score).toBeNull()
  })

  it('rejects an absent operator identity without inventing one', () => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.operators = [operator({ operatorId: ' ' })]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.score).toBeNull()
  })

  it('rejects an unrepresentable positive work/rest ratio without presenting infinity in JSON', () => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.operators = [operator({ mainWorkHours: 8, substituteWorkHours: 0, workHours: 8, exhaustedHours: 0, restHours: Number.MIN_VALUE, idleHours: 0 })]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('invalid')
    expect(result.score).toBeNull()
  })

  it('allows bounded floating-point time-sum roundoff without rewriting input durations', () => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    const times = operator({ mainWorkHours: 4, substituteWorkHours: 0, workHours: 4, exhaustedHours: 0, restHours: 4 - 1e-14, idleHours: 0 })
    input.operators = [times]
    const result = integrateMainRosterDutyOutput(input)
    expect(result.status).toBe('estimated')
    expect(result.operatorDuty[0]!.restHours).toBe(times.restHours)
  })

  it.each([
    { sourceKind: 'predicted-schedule', eligible: true }, { sourceKind: 'observed-replay', eligible: false },
    { sourceKind: 'synthetic-oracle', eligible: false },
  ] as const)('preserves provenance for $sourceKind instead of relabeling observed data as prediction', ({ sourceKind, eligible }) => {
    const input = trajectory([phase(0, 8, 'a', { exp: 10 })])
    input.sourceKind = sourceKind
    input.nativeScheduleParity = 'subset-validated'
    const result = integrateMainRosterDutyOutput(input)
    expect(result.predictionEligible).toBe(eligible)
    expect(result.nativeScheduleParity).toBe('subset-validated')
  })
})
