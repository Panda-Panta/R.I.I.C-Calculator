import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreSimulationProduction } from './productionObjective'
import { hasConsumptionSkill } from './fixedDuty'
import type { SpecialOperatorSimData } from './smartRoster'
import { summarizeIncome, type IncomeCase } from './incomeComparison'
import type { CalculationReport } from '../domain/types'
import { simulationReportToCalculationReport } from '../workbench/calculationBridge'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import type { ScheduleSimulationProgress } from '../simulator/scheduleSimulation'

export interface CandidateSimulationJob {
  workspace: Parameters<typeof runScheduleSimulationBridge>[0]
  options: Parameters<typeof runScheduleSimulationBridge>[1]
  assumptions: Parameters<typeof runScheduleSimulationBridge>[2]
  /** Four-scenario income search needs the integrity evidence as well as the score. */
  incomeComparison?: boolean
}

// Candidate ranking needs a summary, not the full event/production trace.
// Keep full reports local to each worker to avoid copying them between threads.
export interface CandidateSimulationResult {
  completed: boolean
  simScore: number
  diagnostics: string[]
  specialOperators?: SpecialOperatorSimData[]
  incomeCase?: IncomeCase
  /** Compact display report of this same completed run; no timeline/segment payload. */
  calculationReport?: CalculationReport
}

export interface CandidateSimulationBatch {
  jobs: CandidateSimulationJob[]
  onComplete: (result: CandidateSimulationResult, index: number) => void
  onProgress?: (progress: ScheduleSimulationProgress, index: number) => void
}

export type CandidateWorkerMessage = CandidateSimulationResult | { type: 'progress'; progress: ScheduleSimulationProgress }

export type CandidateBatchExecutor = (
  jobs: CandidateSimulationJob[],
  onComplete: CandidateSimulationBatch['onComplete'],
  onProgress?: CandidateSimulationBatch['onProgress'],
) => Promise<CandidateSimulationResult[]>

export function simulateCandidate(job: CandidateSimulationJob): CandidateSimulationResult {
  return simulateCandidateWithProgress(job)
}

export function simulateCandidateWithProgress(job: CandidateSimulationJob, onProgress?: (progress: ScheduleSimulationProgress) => void): CandidateSimulationResult {
  if (!job.incomeComparison && job.workspace.compatibility.backupPlans.length) return { completed: false, simScore: 0, diagnostics: ['AUTOMATIC_BACKUP_PLANS_FORBIDDEN'] }
  if (!job.incomeComparison) {
    const issues = recoveryGroupCapacityIssues(job.workspace)
    if (issues.length) return { completed: false, simScore: 0, diagnostics: issues.map(d => `[${d.code}] ${d.message}`) }
  }
  const response = runScheduleSimulationBridge(job.workspace, job.options, job.assumptions, onProgress)
  const report = response.report
  if (job.incomeComparison) {
    if (!report) throw new Error(response.error ?? '模拟未返回报告')
    // Preserve failed/incomplete evidence for compareIncome; never replace it with a zero label.
    const incomeCase = summarizeIncome(report)
    return { completed: incomeCase.eligible, simScore: incomeCase.output?.daily.total ?? 0,
      diagnostics: incomeCase.issues, incomeCase }
  }
  if (!report?.success || !report.production?.success) {
    return { completed: false, simScore: 0, diagnostics: [
      ...(response.error ? [response.error] : []),
      ...(report?.diagnostics.map(d => `[${d.code}] ${d.message}`) ?? []),
    ] }
  }
  return {
    completed: report.production.sample.completed && report.observedHours > 0,
    simScore: report.production.sample.completed && report.observedHours > 0
      ? scoreSimulationProduction(report).total : 0,
    diagnostics: [],
    ...(report.production.sample.completed && report.observedHours > 0
      ? { calculationReport: simulationReportToCalculationReport(job.workspace, report) } : {}),
    specialOperators: report.operators.filter(op => hasConsumptionSkill(op.operatorId)).map(op => ({
      operatorId: op.operatorId, operatorName: op.operatorName, workFraction: op.workFraction,
      workRestRatio: op.workRestRatio, workHours: op.workHours, restHours: op.restHours,
      exhaustedHours: op.exhaustedHours, finalMorale: op.finalMorale,
    })),
  }
}
