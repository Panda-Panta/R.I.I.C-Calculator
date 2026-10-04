import type { OperatorInventory } from '../domain/operatorInventory'
import type { MowerFacility, MowerRoomId, MowerSlot, RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import type { AtomicMember, AtomicUnit, AtomicUnitConfPolicy } from './riicAtomicUnits'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'

export type RosterRole = 'main' | 'backup'
export interface CombinationPlacement { roomId: MowerRoomId; slotIndex: number; operatorId: string; role: RosterRole }
export interface CombinationVariant {
  id: string
  definitionId: string
  name: string
  coreOperatorIds: string[]
  optionalOperatorIds: string[]
  placements: CombinationPlacement[]
  policy: AtomicUnitConfPolicy
}
export interface CombinationValue {
  variant: CombinationVariant
  status: 'evaluated' | 'unquantified' | 'infeasible'
  perCapita: number | null
  totalGain: number | null
  productionCount: number
  supportCount: number
  diagnostics: string[]
}
export interface CombinationPool { values: CombinationValue[]; diagnostics: string[]; enumeratedCount: number }
export interface CombinationAudit { valid: boolean; violations: string[]; diagnostics: string[] }

/** Dormitory lists are refresh references; trade runners also are not physical relief. */
export function physicalBackupOperatorIds(room: Pick<MowerFacility, 'type'>, slot: Pick<MowerSlot, 'replacements'>): string[] {
  return room.type === 'dormitory' ? [] : slot.replacements.filter(ref => isOrdinaryReplacementCandidate(ref, room.type)).map(resolveId)
}

export function facilityCapacity(type: string, level: number): number {
  if (level <= 0) return 0
  if (type === 'manufacture' || type === 'trading') return level
  if (type === 'central' || type === 'dormitory') return 5
  if (type === 'meeting' || type === 'train') return 2
  return ['power', 'contact', 'factory'].includes(type) ? 1 : 0
}

/** Membership depends on ownership, never a maximum-stage snapshot or an optional headcount. */
export function availableCoreVariants(atom: AtomicUnit, inventory: OperatorInventory, powerCount: number, product?: 'gold' | 'exp') {
  if (!inventory.valid) return []
  const names = new Set(inventory.operators.map(o => o.name))
  const adapted = atom.adaptToPowerCount?.(powerCount, product)
  const variants: NonNullable<AtomicUnit['coreVariants']> = atom.coreVariants ?? [{ members: adapted?.coreMembers ?? atom.coreMembers }]
  return variants.filter(v => (v.requiredPowerCount === undefined || v.requiredPowerCount === powerCount) && v.members.every(m => names.has(m.name)))
    .map(v => ({ coreMembers: [...v.members], thirdMemberWhitelist: adapted?.thirdMemberWhitelist ?? atom.thirdMemberWhitelist,
      confPolicy: { ...atom.confPolicy, ...adapted?.confPolicy } }))
}

export function availableOptionalMembers(atom: AtomicUnit, inventory: OperatorInventory, coreMembers: AtomicMember[], product?: 'gold' | 'exp'): AtomicMember[] {
  const core = new Set(coreMembers.map(m => m.name))
  const owned = new Map(inventory.operators.map(o => [o.name, o]))
  const result = (atom.nonCoreMembers ?? []).filter(m => !core.has(m.name) && owned.has(m.name) && (!m.product || !product || m.product === product))
  for (const operator of inventory.operators) {
    if (core.has(operator.name) || result.some(m => m.name === operator.name)) continue
    if (operator.skills.some(s => s.roomType === 'MANUFACTURE' && atom.nonCoreSkillClasses?.some(category => s.name.match(/^(.+?)·[αβγ]$/)?.[1] === category))) {
      result.push({ name: operator.name, roomType: 'manufacture', ...(product ? { product } : {}) })
    }
  }
  return result
}

/** A relief snapshot replaces actual grouped positions; departing supporters cannot remain active. */
export function shiftSnapshot(workspace: RosterWorkspace, role: RosterRole, roomId?: MowerRoomId): RosterWorkspace {
  const result = structuredClone(workspace)
  if (role === 'main') return result
  const groups = new Set((roomId ? result.mainPlan.facilities[roomId].slots : Object.values(result.mainPlan.facilities).flatMap(r => r.slots)).map(s => s.groupId).filter(Boolean))
  for (const room of Object.values(result.mainPlan.facilities)) {
    if (room.type === 'dormitory') continue
    room.slots.forEach(slot => {
      if (roomId && room.roomId !== roomId && (!slot.groupId || !groups.has(slot.groupId))) return
      if (slot.occupant.kind !== 'operator' && !slot.replacements.length) return
      if (result.mainPlan.conf.workaholic.some(id => resolveId(id) === resolveId(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : ''))) return
      const backup = slot.replacements.find(id => isOrdinaryReplacementCandidate(id, room.type))
      slot.occupant = backup ? { kind: 'operator', operatorId: resolveId(backup) } : { kind: 'empty' }
    })
  }
  return result
}

/** Transactional placement. A failed member leaves the original workspace untouched. */
export function applyCombinationVariant(base: RosterWorkspace, variant: CombinationVariant): RosterWorkspace | null {
  const result = structuredClone(base)
  const members = new Set(variant.placements.map(p => p.operatorId))
  if (members.size !== variant.placements.length) return null
  for (const room of Object.values(base.mainPlan.facilities)) for (const [index, slot] of room.slots.entries()) {
    const placement = variant.placements.find(p => p.roomId === room.roomId && p.slotIndex === index)
    if (slot.occupant.kind === 'operator' && members.has(resolveId(slot.occupant.operatorId)) &&
      !(placement?.role === 'main' && placement.operatorId === resolveId(slot.occupant.operatorId))) return null
    if (physicalBackupOperatorIds(room, slot).some(id => members.has(id) && !(placement?.role === 'backup' && placement.operatorId === id))) return null
  }
  for (const placement of variant.placements) {
    const room = result.mainPlan.facilities[placement.roomId]
    if (!room || placement.slotIndex >= facilityCapacity(room.type, room.level)) return null
    while (room.slots.length <= placement.slotIndex) room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
    const slot = room.slots[placement.slotIndex]!
    if (placement.role === 'main') {
      if (slot.occupant.kind === 'current' || slot.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) !== placement.operatorId) return null
      if (slot.occupant.kind !== 'operator') slot.occupant = { kind: 'operator', operatorId: placement.operatorId }
    } else {
      if (slot.occupant.kind === 'current' || slot.replacements.some(id => resolveId(id) !== placement.operatorId)) return null
      if (!slot.replacements.length) slot.replacements = [placement.operatorId]
    }
  }
  return result
}
