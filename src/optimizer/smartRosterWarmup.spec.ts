import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as synthesis from './molecularSynthesis'
import * as computation from './computedManufacturingRoster'
import { runSmartRosterParallel } from './smartRoster'

const names = ['机械师', '酒神', '刻俄柏', '断罪者', '霜叶', 'Lancet-2', '杜林']
const entries = fullCatalogIdleInventory().filter(entry => names.some(name => entry.operator === id(name)))
const options = { branchCount: 1, simulationWarmupHours: 24, simulationSampleHours: 72,
  enableDeepSearch: false, droneTarget: 'none' as const, seed: 42 }

function fixture() {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) {
    if (!['room_1_1', 'room_1_3', 'dormitory_1'].includes(room.roomId)) { room.level = 0; room.slots = [] }
  }
  const room = base.mainPlan.facilities.room_1_1
  room.level = 2; room.product = 'exp'
  room.slots = Array.from({ length: 2 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
  base.mainPlan.facilities.room_1_3.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  base.mainPlan.facilities.dormitory_1.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))
  base.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('杜林') }
  base.mainPlan.conf.workaholic = [id('Lancet-2')]
  const workspace = structuredClone(base)
  workspace.mainPlan.facilities.room_1_1.slots = ['机械师', '酒神'].map((name, index) => ({
    occupant: { kind: 'operator', operatorId: id(name) }, groupId: 'warmup-crew',
    replacements: [id(index ? '霜叶' : '断罪者')], metadata: { locked: true },
  }))
  return { base, workspace }
}
function candidate(workspace: RosterWorkspace, name = 'warmup') {
  return { id: name, name, workspace, diagnostics: [], appliedAtoms: [], staticScore: 0, simScore: null, confPolicy: {} }
}
beforeEach(() => { vi.spyOn(computation, 'computeManufacturingRoster').mockReturnValue({
  workspace: null, diagnostics: [], calculation: { status: 'unsupported', libraryComplete: false,
    columnCount: 0, quantifiedColumnCount: 0, initialObjective: null, frozenComponents: [], elapsedMs: 0,
    proofScope: 'quantified-manufacturing-model-only' },
}) })
afterEach(() => vi.restoreAllMocks())

describe('automatic warmup policy reaches the evaluated and returned roster', () => {
  it('marks only the warmup primary, retains the whole group and reuses its completed report', async () => {
    const { base, workspace } = fixture()
    const beforeBase = structuredClone(base), beforeCandidate = structuredClone(workspace)
    const build = vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue([candidate(workspace)])
    const unexpectedSimulation = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    let batches = 0
    let simulated: RosterWorkspace | undefined
    const result = await runSmartRosterParallel(base, entries, options, async (jobs, done) => {
      batches++
      expect(jobs).toHaveLength(1)
      simulated = structuredClone(jobs[0]!.workspace)
      expect(simulated.mainPlan.conf.exhaust_require).toContain(id('机械师'))
      expect(simulated.mainPlan.conf.exhaust_require).not.toContain(id('酒神'))
      expect(simulated.mainPlan.facilities.room_1_1.slots).toEqual(beforeCandidate.mainPlan.facilities.room_1_1.slots)
      const summary = { completed: true, simScore: 12345, diagnostics: [] }
      done(summary, 0)
      return [summary]
    })
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('draft')
    expect(build.mock.calls[0]![3]).toMatchObject({ requireWarmupExhaustion: true })
    expect(build.mock.calls[0]![3]).toMatchObject({ branchCount: 3 })
    expect(computation.computeManufacturingRoster).not.toHaveBeenCalled()
    expect(result.workspace).toEqual(simulated)
    expect(result.score).toBe(12345)
    expect(result.phases.search).toBeNull()
    expect(batches).toBe(1)
    expect(unexpectedSimulation).not.toHaveBeenCalled()
    expect(base).toEqual(beforeBase)
    expect(workspace).toEqual(beforeCandidate)
  })

  it('rejects a warmup ordinary backup before any simulation and keeps the admissible plan', async () => {
    const { base, workspace } = fixture(), invalid = structuredClone(workspace)
    const slot = invalid.mainPlan.facilities.room_1_1.slots[0]!
    slot.occupant = { kind: 'operator', operatorId: id('断罪者') }; slot.replacements = [id('机械师')]
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue([candidate(invalid, 'invalid'), candidate(workspace)])
    const result = await runSmartRosterParallel(base, entries, options, async (jobs, done) => {
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('机械师') })
      const summary = { completed: true, simScore: 1, diagnostics: [] }; done(summary, 0); return [summary]
    })
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('draft')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_WARMUP_BACKUP')).toBe(true)
  })

  it('reports a locked warmup backup without moving it or starting generation', async () => {
    const { workspace } = fixture(), slot = workspace.mainPlan.facilities.room_1_1.slots[0]!
    slot.occupant = { kind: 'operator', operatorId: id('断罪者') }; slot.replacements = [id('机械师')]
    const before = structuredClone(workspace)
    const build = vi.spyOn(synthesis, 'generateMolecularCandidates')
    const dispatch = vi.fn()
    const result = await runSmartRosterParallel(workspace, entries, options, dispatch)
    expect(result.status).toBe('blocked')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_WARMUP_BACKUP')).toBe(true)
    expect(build).not.toHaveBeenCalled()
    expect(computation.computeManufacturingRoster).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(workspace).toEqual(before)
  })

  it('adds the policy for a locked warmup primary while preserving its assignment', async () => {
    const { workspace } = fixture(), before = structuredClone(workspace)
    const build = vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(base => [candidate(structuredClone(base))])
    const result = await runSmartRosterParallel(workspace, entries, options, async (jobs, done) => {
      expect(jobs).toHaveLength(1)
      const summary = { completed: true, simScore: 1, diagnostics: [] }; done(summary, 0); return [summary]
    })
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('draft')
    expect(result.workspace!.mainPlan.conf.exhaust_require).toContain(id('机械师'))
    expect(result.workspace!.mainPlan.facilities.room_1_1.slots).toEqual(before.mainPlan.facilities.room_1_1.slots)
    const constructionOptions = build.mock.calls[0]![3]!
    expect(constructionOptions.lockedPositions!.has('room_1_1:0')).toBe(true)
    expect(constructionOptions.lockedOperators!.has(id('机械师'))).toBe(true)
    expect(build.mock.calls[0]![0].mainPlan.conf.exhaust_require).toContain(id('机械师'))
    expect(computation.computeManufacturingRoster).not.toHaveBeenCalled()
    expect(workspace).toEqual(before)
  })

  it('surfaces the retained group earliest-exhaust limitation on the selected result', async () => {
    const { base, workspace } = fixture()
    workspace.mainPlan.facilities.room_1_1.slots[1]!.occupant = { kind: 'operator', operatorId: id('刻俄柏') }
    vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue([candidate(workspace)])
    const result = await runSmartRosterParallel(base, entries, options, async (jobs, done) => {
      expect(jobs).toHaveLength(1)
      const summary = { completed: true, simScore: 1, diagnostics: [] }; done(summary, 0); return [summary]
    })
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('draft')
    expect(result.workspace!.mainPlan.conf.exhaust_require).toEqual(expect.arrayContaining([id('机械师'), id('刻俄柏')]))
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'WARMUP_GROUP_EARLIEST_EXHAUST')).toHaveLength(1)
  })
})
