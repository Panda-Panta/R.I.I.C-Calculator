import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import * as construction from './molecularSynthesis'
import * as computation from './computedManufacturingRoster'
import * as simulation from './candidateSimulation'
import { runSmartRoster, runSmartRosterParallel } from './smartRoster'

afterEach(() => vi.restoreAllMocks())

function scene() {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const manufacture = base.mainPlan.facilities.room_1_1
  manufacture.level = 1; manufacture.product = 'gold'
  manufacture.slots = [{ occupant: { kind: 'empty' }, groupId: null, replacements: [] }]
  const power = base.mainPlan.facilities.room_1_3
  power.level = 3; power.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  base.mainPlan.conf.workaholic = [id('Lancet-2')]
  const dorm = base.mainPlan.facilities.dormitory_1
  dorm.level = 1
  dorm.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  dorm.slots[0] = { occupant: { kind: 'operator', operatorId: id('杜林') }, groupId: null, replacements: [] } as typeof dorm.slots[number]
  const entries = fullCatalogIdleInventory().filter(entry => ['芬', '砾', '斑点', 'Lancet-2', '杜林'].some(name => entry.operator === id(name)))
  const proposals = ['芬', '砾', '斑点'].map((name, index) => {
    const workspace = structuredClone(base)
    workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id(name) }
    workspace.mainPlan.conf.workaholic.push(id(name))
    return { id: ['anchor', 'strong', 'other'][index]!, name, workspace, appliedAtoms: [],
      // Deliberately misleading mean scores must not override actual primary output.
      staticScore: index === 2 ? 1e9 : 0, simScore: null, diagnostics: [], confPolicy: {} }
  })
  return { base, entries, proposals }
}

function prepare() {
  const fixture = scene()
  const build = vi.spyOn(construction, 'generateMolecularCandidates').mockReturnValue(fixture.proposals)
  const slowModel = vi.spyOn(computation, 'computeManufacturingRoster').mockImplementation(() => { throw new Error('Unexpected slow default model') })
  const evaluate = vi.spyOn(simulation, 'simulateCandidate').mockImplementation(job => ({ completed: true,
    simScore: job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant.kind === 'operator' &&
      job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant.operatorId === id('砾') ? 120 : 100,
    diagnostics: [],
  }))
  return { ...fixture, build, slowModel, evaluate }
}

describe('fast high-output primary selection', () => {
  it('returns a completed strongest anchor after one F without eagerly evaluating a non-improving main', () => {
    const fixture = prepare()
    fixture.build.mockReturnValue([fixture.proposals[1]!, fixture.proposals[0]!])
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42 })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.phases.primarySelection!.selectedIds).toEqual(['strong'])
    expect(result.phases.simulation!.candidates.map(candidate => candidate.id)).toEqual(['strong'])
    expect(fixture.evaluate).toHaveBeenCalledTimes(1)
  })

  it('verifies the deferred main only after the strongest anchor fails, preserving parallel identities and the two-F budget', async () => {
    const fixture = prepare()
    fixture.build.mockReturnValue([fixture.proposals[1]!, fixture.proposals[0]!])
    fixture.evaluate.mockImplementation(job => {
      const occupant = job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant
      return occupant.kind === 'operator' && occupant.operatorId === id('砾')
        ? { completed: false, simScore: 1e9, diagnostics: ['anchor did not complete'] }
        : { completed: true, simScore: 100, diagnostics: [] }
    })
    const batches: string[][] = [], progress: number[] = []
    const result = await runSmartRosterParallel(fixture.base, fixture.entries, { seed: 42 }, async (jobs, done) => {
      batches.push(jobs.map(job => {
        const occupant = job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant
        return occupant.kind === 'operator' ? occupant.operatorId : ''
      }))
      const summaries = jobs.map(job => simulation.simulateCandidate(job))
      summaries.forEach((summary, index) => done(summary, index))
      return summaries
    }, state => { if (state.phase === 'simulating') progress.push(state.phaseProgress) })
    expect(batches).toEqual([[id('砾')], [id('芬')]])
    expect(result.status).toBe('draft')
    expect(result.score).toBe(100)
    expect(result.phases.simulation!.candidates[0]!.id).toBe('anchor')
    expect(result.phases.primarySelection!.selectedIds).toEqual(['strong', 'anchor'])
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true)
  })

  it.each(['incomplete', 'non-finite'] as const)('stops after two unsuccessful F results when the strongest anchor is %s', failure => {
    const fixture = prepare()
    fixture.build.mockReturnValue([fixture.proposals[1]!, fixture.proposals[0]!])
    fixture.evaluate.mockImplementation(() => failure === 'incomplete'
      ? { completed: false, simScore: 1e9, diagnostics: ['incomplete'] }
      : { completed: true, simScore: Infinity, diagnostics: ['non-finite'] })
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42 })
    expect(result.status).toBe('blocked')
    expect(result.score).toBeNull()
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    expect(result.phases.primarySelection!.selectedIds).toEqual(['strong', 'anchor'])
  })

  it('skips unconditional mathematical expansion and verifies strong primary plus anchor within two F', () => {
    const fixture = prepare(), before = JSON.stringify(fixture.base)
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42, branchCount: 99, simulationTopK: 99 })
    expect(fixture.build.mock.calls[0]![3]).toMatchObject({ branchCount: 3, requireWarmupExhaustion: true })
    expect(fixture.slowModel).not.toHaveBeenCalled()
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    expect(result.phases.simulation!.candidates.map(candidate => candidate.id).sort()).toEqual(['anchor', 'strong'])
    expect(result.phases.calculation).toBeUndefined()
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.workspace?.compatibility.backupPlans).toEqual([])
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(JSON.stringify(fixture.base)).toBe(before)
  })

  it('returns the verified anchor when the higher-primary candidate cannot complete F', () => {
    const fixture = prepare()
    fixture.evaluate.mockImplementation(job => {
      const occupant = job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant
      return occupant.kind === 'operator' && occupant.operatorId === id('砾')
        ? { completed: false, simScore: 1e9, diagnostics: ['incomplete'] }
        : { completed: true, simScore: 100, diagnostics: [] }
    })
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42 })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(100)
    expect(result.phases.simulation!.candidates[0]!.id).toBe('anchor')
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
  })

  it('keeps selected identities across reordered parallel dispatch and reuses the final exact job', async () => {
    const fixture = prepare(), serial = runSmartRoster(fixture.base, fixture.entries, { seed: 42 })
    fixture.evaluate.mockClear()
    const parallel = await runSmartRosterParallel(fixture.base, fixture.entries, { seed: 42 }, async (jobs, done) => {
      expect(jobs).toHaveLength(2)
      const results = jobs.map(job => simulation.simulateCandidate(job))
      for (let index = results.length - 1; index >= 0; index--) done(results[index]!, index)
      return results
    })
    expect(parallel.workspace).toEqual(serial.workspace)
    expect(parallel.score).toBe(serial.score)
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
  })
})
