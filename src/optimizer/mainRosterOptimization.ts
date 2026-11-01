import type { OperatorInventory } from '../domain/operatorInventory'
import type { RosterWorkspace } from '../domain/roster'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import type { SmartRosterResult } from './smartRoster'
import { candidateScoreImproves, isQualifiedCandidateSimulation, type CandidateSimulationBatch, type CandidateSimulationJob, type CandidateSimulationResult } from './candidateSimulation'
import { CandidateSimulationCache } from './candidateSimulationCache'
import { generateMainRosterRecoveryCandidates } from './mainRosterRecoveryCandidates'
import { generateMainRosterFreeCandidates } from './mainRosterFreeCandidates'
import { generateMainRosterCrewCandidates } from './mainRosterCrewCandidates'
import { preservesFormedCombinations } from './combinationIntegrity'
import { validatePhysicalRoster } from './rosterDraft'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'

export interface MainRosterOptimizationSummary {
  generatedCandidates: number
  evaluatedCandidates: number
  cacheHits: number
  acceptedCandidates: number
  improved: boolean
  qualityRepaired: boolean
  /** Proposal rounds from distinct verified incumbents, not a global certificate. */
  rounds?: number
  searchScope?: 'generated-neighborhood'
  globalOptimumProven?: false
  fullFUpperBound?: null
  gain: number
  termination: 'complete' | 'simulation-budget' | 'time-budget' | 'no-candidates' | 'invalid-budget'
  candidates: { id: string; score: number | null; eligible: boolean; fromCache: boolean; diagnostics: string[]; round?: number }[]
}

interface OptimizationInput {
  baseline: SmartRosterResult
  baselineSummary?: CandidateSimulationResult
  userBase: RosterWorkspace
  inventory: OperatorInventory
  lockedPositions: ReadonlySet<string>
  lockedOperators: ReadonlySet<string>
  cache: CandidateSimulationCache
  makeJob: (workspace: RosterWorkspace) => CandidateSimulationJob
  allowFreeCombinations: boolean
  maxSimulations?: number
  timeBudgetMs?: number
  onIncumbent?: (report: SmartRosterResult) => void
  now?: () => number
}

/** A bounded extension of the fast result. G proposes; same-window complete F selects.
 * The deadline is checked before dispatch, never by truncating an active F window.
 */
export function* mainRosterOptimizationSteps(input: OptimizationInput): Generator<CandidateSimulationBatch, SmartRosterResult, CandidateSimulationResult[]> {
  const best = structuredClone(input.baseline)
  const initialScore = best.score ?? 0
  let acceptedBest = isQualifiedCandidateSimulation(input.baselineSummary)
  const initialAccepted = acceptedBest
  const stats: MainRosterOptimizationSummary = { generatedCandidates: 0, evaluatedCandidates: 0, cacheHits: 0,
    acceptedCandidates: 0, improved: false, qualityRepaired: false, rounds: 0,
    searchScope: 'generated-neighborhood', globalOptimumProven: false, fullFUpperBound: null,
    gain: 0, termination: 'complete', candidates: [] }
  const snapshot = (): SmartRosterResult => {
    stats.gain = (best.score ?? initialScore) - initialScore
    stats.improved = candidateScoreImproves(best.score ?? initialScore, initialScore)
    stats.qualityRepaired = !initialAccepted && acceptedBest
    best.phases.mainOptimization = structuredClone(stats)
    return structuredClone(best)
  }
  if (acceptedBest) input.onIncumbent?.(snapshot())
  const count = input.maxSimulations ?? 3, duration = input.timeBudgetMs ?? 30_000
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(duration) || duration < 0) {
    stats.termination = 'invalid-budget'
    best.diagnostics.push({ code: 'MAIN_OPTIMIZATION_INVALID_BUDGET', message: '持续优化预算必须为非负有限数，保留原完整方案。' })
    return snapshot()
  }
  const limit = Math.min(8, Math.floor(count)), milliseconds = Math.min(300_000, duration)
  const now = input.now ?? Date.now, started = now()
  if (!best.workspace || best.status !== 'draft' || !Number.isFinite(best.score)) return snapshot()
  if (!limit) { stats.termination = 'simulation-budget'; return snapshot() }
  if (!milliseconds) { stats.termination = 'time-budget'; return snapshot() }
  const seed = structuredClone(best.workspace)
  const options = { lockedPositions: input.lockedPositions, lockedOperators: input.lockedOperators,
    userBase: input.userBase, allowFreeCombinations: input.allowFreeCombinations, maxCandidates: 4 }
  const context = (workspace: RosterWorkspace): string => JSON.stringify({ conf: workspace.mainPlan.conf,
    weights: workspace.productionWeights, rooms: Object.values(workspace.mainPlan.facilities)
      .map(room => [room.roomId, room.type, room.level, room.product, room.slots.length]) })
  const propose = (current: RosterWorkspace): { id: string; workspace: RosterWorkspace; round: number; context: string; firstWave: boolean }[] => {
    const round = (stats.rounds ?? 0) + 1
    stats.rounds = round
    const recovery = generateMainRosterRecoveryCandidates(structuredClone(current), input.inventory, options)
    const free = input.allowFreeCombinations ? generateMainRosterFreeCandidates(structuredClone(current), input.inventory, options)
      : { candidates: [], diagnostics: [] }
    const crew = input.allowFreeCombinations ? generateMainRosterCrewCandidates(structuredClone(current), input.inventory, options)
      : { candidates: [], diagnostics: [] }
    best.diagnostics.push(...recovery.diagnostics, ...free.diagnostics, ...crew.diagnostics)
    // A composed state receives its own full F; no parent score is reused.
    const combined = free.candidates.length
      ? generateMainRosterRecoveryCandidates(free.candidates[0]!.workspace, input.inventory, { ...options, maxCandidates: 1 })
      : { candidates: [], diagnostics: [] }
    const combinedCrew = crew.candidates.length
      ? generateMainRosterRecoveryCandidates(crew.candidates[0]!.workspace, input.inventory, { ...options, maxCandidates: 1 })
      : { candidates: [], diagnostics: [] }
    best.diagnostics.push(...combined.diagnostics, ...combinedCrew.diagnostics)
    // Reserve a full-F opportunity for the actual compound state. Neither
    // declining parent needs to be accepted before their combination is tried.
    const families = crew.candidates.length
      ? [crew.candidates, recovery.candidates, combinedCrew.candidates.map(c => ({ ...c, id: `combined-crew:${c.id}` })),
        free.candidates, combined.candidates.map(c => ({ ...c, id: `combined:${c.id}` }))]
      : [...(input.allowFreeCombinations ? [free.candidates, recovery.candidates] : [recovery.candidates]),
        combined.candidates.map(c => ({ ...c, id: `combined:${c.id}` }))]
    const expectedContext = context(current)
    const proposals: { id: string; workspace: RosterWorkspace; round: number; context: string; firstWave: boolean }[] = []
    for (let i = 0; i < Math.max(...families.map(family => family.length)); i++) {
      for (const family of families) if (family[i]) proposals.push({ ...family[i]!, round, context: expectedContext, firstWave: i === 0 })
    }
    return proposals
  }
  const queue = propose(seed)
  const seen = new Set<string>([input.cache.key(input.makeJob(structuredClone(seed)))])
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const proposal = queue[cursor]!
    if (now() - started >= milliseconds) { stats.termination = 'time-budget'; break }
    const candidate = structuredClone(proposal.workspace)
    const reject = (message: string) => stats.candidates.push({ id: proposal.id, score: null, eligible: false, fromCache: false, diagnostics: [message], round: proposal.round })
    const lockedPositions = new Set(input.lockedPositions)
    const lockedActors = new Set([...input.lockedOperators].map(resolveOperatorCharId))
    for (const room of Object.values(input.userBase.mainPlan.facilities)) room.slots.forEach((slot, index) => {
      if (slot.occupant.kind === 'operator' && lockedActors.has(resolveOperatorCharId(slot.occupant.operatorId))) lockedPositions.add(`${room.roomId}:${index}`)
    })
    const sameLocks = [...lockedPositions].every(key => {
      const split = key.lastIndexOf(':'), room = key.slice(0, split), position = Number(key.slice(split + 1))
      return JSON.stringify(candidate.mainPlan.facilities[room as keyof typeof candidate.mainPlan.facilities]?.slots[position]) ===
        JSON.stringify(input.userBase.mainPlan.facilities[room as keyof typeof candidate.mainPlan.facilities]?.slots[position])
    })
    // The job factory may persist a required generated warmup policy in a
    // verified winner. Its descendants keep that exact parent context, while
    // pending siblings remain bound to their own original round.
    const sameContext = context(candidate) === proposal.context
    if (!sameLocks || !sameContext || candidate.compatibility.backupPlans.length) { reject('候选改变已锁工位、布局、策略、权重或携带副表'); continue }
    if (!preservesFormedCombinations(input.userBase, candidate, input.inventory) ||
        !input.allowFreeCombinations && !preservesFormedCombinations(seed, candidate, input.inventory)) { reject('候选违反需保留的组合约束'); continue }
    if (validatePhysicalRoster(candidate).length || recoveryGroupCapacityIssues(candidate).length ||
        compileRosterSchedule(candidate).diagnostics.some(d => d.severity === 'error')) { reject('候选物理占位、恢复床位或编译不合法'); continue }
    let job: CandidateSimulationJob
    try { job = input.makeJob(candidate) } catch (error) { reject(error instanceof Error ? error.message : String(error)); continue }
    const key = input.cache.key(job)
    if (seen.has(key)) continue
    seen.add(key); stats.generatedCandidates++
    let evaluated = input.cache.get(job)
    const fromCache = Boolean(evaluated)
    if (evaluated) stats.cacheHits++
    else {
      if (stats.evaluatedCandidates >= limit) {
        stats.termination = 'simulation-budget'
        reject('额外完整仿真预算已到，未执行该候选')
        continue
      }
      if (now() - started >= milliseconds) { stats.termination = 'time-budget'; break }
      stats.evaluatedCandidates++
      try {
        const results = yield { jobs: [job], onComplete: () => undefined }
        evaluated = results.length === 1 ? results[0] : undefined
        if (evaluated && input.cache.key(job) === key) input.cache.remember(key, evaluated)
        else evaluated = undefined
      } catch (error) { reject(error instanceof Error ? error.message : String(error)); continue }
    }
    const eligible = isQualifiedCandidateSimulation(evaluated)
    stats.candidates.push({ id: proposal.id, score: evaluated?.completed && Number.isFinite(evaluated.simScore) ? evaluated.simScore : null,
      eligible, fromCache, diagnostics: [...evaluated?.diagnostics ?? [], ...evaluated?.quality?.issues ?? []], round: proposal.round })
    if (!eligible || !evaluated) continue
    stats.acceptedCandidates++
    if (acceptedBest && !candidateScoreImproves(evaluated.simScore, best.score ?? initialScore)) continue
    acceptedBest = true
    best.workspace = structuredClone(job.workspace)
    best.score = evaluated.simScore
    best.calculationReport = structuredClone(evaluated.calculationReport)
    best.specialOperators = structuredClone(evaluated.specialOperators ?? [])
    input.onIncumbent?.(snapshot())
    if (now() - started >= milliseconds) { stats.termination = 'time-budget'; break }
    // Retain pending siblings while giving proposals from the real winner an
    // opportunity. Seen full inputs and the shared budget span every round.
    const pending = queue.slice(cursor + 1), next = propose(best.workspace)
    // A continuing crew winner must not consume every slot ahead of the
    // already reserved recovery/compound opportunities from its parent round.
    const reserved = pending.filter(item => item.firstWave), remainder = pending.filter(item => !item.firstWave)
    const interleaved: typeof queue = []
    for (let i = 0; i < Math.max(next.length, remainder.length); i++) {
      if (next[i]) interleaved.push(next[i]!)
      if (remainder[i]) interleaved.push(remainder[i]!)
    }
    queue.splice(cursor + 1, queue.length - cursor - 1, ...reserved, ...interleaved)
  }
  if (!stats.generatedCandidates && stats.termination === 'complete') stats.termination = 'no-candidates'
  if (!acceptedBest) best.diagnostics.push({ code: 'MAIN_OPTIMIZATION_NO_QUALIFIED_RESULT', message: '预算内未找到满足新增工休收益质量门槛的方案，保留快速入口结果及其原有诊断。' })
  return snapshot()
}
