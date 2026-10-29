import type { OperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { PENDANT_AUXILIARY_FACILITIES, facilityCapacity } from '../domain/facilities'
import type { MowerFacility, RosterWorkspace } from '../domain/roster'
import { evaluateDormitoryRecovery } from '../engine/dormitoryRecovery'
import { isAoeDormKeeper, isSingleDormKeeper } from '../scheduler/smartDormitoryPolicy'
import type { CombinationPlacement, CombinationVariant } from './combinationModel'
import { projectRosterConfig } from './rosterProjection'
import { ATOMIC_UNITS } from './riicAtomicUnits'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'

export const MAX_PRESENCE_PLACEMENT_PLANS = 3
export interface PresencePlacementStats { recoveryEvaluations: number; recoveryCacheHits: number }
const EPS = 1e-9

/** A real recovery-capable presence footprint; not a marginal-gain or F proof. */
export function hasDormitoryRecoveryPresence(base: RosterWorkspace, inventory: OperatorInventory, variant: CombinationVariant): boolean {
  const atom = ATOMIC_UNITS.find(unit => unit.id === variant.definitionId)
  const members = new Set([...variant.coreOperatorIds, ...variant.optionalOperatorIds].map(resolveId))
  const presence = new Set((atom?.presenceBoosts ?? []).filter(boost => !boost.whenMember || members.has(resolveId(boost.whenMember)))
    .flatMap(boost => boost.pool.map(resolveId)))
  const placed = variant.placements.filter(placement => placement.role === 'main' &&
    base.mainPlan.facilities[placement.roomId].type === 'dormitory' && base.mainPlan.facilities[placement.roomId].level > 0 &&
    presence.has(resolveId(placement.operatorId)) && !variant.coreOperatorIds.some(id => resolveId(id) === resolveId(placement.operatorId)))
  if (!placed.length || !inventory.valid) return false
  const records = inventoryOperatorRecords(inventory)
  return placed.some(placement => {
    const operator = records[resolveId(placement.operatorId)]
    return operator && (isAoeDormKeeper(operator) || isSingleDormKeeper(operator))
  })
}

/**
 * Keep the auxiliary baseline and at most two recovery alternatives. Marginal
 * recovery is a placement heuristic in the fixed incoming context, not G/F.
 * Callers must retain alternative footprints before finite full-F selection.
 */
export function createPresencePlacementPlanner(base: RosterWorkspace, inventory: OperatorInventory, lockedPositions?: ReadonlySet<string>,
  stats: PresencePlacementStats = { recoveryEvaluations: 0, recoveryCacheHits: 0 },
  records: ReturnType<typeof inventoryOperatorRecords> = inventoryOperatorRecords(inventory)) {
  const kinds: readonly string[] = [...PENDANT_AUXILIARY_FACILITIES, 'dormitory']
  const rooms = Object.values(base.mainPlan.facilities).filter(room => room.level > 0 && kinds.includes(room.type))
    .sort((a, b) => kinds.indexOf(a.type) - kinds.indexOf(b.type) || a.roomId.localeCompare(b.roomId))
  const dorms = rooms.filter(room => room.type === 'dormitory')
  const config = projectRosterConfig(base)
  config.operatorRecords = records
  const gains = new Map<string, number | undefined>()
  const keeper = (operatorId: string) => Boolean(records[operatorId] && (isAoeDormKeeper(records[operatorId]!) || isSingleDormKeeper(records[operatorId]!)))
  const free = (room: MowerFacility, used: ReadonlySet<string>) => room.slots.flatMap((slot, index) => index < facilityCapacity(room.type, room.level) &&
    !used.has(`${room.roomId}:${index}`) && !lockedPositions?.has(`${room.roomId}:${index}`) &&
    (slot.occupant.kind === 'empty' || slot.occupant.kind === 'free') && !slot.replacements.length ? [index] : [])

  // A real owned non-provider is the conditional resting recipient. It is used
  // only in this isolated rate probe, never added to a generated placement.
  const recoveryGain = (room: MowerFacility, operatorId: string, placed: readonly CombinationPlacement[], presence: readonly string[]) => {
    const recipient = inventory.operators.find(operator => !presence.includes(operator.charId) &&
      !operator.skills.some(skill => skill.roomType === 'DORMITORY'))?.charId
    if (!recipient) return undefined
    const extra = placed.filter(placement => placement.roomId === room.roomId).map(placement => placement.operatorId)
    const key = JSON.stringify([room.roomId, operatorId, [...extra].sort(), recipient])
    if (gains.has(key)) { stats.recoveryCacheHits++; return gains.get(key) }
    const index = Number(room.roomId.slice(room.roomId.lastIndexOf('_') + 1)) - 1
    const snapshot = { ...config, controlOperatorIds: config.controlOperatorIds.filter(id => id !== recipient),
      rooms: config.rooms.map(room => ({ ...room, operatorIds: room.operatorIds.filter(id => id !== recipient) })),
      facilityOperatorIds: { ...config.facilityOperatorIds,
        dormitories: config.facilityOperatorIds.dormitories.map(ids => ids.filter(id => id !== recipient)),
        reception: config.facilityOperatorIds.reception.filter(id => id !== recipient),
        workshop: config.facilityOperatorIds.workshop.filter(id => id !== recipient),
        office: config.facilityOperatorIds.office.filter(id => id !== recipient),
        training: config.facilityOperatorIds.training.filter(id => id !== recipient),
      } }
    const residents = [...new Set([...snapshot.facilityOperatorIds.dormitories[index] ?? [], ...extra])]
    snapshot.facilityOperatorIds.dormitories[index] = [...residents, recipient]
    const morale = new Map<string, number>([...residents, operatorId].map(id => [id, 24])); morale.set(recipient, 12)
    // Atmosphere cancels in this same-room marginal comparison. Explicit zero
    // avoids assuming an unprovided atmosphere or using a max-stage shortcut.
    stats.recoveryEvaluations += 2
    const before = evaluateDormitoryRecovery(snapshot, index, morale, 0)
    snapshot.facilityOperatorIds.dormitories[index] = [...residents, operatorId, recipient]
    const after = evaluateDormitoryRecovery(snapshot, index, morale, 0)
    const gain = before.unquantified.length || after.unquantified.length ? undefined :
      (after.rates.get(recipient) ?? NaN) - (before.rates.get(recipient) ?? NaN)
    const quantified = gain !== undefined && Number.isFinite(gain) ? gain : undefined
    gains.set(key, quantified)
    return quantified
  }

  return (presence: readonly string[], occupiedPositions: ReadonlySet<string>, existingPlacements: readonly CombinationPlacement[] = []): CombinationPlacement[][] => {
    const plans: CombinationPlacement[][] = [], seen = new Set<string>()
    const add = (plan: CombinationPlacement[] | undefined) => {
      if (!plan) return
      const signature = JSON.stringify(plan.map(placement => [placement.operatorId, placement.roomId, placement.slotIndex]).sort())
      if (!seen.has(signature)) { seen.add(signature); plans.push(plan) }
    }
    const place = (recoveryLimit: number): CombinationPlacement[] | undefined => {
      const used = new Set(occupiedPositions), placed: CombinationPlacement[] = [], recoveryBeds = new Set<string>()
      const scores = new Map(recoveryLimit ? presence.map(operatorId => [operatorId, keeper(operatorId) ? Math.max(0, ...dorms.map(room =>
        free(room, used).length >= 2 ? recoveryGain(room, operatorId, existingPlacements, presence) ?? 0 : 0)) : 0]) : [])
      const order = recoveryLimit ? [...presence].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || presence.indexOf(a) - presence.indexOf(b)) : presence
      let recoveryPlaced = 0
      for (const operatorId of order) {
        let target: { room: MowerFacility; index: number; recoveryBedIndex?: number } | undefined
        if (recoveryPlaced < recoveryLimit && (scores.get(operatorId) ?? 0) > EPS) {
          const options = dorms.flatMap(room => {
            const available = free(room, used)
            if (available.length < 2) return [] // This resident still needs a real recovery bed beside it.
            const gain = recoveryGain(room, operatorId, [...existingPlacements, ...placed], presence)
            return gain !== undefined && gain > EPS ? [{ room, index: available[0]!, recoveryBedIndex: available[1]!, gain, beds: available.length - 1 }] : []
          }).sort((a, b) => b.gain - a.gain || b.beds - a.beds || a.room.roomId.localeCompare(b.room.roomId))
          if (options[0]) { target = options[0]; recoveryPlaced++ }
        }
        target ??= rooms.flatMap(room => { const index = free(room, used)[0]; return index === undefined ? [] : [{ room, index }] })[0]
        if (!target) return undefined
        const placement: CombinationPlacement = { roomId: target.room.roomId, slotIndex: target.index, operatorId, role: 'main' }
        placed.push(placement); used.add(`${placement.roomId}:${placement.slotIndex}`)
        if (target.recoveryBedIndex !== undefined && !recoveryBeds.has(target.room.roomId)) {
          recoveryBeds.add(target.room.roomId); used.add(`${target.room.roomId}:${target.recoveryBedIndex}`)
        }
      }
      return recoveryLimit && !recoveryPlaced ? undefined : placed
    }
    add(place(0))
    if (presence.some(keeper) && dorms.length) {
      add(place(presence.length))
      add(place(1))
    }
    return plans
  }
}
