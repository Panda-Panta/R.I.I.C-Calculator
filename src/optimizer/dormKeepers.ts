import type { OperatorInventory } from '../domain/operatorInventory'
import { hasDormKeeper } from '../workbench/facilityState'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import { facilityCapacity } from '../domain/facilities'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { isAoeDormKeeper, isSingleDormKeeper } from '../scheduler/smartDormitoryPolicy'

/**
 * Mark unbound, fixed recovery providers on the generator's private copy before
 * smart dormitory cleanup. Explicit residency, dynamic beds and shift bindings
 * keep their existing semantics; only actual unlocked group/single recovery counts.
 */
export function preserveExistingDormKeepers(workspace: RosterWorkspace, inventory: OperatorInventory, lockedPositions?: ReadonlySet<string>): void {
  if (!inventory.valid) return
  const records = inventoryOperatorRecords(inventory)
  const working = new Set(Object.values(workspace.mainPlan.facilities)
    .filter(room => room.level > 0 && room.type !== 'dormitory')
    .flatMap(room => room.slots.slice(0, facilityCapacity(room.type, room.level)).flatMap(slot => [
      ...(slot.occupant.kind === 'operator' ? [resolveOperatorCharId(slot.occupant.operatorId)] : []),
      ...slot.replacements.map(resolveOperatorCharId),
      ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements.map(resolveOperatorCharId)),
    ])))
  for (const dorm of Object.values(workspace.mainPlan.facilities)) {
    if (dorm.type !== 'dormitory' || dorm.level <= 0) continue
    for (const [index, slot] of dorm.slots.slice(0, facilityCapacity(dorm.type, dorm.level)).entries()) {
      if (lockedPositions?.has(`${dorm.roomId}:${index}`) || slot.occupant.kind !== 'operator' || slot.dormitoryResident !== undefined ||
        slot.groupId?.trim() || slot.groupBindings?.length || slot.replacements.length) continue
      const operatorId = resolveOperatorCharId(slot.occupant.operatorId), operator = records[operatorId]
      if (!operator || working.has(operatorId)) continue
      if (isAoeDormKeeper(operator) || isSingleDormKeeper(operator)) slot.dormitoryResident = true
    }
  }
}

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
