import {
  allowedCrewRows, crewCoefficientUpperBound, CrewAssignmentBudget, CrewAssignmentInterrupted,
  inspectCrewSelection, prepareCrewAssignmentModel, relaxCrewAssignment,
  type CrewAssignmentLimits, type CrewAssignmentModel, type CrewPersonBan, type CrewRelaxationResult,
  type CrewStopReason, type PreparedCrewModel,
} from './crewAssignmentKernel'

export interface CrewSearchEvent {
  readonly kind: 'relaxation' | 'incumbent' | 'branch'
  readonly nodeId: number; readonly depth: number; readonly upperBound: number
  readonly bans: readonly CrewPersonBan[]; readonly objective: number | null
  readonly relaxation?: CrewRelaxationResult
}
export interface CrewAssignmentSearchOptions extends CrewAssignmentLimits {
  readonly maxNodes?: number; readonly warmStartIds?: readonly string[]
  /** Observation only. Exceptions are recorded and cannot supply search bounds. */
  readonly onNode?: (event: CrewSearchEvent) => void
}
export interface CrewAssignmentResult {
  readonly modelId: string; readonly objectiveId: string; readonly adapterId: string | null
  readonly status: 'optimal' | 'feasible' | 'infeasible' | 'unknown'
  readonly termination: 'complete' | 'nodeLimit' | CrewStopReason; readonly stoppedAt: string | null
  readonly feasible: boolean; readonly objective: number | null; readonly selectedIds: readonly string[]
  readonly upperBound: number | null; readonly boundKind: 'finite' | 'unknown' | 'infeasible'
  readonly absoluteGap: number | null; readonly relativeGap: number | null; readonly optimalityProven: boolean
  readonly visitedNodes: number; readonly createdNodes: number; readonly pendingNodes: number
  readonly operations: number; readonly elapsedMs: number; readonly observerErrors: readonly string[]
  readonly proofScope: 'declared-additive-coefficients-only'
}
interface Node { id: number; depth: number; bans: CrewPersonBan[]; upperBound: number }

/** Branch on complete role-context conflicts; this never changes a workspace or calls F. */
export function solveCrewAssignment(input: CrewAssignmentModel, options: CrewAssignmentSearchOptions = {}): CrewAssignmentResult {
  const budget = new CrewAssignmentBudget(options), maxNodes = options.maxNodes ?? 2000
  const initialIdentity = { modelId: input.id, objectiveId: input.objective.id }
  if (!(maxNodes === Infinity || Number.isInteger(maxNodes) && maxNodes >= 0)) throw new Error('Invalid maxNodes')
  let model: PreparedCrewModel | undefined, incumbent: number | null = null, selectedIds: string[] = [], visitedNodes = 0, nextId = 1
  let termination: CrewAssignmentResult['termination'] = 'complete', stoppedAt: string | null = null, frontierInitialized = false, active: Node | undefined
  const queue: Node[] = [], seen = new Set<string>(['[]']), observerErrors: string[] = []
  const emit = (event: CrewSearchEvent): void => {
    if (!options.onNode) return
    budget.check('observe:before')
    // Only the small event is copied; the model and row library are never exposed.
    try { options.onNode(structuredClone(event)) } catch (error) { observerErrors.push(String(error)) }
    budget.check('observe:after')
  }
  try {
    budget.check('search:before-prepare')
    model = prepareCrewAssignmentModel(input, budget)
    if (options.warmStartIds !== undefined) {
      const inspection = inspectCrewSelection(model, options.warmStartIds, budget)
      if (!inspection.feasible) throw new Error(`Invalid warm start: ${inspection.errors.join('; ')}`)
      incumbent = inspection.objective; selectedIds = [...options.warmStartIds]
    }
    const firstRows = allowedCrewRows(model, [], budget), upperBound = crewCoefficientUpperBound(model, firstRows, budget)
    queue.push({ id: 0, depth: 0, bans: [], upperBound }); frontierInitialized = true
    while (queue.length) {
      budget.check('search:choose-node')
      let bestIndex = 0
      for (let i = 1; i < queue.length; i++) {
        budget.check('search:frontier')
        if (queue[i]!.upperBound > queue[bestIndex]!.upperBound) bestIndex = i
      }
      active = queue.splice(bestIndex, 1)[0]!
      if (active.upperBound === -Infinity || incumbent !== null && active.upperBound <= incumbent) { active = undefined; continue }
      if (visitedNodes >= maxNodes) { queue.push(active); active = undefined; termination = 'nodeLimit'; stoppedAt = 'search:node-limit'; break }
      visitedNodes++
      const rows = active.id === 0 ? firstRows : allowedCrewRows(model, active.bans, budget)
      const relaxation = relaxCrewAssignment(model, rows, budget)
      if (relaxation.complete) active.upperBound = relaxation.upperBound
      emit({ kind: 'relaxation', nodeId: active.id, depth: active.depth, upperBound: active.upperBound, bans: active.bans, objective: incumbent, relaxation })
      if (!relaxation.complete) throw new CrewAssignmentInterrupted(relaxation.reason, relaxation.stage)
      if (!relaxation.feasible || incumbent !== null && relaxation.upperBound <= incumbent) { active = undefined; continue }
      const inspection = inspectCrewSelection(model, relaxation.witnessIds, budget)
      if (!inspection.relaxedValid || inspection.objective !== relaxation.upperBound) throw new Error('Relaxation witness violates the declared model')
      if (inspection.feasible) {
        incumbent = inspection.objective; selectedIds = [...relaxation.witnessIds]
        emit({ kind: 'incumbent', nodeId: active.id, depth: active.depth, upperBound: active.upperBound, bans: active.bans, objective: incumbent })
        active = undefined; continue
      }
      const conflict = [...inspection.conflicts].sort((a, b) => b.contexts.length - a.contexts.length || a.person.localeCompare(b.person))[0]!
      const contexts = [...new Set(conflict.contexts)].slice(0, 2)
      if (contexts.length !== 2) throw new Error('Conflict must span two physical role-contexts')
      for (const context of contexts) {
        budget.check('search:branch')
        const bans = [...active.bans, { context, person: conflict.person }].sort((a, b) => a.context.localeCompare(b.context) || a.person.localeCompare(b.person))
        const key = JSON.stringify(bans)
        if (seen.has(key)) continue
        seen.add(key); queue.push({ id: nextId++, depth: active.depth + 1, bans, upperBound: relaxation.upperBound })
      }
      emit({ kind: 'branch', nodeId: active.id, depth: active.depth, upperBound: active.upperBound, bans: active.bans, objective: incumbent })
      active = undefined
    }
  } catch (error) {
    if (!(error instanceof CrewAssignmentInterrupted)) throw error
    termination = error.reason; stoppedAt = error.stage
    // If interruption occurs inside filtering, checking or branching, retain the
    // complete parent's domain and bound, including any not-yet-created child.
    if (active) queue.push(active)
  }
  const pendingUpper = frontierInitialized ? queue.reduce((upper, node) => Math.max(upper, node.upperBound), -Infinity) : Infinity
  const rawUpper = incumbent === null ? pendingUpper : Math.max(incumbent, pendingUpper)
  const optimalityProven = incumbent !== null && (termination === 'complete' || rawUpper <= incumbent)
  const status: CrewAssignmentResult['status'] = optimalityProven ? 'optimal' : termination === 'complete' ? 'infeasible' : incumbent !== null ? 'feasible' : 'unknown'
  const upperBound = Number.isFinite(rawUpper) ? rawUpper : null
  const absoluteGap = incumbent === null || upperBound === null ? null : Math.max(0, upperBound - incumbent)
  return { modelId: model?.id ?? initialIdentity.modelId, objectiveId: model?.objectiveId ?? initialIdentity.objectiveId, adapterId: model?.adapterId ?? null,
    status, termination, stoppedAt, feasible: incumbent !== null, objective: incumbent, selectedIds,
    upperBound, boundKind: rawUpper === -Infinity ? 'infeasible' : Number.isFinite(rawUpper) ? 'finite' : 'unknown',
    absoluteGap, relativeGap: absoluteGap === null || incumbent === null ? null : absoluteGap / Math.max(1, Math.abs(incumbent)), optimalityProven,
    visitedNodes, createdNodes: nextId, pendingNodes: queue.length, operations: budget.operations, elapsedMs: budget.elapsedMs, observerErrors,
    proofScope: 'declared-additive-coefficients-only' }
}
