import { describe, expect, it } from 'vitest'
import { CandidateSimulationCache } from './candidateSimulationCache'
import { createDefaultWorkspace } from '../workbench/defaults'
import type { CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'

const job = (): CandidateSimulationJob => ({ workspace: createDefaultWorkspace(), options: {
  warmupHours: 24, sampleHours: 72, maxStepHours: 0.25,
  operatorInventory: [{ operator: '砾', elitePhase: 1, level: 60 }],
  production: { seed: 42, runOrderMode: 'ideal', droneTarget: 'gold' },
}, assumptions: { restingThreshold: 0.65 } })
const result = (): CandidateSimulationResult => ({ completed: true, simScore: 123, diagnostics: [], specialOperators: [] })

describe('request-local simulation cache', () => {
  it('matches named job inputs regardless of envelope order and isolates returned objects', () => {
    const cache = new CandidateSimulationCache(), input = job(), value = result()
    cache.remember(cache.key(input), value)
    value.simScore = 999
    const reordered = { assumptions: input.assumptions, options: input.options, workspace: input.workspace }
    expect(cache.get(reordered)?.simScore).toBe(123)
    cache.get(input)!.simScore = 456
    expect(cache.get(input)?.simScore).toBe(123)
    expect(new CandidateSimulationCache().get(input)).toBeUndefined()
  })
  it('preserves facility insertion order because it affects scheduling traversal and report order', () => {
    const cache = new CandidateSimulationCache(), input = job()
    cache.remember(cache.key(input), result())
    const reordered = structuredClone(input)
    reordered.workspace.mainPlan.facilities = Object.fromEntries(Object.entries(reordered.workspace.mainPlan.facilities).reverse()) as typeof input.workspace.mainPlan.facilities
    expect(cache.get(reordered)).toBeUndefined()
  })
  it('invalidates on each simulation-affecting input including policy and actual skill stage', () => {
    const cache = new CandidateSimulationCache(), input = job()
    cache.remember(cache.key(input), result())
    const mutations: ((j: CandidateSimulationJob) => void)[] = [
      j => { j.options!.warmupHours = 12 }, j => { j.options!.sampleHours = 48 },
      j => { j.options!.maxStepHours = 0.125 }, j => { j.options!.production!.seed = 43 },
      j => { j.options!.production!.droneTarget = 'none' },
      j => { j.options!.productionWeights = { exp: 2, gold: .8, orders: .2, fragments: 0, orundum: 0 } },
      j => { j.workspace.productionWeights = { exp: 0, gold: 1, orders: 0, fragments: 0, orundum: 0 } },
      j => { j.options!.operatorInventory![0]!.elitePhase = 0 },
      j => { j.assumptions!.restingThreshold = 0.5 },
      j => { j.workspace.mainPlan.conf.workaholic = ['砾'] },
      j => { j.workspace.mainPlan.facilities.room_1_1.level = 2 },
      j => { j.incomeComparison = true },
    ]
    for (const mutate of mutations) { const changed = structuredClone(input); mutate(changed); expect(cache.get(changed)).toBeUndefined() }
  })
  it('does not cache unfinished or nonfinite results, and snapshots keys before input mutation', () => {
    const cache = new CandidateSimulationCache(), input = job(), key = cache.key(input)
    cache.remember(key, { ...result(), completed: false })
    expect(cache.get(input)).toBeUndefined()
    cache.remember(key, { ...result(), simScore: NaN })
    expect(cache.get(input)).toBeUndefined()
    cache.remember(key, result())
    input.workspace.mainPlan.conf.workaholic = ['芬']
    expect(cache.get(input)).toBeUndefined()
    expect(cache.get(job())?.simScore).toBe(123)
  })
})
