import type { RosterWorkspace } from '../domain/roster'
import { applyGeneratedRecoveryPolicy } from './generatedRecoveryPolicy'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import {
  prepareManufacturingCrewDomain, enumerateManufacturingCrewColumns, decodeManufacturingCrewSelection,
  ManufacturingCrewBudgetExceeded, type ManufacturingCrewInput, type ManufacturingCrewColumn,
  type ManufacturingCrewDiagnostic,
} from './manufacturingCrewDomain'
import { valueManufacturingCrewColumns, type ManufacturingCrewValuationOptions, type ManufacturingCrewValuationResult } from './manufacturingCrewValuation'
import { solveCrewAssignment, type CrewAssignmentResult, type CrewAssignmentSearchOptions } from './crewAssignmentSearch'
import { prepareCrewAssignmentModel, inspectCrewSelection, type CrewAssignmentModel } from './crewAssignmentKernel'
import { screenManufacturingCrewColumns } from './manufacturingCrewFeasibility'

export interface ComputedRosterCalculation {
  status: 'complete' | 'limited' | 'unsupported' | 'invalid'
  libraryComplete: boolean
  columnCount: number
  quantifiedColumnCount: number
  initialObjective: number | null
  screening?: Pick<ReturnType<typeof screenManufacturingCrewColumns>, 'complete' | 'feasible' | 'stats' | 'reason'> & { retainedColumns: number }
  assignment?: CrewAssignmentResult
  valuation?: Pick<ManufacturingCrewValuationResult, 'status' | 'completeDomain' | 'initialColumnsQuantified' | 'stopReason' | 'window' | 'stats'>
  frozenComponents: { roomIds: string[]; reason: string }[]
  elapsedMs: number
  /** Even a complete/optimal calculation is not a bound on full simulation income. */
  proofScope: 'quantified-manufacturing-model-only'
}
export interface ComputedManufacturingRosterOptions {
  warmupHours?: number
  sampleHours?: number
  enumeration?: { maxColumns?: number; maxVisits?: number; timeLimitMs?: number }
  screening?: { timeLimitMs?: number; maxStates?: number; maxTransitions?: number }
  valuation?: ManufacturingCrewValuationOptions
  assignment?: CrewAssignmentSearchOptions
  onProgress?: (label: string) => void
  now?: () => number
}
export interface ComputedManufacturingRosterResult {
  /** Only a changed, transactionally decoded calculation is offered for full F verification. */
  workspace: RosterWorkspace | null
  diagnostics: ManufacturingCrewDiagnostic[]
  calculation: ComputedRosterCalculation
}

/** One algebraic crew allocation, followed by verification in the caller's full simulator. */
export function computeManufacturingRoster(input: ManufacturingCrewInput, options: ComputedManufacturingRosterOptions = {}): ComputedManufacturingRosterResult {
  const now = options.now ?? (() => performance.now()), start = now()
  const result: ComputedManufacturingRosterResult = { workspace: null, diagnostics: [], calculation: {
    status: 'unsupported', libraryComplete: false, columnCount: 0, quantifiedColumnCount: 0,
    initialObjective: null, frozenComponents: [], elapsedMs: 0, proofScope: 'quantified-manufacturing-model-only',
  } }
  const finish = () => { result.calculation.elapsedMs = Math.max(0, now() - start); return result }
  try {
    const prepared = prepareManufacturingCrewDomain(input)
    result.diagnostics.push(...prepared.diagnostics)
    result.calculation.frozenComponents = prepared.frozenComponents
    if (prepared.status !== 'ready' || !prepared.domain) {
      result.calculation.status = prepared.status === 'invalid' ? 'invalid' : 'unsupported'
      return finish()
    }
    const domain = prepared.domain, columns: ManufacturingCrewColumn[] = [], enumerationStart = now()
    const enumeration = { maxColumns: 350_000, maxVisits: 2_000_000, timeLimitMs: 10_000, ...options.enumeration }
    if (!Number.isFinite(start) || !Number.isFinite(enumeration.timeLimitMs) || enumeration.timeLimitMs < 0 ||
      !Number.isSafeInteger(enumeration.maxColumns) || enumeration.maxColumns < 0 ||
      !Number.isSafeInteger(enumeration.maxVisits) || enumeration.maxVisits < 0) throw new Error('队伍计算预算必须为有效的非负数。')
    options.onProgress?.('建立符合实际持有、锁定与完整组合约束的队伍分配域…')
    try {
      for (const column of enumerateManufacturingCrewColumns(domain, {
        maxColumns: enumeration.maxColumns, maxVisits: enumeration.maxVisits,
        check: () => now() - enumerationStart < enumeration.timeLimitMs,
      })) columns.push(column)
      result.calculation.libraryComplete = true
    } catch (error) {
      if (!(error instanceof ManufacturingCrewBudgetExceeded)) throw error
      result.diagnostics.push({ code: 'CREW_LIBRARY_LIMIT', message: '队伍域计算达到预算，只使用已完成的合法队伍；未证明完整分配域的最优性。' })
    }
    result.calculation.columnCount = columns.length
    if (!columns.length) { result.calculation.status = 'limited'; return finish() }
    const screened = screenManufacturingCrewColumns({ rows: columns, groups: domain.groups.map(group => group.originalRoomId),
      rooms: domain.rooms, coreIds: domain.coreIds, requiredCores: domain.requiredCores },
    { timeLimitMs: 5_000, maxStates: 400_000, maxTransitions: 4_000_000, ...options.screening, now })
    result.calculation.screening = { complete: screened.complete, feasible: screened.feasible, stats: screened.stats,
      reason: screened.reason, retainedColumns: screened.rows.length }
    if (screened.complete) {
      const retained = new Set(screened.rows.map(row => row.id))
      const supplied = new Set(columns.map(row => row.id))
      if (domain.initialColumns.every(row => supplied.has(row.id)) && domain.initialColumns.some(row => !retained.has(row.id))) {
        throw new Error('结构筛选排除了初始可行分配中的队伍。')
      }
    }
    if (!screened.rows.length) { result.calculation.status = 'limited'; return finish() }
    options.onProgress?.('计算完整队伍的心情、暖机与主替周期产出…')
    const valuation = valueManufacturingCrewColumns(domain, screened.rows, {
      timeLimitMs: 45_000, maxOperations: 4_000_000, ...options.valuation,
      warmupHours: options.warmupHours ?? 24, sampleHours: options.sampleHours ?? 72,
      now: options.valuation?.now ?? now,
    })
    const { status, completeDomain, initialColumnsQuantified, stopReason, window, stats } = valuation
    result.calculation.valuation = { status, completeDomain, initialColumnsQuantified, stopReason, window, stats }
    result.calculation.quantifiedColumnCount = valuation.rows.length
    // Summarize rejected rows rather than copying a potentially huge diagnostic list into a Worker response.
    const categories = new Map<string, { message: string; count: number }>()
    for (const diagnostic of valuation.diagnostics) {
      const category = categories.get(diagnostic.code)
      if (category) category.count++
      else categories.set(diagnostic.code, { message: diagnostic.message, count: 1 })
    }
    for (const [code, category] of categories) result.diagnostics.push({ code, message: `${category.message}${category.count > 1 ? `（${category.count} 项）` : ''}` })
    if (!completeDomain) result.diagnostics.push({ code: 'CREW_VALUATION_LIMIT', message: '周期模型只覆盖已完整量化的队伍，最终收益仍由完整仿真验证。' })
    result.calculation.status = status === 'invalid' ? 'invalid' : 'limited'
    if (!valuation.rows.length || status === 'invalid') return finish()
    const model: CrewAssignmentModel = {
      id: 'manufacturing-crew-assignment', objective: { kind: 'cycle-table', id: valuation.objectiveId },
      groups: domain.groups.map(group => group.originalRoomId), rooms: domain.rooms,
      coreIds: domain.coreIds, requiredCores: domain.requiredCores, rows: valuation.rows,
    }
    let warmStartIds: string[] | undefined
    if (initialColumnsQuantified) {
      const initialIds = new Set(domain.initialColumns.map(column => column.id))
      const initialModel = prepareCrewAssignmentModel({ ...model, rows: valuation.rows.filter(row => initialIds.has(row.id)) })
      const inspected = inspectCrewSelection(initialModel, [...initialIds])
      if (inspected.feasible) { warmStartIds = [...initialIds]; result.calculation.initialObjective = inspected.objective }
    }
    options.onProgress?.('联合计算设施落点、完整主替队伍和人员唯一分配…')
    const assignment = solveCrewAssignment(model, {
      timeLimitMs: 5_000, maxOperations: 12_000_000, maxColumns: 350_000, maxCycleValues: 2_000_000,
      maxStates: 400_000, maxNodes: 2_000, ...options.assignment, warmStartIds,
      now: options.assignment?.now ?? now,
    })
    result.calculation.assignment = assignment
    result.calculation.status = result.calculation.libraryComplete && completeDomain && assignment.termination === 'complete' ? 'complete' : 'limited'
    if (!assignment.feasible) return finish()
    // Only IDs from the valued library reach the decoder. Never reconstruct a crew from solver labels.
    const byId = new Map(valuation.rows.map(row => [row.id, row]))
    const selected = assignment.selectedIds.map(id => byId.get(id))
    if (selected.some(row => !row)) throw new Error('计算结果引用了未完整估值的队伍。')
    const decoded = decodeManufacturingCrewSelection(domain, selected as ManufacturingCrewColumn[])
    if (!decoded.valid) { result.diagnostics.push(...decoded.diagnostics); result.calculation.status = 'invalid'; return finish() }
    const policy = applyGeneratedWarmupPolicy(decoded.workspace, input.inventory)
    if (!policy.valid) { result.diagnostics.push(...policy.diagnostics); result.calculation.status = 'invalid'; return finish() }
    applyGeneratedRecoveryPolicy(decoded.workspace)
    if (JSON.stringify(decoded.workspace) !== JSON.stringify(input.initial)) result.workspace = decoded.workspace
  } catch (error) {
    result.calculation.status = 'invalid'
    result.diagnostics.push({ code: 'CREW_CALCULATION_FAILED', message: `队伍计算未完成，保留初始排班：${error instanceof Error ? error.message : String(error)}` })
  }
  return finish()
}
