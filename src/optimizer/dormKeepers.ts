import type { OperatorInventory } from '../domain/operatorInventory'
import { hasDormKeeper } from '../workbench/facilityState'
import { resolveOperatorCharId } from '../workbench/compat/mowerJson'
import type { RosterWorkspace } from '../workbench/model'

/** Keep explicitly built dorms identifiable after exporting and reimporting their roster. */
export function ensureBuiltDormKeepers(workspace: RosterWorkspace, inventory: OperatorInventory, locked: ReadonlySet<string> = new Set()): boolean {
  const reserved = new Set(Object.values(workspace.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot => [
    ...(slot.occupant.kind === 'operator' ? [resolveOperatorCharId(slot.occupant.operatorId)] : []),
    ...slot.replacements.map(resolveOperatorCharId),
  ])))
  for (const dorm of Object.values(workspace.mainPlan.facilities)) {
    if (dorm.type !== 'dormitory' || dorm.level === 0 || hasDormKeeper(dorm)) continue
    const slot = dorm.slots.find((slot, index) => !locked.has(`${dorm.roomId}:${index}`) && ['empty', 'free'].includes(slot.occupant.kind) &&
      !slot.groupId && !slot.replacements.length && !Object.keys(slot.metadata ?? {}).length)
    const available = inventory.operators.filter(operator => !reserved.has(operator.charId) && operator.name !== '菲亚梅塔')
    const keeper = available.find(operator => operator.skills.some(skill => skill.roomType === 'DORMITORY')) ?? available[0]
    if (!slot || !keeper) return false
    slot.occupant = { kind: 'operator', operatorId: keeper.charId }
    reserved.add(keeper.charId)
    const present = workspace.compatibility.importedPresentRooms
    if (present && !present.includes(dorm.roomId)) present.push(dorm.roomId)
  }
  return true
}
