import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'

/** One explicit planning state, not a prediction of runtime availability or duty ratio.
 * Only simple shift groups, ordered idle relief and declared Free beds are projected.
 * Unknown/ambiguous arrangements return undefined rather than an empty-workplace score.
 */
export function projectJointBackupRestState(
  workspace: RosterWorkspace, inventory: OperatorInventory, absent: readonly string[],
): RosterWorkspace | undefined {
  if (!inventory.valid) return undefined
  const projected = structuredClone(workspace)
  if (!absent.length) return projected
  const owned = new Set(inventory.operators.map(operator => operator.charId))
  const permanent = new Set(projected.mainPlan.conf.workaholic.map(id))
  const positions = Object.values(projected.mainPlan.facilities).filter(room => room.level > 0)
    .flatMap(room => room.slots.map(slot => ({ room, slot })))
  const working = positions.filter(position => position.room.type !== 'dormitory')
  const resting = new Set<typeof positions[number]>()
  for (const actor of new Set(absent.map(id))) {
    const primary = working.filter(({ slot }) => slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === actor)
    if (primary.length !== 1 || permanent.has(actor) || primary[0]!.slot.groupBindings?.length) return undefined
    const target = primary[0]!, group = target.slot.groupId?.trim()
    const members = group ? working.filter(({ slot }) => slot.groupId?.trim() === group) : [target]
    if (group && positions.some(({ slot }) => slot.groupBindings?.some(binding => binding.groupId?.trim() === group))) return undefined
    for (const member of members) {
      if (member.slot.groupBindings?.length || member.slot.occupant.kind !== 'operator') return undefined
      if (!permanent.has(id(member.slot.occupant.operatorId))) resting.add(member)
    }
  }
  const beds = positions.filter(({ room, slot }) => room.type === 'dormitory' && slot.occupant.kind === 'free'
    && !slot.groupBindings?.length && !slot.groupId)
  if (beds.length < resting.size) return undefined
  // Even another departing primary is unavailable as relief: it is going to rest.
  const occupants = positions.flatMap(({ slot }) => slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : [])
  const occupied = new Set(occupants)
  if (occupied.size !== occupants.length) return undefined
  const selected = new Set<string>()
  let bed = 0
  for (const { room, slot } of resting) {
    const outgoing = slot.occupant
    if (outgoing.kind !== 'operator' || !owned.has(id(outgoing.operatorId))) return undefined
    const replacement = slot.replacements.map(id).find(actor => owned.has(actor) && !occupied.has(actor)
      && isOrdinaryReplacementCandidate(actor, room.type))
    // Shared first choices need runtime matching/order; do not invent its result.
    if (!replacement || selected.has(replacement)) return undefined
    selected.add(replacement)
    slot.occupant = { kind: 'operator', operatorId: replacement }
    beds[bed++]!.slot.occupant = { kind: 'operator', operatorId: id(outgoing.operatorId) }
  }
  return projected
}
