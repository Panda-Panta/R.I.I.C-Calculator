import type { OperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { evaluateOperators } from '../engine/operatorRules'
import type { RosterWorkspace } from '../workbench/model'
import { shiftSnapshot } from './combinationModel'
import { projectRosterConfig } from './rosterProjection'
import { productionRoomId } from './productionSingletons'

/** Strongest complete production teams first; control/power/dorm support is not in the denominator. */
export function productionEfficiencyVector(workspace: RosterWorkspace, inventory: OperatorInventory): number[] {
  const records = inventoryOperatorRecords(inventory), main = projectRosterConfig(workspace)
  main.operatorRecords = records
  const values: number[] = []
  for (const facility of Object.values(workspace.mainPlan.facilities)) {
    if (facility.level <= 0 || !['manufacture', 'trading'].includes(facility.type)) continue
    for (const role of ['main', 'backup'] as const) {
      const config = role === 'main' ? main : projectRosterConfig(shiftSnapshot(workspace, role, facility.roomId))
      config.operatorRecords = records
      const room = config.rooms.find(r => r.id === productionRoomId(facility.roomId))
      if (!room?.operatorIds.length) continue
      const result = evaluateOperators(room, config)
      values.push(result.unquantifiedSkills.length || !Number.isFinite(result.efficiencyPercent) ? -Infinity :
        (result.efficiencyPercent - 100 - result.staffBonus) / room.operatorIds.length)
    }
  }
  return values.sort((a, b) => b - a)
}

export function compareProductionEfficiencyVectors(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? -Infinity, right = b[i] ?? -Infinity
    if (left === right || Math.abs(left - right) <= 1e-7) continue
    return left > right ? 1 : -1
  }
  return 0
}

export function compareProductionEfficiency(a: RosterWorkspace, b: RosterWorkspace, inventory: OperatorInventory): number {
  return compareProductionEfficiencyVectors(productionEfficiencyVector(a, inventory), productionEfficiencyVector(b, inventory))
}
