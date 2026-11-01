import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as admission from './generatedBackupAdmission'
import * as fixedDuty from './fixedDuty'
import { candidateScoreImproves, isQualifiedCandidateSimulation, simulateCandidate, simulateCandidateWithProgress, type CandidateSimulationJob } from './candidateSimulation'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createLedger } from '../simulator/resourceLedger'
import { createDroneState } from '../simulator/droneTimeline'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { scoreSimulationProduction } from '../simulator/productionScore'

const job = (): CandidateSimulationJob & { options: NonNullable<CandidateSimulationJob['options']> } => ({ workspace: createDefaultWorkspace(),
  options: { warmupHours: 0, sampleHours: 1, production: { seed: 42, droneTarget: 'none' } },
  assumptions: { idleOperators: [] }, generatedBackup: { version: 'joint-production-v1',
    trigger: { observers: [{ operatorId: '阿米娅', roomId: 'central' }], activeWhen: 'all-present' } },
})
/** A complete empty-roster fixture. No Native calendar runs in these tests. */
function report(): ScheduleSimulationReport {
  const input = job()
  return { schemaVersion: 1, engine: 'mower-morale-v1', success: true, elapsedHours: 1, observedHours: 1,
    inputs: { schedule: compileRosterSchedule(input.workspace, input.assumptions), options: input.options },
    assumptions: { schedulingModel: 'mower-alpha', warmupHours: 0, sampleHours: 1, maxStepHours: .25,
      warmupModel: 'continuous', restingThreshold: .65, operationDurationHours: 0,
      dormAtmosphere: 'fixture', singleRecoveryTarget: 'fixture' },
    operators: [], rooms: [], events: [], segments: [], diagnostics: [], shiftDeferrals: [],
    production: { success: true, ledger: createLedger({}),
      sample: { completed: { exp: 1000, gold: 2, orderLmd: 500 }, opening: {}, closing: {}, inflows: {}, outflows: {}, net: {} },
      materialsConsumed: {}, drones: createDroneState(0, 200), manufacturing: [], trading: [], events: [],
      assumptions: { outputMode: 'potential', inventoryMode: 'unlimited', seed: 42, runOrderMode: 'ideal',
        droneTarget: 'none', droneReserve: 0, collectionIntervalHours: 0, orderSnapshotPolicy: 'fixture' } },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('shared complete candidate qualification', () => {
  it('treats the observed same-production denominator drift as a tie', () => {
    const baseline = 101066.66667276855, sameProduction = 101066.66667440505
    expect(candidateScoreImproves(sameProduction, baseline)).toBe(false)
    expect(candidateScoreImproves(baseline + 0.001, baseline)).toBe(true)
    expect(candidateScoreImproves(Number.NaN, baseline)).toBe(false)
  })

  it('requires same-run duty evidence and a matching display score before either search accepts a result', () => {
    vi.spyOn(admission, 'validateGeneratedBackupCandidate').mockReturnValue({ valid: true, diagnostics: [] })
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report: report() })
    const complete = simulateCandidate(job())
    expect(isQualifiedCandidateSimulation(complete)).toBe(true)
    expect(isQualifiedCandidateSimulation(undefined)).toBe(false)
    expect(isQualifiedCandidateSimulation({ ...complete, quality: undefined })).toBe(false)
    expect(isQualifiedCandidateSimulation({ ...complete, calculationReport: undefined })).toBe(false)
    const mismatched = structuredClone(complete)
    mismatched.calculationReport!.summary!.totalScore82 += 100
    expect(isQualifiedCandidateSimulation(mismatched)).toBe(false)
    expect(isQualifiedCandidateSimulation({ ...complete, quality: { ...complete.quality!, ordinaryExhaustedHours: 1 } })).toBe(false)
    expect(isQualifiedCandidateSimulation({ ...complete, quality: { ...complete.quality!, pendingDeferrals: 1 } })).toBe(false)
  })
})

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
    expect(result.quality).toEqual({ eligible: true, strict: true, ordinaryExhaustedHours: 0, pendingDeferrals: 0, issues: [] })
    expect(result.calculationReport).toBeDefined()
    expect(result.specialOperators).toEqual([{ operatorId: 'char_237_gravel', operatorName: '砾', finalMorale: 23,
      workFraction: 1, workRestRatio: null, workHours: 1, restHours: 0, exhaustedHours: 0 }])
  })

  it('adds compact same-run quality without reclassifying legacy ordinary execution', () => {
    const input = job(); delete input.generatedBackup
    const complete = report()
    complete.operators.push({ operatorId: 'char_237_gravel', operatorName: '砾', initialMorale: 0, finalMorale: 0,
      mainWorkHours: 0, substituteWorkHours: 0, workHours: 0, restHours: 0, idleHours: 0,
      exhaustedHours: 1, workFraction: 0, workRestRatio: null })
    complete.shiftDeferrals = [{ key: 'group:terminal', operatorIds: ['char_237_gravel'], blockedAt: 1 }]
    complete.diagnostics.push({ code: 'group-blocked', message: 'group:terminal: blocked' })
    const run = vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report: complete })
    const result = simulateCandidate(input)
    expect(result).toMatchObject({ completed: true, simScore: scoreSimulationProduction(complete).total, diagnostics: [] })
    expect(result.quality).toMatchObject({ eligible: false, strict: false, ordinaryExhaustedHours: 1, pendingDeferrals: 1 })
    expect(Object.keys(result.quality!).sort()).toEqual(['eligible', 'issues', 'ordinaryExhaustedHours', 'pendingDeferrals', 'strict'])
    expect(result).not.toHaveProperty('report')
    expect(result.quality).not.toHaveProperty('operators')
    expect(run).toHaveBeenCalledOnce()
  })

  it('checks the actual job window even when a bridge report labels a shorter window complete', () => {
    const input = job(); delete input.generatedBackup
    input.options.sampleHours = 72; input.options.warmupHours = 24
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report: report() })
    const result = simulateCandidate(input)
    expect(result.completed).toBe(true)
    expect(result.quality?.eligible).toBe(false)
    expect(result.quality?.issues).toContain('采样或预热窗口未完整覆盖实际请求')
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
