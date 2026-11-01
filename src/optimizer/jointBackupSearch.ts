import type { RosterWorkspace } from '../domain/roster'
import type { OperatorInventory, OwnedOperatorInput } from '../domain/operatorInventory'
import { candidateScoreImproves, isQualifiedCandidateSimulation, type CandidateSimulationBatch, type CandidateSimulationJob, type CandidateSimulationResult } from './candidateSimulation'
import { CandidateSimulationCache } from './candidateSimulationCache'
import { generateJointBackupCandidates } from './jointBackupGenerator'
import { selectJointBackupTriggers } from './jointBackupObservers'
import type { GeneratedBackupDescriptor } from './generatedBackupTypes'

interface MainCandidate { id: string; workspace: RosterWorkspace }
export interface JointBackupSearchResult {
  workspace: RosterWorkspace
  score: number
  generatedBackup?: GeneratedBackupDescriptor
  improved: boolean
  /** A qualified result replaces an unknown/ineligible baseline; this is not an output gain. */
  qualityRepaired: boolean
  generatedCandidates: number
  /** Completed comparisons, including exact cache hits and ineligible summaries. */
  evaluatedCandidates: number
  /** Actual new full simulations; cache hits never spend this budget. */
  simulations: number
  cacheHits: number
  acceptedCandidates: number
  termination: 'complete' | 'simulation-budget' | 'time-budget' | 'no-candidates' | 'invalid-budget'
  selectedCandidateId?: string
  candidates: { id: string; mainId: string; overlayId: string; score: number | null; eligible: boolean; fromCache: boolean; diagnostics: string[] }[]
  diagnostics: { code: string; message: string }[]
}

interface SearchRequest {
  primaryCandidates: readonly MainCandidate[]
  entries: readonly OwnedOperatorInput[]
  inventory: OperatorInventory
  baseline: { workspace: RosterWorkspace; score: number; summary?: CandidateSimulationResult }
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  cache: CandidateSimulationCache
  makeJob: (workspace: RosterWorkspace, generatedBackup?: GeneratedBackupDescriptor) => CandidateSimulationJob
  maxCandidates?: number
  maxSimulations?: number
  timeBudgetMs?: number
  onProgress?: (completed: number, total: number, bestScore: number) => void
  /** Receives an isolated snapshot only after a qualified same-run result exists. */
  onIncumbent?: (snapshot: JointBackupSearchResult) => void
  now?: () => number
}

/** G proposes; complete same-window F and duty integrity select.
 * Dispatch one full window at a time so a deadline never truncates an active F
 * and a later failure cannot erase an already published qualified incumbent.
 */
export function* jointBackupSearchSteps(request: SearchRequest): Generator<CandidateSimulationBatch, JointBackupSearchResult, CandidateSimulationResult[]> {
  const result: JointBackupSearchResult = { workspace: structuredClone(request.baseline.workspace), score: request.baseline.score,
    improved: false, qualityRepaired: false, generatedCandidates: 0, evaluatedCandidates: 0,
    simulations: 0, cacheHits: 0, acceptedCandidates: 0, termination: 'complete', candidates: [], diagnostics: [] }
  const baselineSummary = request.baseline.summary
  const initialAccepted = isQualifiedCandidateSimulation(baselineSummary)
    && Number.isFinite(request.baseline.score)
    && Math.abs(baselineSummary.simScore - request.baseline.score) <= 1e-6 * Math.max(1, Math.abs(request.baseline.score))
  let acceptedBest = initialAccepted
  const diagnostic = (code: string, message: string) => {
    if (!result.diagnostics.some(issue => issue.code === code && issue.message === message)) result.diagnostics.push({ code, message })
  }
  const snapshot = (): JointBackupSearchResult => {
    result.improved = result.selectedCandidateId !== undefined && candidateScoreImproves(result.score, request.baseline.score)
    result.qualityRepaired = !initialAccepted && acceptedBest
    return structuredClone(result)
  }
  const publish = () => {
    if (!request.onIncumbent) return
    try { request.onIncumbent(snapshot()) }
    catch { diagnostic('JOINT_BACKUP_SNAPSHOT_CALLBACK_FAILED', '副表进度快照回调失败，继续保留最近已验证方案。') }
  }
  const finish = (): JointBackupSearchResult => {
    if (!acceptedBest) diagnostic('JOINT_BACKUP_NO_QUALIFIED_RESULT', '预算内未找到满足工休收益质量门槛的副表方案，保留原主班及其原有诊断。')
    return snapshot()
  }
  if (acceptedBest) publish()
  const proposals = request.maxCandidates ?? 4, count = request.maxSimulations ?? 4, duration = request.timeBudgetMs ?? 30_000
  if (![proposals, count, duration].every(value => Number.isFinite(value) && value >= 0)) {
    result.termination = 'invalid-budget'
    diagnostic('JOINT_BACKUP_INVALID_BUDGET', '副表候选、完整仿真和时间预算必须为非负有限数，保留原方案。')
    return finish()
  }
  const limit = Math.min(4, Math.floor(proposals)), simulations = Math.min(4, Math.floor(count)), milliseconds = Math.min(300_000, duration)
  if (!limit) { result.termination = 'no-candidates'; return finish() }
  const now = request.now ?? Date.now, started = now()
  let candidates: ReturnType<typeof generateJointBackupCandidates>['candidates'] = []
  try {
    const triggers = selectJointBackupTriggers(request.primaryCandidates, request.inventory)
    const generated = generateJointBackupCandidates(request.primaryCandidates, request.entries, {
      triggers, lockedPositions: request.lockedPositions, lockedOperators: request.lockedOperators, maxCandidates: limit,
    })
    result.diagnostics.push(...generated.diagnostics)
    candidates = generated.candidates.slice(0, limit)
  } catch (error) {
    diagnostic('JOINT_BACKUP_GENERATION_FAILED', `副表候选未完成，保留原方案：${error instanceof Error ? error.message : String(error)}`)
  }
  result.generatedCandidates = candidates.length
  if (!candidates.length) { result.termination = 'no-candidates'; return finish() }
  const progress = () => {
    try { request.onProgress?.(result.evaluatedCandidates, candidates.length, result.score) }
    catch { diagnostic('JOINT_BACKUP_PROGRESS_CALLBACK_FAILED', '副表进度回调失败，继续保留最近已验证方案。') }
  }
  const seen = new Set<string>()
  const terminate = (reason: JointBackupSearchResult['termination']) => {
    if (result.termination === 'complete') result.termination = reason
  }
  for (const candidate of candidates) {
    const reject = (message: string, fromCache = false) => result.candidates.push({
      id: candidate.id, mainId: candidate.mainId, overlayId: candidate.overlayId, score: null,
      eligible: false, fromCache, diagnostics: [message],
    })
    let job: CandidateSimulationJob, key: string, evaluated: CandidateSimulationResult | undefined, fromCache = false
    try {
      job = request.makeJob(structuredClone(candidate.workspace), structuredClone(candidate.generatedBackup))
      key = request.cache.key(job)
      if (seen.has(key)) { reject('与已比较候选输入完全相同，未重复仿真'); continue }
      seen.add(key)
      evaluated = request.cache.get(job)
      fromCache = evaluated !== undefined
      if (fromCache) result.cacheHits++
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error))
      continue
    }
    if (!evaluated) {
      if (result.simulations >= simulations) {
        terminate('simulation-budget')
        reject('额外完整仿真预算已到，未执行该候选')
        continue
      }
      if (now() - started >= milliseconds) {
        terminate('time-budget')
        reject('副表搜索时间预算已到，未派发下一次完整仿真')
        continue
      }
      result.simulations++
      try {
        const summaries = yield { jobs: [job], onComplete: () => undefined }
        if (summaries.length !== 1 || !summaries[0]) throw new Error('联合副表仿真返回数量不完整')
        if (request.cache.key(job) !== key) {
          diagnostic('JOINT_BACKUP_INPUT_CHANGED', '副表仿真输入在执行期间变化，未缓存或采用该结果。')
          reject('副表仿真输入在执行期间变化')
          continue
        }
        evaluated = summaries[0]
        request.cache.remember(key, evaluated)
      } catch (error) {
        const message = `条件副表比较未完成，保留已验证方案：${error instanceof Error ? error.message : String(error)}`
        diagnostic('JOINT_BACKUP_EVALUATION_FAILED', message)
        reject(message)
        continue
      }
    }
    const eligible = isQualifiedCandidateSimulation(evaluated)
    result.evaluatedCandidates++
    const issues = [...evaluated.diagnostics, ...evaluated.quality?.issues ?? []]
    if (!eligible && !issues.length) issues.push('缺少合格的同次完整工休与显示收益证据')
    result.candidates.push({ id: candidate.id, mainId: candidate.mainId, overlayId: candidate.overlayId,
      score: evaluated.completed && Number.isFinite(evaluated.simScore) ? evaluated.simScore : null,
      eligible, fromCache, diagnostics: issues })
    if (eligible) {
      result.acceptedCandidates++
      if (!acceptedBest || candidateScoreImproves(evaluated.simScore, result.score)) {
        acceptedBest = true
        result.workspace = structuredClone(job.workspace)
        result.score = evaluated.simScore
        result.generatedBackup = structuredClone(job.generatedBackup)
        result.selectedCandidateId = candidate.id
        publish()
      }
    }
    progress()
  }
  return finish()
}
