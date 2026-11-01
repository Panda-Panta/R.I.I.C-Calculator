import type { RosterWorkspace } from '../domain/roster'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { hasContinuousMowerWorkaholicPolicy, hasMeasuredPermanentPrimaryDuty } from '../simulator/permanentDutyEvidence'
import { summarizeIncome, type IncomeCase } from './incomeComparison'

/** Small enough for candidate workers; absence is never evidence of eligibility. */
export interface MainRosterDutyQuality {
  eligible: boolean
  /** Preserve the existing income-comparison verdict, including all its diagnostics. */
  strict: boolean
  /** Unexempted fatigue is conservative; missing duty data is null, never a fabricated zero. */
  ordinaryExhaustedHours: number | null
  pendingDeferrals: number
  issues: string[]
}

export interface MainRosterOperatorDuty {
  operatorId: string
  operatorName: string
  effectiveWorkHours: number | null
  /** Physical duty includes zero-morale occupancy; it does not imply active work skills. */
  physicalDutyHours: number | null
  exhaustedHours: number | null
  restHours: number | null
  idleHours: number | null
  /** W/R, null when there is no measured recovery time. */
  workRestRatio: number | null
  /** W/T, where T is the observed sample window, including rest and idle. */
  workFraction: number | null
  permanent: boolean
  permanentExhaustionExempt: boolean
}

export interface MainRosterDutyWindow {
  sampleHours?: number
  warmupHours?: number
}

export interface MainRosterDutyEvaluation extends MainRosterDutyQuality {
  observedHours: number | null
  sampleHours: number | null
  warmupHours: number | null
  windowCompleted: boolean
  operators: MainRosterOperatorDuty[]
  /** Same report and shared production score; no trace and no second simulation. */
  incomeCase?: IncomeCase
}

const EPS = 1e-5
const FATIGUE_EPS = 1e-7
const REST_EPS = 1e-8
const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0
const close = (left: number, right: number): boolean => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= EPS
const measured = (value: number): number | null => finiteNonnegative(value) ? value : null

/**
 * Audit an already completed Native F report. This reads neither a calendar nor a
 * prediction: it cannot repair/calibrate production-off H or infer joint duty
 * states from marginal work fractions. Explicitly short requests are allowed;
 * truncating a longer request is not. The caller keeps comparison windows equal.
 */
export function evaluateMainRosterDuty(
  report: ScheduleSimulationReport,
  workspace?: RosterWorkspace,
  expectedWindow?: MainRosterDutyWindow,
): MainRosterDutyEvaluation {
  const issues: string[] = []
  const add = (message: string) => { if (!issues.includes(message)) issues.push(message) }
  let incomeCase: IncomeCase | undefined
  try {
    incomeCase = summarizeIncome(report)
    incomeCase.issues.forEach(add)
  } catch {
    add('收益报告缺少可核验的完整字段')
  }
  const strict = incomeCase?.eligible === true
  const schedule = report.inputs?.schedule, options = report.inputs?.options
  const sampleHours = report.assumptions?.sampleHours, warmupHours = report.assumptions?.warmupHours
  const requestedSample = options?.sampleHours ?? 336, requestedWarmup = options?.warmupHours ?? 0
  const windowCompleted = finiteNonnegative(sampleHours) && sampleHours > 0 && finiteNonnegative(warmupHours)
    && close(report.observedHours, sampleHours) && close(report.elapsedHours, sampleHours + warmupHours)
    && close(sampleHours, requestedSample) && close(warmupHours, requestedWarmup)
    && (expectedWindow?.sampleHours === undefined || close(sampleHours, expectedWindow.sampleHours))
    && (expectedWindow?.warmupHours === undefined || close(warmupHours, expectedWindow.warmupHours))
  if (!windowCompleted) add('采样或预热窗口未完整覆盖实际请求')
  if (report.schemaVersion !== 1 || report.engine !== 'mower-morale-v1') add('无法识别 Native 收益报告版本')
  if (!report.success || !report.production?.success) add('模拟或生产策略未完整执行')
  const completed = report.production?.sample?.completed
  if (!completed || ![completed.exp, completed.gold, completed.orderLmd].every(finiteNonnegative)
    || !incomeCase?.output || !Number.isFinite(incomeCase.output.daily.total)) add('缺少完整的有限采样产出')
  if (report.diagnostics?.some(issue => issue.code === 'MOWER_BACKUP_CONDITION_ERROR')) add('副表条件未完整执行')
  if (workspace && JSON.stringify(workspace.mainPlan) !== JSON.stringify(schedule?.sourceWorkspace.mainPlan)) add('收益报告与待评价主班不同')

  let runtime: ReturnType<typeof compiledScheduleToRuntimeConfig> | undefined
  try {
    runtime = compiledScheduleToRuntimeConfig(schedule)
  } catch {
    add('缺少可核验的实际岗位策略')
  }
  const expectedIds = new Set([...Object.keys(runtime?.initialMorale ?? {}), ...(runtime?.idleOperators ?? [])])
  const rows = Array.isArray(report.operators) ? report.operators : []
  const seen = new Set<string>()
  let knownDuty = Boolean(runtime) && Array.isArray(report.operators), ordinaryExhaustedHours = 0
  if (!Array.isArray(report.operators)) add('缺少干员工休观测')
  const operators = rows.map(op => {
    if (seen.has(op.operatorId)) { add('干员工休观测实体重复'); knownDuty = false }
    seen.add(op.operatorId)
    const times = [op.workHours, op.exhaustedHours, op.restHours, op.idleHours, op.mainWorkHours, op.substituteWorkHours]
    const validTimes = times.every(finiteNonnegative)
      && close(op.workHours + op.exhaustedHours + op.restHours + op.idleHours, report.observedHours)
      && close(op.mainWorkHours + op.substituteWorkHours, op.workHours)
    if (!validTimes) { add('干员工休观测缺失、非有限或不守恒'); knownDuty = false }
    if (![op.initialMorale, op.finalMorale, op.workFraction].every(Number.isFinite)
      || (op.workRestRatio !== null && !finiteNonnegative(op.workRestRatio))) add('干员心情或工休指标缺少有限观测')
    const primary = runtime?.positions.filter(position => !position.dormitory && position.primary === op.operatorId) ?? []
    const permanent = primary.length === 1 && primary[0]!.permanent === true
    // Mower grants workaholic permission by name across positions. A proven
    // unchanged global policy and full measured primary coverage are separate proofs.
    const permanentExhaustionExempt = validTimes && primary.length <= 1
      && (hasContinuousMowerWorkaholicPolicy(schedule, op.operatorId)
        || permanent && hasMeasuredPermanentPrimaryDuty(op))
    if (validTimes && !permanentExhaustionExempt) ordinaryExhaustedHours += op.exhaustedHours
    return {
      operatorId: op.operatorId, operatorName: op.operatorName,
      effectiveWorkHours: measured(op.workHours), physicalDutyHours: validTimes ? op.workHours + op.exhaustedHours : null,
      exhaustedHours: measured(op.exhaustedHours), restHours: measured(op.restHours), idleHours: measured(op.idleHours),
      workRestRatio: validTimes && op.restHours > REST_EPS ? op.workHours / op.restHours : null,
      workFraction: validTimes && report.observedHours > 0 ? op.workHours / report.observedHours : null,
      permanent, permanentExhaustionExempt,
    }
  })
  if ([...expectedIds].some(id => !seen.has(id))) { add('实际排班干员缺少工休观测'); knownDuty = false }
  if (knownDuty && ordinaryExhaustedHours > FATIGUE_EPS) add('存在普通干员疲劳占岗')

  let pendingDeferrals = 0
  if (!Array.isArray(report.shiftDeferrals)) add('缺少换班延后完整记录')
  for (const episode of Array.isArray(report.shiftDeferrals) ? report.shiftDeferrals : []) {
    const membersValid = Array.isArray(episode.operatorIds) && episode.operatorIds.length > 0
      && episode.operatorIds.every(id => typeof id === 'string' && id.length > 0)
      && new Set(episode.operatorIds).size === episode.operatorIds.length
      && episode.operatorIds.every(id => seen.has(id))
    if (!episode.key || !membersValid || !finiteNonnegative(episode.blockedAt)
      || episode.blockedAt > report.elapsedHours + EPS) add('换班延后记录缺少有效对象或发生时刻')
    if (episode.resolvedAt === undefined) {
      pendingDeferrals++
    } else if (!Number.isFinite(episode.resolvedAt) || episode.resolvedAt <= episode.blockedAt
      || episode.resolvedAt > report.elapsedHours + EPS) {
      pendingDeferrals++
      add('换班延后恢复证据无效')
    }
  }
  if (pendingDeferrals > 0) add('存在期末尚未确认恢复的换班延后')

  return {
    eligible: strict && issues.length === 0, strict,
    ordinaryExhaustedHours: knownDuty ? ordinaryExhaustedHours : null,
    pendingDeferrals, issues, observedHours: measured(report.observedHours), sampleHours: measured(sampleHours),
    warmupHours: measured(warmupHours), windowCompleted, operators, ...(incomeCase ? { incomeCase } : {}),
  }
}
