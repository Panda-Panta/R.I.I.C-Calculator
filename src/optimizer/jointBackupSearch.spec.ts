import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory } from '../domain/operatorInventory'
import type { CalculationReport } from '../domain/types'
import { CandidateSimulationCache } from './candidateSimulationCache'
import * as generator from './jointBackupGenerator'
import * as observers from './jointBackupObservers'
import { jointBackupSearchSteps } from './jointBackupSearch'
import type { CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'
import type { GeneratedBackupDescriptor } from './generatedBackupTypes'

afterEach(() => vi.restoreAllMocks())

const report = (score: number): CalculationReport => ({
  power: { generation: 270, consumption: 10, margin: 260, sufficient: true },
  layoutValid: true, validationMessages: [], efficiencyNotes: [],
  manufacture: [], trading: [], drones: 0, morale: [], roomShiftDetails: {},
  summary: { exp: 0, goldCount: 0, goldValue: 0, virtualGoldCount: 0, virtualGoldValue: 0,
    orderLmd: 0, fragments: 0, orundum: 0, goldConsumed: 0, fragmentsConsumed: 0,
    netGoldCount: 0, netGoldValue: 0, totalScore82: score, totalEquivalentLmd: 0 },
})
// Controlled same-run summaries exercise orchestration. These are not Native F.
const summary = (score: number, patch: Partial<CandidateSimulationResult> = {}): CandidateSimulationResult => ({
  completed: true, simScore: score, diagnostics: [], calculationReport: report(score),
  quality: { eligible: true, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] },
  ...patch,
})

function setup() {
  const baseline = createDefaultWorkspace()
  const descriptor: GeneratedBackupDescriptor = { version: 'joint-production-v1', trigger: {
    activeWhen: 'all-present', observers: [{ operatorId: '森蚺', roomId: 'central', requirePositiveMood: true }],
  } }
  const candidates = Array.from({ length: 3 }, (_, index) => ({ id: `joint-${index}`, mainId: 'main', overlayId: `overlay-${index}`,
    generatedBackup: descriptor, workspace: { ...structuredClone(baseline), name: `joint-${index}` } }))
  vi.spyOn(observers, 'selectJointBackupTriggers').mockReturnValue([descriptor.trigger])
  vi.spyOn(generator, 'generateJointBackupCandidates').mockReturnValue({ candidates, diagnostics: [] })
  const cache = new CandidateSimulationCache()
  const makeJob = (workspace: typeof baseline, generatedBackup?: GeneratedBackupDescriptor): CandidateSimulationJob => ({
    workspace, generatedBackup, options: {}, assumptions: {},
  })
  return { baseline, descriptor, candidates, cache, makeJob, request: {
    primaryCandidates: [{ id: 'main', workspace: baseline }], entries: [], inventory: compileOperatorInventory([]),
    baseline: { workspace: baseline, score: 100, summary: summary(100) }, cache, makeJob, maxCandidates: 3,
    now: () => 0,
  } }
}

type Request = Parameters<typeof jointBackupSearchSteps>[0]
function drain(request: Request, evaluate: (job: CandidateSimulationJob, index: number) => CandidateSimulationResult = () => summary(90)) {
  const run = jointBackupSearchSteps(request), jobs: CandidateSimulationJob[] = []
  let step = run.next()
  while (!step.done) {
    expect(step.value.jobs).toHaveLength(1)
    const job = step.value.jobs[0]!
    jobs.push(job)
    const result = evaluate(job, jobs.length - 1)
    step.value.onComplete(result, 0)
    step = run.next([result])
  }
  return { result: step.value, jobs }
}

describe('joint backup search quality boundary', () => {
  it('keeps the plain baseline for the real equal-production floating score difference', () => {
    const fixture = setup(), baseline = 101066.66667276855
    fixture.request.baseline = { workspace: fixture.baseline, score: baseline, summary: summary(baseline) }
    const { result } = drain(fixture.request, () => summary(101066.66667440505))
    expect(result.workspace).toEqual(fixture.baseline)
    expect(result).toMatchObject({ score: baseline, improved: false })
    expect(result.generatedBackup).toBeUndefined()
  })

  it('selects only qualified finite improvements and binds the exact descriptor and cached report', () => {
    const fixture = setup(), before = JSON.stringify(fixture.baseline)
    const { result, jobs } = drain(fixture.request, (_job, index) => [
      summary(9999, { completed: false }), summary(120), summary(Number.NaN),
    ][index]!)
    expect(jobs).toHaveLength(3)
    expect(jobs.every(job => job.generatedBackup?.version === 'joint-production-v1')).toBe(true)
    expect(result).toMatchObject({ score: 120, selectedCandidateId: 'joint-1', improved: true,
      qualityRepaired: false, simulations: 3, evaluatedCandidates: 3, acceptedCandidates: 1, cacheHits: 0 })
    expect(result.workspace.name).toBe('joint-1')
    expect(result.generatedBackup).toEqual(fixture.descriptor)
    expect(fixture.cache.get(fixture.makeJob(result.workspace, result.generatedBackup))?.calculationReport?.summary?.totalScore82).toBe(120)
    expect(JSON.stringify(fixture.baseline)).toBe(before)
  })

  it.each([
    ['unknown quality', summary(9999, { quality: undefined })],
    ['ordinary fatigue', summary(9999, { quality: { eligible: true, strict: true, ordinaryExhaustedHours: 0.5, pendingDeferrals: 0, issues: ['fatigue'] } })],
    ['unknown fatigue', summary(9999, { quality: { eligible: true, strict: true, ordinaryExhaustedHours: null, pendingDeferrals: 0, issues: [] } })],
    ['pending recovery', summary(9999, { quality: { eligible: true, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 1, issues: [] } })],
    ['non-strict result', summary(9999, { quality: { eligible: true, strict: false, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] } })],
    ['ineligible result', summary(9999, { quality: { eligible: false, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] } })],
    ['missing display report', summary(9999, { calculationReport: undefined })],
    ['display score from another run', summary(9999, { calculationReport: report(120) })],
  ])('rejects %s even when the reported score is higher', (_label, invalid) => {
    const fixture = setup(), { result } = drain(fixture.request, () => invalid)
    expect(result.score).toBe(100)
    expect(result.workspace).toEqual(fixture.baseline)
    expect(result.generatedBackup).toBeUndefined()
    expect(result.candidates.every(candidate => !candidate.eligible)).toBe(true)
  })

  it('keeps the verified plain baseline on ties and scores below it', () => {
    const fixture = setup(), { result } = drain(fixture.request, (_job, index) => summary([100, 90, 80][index]!))
    expect(result.score).toBe(100)
    expect(result.workspace).toEqual(fixture.baseline)
    expect(result.generatedBackup).toBeUndefined()
    expect(result.improved).toBe(false)
    expect(result.qualityRepaired).toBe(false)
  })

  it('repairs an ineligible baseline with a qualified lower score without reporting an output gain', () => {
    const fixture = setup(), { result } = drain({ ...fixture.request,
      baseline: { ...fixture.request.baseline, summary: summary(100, { quality: undefined }) },
    }, (_job, index) => summary([90, 85, 80][index]!))
    expect(result).toMatchObject({ score: 90, qualityRepaired: true, improved: false, selectedCandidateId: 'joint-0' })
  })

  it('does not treat a qualified summary with a different baseline score as proof of the baseline', () => {
    const fixture = setup(), { result } = drain({ ...fixture.request,
      baseline: { ...fixture.request.baseline, summary: summary(200) },
    }, () => summary(90))
    expect(result).toMatchObject({ score: 90, qualityRepaired: true, improved: false })
  })

  it('does not turn an absent baseline summary into eligibility', () => {
    const fixture = setup(), snapshots: number[] = []
    const { result } = drain({ ...fixture.request, baseline: { workspace: fixture.baseline, score: 100 },
      onIncumbent: value => snapshots.push(value.score),
    }, () => summary(9999, { quality: undefined }))
    expect(result.score).toBe(100)
    expect(snapshots).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'JOINT_BACKUP_NO_QUALIFIED_RESULT')).toBe(true)
  })
})

describe('joint backup search budgets and snapshots', () => {
  it('honors a zero proposal budget without generating or evaluating a proposal', () => {
    const fixture = setup(), { result, jobs } = drain({ ...fixture.request, maxCandidates: 0 })
    expect(jobs).toEqual([])
    expect(result.generatedCandidates).toBe(0)
    expect(generator.generateJointBackupCandidates).not.toHaveBeenCalled()
  })

  it.each([
    { maxSimulations: Number.NaN }, { maxSimulations: -1 }, { timeBudgetMs: Number.POSITIVE_INFINITY }, { timeBudgetMs: -1 },
  ])('rejects invalid budgets without running F: %j', budget => {
    const fixture = setup(), { result, jobs } = drain({ ...fixture.request, ...budget })
    expect(jobs).toEqual([])
    expect(result.termination).toBe('invalid-budget')
    expect(generator.generateJointBackupCandidates).not.toHaveBeenCalled()
  })

  it('never spends more than the extra simulation budget and retains the best completed candidate', () => {
    const fixture = setup(), { result, jobs } = drain({ ...fixture.request, maxSimulations: 1 }, () => summary(120))
    expect(jobs).toHaveLength(1)
    expect(result).toMatchObject({ score: 120, simulations: 1, evaluatedCandidates: 1, termination: 'simulation-budget' })
  })

  it('caps both generated proposals and actual F at four even for larger requested budgets', () => {
    const fixture = setup()
    for (let index = 3; index < 7; index++) fixture.candidates.push({ ...structuredClone(fixture.candidates[0]!),
      id: `joint-${index}`, overlayId: `overlay-${index}`, workspace: { ...structuredClone(fixture.baseline), name: `joint-${index}` } })
    const { result, jobs } = drain({ ...fixture.request, maxCandidates: 100, maxSimulations: 100 }, () => summary(120))
    expect(jobs).toHaveLength(4)
    expect(result).toMatchObject({ generatedCandidates: 4, simulations: 4, evaluatedCandidates: 4 })
    expect(generator.generateJointBackupCandidates).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ maxCandidates: 4 }))
  })

  it('allows exact cache hits after the F budget is exhausted and does not re-run them', () => {
    const fixture = setup()
    const cached = fixture.makeJob(fixture.candidates[2]!.workspace, fixture.descriptor)
    fixture.cache.remember(fixture.cache.key(cached), summary(130))
    const { result, jobs } = drain({ ...fixture.request, maxSimulations: 1 }, () => summary(120))
    expect(jobs).toHaveLength(1)
    expect(result).toMatchObject({ score: 130, selectedCandidateId: 'joint-2', simulations: 1, cacheHits: 1, evaluatedCandidates: 2 })
  })

  it('can use cached qualified results with zero new simulations', () => {
    const fixture = setup(), cached = fixture.makeJob(fixture.candidates[0]!.workspace, fixture.descriptor)
    fixture.cache.remember(fixture.cache.key(cached), summary(120))
    const { result, jobs } = drain({ ...fixture.request, maxSimulations: 0 })
    expect(jobs).toEqual([])
    expect(result).toMatchObject({ score: 120, simulations: 0, cacheHits: 1, evaluatedCandidates: 1 })
  })

  it('does not reuse a score from a different generated descriptor', () => {
    const fixture = setup(), candidate = fixture.candidates[0]!
    const other = structuredClone(fixture.descriptor)
    other.trigger.activeWhen = 'not-all-present'
    const wrongJob = fixture.makeJob(candidate.workspace, other)
    fixture.cache.remember(fixture.cache.key(wrongJob), summary(9999))
    const { result, jobs } = drain({ ...fixture.request, maxSimulations: 1 }, () => summary(120))
    expect(jobs).toHaveLength(1)
    expect(result).toMatchObject({ score: 120, cacheHits: 0 })
  })

  it('does not truncate an active complete run when its deadline passes and dispatches no further F', () => {
    const fixture = setup(), snapshots: number[] = []
    let elapsed = 0
    const { result, jobs } = drain({ ...fixture.request, timeBudgetMs: 10, now: () => elapsed,
      onIncumbent: value => snapshots.push(value.score),
    }, () => { elapsed = 11; return summary(120) })
    expect(jobs).toHaveLength(1)
    expect(result).toMatchObject({ score: 120, simulations: 1, termination: 'time-budget' })
    expect(snapshots).toEqual([100, 120])
  })

  it('caps the deadline at 300 seconds without shortening the completed F', () => {
    const fixture = setup()
    let elapsed = 0
    const { result, jobs } = drain({ ...fixture.request, timeBudgetMs: 1_000_000, now: () => elapsed },
      () => { elapsed = 300_001; return summary(120) })
    expect(jobs).toHaveLength(1)
    expect(result).toMatchObject({ score: 120, termination: 'time-budget' })
  })

  it('counts candidate generation time before dispatching another F', () => {
    const fixture = setup()
    let elapsed = 0
    vi.mocked(observers.selectJointBackupTriggers).mockImplementation(() => { elapsed = 11; return [fixture.descriptor.trigger] })
    const { result, jobs } = drain({ ...fixture.request, timeBudgetMs: 10, now: () => elapsed })
    expect(jobs).toEqual([])
    expect(result).toMatchObject({ score: 100, simulations: 0, termination: 'time-budget' })
  })

  it('rejects duplicate exact jobs without spending another F', () => {
    const fixture = setup()
    fixture.candidates[1]!.workspace = structuredClone(fixture.candidates[0]!.workspace)
    const { result, jobs } = drain(fixture.request, (_job, index) => summary(120 + index))
    expect(jobs).toHaveLength(2)
    expect(result.simulations).toBe(2)
  })

  it('does not cache or accept a result when execution mutated its input key', () => {
    const fixture = setup(), { result } = drain(fixture.request, job => {
      job.workspace.name = 'mutated by executor'
      return summary(9999)
    })
    expect(result.score).toBe(100)
    expect(result.generatedBackup).toBeUndefined()
    expect(fixture.cache.get(fixture.makeJob(fixture.candidates[0]!.workspace, fixture.descriptor))).toBeUndefined()
    expect(result.diagnostics.some(issue => issue.code === 'JOINT_BACKUP_INPUT_CHANGED')).toBe(true)
  })

  it('isolates snapshot mutation and callback exceptions from retained workspaces and later improvements', () => {
    const fixture = setup(), snapshots: number[] = []
    const { result } = drain({ ...fixture.request,
      onIncumbent: snapshot => {
        snapshots.push(snapshot.score)
        snapshot.workspace.name = 'callback must not write winner'
        snapshot.candidates.length = 0
        throw new Error('UI callback failed')
      },
      onProgress: () => { throw new Error('progress callback failed') },
    }, (_job, index) => summary(120 + index))
    expect(snapshots).toEqual([100, 120, 121, 122])
    expect(result.score).toBe(122)
    expect(result.workspace.name).toBe('joint-2')
    expect(result.candidates).toHaveLength(3)
    expect(fixture.baseline.name).not.toBe('callback must not write winner')
  })

  it('retains the latest qualified incumbent if a later worker throws or returns an incomplete batch', () => {
    for (const workerFailure of [true, false]) {
      const fixture = setup(), run = jointBackupSearchSteps(fixture.request)
      run.next()
      expect(run.next([summary(120)]).done).toBe(false)
      const next = workerFailure ? run.throw(new Error('worker stopped')) : run.next([])
      expect(next.done).toBe(false)
      const done = run.next([summary(110)])
      if (!done.done) throw new Error('expected safe completion')
      expect(done.value.score).toBe(120)
      expect(done.value.workspace.name).toBe('joint-0')
      expect(done.value.diagnostics.some(issue => issue.code === 'JOINT_BACKUP_EVALUATION_FAILED')).toBe(true)
    }
  })

  it('keeps the baseline on generation failure and continues after an individual job cannot be built', () => {
    const fixture = setup()
    vi.mocked(generator.generateJointBackupCandidates).mockImplementationOnce(() => { throw new Error('cannot generate') })
    const failed = drain(fixture.request)
    expect(failed.jobs).toEqual([])
    expect(failed.result.score).toBe(100)
    expect(failed.result.diagnostics.some(issue => issue.code === 'JOINT_BACKUP_GENERATION_FAILED')).toBe(true)
    const { result, jobs } = drain({ ...fixture.request,
      makeJob: (workspace, descriptor) => {
        if (workspace.name === 'joint-0') throw new Error('cannot build first job')
        return fixture.makeJob(workspace, descriptor)
      },
    }, () => summary(120))
    expect(jobs).toHaveLength(2)
    expect(result.score).toBe(120)
    expect(result.candidates[0]?.diagnostics).toContain('cannot build first job')
  })
})
