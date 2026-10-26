/** Numeric crew assignment only: these bounds apply to declared G coefficients, never simulated income. */
export interface CrewColumnIdentity {
  readonly id: string
  readonly groupOrigin: string
  readonly roomId: string
  readonly ids: readonly string[]
  readonly retainedCores: readonly string[]
}
export interface ScalarCrewMain extends CrewColumnIdentity {
  readonly role: 'main'; readonly score: number; readonly u: number; readonly restHours: number
}
export interface ScalarCrewBackup extends CrewColumnIdentity {
  readonly role: 'backup'; readonly score: number; readonly lower: number; readonly maximumCoverHours: number | null
}
export interface CycleCrewMain extends ScalarCrewMain { readonly cycleKey: string }
export interface CycleCrewBackup extends CrewColumnIdentity {
  readonly role: 'backup'; readonly lower: number; readonly maximumCoverHours: number | null
  readonly compatibleCycleKeys: readonly string[]; readonly scoreByCycleKey: Readonly<Record<string, number>>
}
export type ScalarCrewColumn = ScalarCrewMain | ScalarCrewBackup
export type CycleCrewColumn = CycleCrewMain | CycleCrewBackup
interface CrewDomain {
  readonly id: string; readonly groups: readonly string[]; readonly rooms: readonly string[]
  readonly coreIds?: readonly string[]; readonly requiredCores: readonly string[]
  readonly lockedRowIds?: readonly string[]; readonly cycleTolerance?: number
}
export type CrewAssignmentModel = CrewDomain & (
  { readonly objective: { readonly kind: 'scalar'; readonly id: string }; readonly rows: readonly ScalarCrewColumn[] } |
  { readonly objective: { readonly kind: 'cycle-table'; readonly id: string }; readonly rows: readonly CycleCrewColumn[] }
)
export type CrewStopReason = 'timeLimit' | 'workLimit' | 'columnLimit' | 'cycleValueLimit' | 'stateLimit'
export interface CrewAssignmentLimits {
  readonly timeLimitMs?: number; readonly maxOperations?: number; readonly maxColumns?: number
  readonly maxCycleValues?: number; readonly maxStates?: number
  /** A clock is injectable for deterministic deadline tests, never for objective bounds. */
  readonly now?: () => number
}
export class CrewAssignmentInterrupted extends Error {
  constructor(readonly reason: CrewStopReason, readonly stage: string) { super(`${reason}:${stage}`) }
}
const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}
export class CrewAssignmentBudget {
  readonly startedAt: number
  readonly limits: Readonly<{ timeLimitMs: number; maxOperations: number; maxColumns: number; maxCycleValues: number; maxStates: number }>
  operations = 0
  private readonly now: () => number
  constructor(options: CrewAssignmentLimits = {}) {
    this.now = options.now ?? (() => performance.now())
    this.startedAt = finite(this.now(), 'clock')
    const limit = (value: number | undefined, fallback: number, name: string, integer = true) => {
      const result = value ?? fallback
      if (!(result === Infinity || Number.isFinite(result) && result >= 0 && (!integer || Number.isInteger(result)))) throw new Error(`Invalid ${name}`)
      return result
    }
    this.limits = Object.freeze({ timeLimitMs: limit(options.timeLimitMs, 3000, 'timeLimitMs', false), maxOperations: limit(options.maxOperations, 2_000_000, 'maxOperations'),
      maxColumns: limit(options.maxColumns, 250_000, 'maxColumns'), maxCycleValues: limit(options.maxCycleValues, 1_000_000, 'maxCycleValues'), maxStates: limit(options.maxStates, 200_000, 'maxStates') })
  }
  get elapsedMs(): number { return Math.max(0, finite(this.now(), 'clock') - this.startedAt) }
  check(stage: string): void {
    if (this.elapsedMs >= this.limits.timeLimitMs) throw new CrewAssignmentInterrupted('timeLimit', stage)
    if (this.operations >= this.limits.maxOperations) throw new CrewAssignmentInterrupted('workLimit', stage)
    this.operations++
  }
  size(kind: 'columns' | 'cycleValues' | 'states', count: number, stage: string): void {
    this.check(stage)
    const keys = { columns: 'maxColumns', cycleValues: 'maxCycleValues', states: 'maxStates' } as const
    const reasons = { columns: 'columnLimit', cycleValues: 'cycleValueLimit', states: 'stateLimit' } as const
    if (count > this.limits[keys[kind]]) throw new CrewAssignmentInterrupted(reasons[kind], stage)
  }
}

interface PreparedMain extends CrewColumnIdentity {
  readonly role: 'main'; readonly score: number; readonly u: number; readonly restHours: number; readonly cycleKey: string | null
}
interface PreparedBackup extends CrewColumnIdentity {
  readonly role: 'backup'; readonly score: number | null; readonly lower: number; readonly maximumCoverHours: number | null
  readonly compatibleCycles: ReadonlySet<string>; readonly cycleScores: ReadonlyMap<string, number>
}
export type PreparedCrewColumn = PreparedMain | PreparedBackup
export interface PreparedCrewModel {
  readonly id: string; readonly objectiveId: string; readonly objectiveKind: 'scalar' | 'cycle-table'; readonly adapterId: string
  readonly groups: readonly string[]; readonly rooms: readonly string[]; readonly coreIds: readonly string[]; readonly requiredCores: readonly string[]
  readonly lockedRowIds: readonly string[]; readonly cycleTolerance: number; readonly rows: readonly PreparedCrewColumn[]
  readonly rowById: ReadonlyMap<string, PreparedCrewColumn>; readonly coreMask: ReadonlyMap<string, number>; readonly requiredMask: number
}
const preparedModels = new WeakSet<PreparedCrewModel>()
const checkPrepared = (model: PreparedCrewModel) => { if (!preparedModels.has(model)) throw new Error('Use prepareCrewAssignmentModel before kernel calls') }
const text = (value: unknown, label: string): string => { if (typeof value !== 'string' || !value) throw new Error(`${label} must be a nonempty string`); return value }
function strings(values: readonly string[], label: string, budget: CrewAssignmentBudget): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const copied: string[] = [], seen = new Set<string>()
  for (let i = 0; i < values.length; i++) {
    budget.check(`prepare:${label}`)
    const value = text(values[i], label)
    if (seen.has(value)) throw new Error(`Duplicate ${label}`)
    seen.add(value); copied.push(value)
  }
  return Object.freeze(copied)
}
export const crewContextKey = (row: Pick<CrewColumnIdentity, 'groupOrigin' | 'roomId'> & { readonly role: 'main' | 'backup' }): string =>
  JSON.stringify([row.groupOrigin, row.roomId, row.role])

/** Copy and validate incrementally; an interrupted preparation never returns a partial model. */
export function prepareCrewAssignmentModel(input: CrewAssignmentModel, budget = new CrewAssignmentBudget()): PreparedCrewModel {
  budget.check('prepare:start')
  const id = text(input.id, 'model id'), objectiveId = text(input.objective.id, 'objective id'), kind = input.objective.kind
  if (kind !== 'scalar' && kind !== 'cycle-table') throw new Error('Unknown built-in objective')
  const groups = strings(input.groups, 'groups', budget), rooms = strings(input.rooms, 'rooms', budget)
  const requiredCores = strings(input.requiredCores, 'requiredCores', budget), coreIds = strings(input.coreIds ?? requiredCores, 'coreIds', budget)
  if (!groups.length || groups.length !== rooms.length || groups.length > 7 || coreIds.length > 20 || requiredCores.some(core => !coreIds.includes(core))) throw new Error('Invalid room/group/core domain')
  const cycleTolerance = finite(input.cycleTolerance ?? 0, 'cycleTolerance')
  if (cycleTolerance < 0) throw new Error('Negative cycle tolerance')
  budget.check('prepare:before-rows')
  if (!Array.isArray(input.rows)) throw new Error('rows must be an array')
  budget.size('columns', input.rows.length, 'prepare:column-count')
  const coreBit = new Map(coreIds.map((core, i) => [core, 1 << i])), rows: PreparedCrewColumn[] = [], rowById = new Map<string, PreparedCrewColumn>(), coreMask = new Map<string, number>()
  let cycleValues = 0
  for (let i = 0; i < input.rows.length; i++) {
    budget.check('prepare:row')
    const row = input.rows[i]
    if (!row || !groups.includes(row.groupOrigin) || !rooms.includes(row.roomId) || row.role !== 'main' && row.role !== 'backup') throw new Error('Invalid row or undeclared context')
    const rowId = text(row.id, 'row id')
    if (rowById.has(rowId)) throw new Error('Duplicate row id')
    const ids = strings(row.ids, 'person IDs', budget), retainedCores = strings(row.retainedCores, 'row cores', budget)
    if (retainedCores.some(core => !coreBit.has(core))) throw new Error('Undeclared core')
    const identity = { id: rowId, groupOrigin: row.groupOrigin, roomId: row.roomId, ids, retainedCores }
    let copied: PreparedCrewColumn
    if (row.role === 'main') {
      const u = finite(row.u, 'u'), restHours = finite(row.restHours, 'restHours'), score = finite(row.score, 'main score')
      if (u < 0 || u > 1 || restHours < 0) throw new Error('Invalid main cycle')
      const cycleKey = kind === 'cycle-table' ? text('cycleKey' in row ? row.cycleKey : undefined, 'cycleKey') : null
      copied = Object.freeze({ ...identity, role: 'main', u, restHours, score, cycleKey })
    } else {
      const lower = finite(row.lower, 'lower'), maximumCoverHours = row.maximumCoverHours === null ? null : finite(row.maximumCoverHours, 'maximumCoverHours')
      if (lower < 0 || lower > 1 || maximumCoverHours !== null && maximumCoverHours < 0) throw new Error('Invalid backup coverage')
      const cycleScores = new Map<string, number>(), compatibleCycles = new Set<string>()
      let score: number | null = null
      if (kind === 'scalar') score = finite('score' in row ? row.score : undefined, 'backup score')
      else {
        if (!('compatibleCycleKeys' in row) || !('scoreByCycleKey' in row) || !row.scoreByCycleKey || typeof row.scoreByCycleKey !== 'object' || Array.isArray(row.scoreByCycleKey)) throw new Error('Missing cycle table')
        for (const key of strings(row.compatibleCycleKeys, 'compatible cycles', budget)) compatibleCycles.add(key)
        for (const key in row.scoreByCycleKey) if (Object.prototype.hasOwnProperty.call(row.scoreByCycleKey, key)) {
          budget.size('cycleValues', ++cycleValues, 'prepare:cycle-value')
          cycleScores.set(key, finite(row.scoreByCycleKey[key], 'cycle score'))
        }
        for (const key of compatibleCycles) { budget.check('prepare:cycle-coverage'); if (!cycleScores.has(key)) throw new Error('Compatible cycle has no finite score') }
      }
      copied = Object.freeze({ ...identity, role: 'backup', lower, maximumCoverHours, score, compatibleCycles, cycleScores })
    }
    rows.push(copied); rowById.set(rowId, copied)
    coreMask.set(rowId, retainedCores.reduce((mask, core) => mask | coreBit.get(core)!, 0))
  }
  const lockedRowIds = strings(input.lockedRowIds ?? [], 'locked rows', budget)
  for (const locked of lockedRowIds) { budget.check('prepare:lock'); if (!rowById.has(locked)) throw new Error('Unknown locked row') }
  budget.check('prepare:finish')
  const model: PreparedCrewModel = Object.freeze({ id, objectiveId, objectiveKind: kind, adapterId: kind === 'scalar' ? 'u-main-plus-one-minus-u-backup-v1' : 'u-main-plus-one-minus-u-cycle-backup-v1',
    groups, rooms, requiredCores, coreIds, lockedRowIds, cycleTolerance, rows: Object.freeze(rows), rowById, coreMask,
    requiredMask: requiredCores.reduce((mask, core) => mask | coreBit.get(core)!, 0) })
  preparedModels.add(model)
  return model
}

function pairValue(model: PreparedCrewModel, main: PreparedMain, backup: PreparedBackup): number | null {
  if (main.groupOrigin !== backup.groupOrigin || main.roomId !== backup.roomId || main.u < backup.lower - model.cycleTolerance || main.restHours > (backup.maximumCoverHours ?? Infinity) + model.cycleTolerance) return null
  if (main.cycleKey !== null && !backup.compatibleCycles.has(main.cycleKey)) return null
  const score = main.cycleKey === null ? backup.score : backup.cycleScores.get(main.cycleKey)
  return finite(main.u * main.score + (1 - main.u) * finite(score, 'paired backup score'), 'pair objective')
}
export interface CrewPersonBan { readonly context: string; readonly person: string }
export function allowedCrewRows(model: PreparedCrewModel, bans: readonly CrewPersonBan[] = [], budget = new CrewAssignmentBudget()): readonly PreparedCrewColumn[] {
  checkPrepared(model)
  const locks = model.lockedRowIds.map(id => model.rowById.get(id)!), result: PreparedCrewColumn[] = []
  for (const row of model.rows) {
    budget.check('filter:row')
    let blocked = false
    for (const lock of locks) {
      budget.check('filter:lock')
      if (row.groupOrigin === lock.groupOrigin && row.roomId !== lock.roomId || row.roomId === lock.roomId && row.groupOrigin !== lock.groupOrigin || crewContextKey(row) === crewContextKey(lock) && row.id !== lock.id) { blocked = true; break }
    }
    if (!blocked) for (const ban of bans) {
      budget.check('filter:ban')
      if (crewContextKey(row) === ban.context && row.ids.includes(ban.person)) { blocked = true; break }
    }
    if (!blocked) result.push(row)
  }
  return result
}
export interface CrewSelectionInspection {
  readonly feasible: boolean; readonly relaxedValid: boolean; readonly objective: number | null; readonly errors: readonly string[]
  readonly conflicts: readonly { readonly person: string; readonly contexts: readonly string[] }[]
}
export function inspectCrewSelection(model: PreparedCrewModel, selectedIds: readonly string[], budget = new CrewAssignmentBudget()): CrewSelectionInspection {
  checkPrepared(model); budget.check('inspect:start')
  const errors: string[] = [], selected: PreparedCrewColumn[] = [], people = new Map<string, string[]>(), cores = new Map<string, number>(), seen = new Set<string>()
  for (let i = 0; i < selectedIds.length; i++) {
    budget.check('inspect:row')
    const id = selectedIds[i]!, row = model.rowById.get(id)
    if (!row || seen.has(id)) errors.push('Unknown or duplicated selected row')
    else { seen.add(id); selected.push(row) }
  }
  if (selected.length !== 2 * model.groups.length) errors.push('Incorrect number of roles')
  if (model.lockedRowIds.some(id => !seen.has(id))) errors.push('Missing locked row')
  const usedRooms = new Set<string>(); let objective = 0
  for (const group of model.groups) {
    budget.check('inspect:group')
    const mains = selected.filter((row): row is PreparedMain => row.groupOrigin === group && row.role === 'main')
    const backups = selected.filter((row): row is PreparedBackup => row.groupOrigin === group && row.role === 'backup')
    if (mains.length !== 1 || backups.length !== 1) { errors.push('Incorrect group roles'); continue }
    const main = mains[0]!, backup = backups[0]!
    if (main.roomId !== backup.roomId || usedRooms.has(main.roomId)) errors.push('Room assignment is not a permutation')
    usedRooms.add(main.roomId)
    const value = pairValue(model, main, backup)
    if (value === null) errors.push('Incompatible cycle'); else objective += value
  }
  if (usedRooms.size !== model.rooms.length) errors.push('Missing declared room')
  for (const row of selected) {
    for (const person of row.ids) { budget.check('inspect:person'); const contexts = people.get(person) ?? []; contexts.push(crewContextKey(row)); people.set(person, contexts) }
    for (const core of row.retainedCores) { budget.check('inspect:core'); cores.set(core, (cores.get(core) ?? 0) + 1) }
  }
  if (model.requiredCores.some(core => cores.get(core) !== 1) || [...cores.values()].some(count => count > 1)) errors.push('Core coverage or exclusion failed')
  const relaxedValid = errors.length === 0, conflicts = [...people].filter(([, contexts]) => contexts.length > 1).map(([person, contexts]) => ({ person, contexts }))
  if (conflicts.length) errors.push('Repeated personnel')
  return { feasible: !errors.length, relaxedValid, objective: relaxedValid ? finite(objective, 'selection objective') : null, errors, conflicts }
}
/** Each weighted term is bounded by its nonnegative coefficient maximum, also for negative scores. */
export function crewCoefficientUpperBound(model: PreparedCrewModel, rows: readonly PreparedCrewColumn[], budget: CrewAssignmentBudget): number {
  let total = 0
  for (const group of model.groups) {
    let main = -Infinity, backup = -Infinity
    for (const row of rows) {
      budget.check('coefficient-bound:row')
      if (row.groupOrigin !== group) continue
      if (row.role === 'main') main = Math.max(main, row.score)
      else if (row.score !== null) backup = Math.max(backup, row.score)
      else for (const value of row.cycleScores.values()) { budget.check('coefficient-bound:cycle'); backup = Math.max(backup, value) }
    }
    if (main === -Infinity || backup === -Infinity) return -Infinity
    total += Math.max(0, main) + Math.max(0, backup)
  }
  return total
}
interface DPEntry { value: number; ids: string[] }
interface Cell { main: Map<string, PreparedMain>; backups: PreparedBackup[]; pairs: Map<number, DPEntry> }
interface RelaxationStatistics { rows: number; pairTests: number; placements: number; transitions: number }
export type CrewRelaxationResult = { readonly complete: true; readonly feasible: boolean; readonly upperBound: number; readonly witnessIds: readonly string[]; readonly statistics: RelaxationStatistics } |
  { readonly complete: false; readonly feasible: null; readonly upperBound: null; readonly witnessIds: readonly string[]; readonly reason: CrewStopReason; readonly stage: string; readonly statistics: RelaxationStatistics }

/** Maximize over room permutations and core masks, relaxing personnel alone. */
export function relaxCrewAssignment(model: PreparedCrewModel, suppliedRows?: readonly PreparedCrewColumn[], budget = new CrewAssignmentBudget()): CrewRelaxationResult {
  checkPrepared(model)
  const statistics = { rows: 0, pairTests: 0, placements: 0, transitions: 0 }, key = (group: string, room: string) => JSON.stringify([group, room])
  try {
    budget.check('relax:start')
    const rows = suppliedRows ?? allowedCrewRows(model, [], budget), cells = new Map<string, Cell>()
    statistics.rows = rows.length
    for (const row of rows) {
      budget.check('relax:build-row')
      if (model.rowById.get(row.id) !== row) throw new Error('Relaxation rows must belong to the prepared model')
      const cellKey = key(row.groupOrigin, row.roomId)
      let cell = cells.get(cellKey)
      if (!cell) { cell = { main: new Map(), backups: [], pairs: new Map() }; cells.set(cellKey, cell) }
      if (row.role === 'backup') { cell.backups.push(row); continue }
      const signature = JSON.stringify([row.u, row.restHours, model.coreMask.get(row.id), row.cycleKey]), old = cell.main.get(signature)
      if (!old || row.score > old.score) cell.main.set(signature, row)
    }
    let pairStates = 0
    for (const cell of cells.values()) {
      const byCycle = new Map<string | null, Map<string, { row: PreparedBackup; score: number }>>()
      for (const main of cell.main.values()) {
        budget.check('relax:main-category')
        let backups = byCycle.get(main.cycleKey)
        if (!backups) {
          backups = new Map(); byCycle.set(main.cycleKey, backups)
          for (const row of cell.backups) {
            budget.check('relax:backup-category')
            if (main.cycleKey !== null && !row.compatibleCycles.has(main.cycleKey)) continue
            const score = finite(main.cycleKey === null ? row.score : row.cycleScores.get(main.cycleKey), 'backup category score')
            const signature = JSON.stringify([row.lower, row.maximumCoverHours, model.coreMask.get(row.id)]), old = backups.get(signature)
            if (!old || score > old.score) backups.set(signature, { row, score })
          }
        }
        for (const { row: backup } of backups.values()) {
          budget.check('relax:pair'); statistics.pairTests++
          const a = model.coreMask.get(main.id)!, b = model.coreMask.get(backup.id)!
          if (a & b) continue
          const value = pairValue(model, main, backup)
          if (value === null) continue
          const mask = a | b, old = cell.pairs.get(mask)
          if (!old) budget.size('states', ++pairStates, 'relax:pair-states')
          if (!old || value > old.value) cell.pairs.set(mask, { value, ids: [main.id, backup.id] })
        }
      }
    }
    let best: DPEntry = { value: -Infinity, ids: [] }
    const visit = (index: number, used: ReadonlySet<string>, assignment: readonly string[]): void => {
      budget.check('relax:placement')
      if (index < model.groups.length) {
        for (const room of model.rooms) {
          budget.check('relax:placement-room')
          if (!used.has(room) && cells.get(key(model.groups[index]!, room))?.pairs.size) visit(index + 1, new Set([...used, room]), [...assignment, room])
        }
        return
      }
      statistics.placements++
      let dp = new Map<number, DPEntry>([[0, { value: 0, ids: [] }]])
      for (let i = 0; i < model.groups.length; i++) {
        budget.check('relax:dp-group')
        const next = new Map<number, DPEntry>()
        for (const [a, left] of dp) for (const [b, right] of cells.get(key(model.groups[i]!, assignment[i]!))!.pairs) {
          budget.check('relax:dp-transition'); statistics.transitions++
          if (a & b) continue
          const mask = a | b, value = finite(left.value + right.value, 'DP objective'), old = next.get(mask)
          if (!old) budget.size('states', pairStates + dp.size + next.size + 1, 'relax:dp-states')
          if (!old || value > old.value) next.set(mask, { value, ids: [...left.ids, ...right.ids] })
        }
        dp = next
      }
      for (const [mask, entry] of dp) {
        budget.check('relax:final-mask')
        if ((mask & model.requiredMask) === model.requiredMask && entry.value > best.value) best = entry
      }
    }
    visit(0, new Set(), [])
    return { complete: true, feasible: best.value !== -Infinity, upperBound: best.value, witnessIds: best.ids, statistics }
  } catch (error) {
    if (!(error instanceof CrewAssignmentInterrupted)) throw error
    return { complete: false, feasible: null, upperBound: null, witnessIds: [], reason: error.reason, stage: error.stage, statistics }
  }
}
