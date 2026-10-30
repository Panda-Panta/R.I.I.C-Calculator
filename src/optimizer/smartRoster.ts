import { mainPlanOnly } from './mainPlanOnly'
import { configureRunOrder, runOrderInventoryDiagnostics } from './configureRunOrder'
import type { RosterWorkspace } from '../domain/roster'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreSimulationProduction } from '../simulator/productionScore'
import { normalizeProductionWeights, type ProductionWeights } from '../domain/productionWeights'
import { hasConsumptionSkill } from './fixedDuty'
import { rosterIncomeSearchSteps, type IncomeSearchResult } from './rosterIncomeSearch'
import { validatePhysicalRoster } from './rosterDraft'
import { generateMolecularCandidates } from './molecularSynthesis'
import { computeManufacturingRoster, type ComputedRosterCalculation } from './computedManufacturingRoster'
import { runGlobalPerCapitaReplacement } from './globalPerCapitaReplacement'
import { preservesFormedCombinations } from './combinationIntegrity'
import { isQualifiedCandidateSimulation, simulateCandidate, type CandidateSimulationJob, type CandidateSimulationResult, type CandidateSimulationBatch, type CandidateBatchExecutor } from './candidateSimulation'
export type { CandidateBatchExecutor } from './candidateSimulation'
import { CandidateSimulationCache } from './candidateSimulationCache'
import { candidateExecutionOrder } from './candidateExecutionOrder'
import { completeShiftScores, normalizeProductionShifts } from './combinationAllocation'
import type { CalculationReport } from '../domain/types'
import { simulationReportToCalculationReport } from '../workbench/calculationBridge'
import { applyGeneratedRecoveryPolicy } from './generatedRecoveryPolicy'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import type { ScheduleSimulationProgress } from '../simulator/scheduleSimulation'
import { compareWorkspacePreference } from './automaticCombinationPreferences'
import { compareProductionEfficiencyVectors, productionEfficiencyVector } from './productionEfficiencyPriority'
import { generateProductionShiftAlternatives } from './jointBackupMainAlternatives'
import { generateContextualCrewCandidates } from './jointBackupCrewSeeds'
import { selectHighOutputMainCandidates } from './mainRosterSelection'
import { mainRosterOptimizationSteps, type MainRosterOptimizationSummary } from './mainRosterOptimization'
import { jointBackupSearchSteps, type JointBackupSearchResult } from './jointBackupSearch'
import type { GeneratedBackupDescriptor } from './generatedBackupTypes'

export interface SmartRosterOptions {
  seed?: number
  /** Legacy settings retained for saved configurations. Default construction has its own bounded shortlist. */
  branchCount?: number
  trials?: number
  maxStaticEvals?: number
  simulationTopK?: number
  simulationWarmupHours?: number
  simulationSampleHours?: number
  /** Optional extra comparison. The default two-stage result needs no post-simulation search. */
  enableDeepSearch?: boolean
  /** Compare bounded jointly generated main/conditional-backup configurations. */
  enableBackupGeneration?: boolean
  /** Bounded extra main-roster search after the fast, complete initial result. */
  enableMainOptimization?: boolean
  /** Internal templates are proposals; original user-configured slots stay locked. */
  allowFreeCombinations?: boolean
  optimizationMaxSimulations?: number
  optimizationTimeBudgetMs?: number
  droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
  droneRoomId?: string
  productionWeights?: ProductionWeights
}

export interface SmartRosterProgress {
  phase: 'building' | 'simulating' | 'searching' | 'done'
  phaseProgress: number
  currentTrial?: number
  totalTrials?: number
  bestScore?: number
  label: string
  /** Same-input, complete, quality-accepted result available during continued search. */
  incumbent?: SmartRosterResult
}

export interface SpecialOperatorSimData {
  operatorId: string
  operatorName: string
  workFraction: number
  workRestRatio: number | null
  workHours: number
  restHours: number
  exhaustedHours: number
  finalMorale: number
}

export interface SmartRosterCandidate {
  id: string
  workspace: RosterWorkspace
  staticScore: number | null
  simScore: number | null
  diagnostics: string[]
  specialOperators?: SpecialOperatorSimData[]
}

export interface SmartRosterResult {
  status: 'draft' | 'blocked'
  workspace: RosterWorkspace | null
  score: number | null
  diagnostics: { code: string; message: string }[]
  specialOperators: SpecialOperatorSimData[]
  /** Completed output of the exact returned roster and generation settings. */
  calculationReport?: CalculationReport
  phases: {
    mainOptimization?: MainRosterOptimizationSummary
    primarySelection?: { scores: { id: string; primaryHourlyScore: number | null }[]; selectedIds: string[] }
    /** Bounds describe the declared manufacturing model, never the full simulation objective. */
    calculation?: ComputedRosterCalculation
    static: {
      candidates: SmartRosterCandidate[]
      bestScore: number | null
    }
    simulation: {
      candidates: SmartRosterCandidate[]
      bestScore: number | null
    } | null
    search: {
      improved: boolean
      gain: number
      result?: IncomeSearchResult
    } | null
    replacement?: {
      swappedCount: number
      logs: string[]
    }
    jointBackup?: Pick<JointBackupSearchResult, 'generatedCandidates' | 'evaluatedCandidates' | 'selectedCandidateId' | 'improved' | 'candidates' |
      'simulations' | 'cacheHits' | 'acceptedCandidates' | 'qualityRepaired' | 'termination'> & { gain: number }
  }
}

function workspaceFingerprint(w: RosterWorkspace): string {
  // Group bindings, recovery policies and slot metadata affect the actual schedule.
  // Equal occupants alone do not make two simulation inputs interchangeable.
  return JSON.stringify(w)
}

export function runSmartRoster(
  base: RosterWorkspace,
  entries: readonly OwnedOperatorInput[],
  options: SmartRosterOptions = {},
  onProgress?: (p: SmartRosterProgress) => void,
): SmartRosterResult {
  const run = smartRosterSteps(base, entries, options, onProgress)
  let step = run.next()
  while (!step.done) {
    const batch = step.value
    let results: CandidateSimulationResult[]
    try {
      results = batch.jobs.map((job, index) => {
        const result = simulateCandidate(job)
        batch.onComplete(result, index)
        return result
      })
    } catch (error) { step = run.throw(error); continue }
    step = run.next(results)
  }
  return step.value
}

function simulationProgress(workspaces: readonly RosterWorkspace[], efficiencies: readonly number[][], stages: number, onProgress?: (p: SmartRosterProgress) => void,
  offset = 0, total = workspaces.length) {
  let completed = offset, bestScore: number | undefined, bestIndex: number | undefined
  const fractions = new Map<number, number>()
  return { onComplete: (result: CandidateSimulationResult, index: number) => {
    completed++
    fractions.set(index, 1)
    if (result.completed && Number.isFinite(result.simScore)) {
      const preference = bestIndex === undefined ? 1 : compareWorkspacePreference(workspaces[index]!, workspaces[bestIndex]!) ||
        compareProductionEfficiencyVectors(efficiencies[index]!, efficiencies[bestIndex]!)
      if (bestIndex === undefined || result.simScore > bestScore! || result.simScore === bestScore && preference > 0) { bestScore = result.simScore; bestIndex = index }
    }
    onProgress?.({ phase: 'simulating', phaseProgress: (offset + [...fractions.values()].reduce((a, b) => a + b, 0)) / total,
      currentTrial: completed, totalTrials: total, bestScore,
      label: `阶段 2/${stages}: 动态拟真进度 ${completed}/${total}（${result.completed && Number.isFinite(result.simScore) ? `加权产出: ${result.simScore.toFixed(1)}` : '未完成，跳过评分'}）` })
  }, onProgress: (progress: ScheduleSimulationProgress, index: number) => {
    fractions.set(index, progress.elapsedHours / progress.totalHours)
    const warmup = progress.phase === 'warmup'
    const elapsed = warmup ? progress.elapsedHours : progress.elapsedHours - progress.warmupHours
    const duration = warmup ? progress.warmupHours : progress.totalHours - progress.warmupHours
    onProgress?.({ phase: 'simulating', phaseProgress: (offset + [...fractions.values()].reduce((a, b) => a + b, 0)) / total,
      currentTrial: completed, totalTrials: total, bestScore,
      label: `阶段 2/${stages}: 候选 ${index + 1 + offset}/${total} ${warmup ? '预热' : '采样'} ${elapsed.toFixed(1)}/${duration} 小时（已完成 ${completed}/${total}）` })
  } }
}

export async function runSmartRosterParallel(
  base: RosterWorkspace,
  entries: readonly OwnedOperatorInput[],
  options: SmartRosterOptions,
  execute: CandidateBatchExecutor,
  onProgress?: (p: SmartRosterProgress) => void,
): Promise<SmartRosterResult> {
  const run = smartRosterSteps(base, entries, options, onProgress)
  let step = run.next()
  while (!step.done) {
    const { jobs, onComplete, onProgress: onSimulationProgress } = step.value
    let results: CandidateSimulationResult[]
    try {
      const order = candidateExecutionOrder(jobs)
      const scheduled = await execute(order.map(index => jobs[index]!),
        (summary, index) => onComplete(summary, order[index]!),
        onSimulationProgress ? (progress, index) => onSimulationProgress(progress, order[index]!) : undefined)
      if (scheduled.length !== jobs.length) throw new Error('候选仿真返回数量不完整')
      // Execution priority must never change candidate identity, tie-breaking,
      // cache keys, progress labels or the report attached to the chosen roster.
      results = new Array(jobs.length)
      order.forEach((original, dispatched) => { results[original] = scheduled[dispatched]! })
    } catch (error) { step = run.throw(error); continue }
    step = run.next(results)
  }
  return step.value
}

function* smartRosterSteps(
  base: RosterWorkspace,
  entries: readonly OwnedOperatorInput[],
  options: SmartRosterOptions = {},
  onProgress?: (p: SmartRosterProgress) => void,
): Generator<CandidateSimulationBatch, SmartRosterResult, CandidateSimulationResult[]> {
 base = mainPlanOnly(base)
  base.productionWeights = normalizeProductionWeights(options.productionWeights ?? base.productionWeights)
  const result: SmartRosterResult = {
    status: 'blocked',
    workspace: null,
    score: null,
    diagnostics: [],
    specialOperators: [],
    phases: {
      static: { candidates: [], bestScore: null },
      simulation: null,
      search: null,
    },
  }

  const seed = options.seed ?? 42
  const enableDeepSearch = options.enableDeepSearch ?? false
  const stages = enableDeepSearch ? 3 : 2
  const droneTarget = options.droneTarget ?? 'gold'

  // 1. Inventory & Base validation
  const inventory = compileOperatorInventory(entries)
  if (!inventory.valid) {
    result.diagnostics.push(...inventory.diagnostics)
    return result
  }

  const runOrderErrors = runOrderInventoryDiagnostics(base, inventory)
  if (runOrderErrors.length) {
    result.diagnostics.push({code:'RUN_ORDER_PARTIAL',message:'未持有部分跑单干员，按实际持有技能生成排班，未具备的跑单收益不计入。'})
  }

  const basePhysicalErrors = validatePhysicalRoster(base)
  if (basePhysicalErrors.length) {
    result.diagnostics.push(...basePhysicalErrors)
    return result
  }

  const initialWarmupPolicy = applyGeneratedWarmupPolicy(base, inventory)
  if (!initialWarmupPolicy.valid) {
    result.diagnostics.push(...initialWarmupPolicy.diagnostics)
    return result
  }
  const prepareWarmupPolicy = (workspace: RosterWorkspace): boolean =>
    applyGeneratedWarmupPolicy(workspace, inventory).valid

  const hasProductionRoom = Object.values(base.mainPlan.facilities).some(
    r => r.type === 'manufacture' || r.type === 'trading'
  )
  if (!hasProductionRoom) {
    result.diagnostics.push({ code: 'NO_PRODUCTION_ROOM', message: '当前布局至少需要一个制造站或贸易站。' })
    return result
  }

  // Identify user-locked positions and operators
  const lockedPositions = new Set<string>()
  const lockedOperators = new Set<string>()
  for (const room of Object.values(base.mainPlan.facilities)) {
    for (const [index, slot] of room.slots.entries()) {
      if (slot.occupant.kind === 'operator') {
        const id = resolveId(slot.occupant.operatorId)
        lockedPositions.add(`${room.roomId}:${index}`)
        lockedOperators.add(id)
      }
    }
  }

  // ==========================================
  // Phase 1: Build legal whole-roster alternatives and prioritize actual primary output.
  // ==========================================
  onProgress?.({
    phase: 'building',
    phaseProgress: 0,
    currentTrial: 0,
    label: `阶段 1/${stages}: 构造合法主班候选并核对完整组合与全局联动...`,
  })

  const synthesisOptions = {
    seed,
    branchCount: enableDeepSearch && options.enableBackupGeneration !== true ? 1 : 3,
    lockedPositions,
    lockedOperators,
    droneTarget,
    requireWarmupExhaustion: true,
    warmupInventory: inventory,
  }
  const molecularBranches = generateMolecularCandidates(base, entries, inventory, synthesisOptions)

  // Deduplicate candidates by layout fingerprint
  const seenFingerprints = new Set<string>()
  const uniqueCandidates: SmartRosterCandidate[] = []
  for (let bIdx = 0; bIdx < molecularBranches.length; bIdx++) {
    const source = molecularBranches[bIdx]!
    const branch = { ...source, workspace: structuredClone(source.workspace) }
    if (branch.workspace.compatibility.backupPlans.length) { result.diagnostics.push({ code: 'AUTOMATIC_BACKUP_PLANS_FORBIDDEN', message: '自动生成候选禁止携带副表' }); continue }
    const warmupPolicy = applyGeneratedWarmupPolicy(branch.workspace, inventory)
    if (!warmupPolicy.valid) {
      result.diagnostics.push(...warmupPolicy.diagnostics)
      continue
    }
    applyGeneratedRecoveryPolicy(branch.workspace)
    const fp = workspaceFingerprint(branch.workspace)
    if (seenFingerprints.has(fp)) continue
    seenFingerprints.add(fp)

    uniqueCandidates.push({
      id: branch.id,
      workspace: branch.workspace,
      staticScore: branch.staticScore,
      simScore: null,
      diagnostics: [...branch.diagnostics],
    })

    onProgress?.({
      phase: 'building',
      phaseProgress: 0.1,
      label: `阶段 1/${stages}: 合法排班已就绪，正在比较实际主班产出...`,
    })
    if (uniqueCandidates.length >= synthesisOptions.branchCount) break
  }

  if (uniqueCandidates.length === 0) {
    result.diagnostics.push({ code: 'INSUFFICIENT_STAFF', message: '组合和实际练度散件均无法补齐当前布局的主班与独立替补。请增加持有干员、减少工作工位，或检查锁定人员及替补占用。' })
    return result
  }
  const initial = uniqueCandidates[0]!
  const primaryScores = new Map<string, number>()
  let deferredPrimaryCandidate: SmartRosterCandidate | undefined
  // The large cycle-column model is an explicitly requested extension. The
  // default first spends its verification budget on strong complete primaries.
  if (enableDeepSearch || options.enableBackupGeneration === true) {
  const computed = computeManufacturingRoster({ userBase: base, initial: initial.workspace, inventory, lockedPositions, lockedOperators }, {
    warmupHours: options.simulationWarmupHours ?? 24,
    sampleHours: options.simulationSampleHours ?? 72,
    onProgress: label => onProgress?.({ phase: 'building', phaseProgress: 0.5, label: `阶段 1/${stages}: ${label}` }),
  })
  result.phases.calculation = computed.calculation
  result.diagnostics.push(...computed.diagnostics)
  if (computed.workspace && !seenFingerprints.has(workspaceFingerprint(computed.workspace))) {
    uniqueCandidates.push({ id: 'computed-assignment', workspace: computed.workspace,
      staticScore: completeShiftScores(computed.workspace, inventory)?.mean ?? null, simScore: null, diagnostics: [] })
  }
  }

  if (options.enableBackupGeneration === true) {
    const crews = generateContextualCrewCandidates(uniqueCandidates, inventory, { lockedPositions, lockedOperators, maxCandidates: 2 })
    result.diagnostics.push(...crews.diagnostics)
    const alternatives = generateProductionShiftAlternatives([...crews.candidates, ...uniqueCandidates], inventory, { lockedPositions, lockedOperators, maxCandidates: 2 })
    result.diagnostics.push(...alternatives.diagnostics)
    const calculated = uniqueCandidates.find(candidate => candidate.id === 'computed-assignment')
    const ordered: SmartRosterCandidate[] = [initial, ...(calculated ? [calculated] : []),
      ...crews.candidates.map(candidate => ({ ...candidate, staticScore: completeShiftScores(candidate.workspace, inventory)?.mean ?? null,
        simScore: null, diagnostics: [] })),
      ...alternatives.candidates.map(candidate => ({ ...candidate, staticScore: completeShiftScores(candidate.workspace, inventory)?.mean ?? null,
        simScore: null, diagnostics: [] })), ...uniqueCandidates]
    const selected: SmartRosterCandidate[] = [], fingerprints = new Set<string>()
    for (const candidate of ordered) {
      const fingerprint = workspaceFingerprint(candidate.workspace)
      if (fingerprints.has(fingerprint)) continue
      fingerprints.add(fingerprint); selected.push(candidate)
      if (selected.length >= 4) break
    }
    uniqueCandidates.splice(0, uniqueCandidates.length, ...selected)
  } else if (!enableDeepSearch) {
    const crews = generateContextualCrewCandidates(uniqueCandidates, inventory, { lockedPositions, lockedOperators, maxCandidates: 2 })
    result.diagnostics.push(...crews.diagnostics)
    for (const candidate of crews.candidates) {
      const fingerprint = workspaceFingerprint(candidate.workspace)
      if (seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)
      uniqueCandidates.push({ ...candidate, staticScore: null, simScore: null, diagnostics: [] })
    }
    const selected = selectHighOutputMainCandidates(uniqueCandidates, inventory, { anchorId: initial.id, maxCandidates: 2, deferNonImproving: true })
    deferredPrimaryCandidate = selected.deferredCandidate
    result.diagnostics.push(...selected.diagnostics)
    result.phases.primarySelection = { scores: selected.scores, selectedIds: selected.candidates.map(candidate => candidate.id) }
    for (const candidate of selected.scores) if (candidate.primaryHourlyScore !== null) primaryScores.set(candidate.id, candidate.primaryHourlyScore)
    uniqueCandidates.splice(0, uniqueCandidates.length, ...selected.candidates)
  }

  // ==========================================
  // Phase 2: Dynamic Simulation Verification (1+3 Days, weighted production)
  // Primary output ranks proposals; only completed F chooses the returned roster.
  // ==========================================
  const simCandidates = [...uniqueCandidates]
  onProgress?.({
    phase: 'simulating',
    phaseProgress: 0,
    totalTrials: simCandidates.length + Number(Boolean(deferredPrimaryCandidate)),
    label: `阶段 2/${stages}: 完整仿真验证高效主班与安全备选，保留日均加权产出较高者...`,
  })

  const cache = new CandidateSimulationCache()
  const simulationJob = (workspace: RosterWorkspace, generatedBackup?: GeneratedBackupDescriptor): CandidateSimulationJob => {
    // Persist the policy in the candidate itself before caching and verification.
    if (!prepareWarmupPolicy(workspace)) throw new Error('暖机干员必须具有有效的主班耗尽休息策略')
    applyGeneratedRecoveryPolicy(workspace)
    return {
    workspace,
    ...(generatedBackup ? { generatedBackup } : {}),
    options: {
      warmupHours: options.simulationWarmupHours ?? 24,
      sampleHours: options.simulationSampleHours ?? 72,
      maxStepHours: 0.25,
      productionWeights: normalizeProductionWeights(workspace.productionWeights),
      production: {
        outputMode: 'potential',
        runOrderMode: 'ideal',
        droneTarget,
        droneRoomId: options.droneRoomId,
        seed,
      },
      operatorInventory: [...entries],
    },
    assumptions: {
      restingThreshold: 0.65,
      operationDurationHours: 0,
    },
    }
  }
  const jobs = simCandidates.map(candidate => simulationJob(candidate.workspace))
  // Capture keys before dispatch; later policy/placement changes must not turn
  // a report of the original input into a report of the modified workspace.
  const inputKeys = jobs.map(job => cache.key(job))
  const efficiencies = jobs.map(job => productionEfficiencyVector(job.workspace, inventory))
  const initialResults = yield { jobs, ...simulationProgress(jobs.map(job => job.workspace), efficiencies, stages, onProgress,
    0, jobs.length + Number(Boolean(deferredPrimaryCandidate))) }
  const simulationResults = [...initialResults]
  if (deferredPrimaryCandidate && !simulationResults.some(summary => summary.completed && Number.isFinite(summary.simScore))) {
    const fallback = deferredPrimaryCandidate, job = simulationJob(fallback.workspace)
    const inputKey = cache.key(job), efficiency = productionEfficiencyVector(job.workspace, inventory)
    const fallbackResults = yield { jobs: [job], ...simulationProgress([job.workspace], [efficiency], stages, onProgress, 1, 2) }
    simCandidates.push(fallback); uniqueCandidates.push(fallback)
    jobs.push(job); inputKeys.push(inputKey); efficiencies.push(efficiency); simulationResults.push(...fallbackResults)
    result.phases.primarySelection?.selectedIds.push(fallback.id)
  }
  const efficiencyById = new Map(simCandidates.map((candidate, index) => [candidate.id, efficiencies[index]!]))
  for (let idx = 0; idx < simCandidates.length; idx++) {
    const candidate = simCandidates[idx]!
    const summary = simulationResults[idx]!
    cache.remember(inputKeys[idx]!, summary)
    candidate.simScore = summary.completed && Number.isFinite(summary.simScore) ? summary.simScore : null
    candidate.diagnostics.push(...summary.diagnostics)
    if (summary.specialOperators) candidate.specialOperators = summary.specialOperators
  }

  const completedIds = new Set(simulationResults.flatMap((summary, index) => summary.completed && Number.isFinite(summary.simScore) ? [uniqueCandidates[index]!.id] : []))
  simCandidates.sort((a, b) => Number(completedIds.has(b.id)) - Number(completedIds.has(a.id)) ||
    (b.simScore ?? 0) - (a.simScore ?? 0) ||
    ((primaryScores.get(b.id) ?? -Infinity) - (primaryScores.get(a.id) ?? -Infinity)) ||
    compareWorkspacePreference(b.workspace, a.workspace) || compareProductionEfficiencyVectors(efficiencyById.get(b.id)!, efficiencyById.get(a.id)!))
  const bestSimCandidate = simCandidates[0]!
  const staticScores = uniqueCandidates.flatMap(candidate => candidate.staticScore === null ? [] : [candidate.staticScore])
  result.phases.static = {
    candidates: [...uniqueCandidates],
    bestScore: staticScores.length ? Math.max(...staticScores) : null,
  }
  result.phases.simulation = {
    candidates: simCandidates,
    bestScore: bestSimCandidate.simScore,
  }

  if (!completedIds.has(bestSimCandidate.id)) {
    result.status = 'blocked'
    result.workspace = bestSimCandidate.workspace
    result.score = null
    const allCandidateDiags = Array.from(new Set(simCandidates.flatMap(c => c.diagnostics)))
    result.diagnostics.push({
      code: 'SIMULATION_EVALUATION_FAILED',
      message: `动态拟真计算未完成。原因：${allCandidateDiags.length ? allCandidateDiags.join('；') : '候选方案未能通过动态拟真准入校验'}`,
    })
    return result
  }

  let finalWorkspace = structuredClone(bestSimCandidate.workspace)
  let finalScore = bestSimCandidate.simScore ?? 0
  result.diagnostics.push(...bestSimCandidate.diagnostics.filter(message => message.includes('次完整主替评估预算'))
    .map(message => ({ code: 'COMBINATION_SEARCH_LIMIT', message })))
  result.specialOperators = bestSimCandidate.specialOperators ?? []

  // Only explicit opt-in runs further simulations. Every default candidate is
  // fully prepared before the parallel batch, so the winner can be returned as-is.
  if (enableDeepSearch) {
  // First calculate income, then order complete physical shifts by output/hour.
  // A changed workspace must receive its own simulation result before export.
  onProgress?.({ phase: 'searching', phaseProgress: 0.05, label: '阶段 3/3: 首次收益计算后，按每小时产出验证主替排序...' })
  const ordered = structuredClone(finalWorkspace)
  const ordering = normalizeProductionShifts(ordered, inventory, { lockedPositions, lockedOperators,
    requireWarmupExhaustion: true, warmupInventory: inventory }, 'hourly-output')
  result.diagnostics.push(...ordering.map(message => ({ code: 'PRODUCTION_SHIFT_CONSTRAINT', message })))
  if (JSON.stringify(ordered) !== JSON.stringify(finalWorkspace) && preservesFormedCombinations(finalWorkspace, ordered, inventory) &&
    configureRunOrder(ordered, inventory) && prepareWarmupPolicy(ordered)) {
    const job = simulationJob(ordered), cached = cache.get(job), verified = cached ?? simulateCandidate(job)
    if (!cached) cache.remember(cache.key(job), verified)
    if (verified.completed && verified.simScore > finalScore) { finalWorkspace = ordered; finalScore = verified.simScore }
    else if (!verified.completed) result.diagnostics.push({ code: 'SHIFT_ORDERING_UNVERIFIED', message: '主替排序后的完整模拟未完成，保留首次收益已验证的排班。' })
  }

  // ==========================================
  // Phase 3: Global Per-Capita Replacement & Balance (Rule 6)
  // ==========================================
  onProgress?.({
    phase: 'searching',
    phaseProgress: 0.1,
    label: '阶段 3/3: 全局人均产出检测与优化置换...',
  })

  const currentPowerCount = Object.values(finalWorkspace.mainPlan.facilities).filter((r) => r.type === 'power' && r.level > 0).length
  const replacementBudget = Math.min(12, Math.max(1, Math.floor(288 / Math.max(1,
    (options.simulationWarmupHours ?? 24) + (options.simulationSampleHours ?? 72)))))
  let replacementTrials = 0
  const repResult = runGlobalPerCapitaReplacement(finalWorkspace, inventory, {
    powerCount: currentPowerCount,
    lockedPositions,
    lockedOperators,
    baselineScore: finalScore,
    // Bound simulated hours rather than wall time, preserving serial/parallel
    // replay while avoiding many full 96-hour trials on mixed-stage inventories.
    maxEvaluations: replacementBudget,
    configureRunOrderCandidates: true,
    evaluator: (candidateWs) => {
      if (!preservesFormedCombinations(finalWorkspace, candidateWs, inventory)) return Number.NaN
      try {
        const job = simulationJob(candidateWs)
        const cached = cache.get(job)
        if (cached) return cached.completed ? cached.simScore : Number.NaN
        replacementTrials++
        onProgress?.({ phase: 'searching', phaseProgress: 0.1 + 0.4 * Math.min(1, replacementTrials / replacementBudget),
          label: `阶段 3/3: 动态验证散件置换 ${replacementTrials}/${replacementBudget}...` })
        const key = cache.key(job), summary = simulateCandidate(job)
        cache.remember(key, summary)
        if (summary.completed) return summary.simScore
      } catch {
        // simulation error
      }
      return Number.NaN
    },
  })
  result.phases.replacement = {
    swappedCount: repResult.swappedCount,
    logs: repResult.logs,
  }

  if (repResult.swappedCount > 0 && repResult.score && repResult.score > finalScore &&
    preservesFormedCombinations(finalWorkspace, repResult.workspace, inventory)) {
    finalWorkspace = repResult.workspace
    finalScore = repResult.score
  }

  if (enableDeepSearch) {
    onProgress?.({
      phase: 'searching',
      phaseProgress: 0.5,
      label: '阶段 3/3: 邻域深度微调 (Hill-Climb)...',
    })

    try {
      const searchResult = yield* rosterIncomeSearchSteps(
        {
          baseline: finalWorkspace,
          inventory: [...entries],
          mode: 'hill-climb',
          maxCandidates: 20,
          maxDepth: 3,
          lockedPositions: [...lockedPositions],
          objective: 'composite',
          includeControlMains: true,
          includeProductionMains: true,
          configureRunOrderCandidates: true,
          assumptions: { restingThreshold: 0.65, operationDurationHours: 0 },
          options: {
            warmupHours: options.simulationWarmupHours ?? 24,
            sampleHours: options.simulationSampleHours ?? 72,
            maxStepHours: 0.25,
            productionWeights: normalizeProductionWeights(finalWorkspace.productionWeights),
            production: {
              outputMode: 'potential',
              runOrderMode: 'ideal',
              droneTarget,
              droneRoomId: options.droneRoomId,
              seed,
            },
          },
        },
        progress => {
          onProgress?.({
            phase: 'searching',
            phaseProgress: 0.5 + 0.5 * progress.completedScenarios / Math.max(1, progress.totalScenarios),
            label: `阶段 3/3: 邻域微调 ${progress.label} (候选 ${progress.completedCandidates}/${progress.totalCandidates}，场景 ${progress.completedScenarios}/${progress.totalScenarios})`,
          })
        },
        candidate => preservesFormedCombinations(finalWorkspace, candidate, inventory) && prepareWarmupPolicy(candidate)
      )

      if (searchResult.bestCandidateId && searchResult.bestCandidateId !== 'baseline' && searchResult.bestWorkspace) {
        const gain = searchResult.candidates.find(c => c.id === searchResult.bestCandidateId)?.comparison?.minGain ?? 0
        result.phases.search = {
          improved: true,
          gain,
          result: searchResult,
        }
        const candidate = structuredClone(searchResult.bestWorkspace)
        const job = simulationJob(candidate), cached = cache.get(job)
        const verified = cached ?? simulateCandidate(job)
        if (!cached) cache.remember(cache.key(job), verified)
        if (verified.completed && verified.simScore > finalScore + 1e-6 && preservesFormedCombinations(finalWorkspace, candidate, inventory)) {
          finalWorkspace = candidate
          finalScore = verified.simScore
        } else {
          result.phases.search.improved = false
          result.phases.search.gain = 0
        }
      } else {
        result.phases.search = {
          improved: false,
          gain: 0,
          result: searchResult,
        }
      }
    } catch (searchErr) {
      // Graceful fallback to phase 2 best candidate
      result.phases.search = {
        improved: false,
        gain: 0,
      }
      result.diagnostics.push({
        code: 'SEARCH_FALLBACK',
        message: `邻域深度搜索未产生进一步改动：${searchErr instanceof Error ? searchErr.message : String(searchErr)}`,
      })
    }
  }
  }

  let finalGeneratedBackup: GeneratedBackupDescriptor | undefined
  if (options.enableBackupGeneration === true) {
    const plainScore = finalScore
    const phase = (joint: JointBackupSearchResult): NonNullable<SmartRosterResult['phases']['jointBackup']> => ({
      generatedCandidates: joint.generatedCandidates, evaluatedCandidates: joint.evaluatedCandidates,
      selectedCandidateId: joint.selectedCandidateId, improved: joint.improved, candidates: structuredClone(joint.candidates),
      simulations: joint.simulations, cacheHits: joint.cacheHits, acceptedCandidates: joint.acceptedCandidates,
      qualityRepaired: joint.qualityRepaired, termination: joint.termination, gain: joint.score - plainScore,
    })
    const joint = yield* jointBackupSearchSteps({
      primaryCandidates: [{ id: 'verified-plain', workspace: finalWorkspace }, ...uniqueCandidates],
      entries, inventory, baseline: { workspace: finalWorkspace, score: finalScore, summary: cache.get(simulationJob(structuredClone(finalWorkspace))) },
      lockedPositions, lockedOperators, cache, makeJob: simulationJob, maxCandidates: 4,
      maxSimulations: options.optimizationMaxSimulations, timeBudgetMs: options.optimizationTimeBudgetMs,
      onProgress: (completed, total, bestScore) => onProgress?.({ phase: 'searching', phaseProgress: completed / Math.max(1, total),
        currentTrial: completed, totalTrials: total, bestScore, label: `条件副表联合比较：已完成 ${completed}/${total}，按实际工休与产出保留完整方案…` }),
      onIncumbent: incumbent => {
        const summary = cache.get(simulationJob(structuredClone(incumbent.workspace), incumbent.generatedBackup))
        if (!isQualifiedCandidateSimulation(summary)) return
        const snapshot: SmartRosterResult = { ...structuredClone(result), status: 'draft',
          workspace: structuredClone(incumbent.workspace), score: summary.simScore,
          calculationReport: structuredClone(summary.calculationReport), specialOperators: structuredClone(summary.specialOperators ?? []),
          diagnostics: [...structuredClone(result.diagnostics), ...structuredClone(incumbent.diagnostics)],
          phases: { ...structuredClone(result.phases), jointBackup: phase(incumbent) } }
        onProgress?.({ phase: 'searching', phaseProgress: 0, bestScore: snapshot.score ?? undefined,
          label: '完整排班已就绪，正在预算内逐份比较条件副表。', incumbent: snapshot })
      },
    })
    finalWorkspace = joint.workspace; finalScore = joint.score; finalGeneratedBackup = joint.generatedBackup
    result.phases.jointBackup = phase(joint)
    result.diagnostics.push(...joint.diagnostics)
    if (joint.qualityRepaired) result.diagnostics.push({ code: 'GENERATED_BACKUP_QUALITY_REPAIRED', message: '联合比较保留了工休完整性合格的条件副表配置；原基线不满足该门槛，此处不将质量修复视为产出增益。' })
    else if (joint.improved) result.diagnostics.push({ code: 'GENERATED_BACKUP_SELECTED', message: `联合比较保留了带一张条件副表的排班；同种子完整仿真日均加权产出增加 ${(finalScore - plainScore).toFixed(2)}。` })
  }

  // The exported roster must be the one whose score was evaluated. Never fill or rewrite
  // dormitories/auxiliary seats after simulation; molecular synthesis already prepares them.
  if (finalWorkspace.compatibility.backupPlans.length && !finalGeneratedBackup) {
    result.diagnostics.push({ code: 'AUTOMATIC_BACKUP_PLANS_FORBIDDEN', message: '自动生成结果禁止携带副表' })
    return result
  }
  const finalWarmupPolicy = applyGeneratedWarmupPolicy(finalWorkspace, inventory)
  for (const diagnostic of finalWarmupPolicy.diagnostics) {
    if (!result.diagnostics.some(existing => existing.code === diagnostic.code && existing.message === diagnostic.message)) {
      result.diagnostics.push(diagnostic)
    }
  }
  if (!finalWarmupPolicy.valid) return result
  const finalErrors = validatePhysicalRoster(finalWorkspace)
  if (finalErrors.length) {
    result.workspace = finalWorkspace
    result.diagnostics.push(...finalErrors)
    return result
  }
  const finalJob = simulationJob(finalWorkspace, finalGeneratedBackup)
  const cachedFinal = cache.get(finalJob)
  if (finalGeneratedBackup && !isQualifiedCandidateSimulation(cachedFinal)) {
    result.workspace = finalWorkspace
    result.diagnostics.push({ code: 'GENERATED_BACKUP_RESULT_UNVERIFIED', message: '最终条件副表配置与已完成的演算输入不一致，未采用该结果。' })
    return result
  }
  if (cachedFinal?.completed) {
    finalScore = cachedFinal.simScore
    result.specialOperators = cachedFinal.specialOperators ?? []
    result.calculationReport = cachedFinal.calculationReport
  } else {
    const finalSimulation = runScheduleSimulationBridge(finalJob.workspace, finalJob.options, finalJob.assumptions)
    const verified = finalSimulation.report
    if (!verified?.success || !verified.production?.success || !verified.production.sample.completed || verified.observedHours <= 0) {
      result.workspace = finalWorkspace
      result.diagnostics.push({ code: 'FINAL_ROSTER_SIMULATION_FAILED', message: finalSimulation.error ??
        verified?.diagnostics.map(d => d.message).join('；') ?? '最终排班模拟未完成' })
      return result
    }
    finalScore = scoreSimulationProduction(verified).total
    result.calculationReport = simulationReportToCalculationReport(finalWorkspace, verified)
    result.specialOperators = verified.operators.filter(op => hasConsumptionSkill(op.operatorId)).map(op => ({
      operatorId: op.operatorId, operatorName: op.operatorName, workFraction: op.workFraction,
      workRestRatio: op.workRestRatio, workHours: op.workHours, restHours: op.restHours,
      exhaustedHours: op.exhaustedHours, finalMorale: op.finalMorale,
    }))
  }

  result.status = 'draft'
  result.workspace = finalWorkspace
  result.score = finalScore

  if (options.enableMainOptimization === true && options.enableBackupGeneration !== true) {
    let lastConfirmed = structuredClone(result)
    try {
    const optimized = yield* mainRosterOptimizationSteps({
      baseline: result,
      baselineSummary: cache.get(simulationJob(finalWorkspace)),
      inventory, userBase: base, lockedPositions, lockedOperators, cache,
      makeJob: simulationJob,
      allowFreeCombinations: options.allowFreeCombinations === true,
      maxSimulations: options.optimizationMaxSimulations,
      timeBudgetMs: options.optimizationTimeBudgetMs,
      onIncumbent: report => {
        lastConfirmed = structuredClone(report)
        onProgress?.({ phase: 'searching', phaseProgress: 0,
          bestScore: report.score ?? undefined, label: '完整主班方案已就绪，正在预算内继续优化。', incumbent: report })
      },
    })
    Object.assign(result, optimized)
    } catch (error) {
      Object.assign(result, lastConfirmed)
      result.diagnostics.push({ code: 'MAIN_OPTIMIZATION_FAILED', message: `持续优化未完成，保留最近已完成排班及其同次报告：${error instanceof Error ? error.message : String(error)}` })
    }
    finalScore = result.score ?? finalScore
  } else if (options.enableMainOptimization === true) {
    result.diagnostics.push({ code: 'MAIN_OPTIMIZATION_BACKUP_UNSUPPORTED', message: '持续主班优化与条件副表实验分别运行，本次保留副表实验结果。' })
  }

  onProgress?.({
    phase: 'done',
    phaseProgress: 1,
    bestScore: finalScore,
    label: `一键智能排班已完成，最终加权产出评分：${finalScore.toFixed(1)} 分/日`,
  })

  return result
}
