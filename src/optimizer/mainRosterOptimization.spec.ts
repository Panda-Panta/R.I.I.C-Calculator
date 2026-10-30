import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../domain/productionWeights'
import type { RosterWorkspace } from '../domain/roster'
import type { CalculationReport } from '../domain/types'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createDefaultWorkspace } from '../workbench/defaults'
import type { CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'
import { CandidateSimulationCache } from './candidateSimulationCache'
import type { MainRosterDutyQuality } from './mainRosterDutyEvaluation'
import * as freeCandidates from './mainRosterFreeCandidates'
import { mainRosterOptimizationSteps } from './mainRosterOptimization'
import * as recoveryCandidates from './mainRosterRecoveryCandidates'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'
import type { SmartRosterResult } from './smartRoster'

type Input = Parameters<typeof mainRosterOptimizationSteps>[0]
type Proposal = { id: string; workspace: RosterWorkspace }
type ControlledResult = CandidateSimulationResult & { quality?: MainRosterDutyQuality }

const report = (score: number, marker = 'controlled F'): CalculationReport => ({
  power: { generation: 270, consumption: 10, margin: 260, sufficient: true },
  layoutValid: true, validationMessages: [], efficiencyNotes: [marker],
  manufacture: [], trading: [], drones: 0, morale: [], roomShiftDetails: {},
  summary: { exp: 0, goldCount: 0, goldValue: 0, virtualGoldCount: 0, virtualGoldValue: 0,
    orderLmd: 0, fragments: 0, orundum: 0, goldConsumed: 0, fragmentsConsumed: 0,
    netGoldCount: 0, netGoldValue: 0, totalScore82: score, totalEquivalentLmd: 0 },
})

// These deliberately controlled summaries test the orchestration boundary only.
// Native F evidence and the derivation of duty quality have their own tests.
const summary = (score: number, patch: Partial<ControlledResult> = {}): ControlledResult => ({
  completed: true, simScore: score, diagnostics: [], calculationReport: report(score),
  quality: { eligible: true, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] },
  ...patch,
})

function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const manufacture = workspace.mainPlan.facilities.room_1_1
  manufacture.level = 1; manufacture.product = 'gold'
  manufacture.slots = [{ occupant: { kind: 'operator', operatorId: id('芬') }, groupId: null, replacements: [id('砾')] }]
  const power = workspace.mainPlan.facilities.room_1_3
  power.level = 3
  power.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  const dorm = workspace.mainPlan.facilities.dormitory_1
  dorm.level = 1
  dorm.slots = [{ occupant: { kind: 'operator', operatorId: id('杜林') }, groupId: null, replacements: [] },
    ...Array.from({ length: 4 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))]
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  workspace.productionWeights = { ...DEFAULT_PRODUCTION_WEIGHTS }
  const entries = fullCatalogIdleInventory().filter(row => ['芬', '砾', '斑点', '夜烟', 'Lancet-2', '杜林']
    .some(name => row.operator === id(name)))
  const inventory = compileOperatorInventory(entries)
  expect(inventory.valid).toBe(true)
  const valid = (candidate: RosterWorkspace) => {
    expect(validatePhysicalRoster(candidate)).toEqual([])
    expect(recoveryGroupCapacityIssues(candidate)).toEqual([])
    expect(compileRosterSchedule(candidate).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
  }
  valid(workspace)
  const userBase = structuredClone(workspace)
  userBase.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'empty' }, groupId: null, replacements: [] }
  const propose = (tag: string, mutate?: (candidate: RosterWorkspace) => void): Proposal => {
    const candidate = structuredClone(workspace)
    candidate.mainPlan.facilities.room_1_1.slots[0]!.groupId = tag
    mutate?.(candidate)
    return { id: tag, workspace: candidate }
  }
  const baseline: SmartRosterResult = { status: 'draft', workspace: structuredClone(workspace), score: 100,
    diagnostics: [], specialOperators: [], calculationReport: report(100, 'initial F'),
    phases: { static: { candidates: [], bestScore: null }, simulation: null, search: null } }
  const makeJob = vi.fn((candidate: RosterWorkspace): CandidateSimulationJob => ({ workspace: candidate,
    options: { warmupHours: 24, sampleHours: 72, maxStepHours: 0.25,
      productionWeights: { ...DEFAULT_PRODUCTION_WEIGHTS }, operatorInventory: structuredClone(entries),
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 } },
    assumptions: { restingThreshold: 0.65, operationDurationHours: 0 },
  }))
  const input: Input = { baseline, baselineSummary: summary(100), userBase, inventory,
    lockedPositions: new Set(), lockedOperators: new Set(), cache: new CandidateSimulationCache(),
    makeJob, allowFreeCombinations: true, now: () => 0 }
  const recovery = vi.spyOn(recoveryCandidates, 'generateMainRosterRecoveryCandidates').mockReturnValue({ candidates: [], diagnostics: [] })
  const free = vi.spyOn(freeCandidates, 'generateMainRosterFreeCandidates').mockReturnValue({ candidates: [], diagnostics: [] })
  const families = (recoveryProposals: Proposal[], freeProposals: Proposal[] = [], combinedProposals: Proposal[] = []) => {
    for (const candidate of [...recoveryProposals, ...freeProposals, ...combinedProposals]) valid(candidate.workspace)
    recovery.mockReset().mockReturnValueOnce({ candidates: recoveryProposals, diagnostics: [] })
      .mockReturnValue({ candidates: combinedProposals, diagnostics: [] })
    free.mockReturnValue({ candidates: freeProposals, diagnostics: [] })
  }
  return { workspace, input, propose, families, recovery, free, makeJob, valid }
}

function drain(input: Input, evaluate: (job: CandidateSimulationJob, index: number) => CandidateSimulationResult = () => summary(90)) {
  const iterator = mainRosterOptimizationSteps(input), jobs: CandidateSimulationJob[] = []
  let step = iterator.next()
  while (!step.done) {
    expect(step.value.jobs).toHaveLength(1)
    const job = step.value.jobs[0]!
    jobs.push(structuredClone(job))
    step = iterator.next([evaluate(job, jobs.length - 1)])
  }
  return { result: step.value, jobs }
}

afterEach(() => vi.restoreAllMocks())

describe('bounded main-roster optimization dispatch', () => {
  it('retains the baseline when equal product counts differ only by clock roundoff', () => {
    const f = fixture(), score = 101066.66667276855
    f.input.baseline.score = score
    f.input.baseline.calculationReport = report(score)
    f.input.baselineSummary = summary(score)
    f.families([f.propose('roundoff-only')])
    const { result } = drain(f.input, () => summary(101066.66667440505))
    expect(result.score).toBe(score)
    expect(result.workspace).toEqual(f.input.baseline.workspace)
    expect(result.phases.mainOptimization).toMatchObject({ improved: false, gain: 0 })
  })

  it.each([{ requested: undefined, expected: 3 }, { requested: 999, expected: 8 }])(
    'limits extra full F to $expected when requested=$requested', ({ requested, expected }) => {
      const f = fixture()
      f.input.maxSimulations = requested
      f.families(Array.from({ length: 12 }, (_, index) => f.propose(`recovery-${index}`)))
      const outcome = drain(f.input)
      expect(outcome.jobs).toHaveLength(expected)
      expect(outcome.result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: expected, termination: 'simulation-budget' })
    })

  it.each([{ maxSimulations: 0, timeBudgetMs: 10, termination: 'simulation-budget' },
    { maxSimulations: 3, timeBudgetMs: 0, termination: 'time-budget' }])(
    'does not construct proposals or dispatch with a zero $termination', budget => {
      const f = fixture()
      Object.assign(f.input, budget)
      const outcome = drain(f.input)
      expect(outcome.jobs).toHaveLength(0)
      expect(f.recovery).not.toHaveBeenCalled()
      expect(f.free).not.toHaveBeenCalled()
      expect(outcome.result.phases.mainOptimization?.termination).toBe(budget.termination)
    })

  it.each([{ maxSimulations: -1 }, { maxSimulations: NaN }, { maxSimulations: Infinity },
    { timeBudgetMs: -1 }, { timeBudgetMs: NaN }, { timeBudgetMs: Infinity }])(
    'rejects an invalid budget %j without dispatch', budget => {
      const f = fixture()
      Object.assign(f.input, budget)
      const outcome = drain(f.input)
      expect(outcome.jobs).toHaveLength(0)
      expect(outcome.result.phases.mainOptimization?.termination).toBe('invalid-budget')
      expect(outcome.result.diagnostics.some(issue => issue.code === 'MAIN_OPTIMIZATION_INVALID_BUDGET')).toBe(true)
    })

  it('accepts a complete active F after the deadline but starts no next F', () => {
    const f = fixture(), snapshots: SmartRosterResult[] = []
    let clock = 0
    Object.assign(f.input, { timeBudgetMs: 10, now: () => clock, onIncumbent: (value: SmartRosterResult) => snapshots.push(value) })
    f.families([f.propose('first'), f.propose('second')])
    const iterator = mainRosterOptimizationSteps(f.input), first = iterator.next()
    expect(first.done).toBe(false)
    clock = 25
    const done = iterator.next([summary(125)])
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('a second F was dispatched after the deadline')
    expect(done.value.score).toBe(125)
    expect(done.value.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, termination: 'time-budget' })
    expect(snapshots.map(value => value.score)).toEqual([100, 125])
  })

  it('rechecks the deadline after job preparation before a new F dispatch', () => {
    const f = fixture()
    let clock = 0
    Object.assign(f.input, { timeBudgetMs: 10, now: () => clock })
    const normalJob = f.makeJob.getMockImplementation()!
    f.makeJob.mockImplementation(candidate => {
      if (candidate.mainPlan.facilities.room_1_1.slots[0]?.groupId) clock = 11
      return normalJob(candidate)
    })
    f.families([f.propose('prepared-after-deadline')])
    const outcome = drain(f.input)
    expect(outcome.jobs).toHaveLength(0)
    expect(outcome.result.phases.mainOptimization?.termination).toBe('time-budget')
  })

  it('shares the default three extra F fairly among recovery, free and composed proposals', () => {
    const f = fixture()
    const recoveries = Array.from({ length: 4 }, (_, index) => f.propose(`recovery-${index}`))
    const free = f.propose('free', candidate => { candidate.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('斑点') } })
    const combined = structuredClone(free)
    combined.id = 'crew-and-recovery'
    combined.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'crew-and-recovery'
    f.families(recoveries, [free], [combined])
    const outcome = drain(f.input, (_, index) => summary(105 + index))
    expect(outcome.result.phases.mainOptimization?.candidates.filter(candidate => candidate.score !== null).map(candidate => candidate.id))
      .toEqual(['free', 'recovery-0', 'combined:crew-and-recovery'])
    expect(outcome.jobs).toHaveLength(3)
    expect(outcome.result.score).toBe(107)
    expect(f.recovery.mock.calls[1]![0]).toEqual(free.workspace)
    expect(outcome.jobs[2]!.workspace).toEqual(combined.workspace)
  })

  it('evaluates free first under the soft deadline and allows its full F to finish without dispatching recovery', () => {
    const f = fixture(), snapshots: SmartRosterResult[] = []
    let clock = 0
    f.input.now = () => clock
    f.input.onIncumbent = value => snapshots.push(value)
    const free = f.propose('free-first', workspace => {
      workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('斑点') }
    })
    f.families([f.propose('recovery-not-yet-evaluated')], [free], [f.propose('combined-not-yet-evaluated')])
    const iterator = mainRosterOptimizationSteps(f.input), first = iterator.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('a free candidate was not dispatched')
    expect(first.value.jobs).toHaveLength(1)
    expect(first.value.jobs[0]!.workspace).toEqual(free.workspace)
    expect(first.value.jobs[0]!.options).toMatchObject({ warmupHours: 24, sampleHours: 72 })
    // The 30s default is a soft dispatch deadline, not a shortened F window.
    clock = 70_000
    const completed = iterator.next([summary(140)])
    expect(completed.done).toBe(true)
    if (!completed.done) throw new Error('another F was dispatched after the soft deadline')
    expect(completed.value.workspace).toEqual(free.workspace)
    expect(completed.value.score).toBe(140)
    expect(completed.value.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, termination: 'time-budget' })
    expect(completed.value.phases.mainOptimization?.candidates.map(candidate => candidate.id)).toEqual(['free-first'])
    expect(snapshots.map(value => value.score)).toEqual([100, 140])
  })

  it('does not generate free or composed candidates when free combinations are disabled', () => {
    const f = fixture()
    f.input.allowFreeCombinations = false
    f.families([f.propose('recovery')], [f.propose('free')], [f.propose('composed')])
    const outcome = drain(f.input)
    expect(outcome.jobs).toHaveLength(1)
    expect(f.free).not.toHaveBeenCalled()
    expect(f.recovery).toHaveBeenCalledTimes(1)
  })

  it('uses the same warmup, sample, seed, drones, inventory, weights and assumptions for every full F', () => {
    const f = fixture()
    f.families([f.propose('recovery')], [f.propose('free')], [f.propose('composed')])
    const outcome = drain(f.input)
    const baselineJob = f.makeJob(f.workspace)
    for (const job of outcome.jobs) {
      expect(job.options).toEqual(baselineJob.options)
      expect(job.assumptions).toEqual(baselineJob.assumptions)
      expect(job.workspace.productionWeights).toEqual(f.workspace.productionWeights)
    }
  })
})

describe('exact-input de-duplication and request-local F reuse', () => {
  it('skips the baseline and equivalent proposals across families, and reuses a complete exact job', () => {
    const f = fixture(), duplicate = f.propose('same-input'), cached = f.propose('cached')
    f.families([{ id: 'baseline', workspace: structuredClone(f.workspace) }, duplicate, cached],
      [{ id: 'free-duplicate', workspace: structuredClone(duplicate.workspace) }])
    const cachedJob = f.makeJob(structuredClone(cached.workspace))
    f.input.cache.remember(f.input.cache.key(cachedJob), summary(140))
    const outcome = drain(f.input, () => summary(120))
    expect(outcome.jobs).toHaveLength(1)
    expect(outcome.result.score).toBe(140)
    expect(outcome.result.phases.mainOptimization).toMatchObject({ generatedCandidates: 2, evaluatedCandidates: 1, cacheHits: 1 })
    // The baseline at recovery[0] is skipped; fair interleaving encounters the
    // equivalent free proposal before recovery[1]. Either identity has one F.
    expect(outcome.result.phases.mainOptimization?.candidates.map(candidate => candidate.id)).toEqual(['free-duplicate', 'cached'])
  })

  it.each(['warmup', 'sample', 'seed', 'drones', 'weights', 'inventory', 'assumptions'] as const)(
    'does not reuse a cached candidate from different %s context', context => {
      const f = fixture(), candidate = f.propose('changed-context')
      f.families([candidate])
      const differentJob = f.makeJob(structuredClone(candidate.workspace))
      if (context === 'warmup') differentJob.options!.warmupHours = 12
      if (context === 'sample') differentJob.options!.sampleHours = 48
      if (context === 'seed') differentJob.options!.production!.seed = 43
      if (context === 'drones') differentJob.options!.production!.droneTarget = 'gold'
      if (context === 'weights') differentJob.options!.productionWeights!.gold = 1
      if (context === 'inventory') differentJob.options!.operatorInventory![0]!.elitePhase = 0
      if (context === 'assumptions') differentJob.assumptions!.restingThreshold = 0.5
      f.input.cache.remember(f.input.cache.key(differentJob), summary(1e9))
      const outcome = drain(f.input, () => summary(120))
      expect(outcome.jobs).toHaveLength(1)
      expect(outcome.result.score).toBe(120)
      expect(outcome.result.phases.mainOptimization?.cacheHits).toBe(0)
    })

  it('still considers an exact cached full F after the permitted new F has completed', () => {
    const f = fixture(), cached = f.propose('cached-after-new-F')
    f.input.maxSimulations = 1
    f.families([f.propose('new-F'), cached])
    const cachedJob = f.makeJob(structuredClone(cached.workspace))
    f.input.cache.remember(f.input.cache.key(cachedJob), summary(140))
    const outcome = drain(f.input, () => summary(110))
    expect(outcome.jobs).toHaveLength(1)
    expect(outcome.result.score).toBe(140)
    expect(outcome.result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, cacheHits: 1 })
  })

  it('never accepts a result if its dispatched complete input was mutated before it completed', () => {
    const f = fixture()
    f.families([f.propose('mutated-in-flight')])
    const outcome = drain(f.input, job => { job.options!.sampleHours = 1; return summary(1e9) })
    expect(outcome.result.score).toBe(100)
    expect(outcome.result.phases.mainOptimization?.acceptedCandidates).toBe(0)
  })
})

describe('quality-gated incumbent selection and immutable snapshots', () => {
  it.each(['unknown', 'incomplete', 'non-finite', 'quality-rejected', 'missing-display', 'different-display'] as const)(
    'rejects a higher reported score when the same F evidence is %s', failure => {
      const f = fixture(), snapshots: SmartRosterResult[] = []
      f.input.onIncumbent = value => snapshots.push(value)
      f.families([f.propose('bad-high-score')])
      const bad = summary(1e9)
      if (failure === 'unknown') delete bad.quality
      if (failure === 'incomplete') bad.completed = false
      if (failure === 'non-finite') bad.simScore = Infinity
      if (failure === 'quality-rejected') bad.quality = { ...bad.quality!, eligible: false, ordinaryExhaustedHours: 2, issues: ['ordinary fatigue'] }
      if (failure === 'missing-display') delete bad.calculationReport
      if (failure === 'different-display') bad.calculationReport = report(777)
      const outcome = drain(f.input, () => bad)
      expect(outcome.result.score).toBe(100)
      expect(outcome.result.phases.mainOptimization?.candidates[0]?.eligible).toBe(false)
      expect(snapshots.map(value => value.score)).toEqual([100])
    })

  it.each(['unknown-duty', 'non-finite-duty', 'not-strict', 'pending-deferral'] as const)(
    'fails closed for contradictory eligible quality with %s', failure => {
      const f = fixture()
      f.families([f.propose('contradictory-quality')])
      const bad = summary(1e9)
      if (failure === 'unknown-duty') bad.quality!.ordinaryExhaustedHours = null
      if (failure === 'non-finite-duty') bad.quality!.ordinaryExhaustedHours = NaN
      if (failure === 'not-strict') bad.quality!.strict = false
      if (failure === 'pending-deferral') bad.quality!.pendingDeferrals = 1
      const outcome = drain(f.input, () => bad)
      expect(outcome.result.score).toBe(100)
      expect(outcome.result.phases.mainOptimization?.candidates[0]?.eligible).toBe(false)
    })

  it('keeps the qualified baseline when the new complete qualified score is lower', () => {
    const f = fixture()
    f.families([f.propose('lower')])
    const outcome = drain(f.input, () => summary(99))
    expect(outcome.result.workspace).toEqual(f.input.baseline.workspace)
    expect(outcome.result.score).toBe(100)
    expect(outcome.result.phases.mainOptimization).toMatchObject({ improved: false, gain: 0, qualityRepaired: false })
  })

  it('repairs an unqualified initial result with a lower-scoring qualified complete F', () => {
    const f = fixture(), snapshots: SmartRosterResult[] = []
    f.input.baselineSummary = summary(100, { quality: { eligible: false, strict: false,
      ordinaryExhaustedHours: 1, pendingDeferrals: 1, issues: ['initial result has unresolved recovery'] } })
    f.input.onIncumbent = value => snapshots.push(value)
    const repaired = f.propose('quality-repaired')
    f.families([repaired])
    const outcome = drain(f.input, () => summary(90))
    expect(outcome.result.score).toBe(90)
    expect(outcome.result.workspace).toEqual(repaired.workspace)
    expect(outcome.result.phases.mainOptimization).toMatchObject({ improved: false, gain: -10, qualityRepaired: true })
    expect(snapshots.map(value => value.score)).toEqual([90])
  })

  it('emits only qualifying same-run display reports and snapshots stay isolated from later mutation', () => {
    const f = fixture(), snapshots: SmartRosterResult[] = []
    const original = structuredClone(f.input.baseline), first = summary(120), second = summary(130)
    first.calculationReport = report(120, 'first F only')
    second.calculationReport = report(130, 'second F only')
    f.input.onIncumbent = value => snapshots.push(value)
    f.families([f.propose('first'), f.propose('second'), f.propose('unqualified')])
    const outcome = drain(f.input, (_, index) => [first, second,
      summary(1e9, { quality: { eligible: false, strict: false, ordinaryExhaustedHours: 2, pendingDeferrals: 1, issues: ['fatigue'] } })][index]!)
    expect(snapshots.map(value => [value.score, value.calculationReport?.summary?.totalScore82,
      value.calculationReport?.efficiencyNotes?.[0]])).toEqual([[100, 100, 'initial F'], [120, 120, 'first F only'], [130, 130, 'second F only']])
    expect(snapshots[1]!.phases.mainOptimization?.evaluatedCandidates).toBe(1)
    expect(snapshots[2]!.phases.mainOptimization?.evaluatedCandidates).toBe(2)
    outcome.result.workspace!.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'mutated returned workspace'
    outcome.result.calculationReport!.summary!.totalScore82 = -1
    first.calculationReport!.summary!.totalScore82 = -2
    second.calculationReport!.efficiencyNotes!.push('mutated source result')
    expect(snapshots[1]!.calculationReport!.summary!.totalScore82).toBe(120)
    expect(snapshots[2]!.calculationReport!.efficiencyNotes).toEqual(['second F only'])
    expect(snapshots[2]!.workspace!.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('second')
    expect(f.input.baseline).toEqual(original)
  })
})

describe('admission before any new F', () => {
  it.each(['position', 'operator'] as const)('does not dispatch a proposal that changes a locked %s', lock => {
    const f = fixture()
    f.input.userBase = structuredClone(f.workspace)
    if (lock === 'position') f.input.lockedPositions = new Set(['room_1_1:0'])
    else f.input.lockedOperators = new Set([id('芬')])
    const candidate = f.propose('changes-locked-worker', workspace => {
      workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('斑点') }
    })
    f.families([candidate])
    const outcome = drain(f.input, () => summary(1e9))
    expect(outcome.jobs).toHaveLength(0)
    expect(outcome.result.workspace).toEqual(f.workspace)
  })

  it.each(['conf', 'weights', 'room-level', 'recipe', 'facility-type', 'backups'] as const)(
    'does not dispatch a proposal that changes %s context', context => {
      const f = fixture(), candidate = f.propose('changes-context')
      if (context === 'conf') candidate.workspace.mainPlan.conf.rest_in_full.push(id('芬'))
      if (context === 'weights') candidate.workspace.productionWeights!.gold = 1
      if (context === 'room-level') candidate.workspace.mainPlan.facilities.room_1_1.level = 2
      if (context === 'recipe') candidate.workspace.mainPlan.facilities.room_1_1.product = 'exp'
      if (context === 'facility-type') candidate.workspace.mainPlan.facilities.room_1_1.type = 'trading'
      if (context === 'backups') candidate.workspace.compatibility.backupPlans.push({ trigger: 'true', plan: {} })
      f.recovery.mockReturnValue({ candidates: [candidate], diagnostics: [] })
      const outcome = drain(f.input, () => summary(1e9))
      expect(outcome.jobs).toHaveLength(0)
      expect(outcome.result.score).toBe(100)
    })
})
