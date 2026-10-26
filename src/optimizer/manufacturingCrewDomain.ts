import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import type { MowerFacility, MowerRoomId, MowerSlot, RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { availableCoreVariants, availableOptionalMembers, physicalBackupOperatorIds, type RosterRole } from './combinationModel'
import { combinationAssignmentGroups } from './combinationEnumeration'
import { formedCombinations, preservesFormedCombinations, type FormedCombination } from './combinationIntegrity'
import { ATOMIC_UNITS, type AtomicUnitConfPolicy } from './riicAtomicUnits'
import { isProductionSingletonCandidate } from './productionSingletons'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

export interface ManufacturingCrewInput {
  userBase: Readonly<RosterWorkspace>
  initial: Readonly<RosterWorkspace>
  inventory: Readonly<OperatorInventory>
  lockedPositions: ReadonlySet<string>
  lockedOperators: ReadonlySet<string>
}
export interface ManufacturingCrewGroup {
  id: string
  originalRoomId: MowerRoomId
  support: { roomId: MowerRoomId; index: number }[]
  capacity: number
  main: string[]
  backup: string[]
}
export interface ManufacturingCrewColumn {
  id: string
  roomId: MowerRoomId
  groupId: string
  groupOrigin: MowerRoomId
  role: RosterRole
  /** Resource identity; never used to reconstruct seat order. */
  ids: string[]
  seatOperatorIds: string[]
  retainedCores: string[]
}
export interface ManufacturingFrozenComponent { roomIds: MowerRoomId[]; reason: string }
export interface ManufacturingCrewDiagnostic { code: string; message: string }
interface Position { room: MowerFacility; slot: MowerSlot; index: number }
interface CrewTemplate {
  groupId: string; roomId: MowerRoomId; role: RosterRole; coreId: string
  definitionId: string; externalCoreIds: string[]; restrictedFillers: boolean
  localIds: string[]; fillerIds: string[]
  externalRequirements: { ids: string[]; count: number }[]
  presentIds: string[]
}
interface InitialCore extends FormedCombination {
  localIds: string[]
  /** Exact for user units; generated units may share a tag across proven variants. */
  retentionId: string
  variantSignatures: string[]
  guardedLocalIds: string[]
  requiredGroupId?: string
}
export interface ManufacturingCrewDomain {
  userBase: RosterWorkspace
  initial: RosterWorkspace
  inventory: OperatorInventory
  rooms: MowerRoomId[]
  groups: ManufacturingCrewGroup[]
  coreIds: string[]
  requiredCores: string[]
  initialColumns: ManufacturingCrewColumn[]
  frozenComponents: ManufacturingFrozenComponent[]
  diagnostics: ManufacturingCrewDiagnostic[]
  /** Per-call owned snapshots. These are not mutable global caches. */
  fixedOperatorIds: ReadonlySet<string>
  ownedOperatorIds: ReadonlySet<string>
  warmupOperatorIds: ReadonlySet<string>
  lockedPositions: ReadonlySet<string>
  lockedOperators: ReadonlySet<string>
  templates: readonly CrewTemplate[]
  initialCores: readonly InitialCore[]
  singletonIdsByRoom: ReadonlyMap<MowerRoomId, readonly string[]>
}
export interface ManufacturingCrewDomainResult {
  status: 'ready' | 'unsupported' | 'invalid'
  domain?: ManufacturingCrewDomain
  frozenComponents: ManufacturingFrozenComponent[]
  diagnostics: ManufacturingCrewDiagnostic[]
}
export interface ManufacturingCrewBudget {
  maxColumns?: number
  maxVisits?: number
  /** Caller owns the time/cancellation budget; false stops the incomplete library. */
  check?: () => boolean
}
export class ManufacturingCrewBudgetExceeded extends Error {
  constructor(public readonly reason: 'columns' | 'visits' | 'cancelled', public readonly columns: number, public readonly visits: number) {
    super(`Manufacturing crew library incomplete: ${reason}`)
    this.name = 'ManufacturingCrewBudgetExceeded'
  }
}

const actor = (slot: MowerSlot) => slot.occupant.kind === 'operator' ? resolveId(slot.occupant.operatorId) : undefined
const key = (position: Position) => `${position.room.roomId}:${position.index}`
const contains = (ids: readonly string[], members: readonly string[]) => members.every(id => ids.includes(id))
const unique = <T extends string>(ids: readonly T[]): T[] => [...new Set(ids)]
const slots = (workspace: RosterWorkspace): Position[] => Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
  .flatMap(room => room.slots.slice(0, facilityCapacity(room.type, room.level)).map((slot, index) => ({ room, slot, index })))
const references = (slot: MowerSlot) => unique([slot.replacements, ...(slot.groupBindings ?? []).map(binding => binding.replacements)].flat().map(resolveId))
const physical = (position: Position) => [...(actor(position.slot) ? [actor(position.slot)!] : []), ...physicalBackupOperatorIds(position.room, position.slot)]

/** Derive a narrow complete-room domain, preserving every unsupported connected block. */
export function prepareManufacturingCrewDomain(input: ManufacturingCrewInput): ManufacturingCrewDomainResult {
  const initial = structuredClone(input.initial), userBase = structuredClone(input.userBase), inventory = structuredClone(input.inventory)
  const diagnostics: ManufacturingCrewDiagnostic[] = [], frozenComponents: ManufacturingFrozenComponent[] = []
  if (!inventory.valid) return { status: 'invalid', diagnostics: [{ code: 'CREW_INVALID_INVENTORY', message: '制造队伍计算需要有效的实际干员库。' }], frozenComponents }
  const physicalErrors = validatePhysicalRoster(initial)
  if (physicalErrors.length) return { status: 'invalid', diagnostics: physicalErrors, frozenComponents }
  const positions = slots(initial), owned = new Set(inventory.operators.map(operator => operator.charId))
  if (positions.some(position => physical(position).some(id => !owned.has(id)))) {
    return { status: 'invalid', diagnostics: [{ code: 'CREW_UNOWNED_ACTOR', message: '实际在岗或物理替班缺少持有记录，不能用满练目录补全。' }], frozenComponents }
  }
  const initialPolicy = applyGeneratedWarmupPolicy(structuredClone(initial), inventory)
  if (!initialPolicy.valid || initialPolicy.addedExhaustOperatorIds.length) {
    return { status: 'invalid', diagnostics: [{ code: 'CREW_INITIAL_WARMUP_POLICY', message: '初始排班尚未满足生成暖机策略，不能将其作为已验证的无变化方案。' },
      ...initialPolicy.diagnostics.filter(diagnostic => diagnostic.severity === 'error')], frozenComponents }
  }
  const lockedPositions = new Set(input.lockedPositions), lockedOperators = new Set([...input.lockedOperators].map(resolveId))
  const userPositions = slots(userBase)
  const changedLock = userPositions.some(position => (lockedPositions.has(key(position)) ||
    physical(position).some(id => lockedOperators.has(id))) &&
    JSON.stringify(position.slot) !== JSON.stringify(initial.mainPlan.facilities[position.room.roomId].slots[position.index]))
  if (changedLock || !preservesFormedCombinations(userBase, initial, inventory)) {
    return { status: 'invalid', diagnostics: [{ code: 'CREW_INITIAL_CONSTRAINTS', message: '初始排班已改变用户锁定位置或完整组合，不能作为计算基线。' }], frozenComponents }
  }
  const permanent = new Set(initial.mainPlan.conf.workaholic.map(resolveId))
  const allCores = formedCombinations(initial, inventory), candidates = new Map<MowerRoomId, ManufacturingCrewGroup>()
  const frozen = new Map<MowerRoomId, string>()
  const freeze = (roomId: MowerRoomId, reason: string) => { if (!frozen.has(roomId)) frozen.set(roomId, reason) }
  for (const room of Object.values(initial.mainPlan.facilities)) {
    if (room.type !== 'manufacture' || room.level <= 0) continue
    const capacity = facilityCapacity(room.type, room.level), local = positions.filter(position => position.room.roomId === room.roomId)
    if (!['gold', 'exp'].includes(room.product ?? '') || capacity < 1 || capacity > 3 || local.length !== capacity || local.some(position => !actor(position.slot))) {
      freeze(room.roomId, 'unsupported-room'); continue
    }
    const groups = unique(local.map(position => position.slot.groupId ?? ''))
    if (groups.length !== 1 || !groups[0]!.trim()) { freeze(room.roomId, 'split-or-ungrouped-room'); continue }
    const groupId = groups[0]!, footprint = positions.filter(position => position.slot.groupId === groupId || position.slot.groupBindings?.some(binding => binding.groupId === groupId))
    const main = local.map(position => actor(position.slot)!), backup = local.flatMap(position => physicalBackupOperatorIds(room, position.slot))
    const support = footprint.filter(position => position.room.roomId !== room.roomId)
    candidates.set(room.roomId, { id: groupId, originalRoomId: room.roomId, capacity, main, backup,
      support: support.map(position => ({ roomId: position.room.roomId, index: position.index })) })
    if (footprint.some(position => position.slot.groupBindings?.length)) freeze(room.roomId, 'multiple-bindings')
    if (support.some(position => position.room.type === 'manufacture')) freeze(room.roomId, 'multiple-manufacturing-rooms')
    if (footprint.some(position => lockedPositions.has(key(position)) || physical(position).some(id => lockedOperators.has(id)))) freeze(room.roomId, 'user-lock')
    if (local.some(position => permanent.has(actor(position.slot)!)) || backup.length !== capacity ||
      local.some(position => position.slot.replacements.length !== 1 || !isOrdinaryReplacementCandidate(position.slot.replacements[0]!, 'manufacture')) ||
      unique([...main, ...backup]).length !== capacity * 2) freeze(room.roomId, 'unsupported-role-structure')
    if (footprint.some(position => !actor(position.slot) || position.room.type !== 'dormitory' && !permanent.has(actor(position.slot)!) &&
      (position.slot.replacements.length !== 1 || physicalBackupOperatorIds(position.room, position.slot).length !== 1))) freeze(room.roomId, 'unsupported-support')
  }
  // Closure matters: freezing one room makes its references and core partners external.
  let changed = true
  while (changed) {
    const before = frozen.size
    const active = new Set([...candidates.keys()].filter(roomId => !frozen.has(roomId)))
    const localOwners = new Map<string, MowerRoomId[]>()
    for (const position of positions.filter(position => active.has(position.room.roomId))) for (const id of physical(position)) {
      localOwners.set(id, [...localOwners.get(id) ?? [], position.room.roomId])
    }
    for (const owners of localOwners.values()) if (unique(owners).length > 1) for (const roomId of owners) freeze(roomId, 'shared-personnel')
    for (const position of positions.filter(position => !active.has(position.room.roomId))) {
      for (const id of references(position.slot)) for (const roomId of localOwners.get(id) ?? []) freeze(roomId, 'external-reference')
      const id = actor(position.slot)
      if (id) for (const roomId of localOwners.get(id) ?? []) freeze(roomId, 'external-personnel')
    }
    for (const core of allCores) {
      const touched = unique(positions.filter(position => physical(position).some(id => core.coreOperatorIds.includes(id))).map(position => position.room.roomId))
      const localRooms = touched.filter(roomId => initial.mainPlan.facilities[roomId].type === 'manufacture')
      if (localRooms.length > 1) for (const roomId of localRooms) if (active.has(roomId)) freeze(roomId, 'multiple-manufacturing-core')
      if (touched.some(roomId => frozen.has(roomId))) for (const roomId of touched) if (active.has(roomId)) freeze(roomId, 'frozen-core-partner')
    }
    changed = frozen.size !== before
  }
  for (const [roomId, reason] of frozen) frozenComponents.push({ roomIds: [roomId], reason })
  const groups = [...candidates.values()].filter(group => !frozen.has(group.originalRoomId))
  const rooms = groups.map(group => group.originalRoomId)
  if (!groups.length) return { status: 'unsupported', frozenComponents, diagnostics: [{ code: 'CREW_NO_SUPPORTED_GROUP', message: '没有可按完整主替队伍计算的制造组，保留初始排班。' }] }
  const localIds = new Set(positions.filter(position => rooms.includes(position.room.roomId)).flatMap(physical))
  const fixedOperatorIds = new Set(positions.filter(position => !rooms.includes(position.room.roomId)).flatMap(position => [...physical(position), ...references(position.slot)]))
  const initialCores: InitialCore[] = allCores.filter(core => core.coreOperatorIds.some(id => localIds.has(id)))
    .map(core => ({ ...core, localIds: core.coreOperatorIds.filter(id => localIds.has(id)), retentionId: core.signature,
      variantSignatures: [core.signature], guardedLocalIds: core.coreOperatorIds.filter(id => localIds.has(id)) }))
  const userCores = new Set(formedCombinations(userBase, inventory).map(core => core.signature))
  const singletonIdsByRoom = new Map(rooms.map(roomId => [roomId, inventory.operators.filter(operator => !fixedOperatorIds.has(operator.charId) &&
    !lockedOperators.has(operator.charId) && !permanent.has(operator.charId) && isProductionSingletonCandidate(initial, roomId, operator.skills)).map(operator => operator.charId)]))
  const domain: ManufacturingCrewDomain = { initial, userBase, inventory, rooms, groups, initialCores, fixedOperatorIds, lockedPositions, lockedOperators,
    ownedOperatorIds: owned, warmupOperatorIds: new Set(inventory.operators.filter(operator => isWarmupOperatorInFacility(operator.charId, 'manufacture', inventory)).map(operator => operator.charId)),
    singletonIdsByRoom, templates: [], coreIds: [], requiredCores: [], initialColumns: [], frozenComponents, diagnostics }
  domain.templates = buildTemplates(domain, positions)
  domain.initialCores = trackInitialCores(domain, userCores)
  domain.coreIds = unique(domain.initialCores.map(core => core.retentionId))
  if (domain.coreIds.length > 20) return { status: 'unsupported', frozenComponents, diagnostics: [{ code: 'CREW_CORE_CAPACITY', message: '初始完整核心超过当前指派内核支持的 20 个标签，保留原排班。' }] }
  domain.requiredCores = unique(domain.initialCores.filter(core => userCores.has(core.signature) || core.coreOperatorIds.some(id => fixedOperatorIds.has(id))).map(core => core.retentionId))
  domain.initialColumns = groups.flatMap(group => (['main', 'backup'] as const).map(role => makeColumn(domain, group, group.originalRoomId, role, group[role])))
  return { status: 'ready', domain, frozenComponents, diagnostics }
}

function policyCompatible(domain: ManufacturingCrewDomain, policy: AtomicUnitConfPolicy, role: RosterRole, localIds: readonly string[]): boolean {
  const fields = [['exhaustRequire', 'exhaust_require'], ['restInFull', 'rest_in_full'], ['restingPriorityLow', 'resting_priority'],
    ['restingPriorityHigh', 'ope_resting_priority'], ['workaholic', 'workaholic']] as const
  return fields.every(([from, to]) => (policy[from] ?? []).every(ref => domain.initial.mainPlan.conf[to].some(value => resolveId(value) === resolveId(ref)) ||
    from === 'exhaustRequire' && role === 'main' && localIds.includes(resolveId(ref)) && isWarmupOperatorInFacility(ref, 'manufacture', domain.inventory)))
}
function buildTemplates(domain: ManufacturingCrewDomain, positions: Position[]): CrewTemplate[] {
  const templates: CrewTemplate[] = [], permanent = new Set(domain.initial.mainPlan.conf.workaholic.map(resolveId))
  const powerCount = Object.values(domain.initial.mainPlan.facilities).filter(room => room.type === 'power' && room.level > 0).length
  for (const group of domain.groups) for (const roomId of domain.rooms) {
    const room = domain.initial.mainPlan.facilities[roomId]
    if (facilityCapacity(room.type, room.level) !== group.capacity) continue
    for (const role of ['main', 'backup'] as const) {
      const external = positions.filter(position => !domain.rooms.includes(position.room.roomId)).flatMap(position => {
        const main = actor(position.slot)
        const id = role === 'backup' && position.slot.groupId === group.id && position.room.type !== 'dormitory' && !permanent.has(main ?? '')
          ? physicalBackupOperatorIds(position.room, position.slot)[0] : main
        return id ? [{ ...position, id }] : []
      })
      for (const atom of ATOMIC_UNITS) {
        if (atom.preferredFacilityType !== 'manufacture' || atom.preferredProduct && atom.preferredProduct !== 'any' && atom.preferredProduct !== room.product) continue
        for (const variant of availableCoreVariants(atom, domain.inventory, powerCount, room.product as 'gold' | 'exp')) {
          const local = variant.coreMembers.filter(member => member.roomType === 'manufacture')
          if (!local.length || local.length > group.capacity || combinationAssignmentGroups(atom, variant.coreMembers, []).filter(value => value.members.some(member => member.roomType === 'manufacture')).length !== 1 ||
            local.some(member => member.product && member.product !== room.product || (member.minLevel ?? 1) > room.level)) continue
          const localIds = local.map(member => resolveId(member.name))
          if (localIds.some(id => domain.fixedOperatorIds.has(id) || domain.lockedOperators.has(id) || permanent.has(id)) || !policyCompatible(domain, variant.confPolicy, role, localIds)) continue
          if (variant.coreMembers.filter(member => member.roomType !== 'manufacture').some(member => !external.some(position => position.id === resolveId(member.name) &&
            position.room.type === (member.roomType === 'office' ? 'contact' : member.roomType) && position.room.level >= (member.minLevel ?? 1) &&
            (!member.product || position.room.product === member.product) && (position.slot.groupId === group.id || permanent.has(position.id) || position.room.type === 'dormitory')))) continue
          const optional = availableOptionalMembers(atom, domain.inventory, variant.coreMembers, room.product as 'gold' | 'exp')
            .filter(member => member.roomType === 'manufacture' && (!member.product || member.product === room.product)).map(member => resolveId(member.name))
          const fillers = variant.thirdMemberWhitelist ? variant.thirdMemberWhitelist.map(resolveId) : [...domain.singletonIdsByRoom.get(roomId) ?? [], ...optional]
          templates.push({ groupId: group.id, roomId, role, localIds, definitionId: atom.id,
            externalCoreIds: variant.coreMembers.filter(member => member.roomType !== 'manufacture').map(member => resolveId(member.name)).sort(),
            restrictedFillers: variant.thirdMemberWhitelist !== undefined,
            coreId: `${atom.id}:${room.product}:${variant.coreMembers.map(member => resolveId(member.name)).sort().join('+')}`,
            fillerIds: unique(fillers).filter(id => domain.ownedOperatorIds.has(id) && !domain.fixedOperatorIds.has(id) && !domain.lockedOperators.has(id) && !permanent.has(id) && !localIds.includes(id)),
            externalRequirements: (atom.externalRequirements ?? []).map(requirement => ({ ids: requirement.pool.map(resolveId), count: requirement.count })),
            presentIds: external.map(position => position.id) })
        }
      }
    }
  }
  return templates
}

/** Do not turn an internally selected product variant into a user constraint. */
function trackInitialCores(domain: ManufacturingCrewDomain, userCores: ReadonlySet<string>): InitialCore[] {
  return domain.initialCores.map(core => {
    if (userCores.has(core.signature)) return core
    const origin = domain.groups.find(group => contains(group[core.role], core.localIds))
    if (!origin || !presentTemplates(domain, origin, origin.originalRoomId, core.role, origin[core.role]).some(template => template.coreId === core.signature)) return core
    const externalIds = core.coreOperatorIds.filter(id => !core.localIds.includes(id)).sort()
    const alternatives = domain.templates.filter(template => template.definitionId === core.definitionId &&
      JSON.stringify(template.externalCoreIds) === JSON.stringify(externalIds) && (!externalIds.length || template.groupId === origin.id))
    const variantSignatures = unique(alternatives.map(template => template.coreId))
    const guardedLocalIds = core.localIds.filter(id => alternatives.every(template => template.localIds.includes(id)))
    // A future alternative without a stable local core is outside this narrow model.
    if (variantSignatures.length < 2 || !guardedLocalIds.length) return core
    return { ...core, variantSignatures, guardedLocalIds,
      retentionId: `${core.definitionId}:family:${unique([...guardedLocalIds, ...externalIds]).sort().join('+')}`,
      ...(externalIds.length ? { requiredGroupId: origin.id } : {}) }
  })
}

/** Core presence does not require unrelated complete units to be this core's fillers. */
function presentTemplates(domain: ManufacturingCrewDomain, group: ManufacturingCrewGroup, roomId: MowerRoomId, role: RosterRole, ids: readonly string[]): CrewTemplate[] {
  return domain.templates.filter(template => template.groupId === group.id && template.roomId === roomId && template.role === role && contains(ids, template.localIds) &&
    (!template.restrictedFillers || ids.every(id => template.localIds.includes(id) || template.fillerIds.includes(id))) &&
    template.externalRequirements.every(requirement => requirement.ids.filter(id => ids.includes(id) || template.presentIds.includes(id)).length >= requirement.count))
}
function retainsCore(core: InitialCore, group: ManufacturingCrewGroup, templates: readonly CrewTemplate[]): boolean {
  return (!core.requiredGroupId || core.requiredGroupId === group.id) && templates.some(template => core.variantSignatures.includes(template.coreId))
}
function admissible(domain: ManufacturingCrewDomain, group: ManufacturingCrewGroup, roomId: MowerRoomId, role: RosterRole, ids: readonly string[]): boolean {
  const room = domain.initial.mainPlan.facilities[roomId]
  if (!domain.rooms.includes(roomId) || ids.length !== group.capacity || facilityCapacity(room.type, room.level) !== group.capacity || new Set(ids).size !== ids.length ||
    ids.some(id => domain.fixedOperatorIds.has(id) || domain.lockedOperators.has(id) || !domain.ownedOperatorIds.has(id))) return false
  if (role === 'backup' && ids.some(id => !isOrdinaryReplacementCandidate(id, 'manufacture') || domain.warmupOperatorIds.has(id))) return false
  const templates = presentTemplates(domain, group, roomId, role, ids)
  // Generated variant-only actors can be released; any stable core actor still
  // requires a complete actual variant in this product, role and support group.
  if (domain.initialCores.some(core => ids.some(id => core.guardedLocalIds.includes(id)) && !retainsCore(core, group, templates))) return false
  const known = domain.singletonIdsByRoom.get(roomId) ?? []
  return ids.every(id => known.includes(id)) || templates.some(template => ids.every(id => template.localIds.includes(id) || template.fillerIds.includes(id)))
}
function seats(domain: ManufacturingCrewDomain, roomId: MowerRoomId, role: RosterRole, ids: readonly string[]): string[] {
  const room = domain.initial.mainPlan.facilities[roomId], result: Array<string | undefined> = Array(ids.length).fill(undefined), remaining = new Set(ids)
  const old = (slot: MowerSlot) => role === 'main' ? actor(slot) : physicalBackupOperatorIds(room, slot)[0]
  room.slots.slice(0, ids.length).forEach((slot, index) => { const id = old(slot); if (id && remaining.delete(id)) result[index] = id })
  for (const id of [...remaining].sort()) for (const group of domain.groups) {
    const index = group[role].indexOf(id)
    if (index >= 0 && index < result.length && !result[index]) { result[index] = id; remaining.delete(id); break }
  }
  const rest = [...remaining].sort()
  return result.map(id => id ?? rest.shift()!)
}
function makeColumn(domain: ManufacturingCrewDomain, group: ManufacturingCrewGroup, roomId: MowerRoomId, role: RosterRole, seatOperatorIds: readonly string[]): ManufacturingCrewColumn {
  const ids = [...seatOperatorIds].sort()
  const initialRole = group.originalRoomId === roomId && JSON.stringify(seatOperatorIds) === JSON.stringify(group[role])
  const templates = presentTemplates(domain, group, roomId, role, ids)
  const retainedCores = unique([...domain.initialCores.filter(core => retainsCore(core, group, templates)).map(core => core.retentionId),
    ...domain.initialCores.filter(core => initialRole && core.role === role && contains(ids, core.localIds) &&
      (!core.requiredGroupId || core.requiredGroupId === group.id) && core.signature.split(':')[1] === domain.initial.mainPlan.facilities[roomId].product).map(core => core.retentionId)]).sort()
  return { id: JSON.stringify([group.id, roomId, role, seatOperatorIds]), roomId, groupId: group.id, groupOrigin: group.originalRoomId,
    role, ids, seatOperatorIds: [...seatOperatorIds], retainedCores }
}

/** Exhaustive within this declared singleton/whole-unit library, or an explicit budget exception. */
export function* enumerateManufacturingCrewColumns(domain: ManufacturingCrewDomain, budget: ManufacturingCrewBudget = {}): Generator<ManufacturingCrewColumn> {
  let visits = 0, columns = 0
  // Row IDs include context and seat order. Keep only ID references across the
  // interleaved contexts, using O(emitted rows) memory, never a second row table.
  const seen = new Set<string>()
  const check = () => {
    visits++
    if (budget.check?.() === false) throw new ManufacturingCrewBudgetExceeded('cancelled', columns, visits)
    if (visits > (budget.maxVisits ?? Infinity)) throw new ManufacturingCrewBudgetExceeded('visits', columns, visits)
  }
  function* emit(row: ManufacturingCrewColumn) {
    check()
    if (seen.has(row.id)) return
    if (columns >= (budget.maxColumns ?? Infinity)) throw new ManufacturingCrewBudgetExceeded('columns', columns, visits)
    seen.add(row.id); columns++; yield row
  }
  function* choose(pool: readonly string[], count: number, start = 0, chosen: string[] = []): Generator<string[]> {
    check()
    if (!count) { yield chosen; return }
    for (let index = start; index <= pool.length - count; index++) yield* choose(pool, count - 1, index + 1, [...chosen, pool[index]!])
  }
  function* contextAttempts(group: ManufacturingCrewGroup, roomId: MowerRoomId, role: RosterRole): Generator<ManufacturingCrewColumn | undefined> {
    const add = (ids: string[]) => admissible(domain, group, roomId, role, ids) ? makeColumn(domain, group, roomId, role, seats(domain, roomId, role, ids)) : undefined
    for (const template of domain.templates.filter(template => template.groupId === group.id && template.roomId === roomId && template.role === role)) {
      for (const fillers of choose(template.fillerIds, group.capacity - template.localIds.length)) {
        yield add([...template.localIds, ...fillers])
      }
    }
    for (const ids of choose(domain.singletonIdsByRoom.get(roomId) ?? [], group.capacity)) yield add(ids)
  }
  for (const row of domain.initialColumns) yield* emit(row)
  let active: Generator<ManufacturingCrewColumn | undefined>[] = domain.groups.flatMap(group => domain.rooms.flatMap(roomId =>
    facilityCapacity('manufacture', domain.initial.mainPlan.facilities[roomId].level) !== group.capacity ? [] :
      (['main', 'backup'] as const).map(role => contextAttempts(group, roomId, role))))
  while (active.length) {
    const next: typeof active = []
    for (const context of active) {
      // Rejected and duplicate attempts also return the turn to the other
      // contexts; none may scan to its next accepted row without yielding.
      const attempt = context.next()
      if (attempt.done) continue
      next.push(context)
      if (attempt.value) yield* emit(attempt.value)
    }
    active = next
  }
}

/** Apply only complete, validated decisions; rejection never mutates either source. */
export function decodeManufacturingCrewSelection(domain: ManufacturingCrewDomain, selected: readonly ManufacturingCrewColumn[]): {
  valid: boolean; workspace: RosterWorkspace; diagnostics: ManufacturingCrewDiagnostic[]
} {
  const fail = (message: string) => ({ valid: false, workspace: structuredClone(domain.initial), diagnostics: [{ code: 'CREW_SELECTION_INVALID', message }] })
  if (selected.length !== domain.groups.length * 2 || new Set(selected.map(row => row.id)).size !== selected.length) return fail('每个制造组必须有一个完整主班和替班。')
  const resourceIds = selected.flatMap(row => row.ids)
  if (unique(resourceIds).length !== resourceIds.length) return fail('同一干员不能占用两个队伍资源。')
  const usedRooms = new Set<string>(), expectedRows: ManufacturingCrewColumn[] = []
  for (const group of domain.groups) {
    const local = selected.filter(row => row.groupId === group.id), main = local.find(row => row.role === 'main'), backup = local.find(row => row.role === 'backup')
    if (local.length !== 2 || !main || !backup || main.roomId !== backup.roomId || usedRooms.has(main.roomId) || !domain.rooms.includes(main.roomId)) return fail('组、房间或主替角色不完整。')
    usedRooms.add(main.roomId)
    for (const row of [main, backup]) {
      const expected = makeColumn(domain, group, row.roomId, row.role, row.seatOperatorIds)
      if (row.groupOrigin !== group.originalRoomId || JSON.stringify(row.ids) !== JSON.stringify(expected.ids) || row.id !== expected.id ||
        JSON.stringify(row.retainedCores) !== JSON.stringify(expected.retainedCores)) return fail('列资源、槽序或完整核心声明不一致。')
      const unchanged = domain.initialColumns.some(initial => initial.id === row.id)
      if (!unchanged && !admissible(domain, group, row.roomId, row.role, row.seatOperatorIds)) return fail('队伍不属于声明的完整候选域。')
      expectedRows.push(expected)
    }
  }
  const counts = new Map<string, number>()
  for (const row of expectedRows) for (const core of row.retainedCores) counts.set(core, (counts.get(core) ?? 0) + 1)
  if (domain.requiredCores.some(core => counts.get(core) !== 1) || [...counts.values()].some(count => count > 1)) return fail('必留核心缺失或完整核心重复。')
  if (expectedRows.every(row => domain.initialColumns.some(initial => initial.id === row.id))) return { valid: true, workspace: structuredClone(domain.initial), diagnostics: [] }
  const workspace = structuredClone(domain.initial)
  for (const group of domain.groups) {
    const main = expectedRows.find(row => row.groupId === group.id && row.role === 'main')!, backup = expectedRows.find(row => row.groupId === group.id && row.role === 'backup')!
    const room = workspace.mainPlan.facilities[main.roomId]
    for (let index = 0; index < group.capacity; index++) {
      const slot = room.slots[index]!
      slot.occupant = { kind: 'operator', operatorId: main.seatOperatorIds[index]! }
      slot.replacements = [backup.seatOperatorIds[index]!]
      slot.groupId = group.id
    }
  }
  if (!preservesFormedCombinations(domain.userBase, workspace, domain.inventory)) return fail('解码会拆开用户原有完整组合。')
  const policy = applyGeneratedWarmupPolicy(workspace, domain.inventory)
  const errors = [...validatePhysicalRoster(workspace), ...recoveryGroupCapacityIssues(workspace),
    ...compileRosterSchedule(workspace).diagnostics.filter(diagnostic => diagnostic.severity === 'error')]
  if (!policy.valid || errors.length) return fail([...policy.diagnostics.filter(diagnostic => diagnostic.severity === 'error'), ...errors].map(diagnostic => diagnostic.message).join('；'))
  return { valid: true, workspace, diagnostics: [] }
}
