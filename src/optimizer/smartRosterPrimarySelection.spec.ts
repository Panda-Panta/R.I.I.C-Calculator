import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import type { CalculationReport } from '../domain/types'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import * as nativeSimulation from '../workbench/scheduleSimulationBridge'
import * as construction from './molecularSynthesis'
import * as computation from './computedManufacturingRoster'
import * as simulation from './candidateSimulation'
import * as crewCandidates from './mainRosterCrewCandidates'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import * as freeCandidates from './mainRosterFreeCandidates'
import * as recoveryCandidates from './mainRosterRecoveryCandidates'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'
import { runSmartRoster, runSmartRosterParallel, type SmartRosterProgress } from './smartRoster'

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

// Controlled compact outputs verify actual smartRosterSteps wiring, not Native
// F production or the physical derivation of the duty-quality summary.
function wiredSummary(score: number, eligible = true): simulation.CandidateSimulationResult {
  const calculationReport: CalculationReport = {
    power: { generation: 270, consumption: 10, margin: 260, sufficient: true },
    layoutValid: true, validationMessages: [], manufacture: [], trading: [], drones: 0, morale: [], roomShiftDetails: {},
    summary: { exp: 0, goldCount: 0, goldValue: 0, virtualGoldCount: 0, virtualGoldValue: 0,
      orderLmd: 0, fragments: 0, orundum: 0, goldConsumed: 0, fragmentsConsumed: 0,
      netGoldCount: 0, netGoldValue: 0, totalScore82: score, totalEquivalentLmd: 0 },
  }
  return { completed: true, simScore: score, diagnostics: [], calculationReport,
    quality: { eligible, strict: eligible, ordinaryExhaustedHours: eligible ? 0 : 2,
      pendingDeferrals: eligible ? 0 : 1, issues: eligible ? [] : ['controlled unresolved recovery'] } }
}

function prepareContinuation() {
  const fixture = prepare()
  fixture.build.mockImplementation(base => [fixture.proposals[1]!, fixture.proposals[0]!].map(source => ({
    ...source, workspace: { ...structuredClone(source.workspace), productionWeights: structuredClone(base.productionWeights) },
  })))
  const nativeF = vi.spyOn(nativeSimulation, 'runScheduleSimulationBridge').mockImplementation(() => {
    throw new Error('Unexpected real F in the controlled smartRosterSteps wiring test')
  })
  const proposal = (workspace: RosterWorkspace, family: 'recovery' | 'free') => {
    const candidate = structuredClone(workspace), slot = candidate.mainPlan.facilities.room_1_1.slots[0]!
    slot.groupId = `wired-${family}`
    if (family === 'free') {
      slot.occupant = { kind: 'operator', operatorId: id('斑点') }
      slot.replacements = [id('砾')]
    }
    expect(validatePhysicalRoster(candidate)).toEqual([])
    expect(recoveryGroupCapacityIssues(candidate)).toEqual([])
    expect(compileRosterSchedule(candidate).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
    return { id: `wired-${family}`, workspace: candidate }
  }
  const recovery = vi.spyOn(recoveryCandidates, 'generateMainRosterRecoveryCandidates').mockReturnValue({ candidates: [], diagnostics: [] })
  const free = vi.spyOn(freeCandidates, 'generateMainRosterFreeCandidates').mockReturnValue({ candidates: [], diagnostics: [] })
  const crew = vi.spyOn(crewCandidates, 'generateMainRosterCrewCandidates').mockReturnValue({ candidates: [], diagnostics: [] })
  fixture.evaluate.mockImplementation(job => wiredSummary(
    job.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId?.startsWith('wired-') ? 140 : 120))
  return { ...fixture, nativeF, proposal, recovery, free, crew }
}

describe('continued main-roster optimization through actual smartRosterSteps', () => {
  it('keeps optimization disabled by default even if free combinations is selected', () => {
    const fixture = prepareContinuation(), progress: SmartRosterProgress[] = []
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42, allowFreeCombinations: true }, value => progress.push(value))
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.phases.mainOptimization).toBeUndefined()
    expect(fixture.recovery).not.toHaveBeenCalled()
    expect(fixture.free).not.toHaveBeenCalled()
    expect(fixture.crew).not.toHaveBeenCalled()
    expect(fixture.evaluate).toHaveBeenCalledTimes(1)
    expect(fixture.nativeF).not.toHaveBeenCalled()
    expect(progress.some(value => value.incumbent)).toBe(false)
  })

  it('enables bounded recovery through the real pipeline and retains the original F comparison context', () => {
    const fixture = prepareContinuation(), before = structuredClone(fixture.base)
    fixture.recovery.mockImplementation(workspace => ({ candidates: [fixture.proposal(workspace, 'recovery')], diagnostics: [] }))
    const weights = { exp: 2, gold: 1.3, orders: 0.7, fragments: 0, orundum: 0 }
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 43,
      enableMainOptimization: true, optimizationMaxSimulations: 1, simulationWarmupHours: 12,
      simulationSampleHours: 36, productionWeights: weights, droneTarget: 'none' })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(140)
    expect(result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, acceptedCandidates: 1, improved: true, gain: 20 })
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('wired-recovery')
    expect(fixture.free).not.toHaveBeenCalled()
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    const baselineJob = fixture.evaluate.mock.calls[0]![0], optimizedJob = fixture.evaluate.mock.calls[1]![0]
    expect(optimizedJob.options).toEqual(baselineJob.options)
    expect(optimizedJob.assumptions).toEqual(baselineJob.assumptions)
    expect(optimizedJob.options).toMatchObject({ warmupHours: 12, sampleHours: 36, productionWeights: weights,
      production: { seed: 43, droneTarget: 'none' }, operatorInventory: fixture.entries })
    expect(fixture.nativeF).not.toHaveBeenCalled()
    expect(fixture.base).toEqual(before)
  })

  it('dispatches a valid free crew through the public parallel runner and publishes its same-F display score', async () => {
    const fixture = prepareContinuation(), progress: SmartRosterProgress[] = [], batches: simulation.CandidateSimulationJob[][] = []
    fixture.free.mockImplementation(workspace => ({ candidates: [fixture.proposal(workspace, 'free')], diagnostics: [] }))
    const result = await runSmartRosterParallel(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: 1 }, async (jobs, onComplete) => {
      batches.push(structuredClone(jobs))
      const results = jobs.map(job => simulation.simulateCandidate(job))
      results.forEach((summary, index) => onComplete(summary, index))
      return results
    }, value => progress.push(value))
    expect(batches.map(jobs => jobs.length)).toEqual([1, 1])
    expect(batches[1]![0]!.options).toEqual(batches[0]![0]!.options)
    expect(batches[1]![0]!.assumptions).toEqual(batches[0]![0]!.assumptions)
    expect(result.status).toBe('draft')
    expect(result.score).toBe(140)
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('斑点') })
    expect(result.calculationReport?.summary?.totalScore82).toBe(140)
    expect(result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, acceptedCandidates: 1 })
    expect(progress.flatMap(value => value.incumbent ? [[value.incumbent.score, value.incumbent.calculationReport?.summary?.totalScore82]] : []))
      .toEqual([[120, 120], [140, 140]])
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it('rejects a higher free score with ineligible quality through the actual pipeline', () => {
    const fixture = prepareContinuation(), progress: SmartRosterProgress[] = []
    fixture.free.mockImplementation(workspace => ({ candidates: [fixture.proposal(workspace, 'free')], diagnostics: [] }))
    fixture.evaluate.mockImplementation(job => job.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId === 'wired-free'
      ? wiredSummary(1e9, false) : wiredSummary(120))
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true }, value => progress.push(value))
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 1, acceptedCandidates: 0, improved: false })
    expect(result.phases.mainOptimization?.candidates[0]).toMatchObject({ id: 'wired-free', score: 1e9, eligible: false })
    expect(progress.flatMap(value => value.incumbent ? [value.incumbent.score] : [])).toEqual([120])
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it('publishes the qualified baseline incumbent before any optional proposal is constructed', () => {
    const fixture = prepareContinuation(), events: string[] = []
    fixture.recovery.mockImplementation(() => { events.push('recovery-proposals'); return { candidates: [], diagnostics: [] } })
    fixture.free.mockImplementation(() => { events.push('free-proposals'); return { candidates: [], diagnostics: [] } })
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true }, state => {
      if (state.incumbent) {
        expect(state.incumbent.calculationReport?.summary?.totalScore82).toBe(state.incumbent.score)
        events.push(`incumbent:${state.incumbent.score}`)
      }
      if (state.phase === 'done') events.push('done')
    })
    expect(events).toEqual(['incumbent:120', 'recovery-proposals', 'free-proposals', 'done'])
    expect(result.status).toBe('draft')
    expect(fixture.evaluate).toHaveBeenCalledTimes(1)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it.each(['recovery', 'free'] as const)('returns the completed fast baseline if optional %s generation throws', family => {
    const fixture = prepareContinuation(), progress: SmartRosterProgress[] = []
    fixture[family].mockImplementation(() => { throw new Error('proposal construction failed') })
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true }, value => progress.push(value))
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(result.calculationReport?.summary?.totalScore82).toBe(120)
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_OPTIMIZATION_FAILED')).toBe(true)
    expect(progress[progress.length - 1]?.phase).toBe('done')
    expect(progress.flatMap(value => value.incumbent ? [value.incumbent.score] : [])).toEqual([120])
    expect(fixture.evaluate).toHaveBeenCalledTimes(1)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })
})

function controlledWholeCrew(workspace: RosterWorkspace, step: number) {
  const candidate = structuredClone(workspace), slot = candidate.mainPlan.facilities.room_1_1.slots[0]!
  const workers = ['斑点', '芬', '砾'] as const
  // Keep the longer budget chain legal when Fang's generated warmup policy
  // becomes active: Fang remains a primary or idle, never an unsupported relief.
  const main = step <= 2 ? workers[step - 1]! : step % 2 ? '芬' : '斑点'
  const relief = step === 2 ? '斑点' : '砾'
  slot.occupant = { kind: 'operator', operatorId: id(main) }
  slot.replacements = [id(relief)]
  slot.groupId = `wired-crew-${step}`
  expect(validatePhysicalRoster(candidate)).toEqual([])
  expect(recoveryGroupCapacityIssues(candidate)).toEqual([])
  expect(compileRosterSchedule(candidate).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
  return { id: `wired-crew-${step}`, workspace: candidate }
}

describe('whole-crew and recovery iteration through actual smartRosterSteps', () => {
  it.each([undefined, false])('does not request whole-crew proposals with allowFreeCombinations=%s', allowFreeCombinations => {
    const fixture = prepareContinuation()
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42, enableMainOptimization: true, allowFreeCombinations })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(fixture.crew).not.toHaveBeenCalled()
    expect(fixture.free).not.toHaveBeenCalled()
    expect(fixture.evaluate).toHaveBeenCalledTimes(1)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it('passes the original input and explicit locks to the opt-in crew constructor', () => {
    const fixture = prepareContinuation(), original = structuredClone(fixture.base)
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true })
    expect(result.status).toBe('draft')
    expect(fixture.crew).toHaveBeenCalledTimes(1)
    const [seed, inventory, options] = fixture.crew.mock.calls[0]!
    expect(seed.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(options?.allowFreeCombinations).toBe(true)
    expect(options?.userBase?.mainPlan).toEqual(original.mainPlan)
    expect(options?.userBase?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'empty' })
    expect(options?.lockedPositions).toEqual(new Set(['room_1_3:0', 'dormitory_1:0']))
    expect(options?.lockedOperators).toEqual(new Set([id('Lancet-2'), id('杜林')]))
    expect(inventory.valid).toBe(true)
    expect(inventory.operators.map(operator => operator.charId).sort()).toEqual(fixture.entries.map(entry => entry.operator).sort())
    expect(fixture.base).toEqual(original)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it('continues from a qualified whole-crew winner and retains each same-run compact report', () => {
    const fixture = prepareContinuation(), progress: SmartRosterProgress[] = []
    fixture.crew.mockImplementation(workspace => {
      const tag = workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId
      const step = tag === 'wired-crew-1' ? 2 : tag === 'wired-crew-2' ? 0 : 1
      return { candidates: step ? [controlledWholeCrew(workspace, step)] : [], diagnostics: [] }
    })
    fixture.evaluate.mockImplementation(job => {
      const tag = job.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId
      const result = wiredSummary(tag === 'wired-crew-1' ? 140 : tag === 'wired-crew-2' ? 160 : 120)
      result.calculationReport!.efficiencyNotes = [tag ?? 'initial-F']
      return result
    })
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true }, state => progress.push(state))
    expect(result.score).toBe(160)
    expect(result.workspace?.mainPlan.facilities.room_1_1.slots[0]).toMatchObject({
      occupant: { kind: 'operator', operatorId: id('芬') }, replacements: [id('斑点')], groupId: 'wired-crew-2',
    })
    expect(result.calculationReport?.summary?.totalScore82).toBe(160)
    expect(result.calculationReport?.efficiencyNotes).toEqual(['wired-crew-2'])
    const nextSeed = fixture.crew.mock.calls.find(([workspace]) => workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId === 'wired-crew-1')
    expect(nextSeed).toBeDefined()
    expect(nextSeed![0].mainPlan.facilities.room_1_1.slots[0]).toMatchObject({
      occupant: { kind: 'operator', operatorId: id('斑点') }, replacements: [id('砾')],
    })
    for (const [, , options] of fixture.crew.mock.calls) {
      expect(options?.userBase?.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'empty' })
      expect(options?.lockedPositions).toEqual(new Set(['room_1_3:0', 'dormitory_1:0']))
    }
    expect(progress.flatMap(state => state.incumbent ? [[state.incumbent.score,
      state.incumbent.calculationReport?.summary?.totalScore82, state.incumbent.calculationReport?.efficiencyNotes?.[0]]] : []))
      .toEqual([[120, 120, 'initial-F'], [140, 140, 'wired-crew-1'], [160, 160, 'wired-crew-2']])
    expect(fixture.evaluate).toHaveBeenCalledTimes(3)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it('compares a winning crew-plus-recovery state even when both separate changes lose within the default three F', () => {
    const fixture = prepareContinuation()
    fixture.entries.push(fullCatalogIdleInventory().find(entry => entry.operator === id('安赛尔'))!)
    const hasCrew = (workspace: RosterWorkspace) => workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant.kind === 'operator'
      && workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant.operatorId === id('斑点')
    const hasRecovery = (workspace: RosterWorkspace) => workspace.mainPlan.facilities.dormitory_1.slots[1]!.occupant.kind === 'operator'
      && workspace.mainPlan.facilities.dormitory_1.slots[1]!.occupant.operatorId === id('安赛尔')
    fixture.crew.mockImplementation(workspace => ({ candidates: hasCrew(workspace) ? [] : [controlledWholeCrew(workspace, 1)], diagnostics: [] }))
    fixture.recovery.mockImplementation(workspace => {
      if (hasRecovery(workspace)) return { candidates: [], diagnostics: [] }
      const candidate = structuredClone(workspace)
      candidate.mainPlan.facilities.dormitory_1.slots[1]!.occupant = { kind: 'operator', operatorId: id('安赛尔') }
      expect(validatePhysicalRoster(candidate)).toEqual([])
      expect(recoveryGroupCapacityIssues(candidate)).toEqual([])
      expect(compileRosterSchedule(candidate).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
      return { candidates: [{ id: 'wired-dorm-recovery', workspace: candidate }], diagnostics: [] }
    })
    fixture.evaluate.mockImplementation(job => wiredSummary(hasCrew(job.workspace) && hasRecovery(job.workspace)
      ? 200 : hasCrew(job.workspace) || hasRecovery(job.workspace) ? 110 : 120))
    const result = runSmartRoster(fixture.base, fixture.entries, { seed: 42,
      enableMainOptimization: true, allowFreeCombinations: true })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(200)
    expect(hasCrew(result.workspace!)).toBe(true)
    expect(hasRecovery(result.workspace!)).toBe(true)
    expect(result.calculationReport?.summary?.totalScore82).toBe(200)
    expect(result.phases.mainOptimization).toMatchObject({ evaluatedCandidates: 3, improved: true, gain: 80 })
    const compared = fixture.evaluate.mock.calls.slice(1).map(([job]) => `${hasCrew(job.workspace)}:${hasRecovery(job.workspace)}`)
    expect(compared.sort()).toEqual(['false:true', 'true:false', 'true:true'])
    expect(fixture.evaluate).toHaveBeenCalledTimes(4)
    expect(fixture.nativeF).not.toHaveBeenCalled()
  })

  it.each([{ requested: 2, expected: 2 }, { requested: 999, expected: 8 }])(
    'returns identical serial and parallel winners while keeping $expected total extra F across winner rounds', async ({ requested, expected }) => {
      const fixture = prepareContinuation()
      // Distinct full jobs form a controlled improvement chain. Their scores
      // prove shared dispatch budgets, not a physical gain from group labels.
      const stepOf = (workspace: RosterWorkspace) => Number(workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId?.match(/^wired-crew-(\d+)$/)?.[1] ?? 0)
      fixture.crew.mockImplementation(workspace => {
        const candidate = controlledWholeCrew(workspace, stepOf(workspace) + 1)
        expect(applyGeneratedWarmupPolicy(structuredClone(candidate.workspace), compileOperatorInventory(fixture.entries)).valid).toBe(true)
        return { candidates: [candidate], diagnostics: [] }
      })
      fixture.evaluate.mockImplementation(job => wiredSummary(120 + stepOf(job.workspace) * 20))
      const options = { seed: 42, enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: requested }
      const serial = runSmartRoster(fixture.base, fixture.entries, options)
      const serialJobs = fixture.evaluate.mock.calls.map(([job]) => structuredClone(job))
      expect(serial.diagnostics.filter(issue => issue.code === 'MAIN_OPTIMIZATION_FAILED')).toEqual([])
      expect(serialJobs).toHaveLength(1 + expected)
      expect(new Set(serialJobs.map(job => JSON.stringify(job))).size).toBe(1 + expected)
      for (const job of serialJobs) {
        expect(job.options).toEqual(serialJobs[0]!.options)
        expect(job.assumptions).toEqual(serialJobs[0]!.assumptions)
      }
      fixture.evaluate.mockClear()
      const parallel = await runSmartRosterParallel(fixture.base, fixture.entries, options, async (jobs, onComplete) => {
        const results = jobs.map(job => simulation.simulateCandidate(job))
        for (let index = results.length - 1; index >= 0; index--) onComplete(results[index]!, index)
        return results
      })
      expect(fixture.evaluate).toHaveBeenCalledTimes(1 + expected)
      expect(fixture.evaluate.mock.calls.map(([job]) => job)).toEqual(serialJobs)
      expect(parallel).toEqual(serial)
      expect(parallel.score).toBe(120 + expected * 20)
      expect(parallel.phases.mainOptimization).toMatchObject({ evaluatedCandidates: expected, termination: 'simulation-budget',
        searchScope: 'generated-neighborhood', globalOptimumProven: false, fullFUpperBound: null })
      expect(parallel.calculationReport?.summary?.totalScore82).toBe(parallel.score)
      expect(fixture.nativeF).not.toHaveBeenCalled()
    })
})
