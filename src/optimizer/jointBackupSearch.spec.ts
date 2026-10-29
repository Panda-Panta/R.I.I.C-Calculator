import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { CandidateSimulationCache } from './candidateSimulationCache'
import * as generator from './jointBackupGenerator'
import * as observers from './jointBackupObservers'
import { jointBackupSearchSteps } from './jointBackupSearch'
import type { CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'
import type { GeneratedBackupDescriptor } from './generatedBackupTypes'

afterEach(() => vi.restoreAllMocks())

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
    baseline: { workspace: baseline, score: 100 }, cache, makeJob, maxCandidates: 3,
  } }
}

describe('joint backup search integration boundary', () => {
  it('selects only completed finite improvements and binds the exact descriptor and cached report', () => {
    const fixture = setup(), run = jointBackupSearchSteps(fixture.request), batch = run.next()
    expect(batch.done).toBe(false)
    if (batch.done) throw new Error('expected work')
    expect(batch.value.jobs).toHaveLength(3)
    expect(batch.value.jobs.every(job => job.generatedBackup?.version === 'joint-production-v1')).toBe(true)
    const results: CandidateSimulationResult[] = [
      { completed: false, simScore: 9999, diagnostics: ['incomplete'] },
      { completed: true, simScore: 120, diagnostics: [] },
      { completed: true, simScore: Number.NaN, diagnostics: [] },
    ]
    const done = run.next(results)
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('expected completion')
    expect(done.value.score).toBe(120)
    expect(done.value.workspace.name).toBe('joint-1')
    expect(done.value.generatedBackup).toEqual(fixture.descriptor)
    expect(done.value.improved).toBe(true)
    expect(fixture.cache.get(fixture.makeJob(done.value.workspace, done.value.generatedBackup))?.simScore).toBe(120)
    expect(fixture.baseline.name).not.toBe('joint-1')
  })

  it('keeps the verified plain baseline on ties and scores below it', () => {
    const fixture = setup(), run = jointBackupSearchSteps(fixture.request)
    run.next()
    const done = run.next([100, 90, 80].map(simScore => ({ completed: true, simScore, diagnostics: [] })))
    if (!done.done) throw new Error('expected completion')
    expect(done.value.score).toBe(100)
    expect(done.value.workspace).toEqual(fixture.baseline)
    expect(done.value.generatedBackup).toBeUndefined()
    expect(done.value.improved).toBe(false)
  })

  it('falls back without inventing a score when worker execution fails or returns incomplete batches', () => {
    for (const workerFailure of [true, false]) {
      const fixture = setup(), run = jointBackupSearchSteps(fixture.request)
      run.next()
      const done = workerFailure ? run.throw(new Error('worker stopped')) : run.next([])
      if (!done.done) throw new Error('expected safe completion')
      expect(done.value.score).toBe(100)
      expect(done.value.generatedBackup).toBeUndefined()
      expect(done.value.diagnostics.length).toBeGreaterThan(0)
    }
  })

  it('honors a zero budget without generating or evaluating a proposal', () => {
    const fixture = setup(), run = jointBackupSearchSteps({ ...fixture.request, maxCandidates: 0 }), done = run.next()
    expect(done.done).toBe(true)
    expect(generator.generateJointBackupCandidates).not.toHaveBeenCalled()
  })
})
