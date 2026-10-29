import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as admission from './generatedBackupAdmission'
import * as fixedDuty from './fixedDuty'
import { simulateCandidate, simulateCandidateWithProgress, type CandidateSimulationJob } from './candidateSimulation'

const job = (): CandidateSimulationJob => ({ workspace: createDefaultWorkspace(),
  options: { warmupHours: 0, sampleHours: 1, production: { seed: 42, droneTarget: 'none' } },
  assumptions: { idleOperators: [] }, generatedBackup: { version: 'joint-production-v1',
    trigger: { observers: [{ operatorId: '阿米娅', roomId: 'central' }], activeWhen: 'all-present' } },
})
function report() {
  const input = job()
  return bridge.runScheduleSimulationBridge(input.workspace, input.options, input.assumptions).report!
}

afterEach(() => vi.restoreAllMocks())

describe('explicit generated backup simulation mode', () => {
  it('keeps arbitrary backups forbidden without a descriptor and stops invalid generated jobs before F', () => {
    const input = job(); delete input.generatedBackup
    input.workspace.compatibility.backupPlans = [{ trigger: 'True', plan: {} }]
    const run = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    expect(simulateCandidate(input)).toEqual({ completed: false, simScore: 0, diagnostics: ['AUTOMATIC_BACKUP_PLANS_FORBIDDEN'] })
    const check = vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: false, diagnostics: ['GENERATED_BACKUP_INVALID'] })
    input.generatedBackup = job().generatedBackup
    expect(simulateCandidate(input)).toMatchObject({ completed: false, diagnostics: ['GENERATED_BACKUP_INVALID'] })
    expect(check).toHaveBeenCalledWith(input)
    expect(run).not.toHaveBeenCalled()
  })

  it('returns a strict completed score, same-run display report and special operator summary', () => {
    const complete = report(), input = job()
    complete.operators.push({ operatorId: 'char_237_gravel', operatorName: '砾', initialMorale: 24, finalMorale: 23,
      mainWorkHours: 1, substituteWorkHours: 0, workHours: 1, restHours: 0, idleHours: 0,
      exhaustedHours: 0, workFraction: 1, workRestRatio: null })
    vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: true, diagnostics: [] })
    vi.spyOn(fixedDuty, 'hasConsumptionSkill').mockReturnValue(true)
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report: complete })
    const result = simulateCandidate(input)
    expect(result.completed).toBe(true)
    expect(result.incomeCase?.eligible).toBe(true)
    expect(result.simScore).toBe(result.incomeCase?.output?.daily.total)
    expect(result.calculationReport).toBeDefined()
    expect(result.specialOperators).toEqual([{ operatorId: 'char_237_gravel', operatorName: '砾', finalMorale: 23,
      workFraction: 1, workRestRatio: null, workHours: 1, restHours: 0, exhaustedHours: 0 }])
  })

  it('keeps partial windows, fatigue, bad ledgers and condition failures ineligible in generated mode', () => {
    const complete = report()
    vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: true, diagnostics: [] })
    const run = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    const mutations: ((value: typeof complete) => void)[] = [
      value => { value.observedHours = .5 },
      value => { delete (value.production!.sample as { completed?: unknown }).completed },
      value => { value.production!.ledger.balances.gold = NaN },
      value => { value.diagnostics.push({ code: 'MOWER_BACKUP_CONDITION_ERROR', message: 'condition failed' }) },
      value => { value.operators.push({ operatorId: 'char_237_gravel', operatorName: '砾', initialMorale: 0, finalMorale: 0,
        mainWorkHours: 0, substituteWorkHours: 0, workHours: 0, restHours: 0, idleHours: 0,
        exhaustedHours: 1, workFraction: 0, workRestRatio: null }) },
    ]
    for (const mutate of mutations) {
      const value = structuredClone(complete); mutate(value); run.mockReturnValue({ report: value })
      const result = simulateCandidate(job())
      expect(result.completed).toBe(false)
      expect(result.incomeCase?.eligible).toBe(false)
      expect(result.diagnostics.length).toBeGreaterThan(0)
      expect(result.calculationReport).toBeUndefined()
    }
  })

  it('reports a missing bridge report as an unfinished generated candidate', () => {
    vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: true, diagnostics: [] })
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report: null, error: 'blocked transition' })
    expect(simulateCandidate(job())).toEqual({ completed: false, simScore: 0, diagnostics: ['blocked transition'] })
  })

  it('forwards progress and preserves the ordinary and imported income comparison routes', () => {
    const complete = report()
    complete.diagnostics.push({ code: 'MOWER_BACKUP_CONDITION_ERROR', message: 'legacy import observation' })
    const check = vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: true, diagnostics: [] })
    const progress = { phase: 'sampling' as const, elapsedHours: 1, totalHours: 1, warmupHours: 0 }
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockImplementation((_workspace, _options, _assumptions, onProgress) => {
      onProgress?.(progress)
      return { report: complete }
    })
    const onProgress = vi.fn()
    const generated = simulateCandidateWithProgress(job(), onProgress)
    expect(generated.completed).toBe(false)
    expect(onProgress).toHaveBeenCalledWith(progress)
    const imported = job(); delete imported.generatedBackup; imported.incomeComparison = true
    imported.workspace.compatibility.backupPlans = [{ trigger: '1 / 0 > 0', plan: {} }]
    expect(simulateCandidate(imported)).toMatchObject({ completed: true, incomeCase: { eligible: true } })
    const ordinary = job(); delete ordinary.generatedBackup
    expect(simulateCandidate(ordinary)).toMatchObject({ completed: true, diagnostics: [] })
    expect(check).toHaveBeenCalledTimes(1)
  })
})
