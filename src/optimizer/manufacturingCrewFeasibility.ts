import type { ManufacturingCrewColumn } from './manufacturingCrewDomain'

export interface ManufacturingCrewFeasibilityInput {
  readonly rows: readonly ManufacturingCrewColumn[]
  readonly groups: readonly string[]
  readonly rooms: readonly string[]
  readonly coreIds: readonly string[]
  readonly requiredCores: readonly string[]
}
export interface ManufacturingCrewFeasibilityOptions {
  readonly timeLimitMs?: number
  /** Stored categories, union masks/contributors and forward/backward DP entries; not total JS heap. */
  readonly maxStates?: number
  /** Attempted local main/backup pairs and forward/backward state transitions. */
  readonly maxTransitions?: number
  readonly now?: () => number
}
export interface ManufacturingCrewFeasibilityStats {
  rowsRead: number
  categories: number
  pairMasks: number
  pairContributions: number
  forwardStates: number
  backwardStates: number
  storedItems: number
  transitions: number
  retainedCategories: number | null
  removedRows: number
  elapsedMs: number
  stopStage: string | null
}
type LimitReason = 'timeLimit' | 'stateLimit' | 'transitionLimit'
export interface ManufacturingCrewFeasibilityResult {
  readonly rows: readonly ManufacturingCrewColumn[]
  readonly complete: boolean
  /** Feasibility of this structural relaxation only, never full personnel/cycle feasibility. */
  readonly feasible: boolean | null
  readonly stats: Readonly<ManufacturingCrewFeasibilityStats>
  readonly reason?: LimitReason | 'infeasible'
}
interface Category { mask: number; retained: boolean }
interface Pair { mask: number; contributors: Set<Category> }
interface Cell { main: Map<number, Category>; backup: Map<number, Category>; pairs: Map<number, Pair> }
interface State { rooms: number; cores: number }
class Interrupted extends Error {
  constructor(readonly reason: LimitReason, readonly stage: string) { super(reason) }
}

/**
 * Keep every row occurring in at least one complete room/role/core assignment.
 * Personnel, mood, cycles and scores are deliberately absent from this relaxation.
 * Core tags and their required subset belong to the supplied domain, not a global user rule.
 * Any interrupted computation returns the original library by reference, with no pruning.
 * Budgets are cooperative and include input indexing; they are not a hard watchdog.
 */
export function screenManufacturingCrewColumns(input: ManufacturingCrewFeasibilityInput, options: ManufacturingCrewFeasibilityOptions = {}): ManufacturingCrewFeasibilityResult {
  const now = options.now ?? (() => performance.now()), start = now()
  const timeLimitMs = options.timeLimitMs ?? 1000, maxStates = options.maxStates ?? 250_000, maxTransitions = options.maxTransitions ?? 2_000_000
  if (!Number.isFinite(start) || !Number.isFinite(timeLimitMs) || timeLimitMs < 0 ||
    !Number.isSafeInteger(maxStates) || maxStates < 0 || !Number.isSafeInteger(maxTransitions) || maxTransitions < 0) throw new Error('Invalid structural screening budget')
  const rows = input.rows
  const stats: ManufacturingCrewFeasibilityStats = {
    rowsRead: 0, categories: 0, pairMasks: 0, pairContributions: 0, forwardStates: 0, backwardStates: 0,
    storedItems: 0, transitions: 0, retainedCategories: null, removedRows: 0, elapsedMs: 0, stopStage: null,
  }
  const elapsed = () => {
    const value = now()
    if (!Number.isFinite(value)) throw new Error('Invalid structural screening clock')
    return Math.max(0, value - start)
  }
  const check = (stage: string) => {
    if (elapsed() >= timeLimitMs) throw new Interrupted('timeLimit', stage)
  }
  const store = (stage: string) => {
    check(stage)
    if (stats.storedItems >= maxStates) throw new Interrupted('stateLimit', stage)
    stats.storedItems++
  }
  const transition = (stage: string) => {
    check(stage)
    if (stats.transitions >= maxTransitions) throw new Interrupted('transitionLimit', stage)
    stats.transitions++
  }
  const indexNames = (values: readonly string[], label: string) => {
    const result = new Map<string, number>()
    if (!Array.isArray(values)) throw new Error(`Invalid ${label}`)
    for (const name of values) {
      check(`validate:${label}`)
      if (typeof name !== 'string' || !name || result.has(name)) throw new Error(`Invalid or repeated ${label}`)
      result.set(name, result.size)
    }
    return result
  }
  try {
    check('validate:before')
    if (!Array.isArray(input.rows)) throw new Error('Rows must be an array')
    const groups = indexNames(input.groups, 'groups'), rooms = indexNames(input.rooms, 'rooms'), cores = indexNames(input.coreIds, 'cores')
    if (!groups.size || groups.size !== rooms.size || groups.size > 7 || cores.size > 20) throw new Error('Unsupported structural domain size')
    const required = indexNames(input.requiredCores, 'required-cores')
    let requiredMask = 0
    for (const core of required.keys()) {
      check('validate:required-subset')
      const index = cores.get(core)
      if (index === undefined) throw new Error('Required core is outside the declared core domain')
      requiredMask |= 1 << index
    }
    const cells: Cell[][] = []
    for (let group = 0; group < groups.size; group++) {
      check('validate:cells')
      const groupCells: Cell[] = []
      for (let room = 0; room < rooms.size; room++) {
        check('validate:cell')
        groupCells.push({ main: new Map(), backup: new Map(), pairs: new Map() })
      }
      cells.push(groupCells)
    }
    // Linear reference storage preserves the original row order/identity. The
    // combinatorial maxStates budget is separate from this input-sized index.
    const categoryByRow: Category[] = []
    for (const row of rows) {
      check('rows:index')
      if (!row || (row.role !== 'main' && row.role !== 'backup') || !Array.isArray(row.retainedCores)) throw new Error('Invalid structural row')
      const group = groups.get(row.groupOrigin), room = rooms.get(row.roomId)
      if (group === undefined || room === undefined) throw new Error('Row is outside the declared group/room domain')
      let mask = 0
      for (const core of row.retainedCores) {
        check('rows:cores')
        const index = cores.get(core)
        if (index === undefined || (mask & (1 << index))) throw new Error('Unknown or repeated row core')
        mask |= 1 << index
      }
      const role = cells[group]![room]![row.role]
      let category = role.get(mask)
      if (!category) {
        store('rows:category')
        category = { mask, retained: false }; role.set(mask, category); stats.categories++
      }
      categoryByRow.push(category); stats.rowsRead++
    }
    for (const groupCells of cells) {
      check('pairs:group')
      for (const cell of groupCells) {
        check('pairs:cell')
        for (const main of cell.main.values()) {
          check('pairs:main')
          for (const backup of cell.backup.values()) {
            transition('pairs:attempt')
            if (main.mask & backup.mask) continue
            const mask = main.mask | backup.mask
            let pair = cell.pairs.get(mask)
            if (!pair) {
              store('pairs:union')
              pair = { mask, contributors: new Set() }; cell.pairs.set(mask, pair); stats.pairMasks++
            }
            // Every decomposition of the same union has exactly the same
            // remaining structural problem; retain all of its role categories.
            for (const category of [main, backup]) {
              check('pairs:contributors')
              if (!pair.contributors.has(category)) {
                store('pairs:contributor'); pair.contributors.add(category); stats.pairContributions++
              }
            }
          }
        }
      }
    }
    const stride = 2 ** cores.size, key = (roomMask: number, coreMask: number) => roomMask * stride + coreMask
    const forward: Map<number, State>[] = []
    for (let depth = 0; depth <= groups.size; depth++) { check('forward:layers'); forward.push(new Map()) }
    store('forward:root'); forward[0]!.set(0, { rooms: 0, cores: 0 }); stats.forwardStates++
    for (let group = 0; group < groups.size; group++) {
      check('forward:group')
      for (const state of forward[group]!.values()) {
        check('forward:state')
        for (let room = 0; room < rooms.size; room++) {
          check('forward:room')
          const roomBit = 1 << room
          if (state.rooms & roomBit) continue
          for (const pair of cells[group]![room]!.pairs.values()) {
            transition('forward:transition')
            if (state.cores & pair.mask) continue
            const nextRooms = state.rooms | roomBit, nextCores = state.cores | pair.mask, nextKey = key(nextRooms, nextCores)
            if (!forward[group + 1]!.has(nextKey)) {
              store('forward:next'); forward[group + 1]!.set(nextKey, { rooms: nextRooms, cores: nextCores }); stats.forwardStates++
            }
          }
        }
      }
    }
    let viable = new Set<number>()
    for (const [stateKey, state] of forward[groups.size]!) {
      check('backward:terminal')
      if ((state.cores & requiredMask) === requiredMask) {
        store('backward:terminal-state'); viable.add(stateKey); stats.backwardStates++
      }
    }
    const feasible = viable.size > 0
    for (let group = groups.size - 1; group >= 0; group--) {
      check('backward:group')
      const previous = new Set<number>()
      for (const [stateKey, state] of forward[group]!) {
        check('backward:state')
        for (let room = 0; room < rooms.size; room++) {
          check('backward:room')
          const roomBit = 1 << room
          if (state.rooms & roomBit) continue
          for (const pair of cells[group]![room]!.pairs.values()) {
            transition('backward:transition')
            if ((state.cores & pair.mask) || !viable.has(key(state.rooms | roomBit, state.cores | pair.mask))) continue
            if (!previous.has(stateKey)) {
              store('backward:previous'); previous.add(stateKey); stats.backwardStates++
            }
            for (const category of pair.contributors) { check('backward:mark'); category.retained = true }
          }
        }
      }
      viable = previous
    }
    const retainedRows: ManufacturingCrewColumn[] = []
    let retainedCategories = 0
    for (const groupCells of cells) for (const cell of groupCells) for (const role of [cell.main, cell.backup]) {
      check('retain:categories')
      for (const category of role.values()) { check('retain:category'); if (category.retained) retainedCategories++ }
    }
    for (let index = 0; index < rows.length; index++) {
      check('retain:row')
      if (categoryByRow[index]!.retained) retainedRows.push(rows[index]!)
    }
    check('retain:complete')
    stats.retainedCategories = retainedCategories; stats.removedRows = rows.length - retainedRows.length; stats.elapsedMs = elapsed()
    return { rows: retainedRows, complete: true, feasible, stats, ...(feasible ? {} : { reason: 'infeasible' as const }) }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error
    stats.stopStage = error.stage; stats.elapsedMs = elapsed()
    return { rows, complete: false, feasible: null, stats, reason: error.reason }
  }
}
