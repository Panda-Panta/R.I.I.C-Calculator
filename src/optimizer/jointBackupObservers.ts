import type { OperatorInventory } from '../domain/operatorInventory'
import type { MowerRoomId, RosterWorkspace } from '../domain/roster'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import type { GeneratedBackupObserver, GeneratedBackupTrigger } from './generatedBackupTypes'

interface MainCandidate { id: string; workspace: RosterWorkspace }
interface RankedObserver { observer: GeneratedBackupObserver; crossover: boolean; change: number }

/** Cheap context sensitivity ranks proposals; it is neither an F bound nor a gain claim. */
export function selectJointBackupTriggers(candidates: readonly MainCandidate[], inventory: OperatorInventory, maxTriggers = 8): GeneratedBackupTrigger[] {
  const limit = Number.isFinite(maxTriggers) ? Math.max(0, Math.min(16, Math.floor(maxTriggers))) : 0
  if (!limit || !inventory.valid || candidates.length < 2) return []
  const owned = new Set(inventory.operators.map(operator => operator.charId))
  const ranked = new Map<string, RankedObserver>()
  for (let left = 0; left < candidates.length; left++) for (let right = left + 1; right < candidates.length; right++) {
    const a = candidates[left]!.workspace, b = candidates[right]!.workspace
    const changed = new Set(Object.values(a.mainPlan.facilities).filter(room => room.level > 0 &&
      ['manufacture', 'trading'].includes(room.type) && JSON.stringify(room) !== JSON.stringify(b.mainPlan.facilities[room.roomId])).map(room => room.roomId))
    if (!changed.size) continue
    const scoreA = productionWorkspaceHourlyScore(a, inventory), scoreB = productionWorkspaceHourlyScore(b, inventory)
    if (scoreA === undefined || scoreB === undefined || !Number.isFinite(scoreA - scoreB)) continue
    const onGap = scoreA - scoreB
    const permanent = new Set([...a.mainPlan.conf.workaholic, ...b.mainPlan.conf.workaholic].map(id))
    for (const room of Object.values(a.mainPlan.facilities)) {
      if (room.level <= 0 || room.type === 'dormitory' || changed.has(room.roomId)) continue
      for (const [index, slot] of room.slots.entries()) {
        if (slot.occupant.kind !== 'operator') continue
        const actor = id(slot.occupant.operatorId), other = b.mainPlan.facilities[room.roomId]?.slots[index]
        if (!owned.has(actor) || permanent.has(actor) || other?.occupant.kind !== 'operator' || id(other.occupant.operatorId) !== actor) continue
        const withoutA = structuredClone(a), withoutB = structuredClone(b)
        withoutA.mainPlan.facilities[room.roomId].slots[index]!.occupant = { kind: 'empty' }
        withoutB.mainPlan.facilities[room.roomId].slots[index]!.occupant = { kind: 'empty' }
        const offA = productionWorkspaceHourlyScore(withoutA, inventory), offB = productionWorkspaceHourlyScore(withoutB, inventory)
        if (offA === undefined || offB === undefined || !Number.isFinite(offA - offB)) continue
        const offGap = offA - offB, change = Math.abs(onGap - offGap)
        if (change < 1e-7) continue
        const observer: GeneratedBackupObserver = { operatorId: actor, roomId: room.roomId as MowerRoomId,
          // Power presence may matter even at zero morale (for example a robot
          // counted by another provider); test the presence condition directly.
          ...(room.type === 'power' ? {} : { requirePositiveMood: true }) }
        const item = { observer, crossover: onGap * offGap < -1e-8, change }
        const previous = ranked.get(actor)
        if (!previous || Number(item.crossover) > Number(previous.crossover) ||
          item.crossover === previous.crossover && change > previous.change) ranked.set(actor, item)
      }
    }
  }
  const observers = [...ranked.values()].sort((a, b) => Number(b.crossover) - Number(a.crossover) || b.change - a.change ||
    Number(b.observer.roomId === 'central') - Number(a.observer.roomId === 'central') || a.observer.operatorId.localeCompare(b.observer.operatorId))
    .slice(0, 3).map(item => item.observer)
  const sets = [...observers.map(observer => [observer]), ...observers.flatMap((observer, index) => observers.slice(index + 1).map(other => [observer, other]))]
  return sets.flatMap(group => (['all-present', 'not-all-present'] as const).map(activeWhen => ({ observers: group, activeWhen }))).slice(0, limit)
}
