import type { RosterWorkspace } from '../domain/roster'
import type { OperatorInventory, OwnedOperatorInput } from '../domain/operatorInventory'
import type { CandidateSimulationBatch, CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'
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
  generatedCandidates: number
  evaluatedCandidates: number
  selectedCandidateId?: string
  candidates: { id: string; mainId: string; overlayId: string; score: number | null; diagnostics: string[] }[]
  diagnostics: { code: string; message: string }[]
}

interface SearchRequest {
  primaryCandidates: readonly MainCandidate[]
  entries: readonly OwnedOperatorInput[]
  inventory: OperatorInventory
  baseline: { workspace: RosterWorkspace; score: number }
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  cache: CandidateSimulationCache
  makeJob: (workspace: RosterWorkspace, generatedBackup?: GeneratedBackupDescriptor) => CandidateSimulationJob
  maxCandidates?: number
  onProgress?: (completed: number, total: number, bestScore: number) => void
}

/** One additional bounded batch; old deep-search proposals never rewrite its winner. */
export function* jointBackupSearchSteps(request: SearchRequest): Generator<CandidateSimulationBatch, JointBackupSearchResult, CandidateSimulationResult[]> {
  const result: JointBackupSearchResult = { workspace: structuredClone(request.baseline.workspace), score: request.baseline.score,
    improved: false, generatedCandidates: 0, evaluatedCandidates: 0, candidates: [], diagnostics: [] }
  const limit = Number.isFinite(request.maxCandidates ?? 4) ? Math.max(0, Math.min(4, Math.floor(request.maxCandidates ?? 4))) : 0
  if (!limit) return result
  const triggers = selectJointBackupTriggers(request.primaryCandidates, request.inventory)
  const generated = generateJointBackupCandidates(request.primaryCandidates, request.entries, {
    triggers, lockedPositions: request.lockedPositions, lockedOperators: request.lockedOperators, maxCandidates: limit,
  })
  result.diagnostics.push(...generated.diagnostics)
  const candidates = generated.candidates.slice(0, limit)
  result.generatedCandidates = candidates.length
  if (!candidates.length) return result
  const prepared: { candidate: typeof candidates[number]; job: CandidateSimulationJob; key: string; index: number }[] = []
  const accept = (candidate: typeof candidates[number], summary: CandidateSimulationResult, index: number) => {
    result.candidates[index] = { id: candidate.id, mainId: candidate.mainId, overlayId: candidate.overlayId,
      score: summary.completed && Number.isFinite(summary.simScore) ? summary.simScore : null, diagnostics: [...summary.diagnostics] }
    result.evaluatedCandidates++
    if (summary.completed && Number.isFinite(summary.simScore) && summary.simScore > result.score + 1e-6) {
      result.workspace = structuredClone(candidate.workspace)
      result.score = summary.simScore
      result.generatedBackup = structuredClone(candidate.generatedBackup)
      result.selectedCandidateId = candidate.id
      result.improved = true
    }
    request.onProgress?.(result.evaluatedCandidates, candidates.length, result.score)
  }
  for (const [index, candidate] of candidates.entries()) {
    try {
      const job = request.makeJob(candidate.workspace, candidate.generatedBackup), cached = request.cache.get(job)
      if (cached) accept(candidate, cached, index)
      else prepared.push({ candidate, job, key: request.cache.key(job), index })
    } catch (error) {
      result.candidates[index] = { id: candidate.id, mainId: candidate.mainId, overlayId: candidate.overlayId, score: null,
        diagnostics: [error instanceof Error ? error.message : String(error)] }
    }
  }
  if (!prepared.length) return result
  try {
    let completed = 0
    const summaries = yield { jobs: prepared.map(item => item.job),
      onComplete: () => { completed++; request.onProgress?.(completed, prepared.length, result.score) } }
    if (summaries.length !== prepared.length) throw new Error('联合副表仿真返回数量不完整')
    for (const [index, item] of prepared.entries()) {
      const summary = summaries[index]!
      request.cache.remember(item.key, summary)
      accept(item.candidate, summary, item.index)
    }
  } catch (error) {
    result.diagnostics.push({ code: 'JOINT_BACKUP_EVALUATION_FAILED', message: `条件副表比较未完成，保留已验证方案：${error instanceof Error ? error.message : String(error)}` })
  }
  return result
}
