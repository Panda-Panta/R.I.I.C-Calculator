import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import type { RosterWorkspace } from '../domain/roster'
import { runSmartRoster } from './smartRoster'
import * as synthesis from './molecularSynthesis'
import * as computation from './computedManufacturingRoster'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'

const fakeBridge = vi.hoisted(() => {
  const complete = (_workspace: unknown, options: unknown) => ({ report: {
    success: true, observedHours: 72, elapsedHours: 96, assumptions: { warmupHours: 24 }, inputs: { options },
    operators: [], diagnostics: [], production: { success: true, assumptions: { outputMode: 'potential' }, events: [],
      manufacturing: [], sample: { completed: { exp: 1000, gold: 100, orderLmd: 5000 } } },
  } })
  return { complete, run: vi.fn(complete) }
})
vi.mock('../workbench/scheduleSimulationBridge', () => ({ runScheduleSimulationBridge: fakeBridge.run }))

const owned = [{ operator: '砾', elitePhase: 1, level: 60 }, { operator: '芬', elitePhase: 1, level: 55 }]
function fixture(name?: string) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (!['room_1_1', 'room_1_3'].includes(room.roomId)) { room.level = 0; room.slots = [] }
  }
  workspace.mainPlan.facilities.room_1_1.level = 1
  workspace.mainPlan.facilities.room_1_1.slots = [{
    occupant: name ? { kind: 'operator', operatorId: name } : { kind: 'empty' }, groupId: null, replacements: [],
  }]
  workspace.mainPlan.conf.workaholic = name ? [name] : []
  return workspace
}
function construction(workspace: RosterWorkspace) {
  return { id: 'initial', name: 'initial', workspace, diagnostics: [], appliedAtoms: [], staticScore: 0, simScore: null, confPolicy: {} }
}
beforeEach(() => {
  fakeBridge.run.mockReset().mockImplementation(fakeBridge.complete)
  vi.spyOn(synthesis, 'generateMolecularCandidates').mockImplementation(() => [construction(fixture('砾'))])
  vi.spyOn(computation, 'computeManufacturingRoster').mockImplementation(() => ({
    workspace: fixture('芬'), diagnostics: [], calculation: { status: 'complete', libraryComplete: true,
      columnCount: 2, quantifiedColumnCount: 2, initialObjective: 10, frozenComponents: [], elapsedMs: 0,
      proofScope: 'quantified-manufacturing-model-only' },
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('one construction and one calculated assignment before formal verification', () => {
  it('verifies both complete inputs once, ignoring legacy branch-count and top-K controls', () => {
    let admitted = 0
    const result = runSmartRoster(fixture(), owned, { seed: 20260919, branchCount: 99, trials: 1, simulationTopK: 1, enableDeepSearch: false }, progress => {
      if (progress.phase === 'simulating' && progress.phaseProgress === 0) {
        admitted = progress.totalTrials!
        expect(admitted).toBe(2)
        expect(runScheduleSimulationBridge).not.toHaveBeenCalled()
      }
    })
    expect(synthesis.generateMolecularCandidates).toHaveBeenCalledTimes(1)
    expect(vi.mocked(synthesis.generateMolecularCandidates).mock.calls[0]![3]).toMatchObject({ branchCount: 1 })
    expect(computation.computeManufacturingRoster).toHaveBeenCalledTimes(1)
    expect(result.phases.simulation!.candidates).toHaveLength(admitted)
    expect(new Set(result.phases.simulation!.candidates.map(candidate => candidate.id))).toEqual(new Set(['initial', 'computed-assignment']))
    const calls = vi.mocked(runScheduleSimulationBridge).mock.calls
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(call => JSON.stringify(call[0]))).size).toBe(2)
    expect(calls.every(call => call[1]?.production?.runOrderMode === 'ideal')).toBe(true)
    expect(result.phases.calculation).toMatchObject({ status: 'complete', proofScope: 'quantified-manufacturing-model-only' })
  })

  it('does not rank an incomplete initial report even if its partial production is very high', () => {
    const complete = vi.mocked(runScheduleSimulationBridge).getMockImplementation()!(createDefaultWorkspace(), {})
    vi.mocked(runScheduleSimulationBridge).mockReturnValueOnce({ ...complete, report: { ...complete.report!, success: false,
      observedHours: 13, production: { ...complete.report!.production!, sample: { ...complete.report!.production!.sample,
        completed: { exp: 1e9, gold: 1e9, orderLmd: 1e9 } } } } })
    const result = runSmartRoster(fixture(), owned, { seed: 20260919, enableDeepSearch: false })
    expect(result.status).toBe('draft')
    expect(result.phases.simulation!.candidates.find(candidate => candidate.id === 'initial')!.simScore).toBeNull()
    expect(result.phases.simulation!.candidates[0]!.id).toBe('computed-assignment')
    expect(runScheduleSimulationBridge).toHaveBeenCalledTimes(2)
  })

  it('does not calculate an assignment or start simulation if no initial roster can be constructed', () => {
    vi.mocked(synthesis.generateMolecularCandidates).mockReturnValue([])
    const result = runSmartRoster(fixture(), owned, { enableDeepSearch: false })
    expect(result.status).toBe('blocked')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'INSUFFICIENT_STAFF')).toBe(true)
    expect(computation.computeManufacturingRoster).not.toHaveBeenCalled()
    expect(runScheduleSimulationBridge).not.toHaveBeenCalled()
  })
})
