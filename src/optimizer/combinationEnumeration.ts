import type { OperatorInventory } from '../domain/operatorInventory'
import type { MowerFacility, MowerRoomId, RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { ATOMIC_UNITS, type AtomicMember, type AtomicUnit } from './riicAtomicUnits'
import { availableCoreVariants, availableOptionalMembers, facilityCapacity, physicalBackupOperatorIds, type CombinationPlacement, type CombinationVariant } from './combinationModel'
import { isProductionSingletonCandidate } from './productionSingletons'
import { isShiftRunOperator } from '../scheduler/scheduleAdapter'

function subsets<T>(items: readonly T[], maximum = items.length): T[][] {
  const result: T[][] = [[]]
  for (const item of items) {
    const next = result.filter(row => row.length < maximum).map(row => [...row, item])
    result.push(...next)
  }
  return result
}

interface AssignmentGroup { key: string; members: AtomicMember[]; distinct?: boolean }
export function combinationAssignmentGroups(atom: AtomicUnit, core: AtomicMember[], optional: AtomicMember[]): AssignmentGroup[] {
  const groups = new Map<string, AssignmentGroup>()
  for (const [index, member] of [...core, ...optional].entries()) {
    const hunters = atom.id === 'abyssal_hunters' && member.roomType === 'manufacture' && index < core.length
    const separate = member.roomType === 'power'
    const key = hunters ? `hunter:${Math.floor(core.filter(m => m.roomType === 'manufacture').findIndex(m => m.name === member.name) / 2)}` :
      separate ? `${member.roomType}:${member.name}` : member.roomType
    const group = groups.get(key) ?? { key, members: [], distinct: hunters || separate }
    group.members.push(member)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function matches(member: AtomicMember, room: MowerFacility): boolean {
  const type = member.roomType === 'office' ? 'contact' : member.roomType
  return room.type === type && room.level > 0 && room.level >= (member.minLevel ?? 1) && (!member.product || room.product === member.product)
}

/** Enumerate logical optional subsets and legal footprints before globally reserving anyone. */
export function enumerateCombinationVariants(base: RosterWorkspace, inventory: OperatorInventory): CombinationVariant[] {
  if (!inventory.valid) return []
  const rooms = Object.values(base.mainPlan.facilities)
  const powerCount = rooms.filter(r => r.type === 'power' && r.level > 0).length
  const owned = new Set(inventory.operators.map(o => o.name))
  const stationed = new Set(rooms.flatMap(r => r.slots.flatMap(s => s.occupant.kind === 'operator' ? [resolveId(s.occupant.operatorId)] : [])))
  const reservedBackups = new Set(rooms.flatMap(r => r.slots.flatMap(s => physicalBackupOperatorIds(r, s))))
  const values: CombinationVariant[] = []
  const seen = new Set<string>()
  for (const atom of ATOMIC_UNITS) {
    const products: Array<'gold' | 'exp' | undefined> = atom.preferredFacilityType === 'manufacture'
      ? [...new Set(rooms.filter(r => r.type === 'manufacture' && r.level > 0 && (r.product === 'gold' || r.product === 'exp')).map(r => r.product as 'gold' | 'exp'))]
      : [undefined]
    for (const product of products) {
      if (atom.preferredProduct && atom.preferredProduct !== 'any' && atom.preferredProduct !== product) continue
      for (const available of availableCoreVariants(atom, inventory, powerCount, product)) {
        const core = available.coreMembers.map(m => atom.id !== 'abyssal_hunters' && m.roomType === 'manufacture' && !m.product && product ? { ...m, product } : m)
        const optional = availableOptionalMembers(atom, inventory, core, product)
        for (const name of available.thirdMemberWhitelist ?? []) {
          if (owned.has(name) && !core.some(m => m.name === name) && !optional.some(m => m.name === name)) optional.push({ name, roomType: 'manufacture', ...(product ? { product } : {}) })
        }
        if (atom.allowProductionFillers) {
          const target = rooms.find(r => r.type === atom.preferredFacilityType && r.level > 0)
          if (target) for (const operator of inventory.operators) {
            if (operator.name === '空' || isShiftRunOperator(operator.charId) || core.some(m => m.name === operator.name) || optional.some(m => m.name === operator.name)) continue
            if (isProductionSingletonCandidate(base, target.roomId, operator.skills)) optional.push({ name: operator.name, roomType: atom.preferredFacilityType })
          }
        }
        const local = optional.filter(m => m.roomType === atom.preferredFacilityType)
        const support = optional.filter(m => m.roomType !== atom.preferredFacilityType)
        const targetCapacity = Math.max(0, ...rooms.filter(r => r.type === atom.preferredFacilityType && r.level > 0).map(r => facilityCapacity(r.type, r.level)))
        const localCount = core.filter(m => m.roomType === atom.preferredFacilityType).length
        const localMaximum = atom.id === 'abyssal_hunters' ? 0 : Math.max(0, targetCapacity - localCount)
        for (const localMembers of subsets(local, localMaximum)) for (const supporters of subsets(support)) {
          const enhanced = [...localMembers, ...supporters]
          let presenceSets: string[][] = [[]]
          for (const boost of atom.presenceBoosts ?? []) {
            if (boost.whenMember && ![...core, ...enhanced].some(m => m.name === boost.whenMember)) continue
            const already = new Set([...stationed, ...[...core, ...enhanced].map(m => resolveId(m.name))])
            const presentCount = boost.pool.filter(name => already.has(resolveId(name))).length
            const pool = boost.pool.filter(name => owned.has(name) && !already.has(resolveId(name)) && !reservedBackups.has(resolveId(name)))
            presenceSets = subsets(pool, Math.max(0, boost.maximumUsefulCount - presentCount))
          }
          for (const presence of presenceSets) {
            const assignments = combinationAssignmentGroups(atom, core, enhanced)
            const placed: CombinationPlacement[] = []
            const usedRooms = new Map<string, MowerRoomId>()
            const occupiedPositions = new Set<string>()
            const placePresence = () => {
              const start = placed.length
              for (const name of presence) {
                // Presence is a real station, never an extraWorkplace/ownership-only credit.
                const candidates = rooms.filter(r => ['dormitory', 'factory', 'train'].includes(r.type) && r.level > 0)
                  .sort((a, b) => (a.type === 'dormitory' ? 0 : 1) - (b.type === 'dormitory' ? 0 : 1) || a.roomId.localeCompare(b.roomId))
                let found = false
                for (const room of candidates) {
                  const index = Array.from({ length: facilityCapacity(room.type, room.level) }, (_, i) => i).find(i =>
                    !occupiedPositions.has(`${room.roomId}:${i}`) && room.slots[i]?.occupant.kind !== 'operator' && room.slots[i]?.occupant.kind !== 'current' && !room.slots[i]?.replacements.length)
                  if (index === undefined) continue
                  placed.push({ roomId: room.roomId, slotIndex: index, operatorId: resolveId(name), role: 'main' })
                  occupiedPositions.add(`${room.roomId}:${index}`)
                  found = true
                  break
                }
                if (!found) {
                  while (placed.length > start) { const p = placed.pop()!; occupiedPositions.delete(`${p.roomId}:${p.slotIndex}`) }
                  return
                }
              }
              const id = `${atom.id}:${placed.map(p => `${p.roomId}.${p.slotIndex}=${p.operatorId}`).sort().join('|')}`
              if (!seen.has(id)) {
                seen.add(id)
                values.push({ id, definitionId: atom.id, name: atom.name, coreOperatorIds: core.map(m => resolveId(m.name)),
                  optionalOperatorIds: [...enhanced.map(m => resolveId(m.name)), ...presence.map(resolveId)], placements: placed.map(p => ({ ...p })), policy: available.confPolicy ?? {} })
              }
              while (placed.length > start) { const p = placed.pop()!; occupiedPositions.delete(`${p.roomId}:${p.slotIndex}`) }
            }
            const search = (groupIndex: number) => {
              if (groupIndex === assignments.length) { placePresence(); return }
              const group = assignments[groupIndex]!
              for (const room of rooms) {
                if (!group.members.every(m => matches(m, room))) continue
                if (group.distinct && [...usedRooms.entries()].some(([key, id]) => id === room.roomId && key !== group.key)) continue
                const indices: number[] = []
                let valid = true
                for (const member of group.members) {
                  const id = resolveId(member.name)
                  if (reservedBackups.has(id)) { valid = false; break }
                  const already = room.slots.findIndex(s => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === id)
                  if (stationed.has(id) && already < 0) { valid = false; break }
                  const index = already >= 0 ? already : Array.from({ length: facilityCapacity(room.type, room.level) }, (_, i) => i).find(i =>
                    !indices.includes(i) && !occupiedPositions.has(`${room.roomId}:${i}`) && room.slots[i]?.occupant.kind !== 'operator' && room.slots[i]?.occupant.kind !== 'current' && !room.slots[i]?.replacements.length)
                  if (index === undefined || occupiedPositions.has(`${room.roomId}:${index}`)) { valid = false; break }
                  indices.push(index)
                }
                if (!valid) continue
                usedRooms.set(group.key, room.roomId)
                const start = placed.length
                group.members.forEach((member, i) => {
                  const slotIndex = indices[i]!
                  occupiedPositions.add(`${room.roomId}:${slotIndex}`)
                  placed.push({ roomId: room.roomId, slotIndex, operatorId: resolveId(member.name), role: 'main' })
                })
                search(groupIndex + 1)
                while (placed.length > start) { const p = placed.pop()!; occupiedPositions.delete(`${p.roomId}:${p.slotIndex}`) }
                usedRooms.delete(group.key)
              }
            }
            search(0)
          }
        }
      }
    }
  }
  return values
}
