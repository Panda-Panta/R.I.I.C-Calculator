import type { OperatorInventory } from '../domain/operatorInventory'
import type { RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { ATOMIC_UNITS } from './riicAtomicUnits'
import { availableCoreVariants, physicalBackupOperatorIds, type RosterRole } from './combinationModel'
import { combinationAssignmentGroups } from './combinationEnumeration'

export interface FormedCombination { signature: string; definitionId: string; coreOperatorIds: string[]; role: RosterRole }

/** Inspect actual actors and facility/product constraints; labels do not prove membership. */
export function formedCombinations(workspace: RosterWorkspace, inventory: OperatorInventory): FormedCombination[] {
  const rooms = Object.values(workspace.mainPlan.facilities).filter(r => r.level > 0)
  const permanent = new Set(workspace.mainPlan.conf.workaholic.map(id))
  const actors = (room: typeof rooms[number], role: RosterRole) => room.slots.flatMap(slot => {
    const main = slot.occupant.kind === 'operator' ? id(slot.occupant.operatorId) : undefined
    const operator = role === 'main' || room.type === 'dormitory' || main && permanent.has(main)
      ? main : physicalBackupOperatorIds(room, slot)[0]
    return operator ? [operator] : []
  })
  const powerCount = rooms.filter(r => r.type === 'power').length
  const result: FormedCombination[] = []
  for (const atom of ATOMIC_UNITS) {
    const products = atom.preferredFacilityType === 'manufacture'
      ? [...new Set(rooms.filter(r => r.type === 'manufacture' && (r.product === 'gold' || r.product === 'exp')).map(r => r.product as 'gold' | 'exp'))]
      : [undefined]
    for (const product of products) {
      if (atom.preferredProduct && atom.preferredProduct !== 'any' && atom.preferredProduct !== product) continue
      for (const variant of availableCoreVariants(atom, inventory, powerCount, product)) {
        const core = variant.coreMembers.map(m => atom.id !== 'abyssal_hunters' && m.roomType === 'manufacture' && !m.product && product ? { ...m, product } : m)
        const groups = combinationAssignmentGroups(atom, core, [])
        for (const role of ['main', 'backup'] as const) {
          const present = new Set(rooms.flatMap(room => actors(room, role)))
          if (atom.externalRequirements?.some(req => req.pool.filter(name => present.has(id(name))).length < req.count)) continue
          const usedRooms: string[] = []
          const matches = (index: number): boolean => {
            if (index === groups.length) return true
            const group = groups[index]!
            for (const room of rooms) {
              if (group.distinct && usedRooms.includes(room.roomId)) continue
              const occupants = actors(room, role)
              if (!group.members.every(member => room.type === (member.roomType === 'office' ? 'contact' : member.roomType) &&
                room.level >= (member.minLevel ?? 1) && (!member.product || room.product === member.product) && occupants.includes(id(member.name)))) continue
              usedRooms.push(room.roomId)
              if (matches(index + 1)) return true
              usedRooms.pop()
            }
            return false
          }
          if (matches(0)) result.push({ definitionId: atom.id, role, coreOperatorIds: core.map(m => id(m.name)),
            signature: `${atom.id}:${product ?? ''}:${core.map(m => id(m.name)).sort().join('+')}` })
        }
      }
    }
  }
  return result
}

export function formedCombinationCoreIds(workspace: RosterWorkspace, inventory: OperatorInventory): Set<string> {
  return new Set(formedCombinations(workspace, inventory).flatMap(combo => combo.coreOperatorIds))
}

/** Whole units may change main/relief roles. Individual changes must retain every formed core. */
export function preservesFormedCombinations(before: RosterWorkspace, after: RosterWorkspace, inventory: OperatorInventory): boolean {
  const remaining = new Set(formedCombinations(after, inventory).map(combo => combo.signature))
  return formedCombinations(before, inventory).every(combo => remaining.has(combo.signature))
}
