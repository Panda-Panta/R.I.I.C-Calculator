import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreProduction } from './productionObjective'
import { hasConsumptionSkill } from './fixedDuty'
import type { SpecialOperatorSimData } from './smartRoster'
import { summarizeIncome, type IncomeCase } from './incomeComparison'

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
}

export interface CandidateSimulationBatch {
  jobs: CandidateSimulationJob[]
  onComplete: (result: CandidateSimulationResult, index: number) => void
}

export type CandidateBatchExecutor = (
  jobs: CandidateSimulationJob[],
  onComplete: CandidateSimulationBatch['onComplete'],
) => Promise<CandidateSimulationResult[]>

export function simulateCandidate(job: CandidateSimulationJob): CandidateSimulationResult {
  if (!job.incomeComparison && job.workspace.compatibility.backupPlans.length) return { completed: false, simScore: 0, diagnostics: ['AUTOMATIC_BACKUP_PLANS_FORBIDDEN'] }
  const response = runScheduleSimulationBridge(job.workspace, job.options, job.assumptions)
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
    completed: report.observedHours > 0,
    simScore: report.production.sample.completed && report.observedHours > 0
      ? scoreProduction(report.production.sample.completed, report.observedHours).total : 0,
    diagnostics: [],
    specialOperators: report.operators.filter(op => hasConsumptionSkill(op.operatorId)).map(op => ({
      operatorId: op.operatorId, operatorName: op.operatorName, workFraction: op.workFraction,
      workRestRatio: op.workRestRatio, workHours: op.workHours, restHours: op.restHours,
      exhaustedHours: op.exhaustedHours, finalMorale: op.finalMorale,
    })),
  }
}
