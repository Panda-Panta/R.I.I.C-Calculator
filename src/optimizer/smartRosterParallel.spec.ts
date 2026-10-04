import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { runSmartRoster, runSmartRosterParallel, type SmartRosterProgress } from './smartRoster'
import { simulateCandidate } from './candidateSimulation'
import * as synthesis from './molecularSynthesis'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as replacement from './globalPerCapitaReplacement'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { planMowerMetadata } from '../scheduler/mowerMetadata'
import { MowerTaskQueue, MOWER_TASK_TYPES as T, toMowerMicros } from '../scheduler/mowerTaskQueue'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'

afterEach(() => vi.restoreAllMocks())
const entries = [{ operator: '砾', elitePhase: 1, level: 60 }, { operator: '芬', elitePhase: 1, level: 55 }]
const options = { branchCount: 2, simulationWarmupHours: 0, simulationSampleHours: 1, enableDeepSearch: false, seed: 42 }
function baseWorkspace() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) if (room.type === 'trading') room.product = 'orundum'
  return workspace
}
function candidates() {
  return ['砾', '芬'].map((name, i) => {
    const workspace = baseWorkspace()
    workspace.mainPlan.facilities.room_1_1.level = 1
    workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: name }, groupId: null, replacements: [] }]
    workspace.mainPlan.conf.workaholic = [name]
    return { id: `branch-${i}`, name, workspace, diagnostics: [], appliedAtoms: [], staticScore: 0, simScore: null, confPolicy: {} }
  })
}

describe('parallel smart roster preserves serial semantics', () => {
  it('lets a mixed-mood group recover before returning instead of immediately repeating its shift', async () => {
    const source = baseWorkspace()
    source.mainPlan.facilities.room_3_1.slots = ['食铁兽', '铅踝'].map(name => ({
      occupant: { kind: 'operator', operatorId: id(name) }, groupId: 'mixed-mood', replacements: [id(name === '铅踝' ? '泡泡' : '红云')],
    }))
    source.mainPlan.facilities.dormitory_1.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))
    const before = structuredClone(source)
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue([{ ...candidates()[0]!, workspace: structuredClone(source) }])
    await runSmartRosterParallel(source, entries, options, async jobs => jobs.map(job => {
      const state = createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(job.workspace)))
      state.time = 32
      const data = getMowerSourceRuntime(state).data
      for (const [index, name] of ['食铁兽', '铅踝'].entries()) {
        const op = data.operators[id(name)]!
        op.currentRoom = 'dormitory_1'; op.currentIndex = index; op.mood = index ? 22 : 23.94
        op.timeStampMicros = data.nowMicros; op.depletionRate = 0
        const bed = data.dorms.find(b => b.position[0] === 'dormitory_1' && b.position[1] === index)!
        bed.name = op.name; bed.timeMicros = toMowerMicros(index ? 32.74 : 32.02)
      }
      const queue = new MowerTaskQueue()
      planMowerMetadata(data, queue)
      const returning = queue.tasks.find(t => t.type === T.SHIFT_ON && Object.values(t.plan).flat().includes(id('铅踝')))!
      expect(returning.timeMicros).toBeGreaterThan(toMowerMicros(32.5))
      expect(job.workspace.mainPlan.conf.rest_in_full.map(id)).toContain(id('铅踝'))
      return { completed: false, simScore: 0, diagnostics: ['test stops after dispatch'] }
    }))
    expect(source).toEqual(before)
  })
  it('marks incomplete simulations as unknown in both scores and progress', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue(candidates().slice(0, 1))
    const progress: SmartRosterProgress[] = []
    const result = await runSmartRosterParallel(baseWorkspace(), entries, options, async (jobs, done) => jobs.map((_, index) => {
      const result = { completed: false, simScore: 0, diagnostics: ['SIMULATION_EVENT_LIMIT'] }
      done(result, index)
      return result
    }), p => progress.push(p))
    expect(result.status).toBe('blocked')
    expect(result.score).toBeNull()
    expect(result.phases.simulation?.bestScore).toBeNull()
    expect(result.phases.simulation?.candidates[0]?.simScore).toBeNull()
    expect(progress[progress.length - 1]?.bestScore).toBeUndefined()
    expect(progress[progress.length - 1]?.label).toContain('未完成')
    expect(progress[progress.length - 1]?.label).not.toContain('加权产出: 0')
  })
  it('propagates explicit weights to synthesis and every worker without changing the source preference', async () => {
    const base = baseWorkspace(), inherited = { exp: 2, gold: 3, orders: 4, fragments: 5, orundum: 6 }
    base.productionWeights = inherited
    const before = structuredClone(base), weights = { exp: 0, gold: 7, orders: 0, fragments: 0, orundum: 0 }
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(source => {
      expect(source.productionWeights).toEqual(weights)
      return candidates().map(candidate => ({ ...candidate, workspace: { ...candidate.workspace, productionWeights: source.productionWeights } }))
    })
    const result = await runSmartRosterParallel(base, entries, { ...options, productionWeights: weights, enableDeepSearch: true }, async jobs => {
      expect(jobs.every(job => JSON.stringify(job.options?.productionWeights) === JSON.stringify(weights))).toBe(true)
      return jobs.map(simulateCandidate)
    })
    expect(result.status).toBe('draft')
    expect(result.workspace!.productionWeights).toEqual(weights)
    expect(base).toEqual(before)
  })
  it('inherits the source weights and accepts a completed zero-score objective', () => {
    const base = baseWorkspace(), weights = { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 }
    base.productionWeights = weights
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(source => {
      expect(source.productionWeights).toEqual(weights)
      return candidates().map(candidate => ({ ...candidate, workspace: { ...candidate.workspace, productionWeights: source.productionWeights } }))
    })
    const result = runSmartRoster(base, entries, options)
    expect(result.status).toBe('draft')
    expect(result.score).toBe(0)
    expect(result.diagnostics.some(d => d.code === 'SIMULATION_EVALUATION_FAILED')).toBe(false)
  })
  it('preserves the fully verified second-stage result when a deep-search worker fails', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    const result = await runSmartRosterParallel(baseWorkspace(), entries, { ...options, enableDeepSearch: true }, async (jobs, done) => {
      if (jobs[0]?.incomeComparison) throw new Error('deep worker failed')
      return jobs.map((job, i) => { const result = simulateCandidate(job); done(result, i); return result })
    })
    const baseline = runSmartRoster(baseWorkspace(), entries, options)
    expect(result.status).toBe('draft')
    expect(result.workspace).toEqual(baseline.workspace)
    expect(result.score).toEqual(baseline.score)
    expect(result.diagnostics).toContainEqual({ code: 'SEARCH_FALLBACK', message: '邻域深度搜索未产生进一步改动：deep worker failed' })
    expect(result.phases.search).toEqual({ improved: false, gain: 0 })
  })
  it('dispatches the four deep-search scenarios through the real batch executor', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    const input = { ...options, enableDeepSearch: true }, batches: number[] = [], progress: SmartRosterProgress[] = []
    const serial = runSmartRoster(baseWorkspace(), entries, input)
    const parallel = await runSmartRosterParallel(baseWorkspace(), entries, input, async (jobs, done) => {
      if (jobs[0]?.incomeComparison) {
        expect(jobs.every(job => job.incomeComparison)).toBe(true)
        batches.push(jobs.length)
      }
      const results = jobs.map(simulateCandidate)
      for (let i = results.length - 1; i >= 0; i--) done(results[i]!, i)
      return results
    }, p => progress.push(p))
    expect(batches).toEqual([4])
    expect(parallel).toEqual(serial)
    expect(parallel.phases.search?.result?.baseline.cases).toHaveLength(4)
    expect(progress.filter(p => p.phase === 'simulating').map(p => p.phaseProgress)).toEqual([0, 0.5, 1])
    expect(progress.some(p => p.phase === 'searching' && p.label.includes('场景 4/80'))).toBe(true)
  })
  it('reuses the winning completed simulation when the final input is unchanged', () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    const simulate = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    const result = runSmartRoster(baseWorkspace(), entries, options)
    expect(result.status).toBe('draft')
    expect(result.calculationReport?.summary?.totalScore82).toBe(result.score)
    expect(result.calculationReport?.summary?.goldValue).toBeGreaterThan(0)
    expect(simulate).toHaveBeenCalledTimes(2)
  })
  it('simulates the final input again when replacement changes an unevaluated field', () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    vi.spyOn(replacement, 'runGlobalPerCapitaReplacement').mockImplementation(workspace => {
      const changed = structuredClone(workspace)
      changed.mainPlan.conf.restInFull = ['砾']
      return { workspace: changed, swappedCount: 1, score: 1e9, logs: [] }
    })
    const simulate = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    const result = runSmartRoster(baseWorkspace(), entries, options)
    expect(result.status).toBe('draft')
    expect(simulate).toHaveBeenCalledTimes(3)
    expect(simulate.mock.calls[2]![0].mainPlan.conf.restInFull).toEqual(['砾'])
  })
  it('reuses repeated replacement evaluations and the final verified replacement', () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    vi.spyOn(replacement, 'runGlobalPerCapitaReplacement').mockImplementation((workspace, _inventory, opts) => {
      const changed = structuredClone(workspace)
      changed.mainPlan.conf.restInFull = ['砾']
      const first = opts!.evaluator!(changed)
      expect(opts!.evaluator!(changed)).toBe(first)
      return { workspace: changed, swappedCount: 1, score: 1e9, logs: [] }
    })
    const simulate = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    const result = runSmartRoster(baseWorkspace(), entries, options)
    expect(result.status).toBe('draft')
    expect(simulate).toHaveBeenCalledTimes(3)
    expect(result.score).not.toBe(1e9)
  })
  it('produces the identical full result with out-of-order completions and real simulations', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    const base = baseWorkspace(), original = structuredClone(base)
    const serial = runSmartRoster(base, entries, options)
    const progress: SmartRosterProgress[] = []
    const parallel = await runSmartRosterParallel(base, entries, options, async (jobs, done) => {
      const results = jobs.map(simulateCandidate)
      for (let i = results.length - 1; i >= 0; i--) done(results[i]!, i)
      return results
    }, p => progress.push(p))
    expect(serial.status).toBe('draft')
    expect(parallel).toEqual(serial)
    expect(base).toEqual(original)
    expect(progress.filter(p => p.phase === 'simulating').map(p => p.phaseProgress)).toEqual([0, 0.5, 1])
  })
  it('isolates backup input in serial and parallel automatic generation', async () => {
    const base=baseWorkspace()
    base.compatibility.backupPlans=[{trigger:'True',name:'must not enter generation'}]
    const original=structuredClone(base)
    vi.spyOn(synthesis,'generateMolecularCandidates').mockImplementation(source=>{
      expect(source.compatibility.backupPlans).toEqual([])
      return candidates()
    })
    const serial=runSmartRoster(base,entries,options)
    const parallel=await runSmartRosterParallel(base,entries,options,async jobs=>{
      jobs.forEach(job=>expect(job.workspace.compatibility.backupPlans).toEqual([]))
      return jobs.map(simulateCandidate)
    })
    expect(serial.status).toBe('draft')
    expect(parallel.status).toBe('draft')
    expect(serial.workspace!.compatibility.backupPlans).toEqual([])
    expect(parallel.workspace!.compatibility.backupPlans).toEqual([])
    expect(base).toEqual(original)
  })
  it('never dispatches an empty candidate set', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue([])
    const executor = vi.fn()
    const result = await runSmartRosterParallel(baseWorkspace(), entries, options, executor)
    expect(result.status).toBe('blocked')
    expect(result.diagnostics.some(d => d.code === 'INSUFFICIENT_STAFF')).toBe(true)
    expect(executor).not.toHaveBeenCalled()
  })
  it('simulates the available candidates when fewer than requested are distinct', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue(candidates().slice(0, 1))
    const executor = vi.fn(async jobs => jobs.map(simulateCandidate))
    const result = await runSmartRosterParallel(baseWorkspace(), entries, options, executor)
    expect(result.status).toBe('draft')
    expect(executor.mock.calls[0]![0]).toHaveLength(1)
    expect(result.diagnostics.some(d => d.code === 'FEWER_DISTINCT_BRANCHES')).toBe(true)
  })
  it('rejects a missing result instead of ranking a partial batch', async () => {
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(candidates)
    await expect(runSmartRosterParallel(baseWorkspace(), entries, options, async () => [])).rejects.toThrow('数量不完整')
  })
})
