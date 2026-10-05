import type { OperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import type { RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { projectRosterConfig } from './rosterProjection'
import { projectControlOutput } from './controlImpact'
import { productionTeamTheory } from './productionSingletons'
import { applyCombinationVariant, physicalBackupOperatorIds, shiftSnapshot, type CombinationPlacement, type CombinationPool, type CombinationVariant, type RosterRole } from './combinationModel'
import { ATOMIC_UNITS, type AtomicUnitConfPolicy } from './riicAtomicUnits'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'

export interface AllocationLocks {
  lockedPositions?: ReadonlySet<string>; lockedOperators?: ReadonlySet<string>
  /** Full automatic generation must reject groups that cannot physically recover. */
  enforceRecoveryCapacity?: boolean
  /** Existing cores remain in their main/relief seats; only gap fillers can move. */
  protectedCombinationOperators?: ReadonlySet<string>
}
export interface CombinationAllocation { workspace: RosterWorkspace; variants: CombinationVariant[] }
const key = (p: Pick<CombinationPlacement, 'roomId' | 'slotIndex'>) => `${p.roomId}:${p.slotIndex}`
const skillTypes: Record<string, string> = { manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', central: 'CONTROL', contact: 'HIRE', meeting: 'MEETING', factory: 'WORKSHOP', train: 'TRAINING' }
function preservesLocks(before: RosterWorkspace, after: RosterWorkspace, locks: AllocationLocks): boolean {
  return [...locks.lockedPositions ?? []].every(position => {
    const [room, index] = position.split(':')
    const get = (ws: RosterWorkspace) => Object.values(ws.mainPlan.facilities).find(r => r.roomId === room)?.slots[Number(index)]
    return JSON.stringify(get(before)) === JSON.stringify(get(after))
  })
}

export function applyCombinationPolicy(ws: RosterWorkspace, policy: AtomicUnitConfPolicy): void {
  for (const [source, target] of [['exhaustRequire', 'exhaust_require'], ['restInFull', 'rest_in_full'], ['restingPriorityLow', 'resting_priority'], ['restingPriorityHigh', 'ope_resting_priority'], ['workaholic', 'workaholic']] as const) {
    ws.mainPlan.conf[target] = [...new Set([...ws.mainPlan.conf[target], ...(policy[source] ?? [])].map(id))]
  }
}

function groupVariant(ws: RosterWorkspace, variant: CombinationVariant, locks: AllocationLocks): boolean {
  // A relief combination may fill gaps in one shift unit, never join existing units.
  const positions = variant.placements.filter(p => ws.mainPlan.facilities[p.roomId].type !== 'dormitory')
  const frozen = (roomId: CombinationPlacement['roomId'], slotIndex: number) => {
    const slot = ws.mainPlan.facilities[roomId].slots[slotIndex]!
    return locks.lockedPositions?.has(`${roomId}:${slotIndex}`) ||
      [slot.occupant.kind === 'operator' ? id(slot.occupant.operatorId) : '', ...physicalBackupOperatorIds(ws.mainPlan.facilities[roomId], slot)].some(op => locks.lockedOperators?.has(op))
  }
  const protectedGroups = new Set(Object.values(ws.mainPlan.facilities).flatMap(room => room.slots
    .flatMap((slot, index) => frozen(room.roomId, index) && slot.groupId ? [slot.groupId] : [])))
  const oldGroups = new Set(positions.map(p => ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.groupId).filter(Boolean))
  if (oldGroups.size > 1) return false
  const anchor = positions.find(p => frozen(p.roomId, p.slotIndex) && ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.groupId)
  const group = anchor ? ws.mainPlan.facilities[anchor.roomId].slots[anchor.slotIndex]!.groupId! :
    [...oldGroups][0] ?? `组合_${variant.definitionId}_${positions.map(p => key(p)).join('_')}`
  for (const p of variant.definitionId === 'singleton' ? [] : positions) {
    const slot = ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!
    if (!frozen(p.roomId, p.slotIndex) && (!slot.groupId || !protectedGroups.has(slot.groupId))) slot.groupId = group
  }
  // Presence support remains stationed in both shifts; it is not a working shift group.
  for (const p of variant.placements.filter(p => ws.mainPlan.facilities[p.roomId].type === 'dormitory')) {
    const slot = ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!
    if (!frozen(p.roomId, p.slotIndex)) slot.groupId ||= `组合驻留_${variant.definitionId}_${key(p)}`
  }
  applyCombinationPolicy(ws, variant.policy)
  return !locks.enforceRecoveryCapacity || recoveryGroupCapacityIssues(ws, true).length === 0
}

/** Reuse each legal room footprint, but reserve currently free seats in both shifts. */
function remapFree(ws: RosterWorkspace, original: CombinationVariant, role: RosterRole, locks: AllocationLocks): CombinationVariant | null {
  const occupied = new Map<string, CombinationPlacement>()
  for (const room of Object.values(ws.mainPlan.facilities)) room.slots.forEach((slot, slotIndex) => {
    if (slot.occupant.kind === 'operator') occupied.set(id(slot.occupant.operatorId), { roomId: room.roomId, slotIndex, role: 'main', operatorId: id(slot.occupant.operatorId) })
    for (const ref of physicalBackupOperatorIds(room, slot)) occupied.set(ref, { roomId: room.roomId, slotIndex, role: 'backup', operatorId: ref })
  })
  const placements: CombinationPlacement[] = []
  for (const p of original.placements) {
    const room = ws.mainPlan.facilities[p.roomId]
    const actualRole = room.type === 'dormitory' ? 'main' : role
    const existing = occupied.get(p.operatorId)
    if (locks.lockedOperators?.has(p.operatorId) && (!existing || existing.roomId !== p.roomId || existing.role !== actualRole)) return null
    if (existing && (existing.roomId !== p.roomId || existing.role !== actualRole)) return null
    if (actualRole === 'backup' && (!isOrdinaryReplacementCandidate(p.operatorId, room.type) ||
      original.policy.workaholic?.some(ref => id(ref) === p.operatorId))) return null
    const index = existing?.slotIndex ?? room.slots.findIndex((slot, index) => {
      if (locks.lockedPositions?.has(`${room.roomId}:${index}`) || placements.some(a => a.roomId === room.roomId && a.slotIndex === index && a.role === actualRole)) return false
      if (actualRole === 'main') return ['empty', 'free'].includes(slot.occupant.kind)
      return !slot.replacements.length && slot.occupant.kind !== 'current' &&
        !(slot.occupant.kind === 'operator' && ws.mainPlan.conf.workaholic.some(ref => id(ref) === id(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : '')))
    })
    if (index < 0 || locks.lockedPositions?.has(`${room.roomId}:${index}`) && !existing) return null
    placements.push({ ...p, slotIndex: index, role: actualRole })
  }
  if (placements.every(p => occupied.has(p.operatorId))) return null
  return { ...original, id: `${original.id}:${role}`, placements }
}

/** First branch follows measured ranking; later branches explore complete alternative cores. */
export function allocateCombinationSkeleton(base: RosterWorkspace, pool: CombinationPool, branch: number, locks: AllocationLocks = {}): CombinationAllocation {
  let workspace = structuredClone(base)
  const variants: CombinationVariant[] = []
  const usable = pool.values.filter(v => v.status === 'evaluated')
  const families = [...new Map(usable.map(v => [v.variant.definitionId, v.variant.definitionId])).keys()]
  const forced = branch > 0 ? usable.find(v => v.variant.definitionId === families[(branch - 1) % Math.max(1, families.length)]) : undefined
  const ranked = forced ? [forced, ...usable.filter(v => v !== forced)] : usable
  for (const role of ['main', 'backup'] as const) for (const value of ranked) {
    const variant = remapFree(workspace, value.variant, role, locks)
    if (!variant) continue
    const placed = applyCombinationVariant(workspace, variant)
    if (!placed) continue
    if (!groupVariant(placed, variant, locks)) continue
    if (!preservesLocks(workspace, placed, locks)) continue
    workspace = placed
    variants.push(variant)
  }
  return { workspace, variants }
}

/** Score both complete shift snapshots, including the opportunity cost of support stations. */
export function completeShiftScore(ws: RosterWorkspace, inventory: OperatorInventory): number | undefined {
  let sum = 0
  for (const role of ['main', 'backup'] as const) {
    const config = projectRosterConfig(shiftSnapshot(ws, role))
    config.operatorRecords = inventoryOperatorRecords(inventory)
    const value = projectControlOutput(config)
    if (!value.complete || !Number.isFinite(value.daily.score)) return undefined
    sum += value.daily.score
  }
  return sum / 2
}

function actor(ws: RosterWorkspace, p: CombinationPlacement): string | undefined {
  const room = ws.mainPlan.facilities[p.roomId], slot = room.slots[p.slotIndex]!
  return p.role === 'main' ? slot.occupant.kind === 'operator' ? id(slot.occupant.operatorId) : undefined :
    physicalBackupOperatorIds(room, slot)[0]
}
function put(ws: RosterWorkspace, p: CombinationPlacement, operator: string | undefined): void {
  const room = ws.mainPlan.facilities[p.roomId], slot = room.slots[p.slotIndex]!
  if (p.role === 'main') slot.occupant = operator ? { kind: 'operator', operatorId: id(operator) } : { kind: room.type === 'dormitory' ? 'free' : 'empty' }
  else slot.replacements = [...slot.replacements.filter(ref => !isOrdinaryReplacementCandidate(ref, room.type)), ...(operator ? [id(operator)] : [])]
}
function canMove(ws: RosterWorkspace, inventory: OperatorInventory, operator: string, p: CombinationPlacement, fromType?: string): boolean {
  const room = ws.mainPlan.facilities[p.roomId]
  return (p.role !== 'backup' || isOrdinaryReplacementCandidate(operator, room.type)) &&
    (room.type === fromType || room.type === 'dormitory' || Boolean(inventory.operators.find(o => o.charId === id(operator))?.skills.some(s => s.roomType === skillTypes[room.type])))
}

/** Recombine already allocated actors transactionally; outgoing actors take their vacated seats. */
export function regroupCombination(ws: RosterWorkspace, inventory: OperatorInventory, original: CombinationVariant, role: RosterRole, locks: AllocationLocks = {}): RosterWorkspace | null {
  const draft = structuredClone(ws)
  const desired = original.placements.map(p => ({ ...p, role: draft.mainPlan.facilities[p.roomId].type === 'dormitory' ? 'main' as const : role }))
  if (desired.some(p => actor(ws, p) !== p.operatorId && (locks.lockedPositions?.has(key(p)) || locks.lockedOperators?.has(p.operatorId)))) return null
  const permanent = new Set(draft.mainPlan.conf.workaholic.map(id))
  for (const target of desired) {
    const outgoing = actor(draft, target)
    if (outgoing === target.operatorId) continue
    if (outgoing && (locks.lockedOperators?.has(id(outgoing)) || permanent.has(id(outgoing)) || locks.protectedCombinationOperators?.has(id(outgoing)))) return null
    let source: CombinationPlacement | undefined
    for (const room of Object.values(draft.mainPlan.facilities)) room.slots.forEach((slot, slotIndex) => {
      if (slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === target.operatorId) source = { roomId: room.roomId, slotIndex, role: 'main', operatorId: target.operatorId }
      if (physicalBackupOperatorIds(room, slot).includes(target.operatorId)) source = { roomId: room.roomId, slotIndex, role: 'backup', operatorId: target.operatorId }
    })
    if (source && (locks.lockedPositions?.has(key(source)) || permanent.has(target.operatorId) ||
      locks.protectedCombinationOperators?.has(target.operatorId) || outgoing && !canMove(draft, inventory, outgoing, source, draft.mainPlan.facilities[target.roomId].type))) return null
    // A reserved special order operator cannot become an ordinary production member.
    if (target.role === 'backup' && !isOrdinaryReplacementCandidate(target.operatorId, draft.mainPlan.facilities[target.roomId].type)) return null
    if (source) put(draft, source, outgoing)
    put(draft, target, target.operatorId)
  }
  if (desired.every(p => actor(ws, p) === p.operatorId)) return null
  const physical = Object.values(draft.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot => [
    ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, slot),
  ]))
  if (new Set(physical).size !== physical.length) return null
  const production = Object.values(draft.mainPlan.facilities).filter(room => room.level > 0 && ['manufacture', 'trading'].includes(room.type))
  const active = production.flatMap(room => room.slots.flatMap(s => s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []))
  let rankedActive: string[] | undefined
  for (const dorm of Object.values(draft.mainPlan.facilities).filter(room => room.type === 'dormitory')) for (const [index, slot] of dorm.slots.entries()) {
    if (slot.occupant.kind !== 'operator' || id(slot.occupant.operatorId) !== id('菲亚梅塔') || slot.replacements.every(ref => active.includes(id(ref)))) continue
    if (locks.lockedPositions?.has(`${dorm.roomId}:${index}`) || locks.lockedOperators?.has(id('菲亚梅塔'))) return null
    rankedActive ??= production.map(room => ({ room,
      perCapita: (productionTeamTheory(draft, inventory, room.roomId) ?? -Infinity) / Math.max(1, room.slots.filter(s => s.occupant.kind === 'operator').length) }))
      .sort((a, b) => b.perCapita - a.perCapita)
      .flatMap(({ room }) => room.slots.flatMap(s => s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []))
    const size = Math.min(3, slot.replacements.length)
    const valid = slot.replacements.filter(ref => active.includes(id(ref)))
    slot.replacements = [...valid, ...rankedActive.filter(ref => !valid.some(v => id(v) === ref))].slice(0, size)
  }
  if (!groupVariant(draft, { ...original, placements: desired }, locks)) return null
  if (!preservesLocks(ws, draft, locks)) return null
  return draft
}

/** Every swap preserves the cross-room group; higher complete production teams enter main. */
export function normalizeProductionShifts(ws: RosterWorkspace, inventory: OperatorInventory, locks: AllocationLocks = {}): string[] {
  const rooms = Object.values(ws.mainPlan.facilities).filter(r => ['manufacture', 'trading'].includes(r.type) && r.level > 0)
  const values = (draft: RosterWorkspace) => rooms.map(room => {
    const mainRoom = draft.mainPlan.facilities[room.roomId], backup = shiftSnapshot(draft, 'backup', room.roomId)
    const count = mainRoom.slots.filter(s => s.occupant.kind === 'operator').length
    const backupCount = backup.mainPlan.facilities[room.roomId].slots.filter(s => s.occupant.kind === 'operator').length
    const main = productionTeamTheory(draft, inventory, room.roomId), relief = productionTeamTheory(backup, inventory, room.roomId)
    return { roomId: room.roomId, count, backupCount,
      gap: main === undefined || relief === undefined || !count || !backupCount ? undefined : relief / backupCount - main / count }
  })
  const reasons = new Map<string, string>()
  // Support changes may affect rooms visited earlier. Re-evaluate the complete base
  // after every accepted swap, rather than marking an entire group as processed.
  for (let pass = 0; pass < Math.max(1, rooms.length * 2); pass++) {
    const before = values(ws), deficit = before.reduce((sum, v) => sum + Math.max(0, v.gap ?? 0), 0)
    let changed = false
    for (const value of before.filter(v => v.gap !== undefined && v.gap > 1e-9).sort((a, b) => b.gap! - a.gap!)) {
      const room = ws.mainPlan.facilities[value.roomId], groups = new Set(room.slots.map(s => s.groupId).filter(Boolean))
      const positions: CombinationPlacement[] = []
      for (const other of Object.values(ws.mainPlan.facilities)) if (other.type !== 'dormitory') other.slots.forEach((slot, slotIndex) => {
        if (other.roomId === room.roomId || slot.groupId && groups.has(slot.groupId)) positions.push({ roomId: other.roomId, slotIndex, role: 'main', operatorId: '' })
      })
      if (positions.some(p => locks.lockedPositions?.has(key(p)) || [actor(ws, p), actor(ws, { ...p, role: 'backup' })].some(op => op && locks.lockedOperators?.has(id(op))))) {
        reasons.set(room.roomId, '用户锁定阻止主替互换'); continue
      }
      const draft = structuredClone(ws), swapped = new Map<string, string>()
      let valid = value.count === value.backupCount
      for (const p of positions) {
        const a = actor(draft, p), b = actor(draft, { ...p, role: 'backup' })
        if (a && draft.mainPlan.conf.workaholic.some(ref => id(ref) === id(a))) continue
        if (!a || !b || !canMove(draft, inventory, a, { ...p, role: 'backup' }, draft.mainPlan.facilities[p.roomId].type)) { valid = false; break }
        put(draft, p, b); put(draft, { ...p, role: 'backup' }, a); swapped.set(id(a), id(b))
      }
      if (!valid) { reasons.set(room.roomId, '主替人数或常驻人员约束阻止整组互换'); continue }
      // Fiammetta's special targets refer to active primary workers, not their
      // newly departed relief counterparts. Update before simulation or rollback.
      for (const dorm of Object.values(draft.mainPlan.facilities).filter(r => r.type === 'dormitory')) for (const slot of dorm.slots) {
        if (slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === id('菲亚梅塔')) slot.replacements = slot.replacements.map(ref => swapped.get(id(ref)) ?? ref)
      }
      if (!preservesLocks(ws, draft, locks)) { reasons.set(room.roomId, '用户锁定的特殊换班目标阻止互换'); continue }
      const after = values(draft), target = after.find(v => v.roomId === room.roomId)!
      const nextDeficit = after.reduce((sum, v) => sum + Math.max(0, v.gap ?? 0), 0)
      if (target.gap === undefined || target.gap > 1e-9 || nextDeficit >= deficit - 1e-9 || after.some(v => {
        const old = before.find(o => o.roomId === v.roomId)!
        return old.gap !== undefined && old.gap <= 1e-9 && (v.gap === undefined || v.gap > 1e-9)
      })) { reasons.set(room.roomId, '跨站联动的主替排序冲突，保留完整组合'); continue }
      Object.assign(ws, draft); changed = true; break
    }
    if (!changed) break
  }
  return values(ws).filter(v => v.gap !== undefined && v.gap > 1e-9)
    .map(v => `${v.roomId} 替班人均较高，${reasons.get(v.roomId) ?? '排序搜索达到有限预算，保留已验证排班'}`)
}

/** Bounded joint refinement, after all logical variants have been enumerated and evaluated. */
export function refineCombinationAllocation(ws: RosterWorkspace, inventory: OperatorInventory, pool: CombinationPool, locks: AllocationLocks = {}, budget = 160): { workspace: RosterWorkspace; diagnostics: string[]; evaluated: number } {
  let workspace = structuredClone(ws), score = completeShiftScore(workspace, inventory)
  let evaluated = 0, changed = true
  const tried = new Set<string>()
  while (changed && score !== undefined && evaluated < budget) {
    changed = false
    const protectedCombinationOperators = activeCombinationCoreIds(workspace, pool)
    for (const value of pool.values) {
      if (value.status !== 'evaluated') continue
      for (const role of ['main', 'backup'] as const) {
        const trialKey = `${value.variant.id}:${role}:${score}`
        if (tried.has(trialKey)) continue
        tried.add(trialKey)
        const draft = regroupCombination(workspace, inventory, value.variant, role, { ...locks, protectedCombinationOperators })
        if (!draft) continue
        evaluated++
        const next = completeShiftScore(draft, inventory)
        if (next !== undefined && next > score + 1e-7) { workspace = draft; score = next; changed = true; break }
        if (evaluated >= budget) break
      }
      if (changed || evaluated >= budget) break
    }
  }
  const diagnostics = normalizeProductionShifts(workspace, inventory, locks)
  if (evaluated >= budget) diagnostics.push(`再组合验证达到 ${budget} 次完整主替评估预算；已验证的改动均提高整体静态效率，尚未穷尽全局分配`)
  return { workspace, diagnostics, evaluated }
}

/** Core presence alone protects a formed combination; optional members are gap fillers. */
export function activeCombinationCoreIds(ws: RosterWorkspace, pool: CombinationPool): Set<string> {
  const cores = new Set<string>()
  for (const value of pool.values) {
    if (value.status !== 'evaluated') continue
    const core = value.variant.placements.filter(p => value.variant.coreOperatorIds.includes(p.operatorId))
    if (!core.length) continue
    for (const role of ['main', 'backup'] as const) {
      if (core.every(p => ws.mainPlan.facilities[p.roomId].slots.some((_slot, slotIndex) =>
        actor(ws, { ...p, slotIndex, role: ws.mainPlan.facilities[p.roomId].type === 'dormitory' ? 'main' : role }) === p.operatorId))) {
        core.forEach(p => cores.add(p.operatorId))
      }
    }
  }
  return cores
}

/** Labels are derived from final placements, never retained after the combination is broken. */
export function appliedMainCombinations(ws: RosterWorkspace, pool: CombinationPool): string[] {
  const result = new Set<string>()
  for (const value of pool.values) {
    const core = value.variant.placements.filter(p => value.variant.coreOperatorIds.includes(p.operatorId))
    if (core.every(p => ws.mainPlan.facilities[p.roomId].slots.some(s => s.occupant.kind === 'operator' && id(s.occupant.operatorId) === p.operatorId))) result.add(value.variant.definitionId)
  }
  return ATOMIC_UNITS.filter(unit => result.has(unit.id)).map(unit => unit.id)
}
