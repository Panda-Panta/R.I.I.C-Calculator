import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runRosterIncomeSearch, runRosterIncomeSearchParallel, type IncomeSearchProgress } from './rosterIncomeSearch'
import { simulateCandidate, type CandidateSimulationJob } from './candidateSimulation'
import * as neighborhood from './backupNeighborhood'
import * as scoring from './incomeComparison'

const inventory = ['砾', '断罪者', '芬', '香草', '调香师', 'Castle-3'].map(operator => ({
  operator, elitePhase: ['芬', '香草'].includes(operator) ? 1 : operator === 'Castle-3' ? 0 : 2,
  level: operator === 'Castle-3' ? 30 : ['芬', '香草'].includes(operator) ? 55 : 70,
}))
function workspace(node = 'O') {
  const w = createDefaultWorkspace()
  for (const [index, operator] of ['砾', '断罪者'].entries()) {
    const slot = w.mainPlan.facilities[index === 0 ? 'room_1_1' : 'room_1_2'].slots[0]!
    slot.occupant = { kind: 'operator', operatorId: id(operator) }
    slot.replacements = [id(index === 0 ? (['A', 'C'].includes(node) ? '调香师' : '芬') : (['B', 'C'].includes(node) ? 'Castle-3' : '香草'))]
  }
  return w
}
function node(w: ReturnType<typeof workspace>) {
  const a = w.mainPlan.facilities.room_1_1.slots[0]!.replacements[0] === id('调香师')
  const b = w.mainPlan.facilities.room_1_2.slots[0]!.replacements[0] === id('Castle-3')
  return a ? b ? 'C' : 'A' : b ? 'B' : 'O'
}
const request = () => ({ baseline: workspace(), inventory, mode: 'hill-climb' as const, objective: 'lmd' as const, maxCandidates: 5, maxDepth: 3,
  options: { sampleHours: 1, warmupHours: 0, production: { droneTarget: 'none' as const } } })
afterEach(() => vi.restoreAllMocks())

describe('parallel income scenarios keep the adaptive search serial', () => {
  it('matches the complete serial result despite reverse completion and reuses a rejected-parent route', async () => {
    const graph = { O: ['A', 'B'], A: ['C', 'O'], B: ['C'], C: ['A', 'B', 'O'] }
    vi.spyOn(neighborhood, 'generateBackupNeighbors').mockImplementation(w => graph[node(w)].map(next => ({
      label: next, workspace: workspace(next), move: { kind: 'replace', positions: [next] },
    })))
    const summarize = scoring.summarizeIncome
    vi.spyOn(scoring, 'summarizeIncome').mockImplementation(report => {
      const key = node(report.inputs.schedule.sourceWorkspace), c = summarize(report)
      c.daily.lmd += { O: 0, A: 100, B: 50, C: 200 }[key]; c.closing.lmd += c.daily.lmd
      c.daily.gold += { O: 0, A: 20, B: 0, C: 10 }[key]; c.closing.gold += c.daily.gold
      return c
    })
    const input = request(), before = structuredClone(input), batches: CandidateSimulationJob[][] = [], progress: IncomeSearchProgress[] = []
    const serial = runRosterIncomeSearch(input)
    const parallel = await runRosterIncomeSearchParallel(input, async (jobs, done) => {
      batches.push(jobs)
      const results = jobs.map(simulateCandidate)
      for (let i = results.length - 1; i >= 0; i--) done(results[i]!, i)
      return results
    }, p => progress.push(p))
    expect(parallel).toEqual(serial)
    expect(parallel.bestPath.map(key => node(parallel.candidates.find(c => c.id === key)!.workspace))).toEqual(['O', 'B', 'C'])
    expect(batches).toHaveLength(4)
    expect(batches.every(jobs => jobs.length === 4 && jobs.every(job => job.incomeComparison))).toBe(true)
    expect(parallel.simulatedCandidates).toBe(4); expect(parallel.evaluatedCandidates).toBe(5)
    expect(progress.filter(p => p.completed).map(p => p.completed!.id)).toEqual(serial.candidates.map(c => c.id))
    expect(progress[progress.length - 1]!.completedScenarios).toBe(16)
    expect(input).toEqual(before)
  })
  it('keeps incomplete real reports ineligible instead of inventing zero-score labels', async () => {
    const input = { ...request(), maxCandidates: 2, options: { ...request().options, maxEvents: 1 } }
    const result = await runRosterIncomeSearchParallel(input, async jobs => jobs.map(simulateCandidate))
    expect(result).toEqual(runRosterIncomeSearch(input))
    expect(result.baseline.cases.every(c => !c.eligible)).toBe(true)
    expect(result.bestCandidateId).toBeNull()
  })
  it('rejects missing scenario results and propagates executor failure', async () => {
    await expect(runRosterIncomeSearchParallel(request(), async () => [])).rejects.toThrow('数量不完整')
    await expect(runRosterIncomeSearchParallel(request(), async () => { throw new Error('worker failed') })).rejects.toThrow('worker failed')
  })
  it('rejects unordered or absent scenario evidence instead of comparing the wrong seed', async () => {
    await expect(runRosterIncomeSearchParallel(request(), async jobs => jobs.map(simulateCandidate).reverse())).rejects.toThrow('顺序错误')
    await expect(runRosterIncomeSearchParallel(request(), async jobs => jobs.map(() => ({ completed: true, simScore: 1, diagnostics: [] })))).rejects.toThrow('证据缺失')
  })
})
