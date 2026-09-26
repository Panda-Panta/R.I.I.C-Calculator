import { mainPlanOnly } from './mainPlanOnly'
import { runOrderInventoryDiagnostics } from './configureRunOrder'
import type { RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreProduction } from './productionObjective'
import { hasConsumptionSkill } from './fixedDuty'
import { runRosterIncomeSearch, type IncomeSearchResult } from './rosterIncomeSearch'
import { validatePhysicalRoster } from './rosterDraft'
import { generateMolecularCandidates } from './molecularSynthesis'
import { runGlobalPerCapitaReplacement } from './globalPerCapitaReplacement'
import { simulateCandidate, type CandidateSimulationJob, type CandidateSimulationResult } from './candidateSimulation'
import { CandidateSimulationCache } from './candidateSimulationCache'
import { compareIncome, summarizeIncome } from './incomeComparison'

export interface SmartRosterOptions {
  seed?: number
  branchCount?: number
  /** Legacy settings retained for old saved configurations; no longer control branch admission. */
  trials?: number
  maxStaticEvals?: number
  simulationTopK?: number
  simulationWarmupHours?: number
  simulationSampleHours?: number
  enableDeepSearch?: boolean
  /** Additional distinct-candidate budget, shared by all finalists; 0 keeps legacy search. */
  searchBudget?: number
  refinementTopK?: number
  droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
  droneRoomId?: string
}

export interface SmartRosterProgress {
  phase: 'building' | 'simulating' | 'searching' | 'done'
  phaseProgress: number
  currentTrial?: number
  totalTrials?: number
  bestScore?: number
  label: string
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
  staticScore: number
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
  phases: {
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
      /** Final same-request score delta from the roster immediately before neighborhood search. */
      gain: number
      result?: IncomeSearchResult
    } | null
    replacement?: {
      swappedCount: number
      logs: string[]
    }
    refinements?: { candidateId: string; budget: number; evaluated: number; accepted: boolean; score: number; minGain?: number; issues: string[] }[]
  }
}

function workspaceFingerprint(w: RosterWorkspace): string {
  const rooms = Object.values(w.mainPlan.facilities).map(r => [
    r.roomId,
    r.slots.map(s => (s.occupant.kind === 'operator' ? resolveId(s.occupant.operatorId) : '')),
    r.slots.map(s => s.replacements.map(resolveId)),
  ])
  return JSON.stringify(rooms)
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
    const completed = simulationProgress(step.value.length, onProgress)
    step = run.next(step.value.map((job, index) => {
      const result = simulateCandidate(job)
      completed(result, index)
      return result
    }))
  }
  return step.value
}

function simulationProgress(total: number, onProgress?: (p: SmartRosterProgress) => void) {
  let completed = 0, bestScore = 0
  return (result: CandidateSimulationResult, _index: number) => {
    completed++; bestScore = Math.max(bestScore, result.simScore)
    onProgress?.({ phase: 'simulating', phaseProgress: completed / total,
      currentTrial: completed, totalTrials: total, bestScore,
      label: `阶段 2/2: 动态拟真进度 ${completed}/${total}（82分: ${result.simScore.toFixed(1)}）` })
  }
}

export type CandidateBatchExecutor = (
  jobs: CandidateSimulationJob[],
  onComplete: (result: CandidateSimulationResult, index: number) => void,
) => Promise<CandidateSimulationResult[]>

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
    const jobs = step.value
    const results = await execute(jobs, simulationProgress(jobs.length, onProgress))
    if (results.length !== jobs.length) throw new Error('候选仿真返回数量不完整')
    step = run.next(results)
  }
  return step.value
}

function* smartRosterSteps(
  base: RosterWorkspace,
  entries: readonly OwnedOperatorInput[],
  options: SmartRosterOptions = {},
  onProgress?: (p: SmartRosterProgress) => void,
): Generator<CandidateSimulationJob[], SmartRosterResult, CandidateSimulationResult[]> {
 base = mainPlanOnly(base)
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
  const trials = options.branchCount ?? 10
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) {
    result.diagnostics.push({ code: 'INVALID_BRANCH_COUNT', message: '有效分支数必须为 1–20 的整数。' })
    return result
  }
  const enableDeepSearch = options.enableDeepSearch ?? true
  const searchBudget = options.searchBudget ?? 24
  const refinementTopK = options.refinementTopK ?? 3
  if (!Number.isSafeInteger(searchBudget) || searchBudget < 0 || searchBudget > 200 ||
      !Number.isSafeInteger(refinementTopK) || refinementTopK < 1 || refinementTopK > 5) {
    result.diagnostics.push({code:'INVALID_SEARCH_OPTIONS',message:'追加搜索预算须为 0–200、深入优化方案数须为 1–5 的整数。'})
    return result
  }
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
  // ==========================================
  // Phase 1: Indivisible Atomic-to-Molecular Synthesis
  // ==========================================
  onProgress?.({
    phase: 'building',
    phaseProgress: 0,
    currentTrial: 0,
    totalTrials: trials,
    label: '阶段 1/2: 不可分割原子组合与多分支分子合成...',
  })

  const branchCount = trials
  const molecularBranches = generateMolecularCandidates(base, entries, inventory, {
    seed,
    branchCount,
    lockedPositions,
    lockedOperators,
    droneTarget,
  })

  // Deduplicate candidates by layout fingerprint
  const seenFingerprints = new Set<string>()
  const uniqueCandidates: SmartRosterCandidate[] = []
  for (let bIdx = 0; bIdx < molecularBranches.length; bIdx++) {
    const branch = molecularBranches[bIdx]!
    if (branch.workspace.compatibility.backupPlans.length) { result.diagnostics.push({ code: 'AUTOMATIC_BACKUP_PLANS_FORBIDDEN', message: '自动生成候选禁止携带副表' }); continue }
    const fp = workspaceFingerprint(branch.workspace)
    if (seenFingerprints.has(fp)) continue
    seenFingerprints.add(fp)

    uniqueCandidates.push({
      id: branch.id,
      workspace: branch.workspace,
      staticScore: 0,
      simScore: null,
      diagnostics: [],
    })

    onProgress?.({
      phase: 'building',
      phaseProgress: (bIdx + 1) / molecularBranches.length,
      currentTrial: bIdx + 1,
      totalTrials: molecularBranches.length,
      label: `阶段 1/2: 分子合成候选生成 ${bIdx + 1}/${molecularBranches.length} 完成`,
    })
  }

  if (uniqueCandidates.length === 0) {
    result.diagnostics.push({ code: 'INSUFFICIENT_STAFF', message: '组合和实际练度散件均无法补齐当前布局的主班与独立替补。请增加持有干员、减少工作工位，或检查锁定人员及替补占用。' })
    return result
  }
  if (uniqueCandidates.length < branchCount) result.diagnostics.push({code:'FEWER_DISTINCT_BRANCHES',message:`生成 ${uniqueCandidates.length}/${branchCount} 个有效候选，使用全部现有候选继续模拟。`})

  // ==========================================
  // Phase 2: Dynamic Simulation Verification (1+3 Days, 82 Formula)
  // Admit the complete distinct, physically valid branch set before simulating every member.
  // ==========================================
  const simCandidates = [...uniqueCandidates]
  onProgress?.({
    phase: 'simulating',
    phaseProgress: 0,
    totalTrials: simCandidates.length,
    label: `阶段 2/2: 全量动态拟真评估（预热 1 天 + 采样 3 天，82 综合评分）...`,
  })

  const cache = new CandidateSimulationCache()
  const simulationJob = (workspace: RosterWorkspace): CandidateSimulationJob => ({
    workspace,
    options: {
      warmupHours: options.simulationWarmupHours ?? 24,
      sampleHours: options.simulationSampleHours ?? 72,
      maxStepHours: 0.25,
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
  })
  const jobs = simCandidates.map(candidate => simulationJob(candidate.workspace))
  // Capture keys before dispatch; later policy/placement changes must not turn
  // a report of the original input into a report of the modified workspace.
  const inputKeys = jobs.map(job => cache.key(job))
  const simulationResults = yield jobs
  for (let idx = 0; idx < simCandidates.length; idx++) {
    const candidate = simCandidates[idx]!
    const summary = simulationResults[idx]!
    cache.remember(inputKeys[idx]!, summary)
    candidate.simScore = summary.simScore
    candidate.staticScore = summary.simScore
    candidate.diagnostics.push(...summary.diagnostics)
    if (summary.specialOperators) candidate.specialOperators = summary.specialOperators
  }

  simCandidates.sort((a, b) => (b.simScore ?? 0) - (a.simScore ?? 0))
  const bestSimCandidate = simCandidates[0]!
  result.phases.static = {
    candidates: simCandidates,
    bestScore: bestSimCandidate.simScore ?? 0,
  }
  result.phases.simulation = {
    candidates: simCandidates,
    bestScore: bestSimCandidate.simScore ?? 0,
  }

  if (bestSimCandidate.simScore === null || bestSimCandidate.simScore <= 0) {
    result.status = 'blocked'
    result.workspace = bestSimCandidate.workspace
    result.score = 0
    const allCandidateDiags = Array.from(new Set(simCandidates.flatMap(c => c.diagnostics)))
    result.diagnostics.push({
      code: 'SIMULATION_EVALUATION_FAILED',
      message: `动态拟真计算未完成或产出为0。原因：${allCandidateDiags.length ? allCandidateDiags.join('；') : '候选方案未能通过动态拟真准入校验'}`,
    })
    return result
  }

  let finalWorkspace = structuredClone(bestSimCandidate.workspace)
  let finalScore = bestSimCandidate.simScore ?? 0
  result.specialOperators = bestSimCandidate.specialOperators ?? []

  // ==========================================
  // Phase 3: Global Per-Capita Replacement & Balance (Rule 6)
  // ==========================================
  onProgress?.({
    phase: 'searching',
    phaseProgress: 0.1,
    label: '阶段 3/3: 全局人均产出检测与优化置换...',
  })

  const currentPowerCount = Object.values(finalWorkspace.mainPlan.facilities).filter((r) => r.type === 'power').length
  const repResult = runGlobalPerCapitaReplacement(finalWorkspace, inventory, {
    powerCount: currentPowerCount,
    lockedPositions,
    lockedOperators,
    baselineScore: finalScore,
    evaluator: (candidateWs) => {
      try {
        const job = simulationJob(candidateWs)
        const cached = cache.get(job)
        if (cached) return cached.simScore
        const key = cache.key(job), summary = simulateCandidate(job)
        cache.remember(key, summary)
        if (summary.completed) return summary.simScore
      } catch {
        // simulation error
      }
      return 0
    },
  })
  result.phases.replacement = {
    swappedCount: repResult.swappedCount,
    logs: repResult.logs,
  }

  if (repResult.swappedCount > 0 && repResult.score && repResult.score > finalScore) {
    finalWorkspace = repResult.workspace
    finalScore = repResult.score
  }

  const searchStartingScore = finalScore
  if (enableDeepSearch) {
    onProgress?.({
      phase: 'searching',
      phaseProgress: 0.5,
      label: '阶段 3/3: 邻域深度微调 (Hill-Climb)...',
    })

    try {
      const searchResult = runRosterIncomeSearch(
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
          assumptions: { restingThreshold: 0.65, operationDurationHours: 0 },
          options: {
            warmupHours: options.simulationWarmupHours ?? 24,
            sampleHours: options.simulationSampleHours ?? 72,
            maxStepHours: 0.25,
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
            phaseProgress: progress.completedCandidates / Math.max(1, progress.totalCandidates),
            label: `阶段 3/3: 邻域微调 ${progress.label} (${progress.completedCandidates}/${progress.totalCandidates})`,
          })
        }
      )

      if (searchResult.bestCandidateId && searchResult.bestCandidateId !== 'baseline' && searchResult.bestWorkspace) {
        const gain = searchResult.candidates.find(c => c.id === searchResult.bestCandidateId)?.comparison?.minGain ?? 0
        result.phases.search = {
          improved: true,
          gain,
          result: searchResult,
        }
        finalWorkspace = searchResult.bestWorkspace
        finalScore += gain
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

  // Keep the legacy winner, then explore the other leading branches as independent starts.
  // Only actual, same-request scores and a common holdout comparison may replace it.
  if (enableDeepSearch && searchBudget > 0) {
    const evaluate = (workspace: RosterWorkspace) => {
      const job = simulationJob(workspace), cached = cache.get(job)
      if (cached) return cached
      const summary = simulateCandidate(job)
      cache.remember(cache.key(job), summary)
      return summary
    }
    const incumbent = evaluate(finalWorkspace)
    if (incumbent.completed && Number.isFinite(incumbent.simScore) && incumbent.simScore > 0) {
      finalScore = incumbent.simScore
      const starts = [{id:bestSimCandidate.id,workspace:structuredClone(finalWorkspace)},
        ...simCandidates.filter(c=>c.id!==bestSimCandidate.id && (c.simScore ?? 0)>0)]
        .filter((c,index,all)=>all.findIndex(other=>cache.key(simulationJob(other.workspace))===cache.key(simulationJob(c.workspace)))===index)
        .slice(0,refinementTopK)
      result.phases.refinements = []
      let remaining = searchBudget
      for (const [index,start] of starts.entries()) {
        const budget = Math.ceil(remaining / (starts.length-index))
        if (budget < 1) continue
        const record = {candidateId:start.id,budget,evaluated:0,accepted:false,score:finalScore,issues:[] as string[],minGain:undefined as number|undefined}
        result.phases.refinements.push(record)
        // Reserve budgets before invoking a search: a failed call cannot spend its allowance twice.
        remaining -= budget
        try {
          const explored = runRosterIncomeSearch({
            baseline:start.workspace,inventory:[...entries],mode:'multi-start',objective:'composite',
            maxCandidates:budget,maxDepth:8,restarts:Math.min(20,Math.max(1,Math.ceil((budget-1)/8))),
            searchSeed:(seed+Math.imul(index,0x9e3779b9))>>>0,
            includeControlMains:true,includeProductionMains:true,lockedPositions:[...lockedPositions],
            options:simulationJob(start.workspace).options,assumptions:simulationJob(start.workspace).assumptions,
          }, progress=>onProgress?.({phase:'searching',phaseProgress:(searchBudget-remaining-budget+progress.completedCandidates)/searchBudget,
            bestScore:finalScore,label:`追加寻优 ${index+1}/${starts.length}：${progress.label} (${progress.completedCandidates}/${budget})`}))
          record.evaluated = explored.evaluatedCandidates
          record.issues.push(...explored.issues ?? [])
          const validation = explored.validation
          if (!explored.bestCandidateId || validation?.status !== 'passed') continue
          const candidate = explored.bestWorkspace
          if (candidate.compatibility.backupPlans.length || validatePhysicalRoster(candidate).length) continue
          const summary = evaluate(candidate)
          if (!summary.completed || !Number.isFinite(summary.simScore) || summary.simScore <= finalScore) continue
          const candidateCases = validation.candidates.find(c=>c.id===explored.bestCandidateId)?.cases
          if (!candidateCases) continue
          // The runner-up's local improvement is insufficient: compare against the current best
          // using the same new seeds, 168+h window, inventory, drone policy and step sizes.
          const incumbentCases = validation.seeds.flatMap(holdoutSeed=>validation.steps.map(step=>{
            const response = runScheduleSimulationBridge(finalWorkspace,{
              ...structuredClone(explored.settings.options),sampleHours:validation.sampleHours,warmupHours:validation.warmupHours,
              maxStepHours:step,production:{...explored.settings.options.production,seed:holdoutSeed},
            },structuredClone(explored.settings.assumptions))
            if (!response.report) throw new Error(response.error ?? '保底方案复核失败')
            return summarizeIncome(response.report)
          }))
          const comparison = compareIncome(incumbentCases,candidateCases,'composite')
          record.minGain = comparison.minGain
          if (comparison.status !== 'improved') {record.issues.push(...comparison.reasons);continue}
          finalWorkspace = structuredClone(candidate)
          finalScore = summary.simScore
          record.accepted = true;record.score = finalScore
          result.phases.search = {improved:true,gain:finalScore-searchStartingScore,result:explored}
        } catch (error) {
          record.issues.push(error instanceof Error ? error.message : String(error))
          result.diagnostics.push({code:'REFINEMENT_FALLBACK',message:`${start.id} 追加搜索未完成，保留已验证方案：${record.issues[record.issues.length-1]}`})
        }
      }
    }
  }

  // The exported roster must be the one whose score was evaluated. Never fill or rewrite
  // dormitories/auxiliary seats after simulation; molecular synthesis already prepares them.
  if (finalWorkspace.compatibility.backupPlans.length) {
    result.diagnostics.push({ code: 'AUTOMATIC_BACKUP_PLANS_FORBIDDEN', message: '自动生成结果禁止携带副表' })
    return result
  }
  const finalErrors = validatePhysicalRoster(finalWorkspace)
  if (finalErrors.length) {
    result.workspace = finalWorkspace
    result.diagnostics.push(...finalErrors)
    return result
  }
  const finalJob = simulationJob(finalWorkspace)
  const cachedFinal = cache.get(finalJob)
  if (cachedFinal) {
    finalScore = cachedFinal.simScore
    result.specialOperators = cachedFinal.specialOperators ?? []
  } else {
    const finalSimulation = runScheduleSimulationBridge(finalJob.workspace, finalJob.options, finalJob.assumptions)
    const verified = finalSimulation.report
    if (!verified?.success || !verified.production?.success || verified.observedHours <= 0) {
      result.workspace = finalWorkspace
      result.diagnostics.push({ code: 'FINAL_ROSTER_SIMULATION_FAILED', message: finalSimulation.error ??
        verified?.diagnostics.map(d => d.message).join('；') ?? '最终排班模拟未完成' })
      return result
    }
    finalScore = scoreProduction(verified.production.sample.completed, verified.observedHours).total
    result.specialOperators = verified.operators.filter(op => hasConsumptionSkill(op.operatorId)).map(op => ({
      operatorId: op.operatorId, operatorName: op.operatorName, workFraction: op.workFraction,
      workRestRatio: op.workRestRatio, workHours: op.workHours, restHours: op.restHours,
      exhaustedHours: op.exhaustedHours, finalMorale: op.finalMorale,
    }))
  }

  result.status = 'draft'
  result.workspace = finalWorkspace
  result.score = finalScore
  if (result.phases.search) {
    result.phases.search.gain = finalScore-searchStartingScore
    result.phases.search.improved = finalScore > searchStartingScore
  }

  onProgress?.({
    phase: 'done',
    phaseProgress: 1,
    bestScore: finalScore,
    label: `一键智能排班已完成，最终 82 综合评分：${finalScore.toFixed(1)} 分/日`,
  })

  return result
}
