import type { OperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { evaluateOperators } from '../engine/operatorRules'
import type { RosterWorkspace } from '../workbench/model'
import { projectRosterConfig } from './rosterProjection'
import { projectControlOutput } from './controlImpact'
import { productionRoomId } from './productionSingletons'
import { applyCombinationVariant, shiftSnapshot, type CombinationPool, type CombinationValue, type CombinationVariant } from './combinationModel'
import { enumerateCombinationVariants } from './combinationEnumeration'
import { compareVariantPreference } from './automaticCombinationPreferences'

/** Facility base 100% and staffing 1% are excluded from the skill-efficiency comparison. */
export function evaluateCombinationVariant(base: RosterWorkspace, inventory: OperatorInventory, variant: CombinationVariant, baselineDailyScore?: number): CombinationValue {
  const result: CombinationValue = { variant, status: 'infeasible', perCapita: null, totalGain: null, productionCount: 0, supportCount: 0, diagnostics: [] }
  const placed = applyCombinationVariant(base, variant)
  if (!placed) { result.diagnostics.push('组合有占位或人员冲突'); return result }
  const snapshot = shiftSnapshot(placed, variant.placements.some(p => p.role === 'backup') ? 'backup' : 'main')
  const config = projectRosterConfig(snapshot)
  config.operatorRecords = inventoryOperatorRecords(inventory)
  const targetIds = new Set(variant.placements.filter(p => ['manufacture', 'trading'].includes(snapshot.mainPlan.facilities[p.roomId].type)).map(p => productionRoomId(p.roomId)))
  const targets = config.rooms.filter(r => targetIds.has(r.id))
  result.productionCount = targets.reduce((n, r) => n + r.operatorIds.length, 0)
  result.supportCount = variant.placements.filter(p => !['manufacture', 'trading'].includes(snapshot.mainPlan.facilities[p.roomId].type)).length
  if (!result.productionCount) { result.diagnostics.push('组合未入驻生产设施'); return result }
  let bonus = 0
  for (const room of targets) {
    const value = evaluateOperators(room, config)
    result.diagnostics.push(...value.unquantifiedSkills)
    bonus += value.efficiencyPercent - 100 - value.staffBonus
  }
  const projected = projectControlOutput(config)
  if (result.diagnostics.length || !projected.complete || !Number.isFinite(bonus)) {
    result.status = 'unquantified'
    result.diagnostics.push(...projected.diagnostics)
    return result
  }
  result.status = 'evaluated'
  result.perCapita = bonus / result.productionCount
  if (baselineDailyScore === undefined) {
    const original = projectRosterConfig(base)
    original.operatorRecords = inventoryOperatorRecords(inventory)
    const reference = projectControlOutput(original)
    if (reference.complete) baselineDailyScore = reference.daily.score
  }
  result.totalGain = baselineDailyScore === undefined ? null : projected.daily.score - baselineDailyScore
  return result
}

export function buildCombinationPool(base: RosterWorkspace, inventory: OperatorInventory): CombinationPool {
  const variants = enumerateCombinationVariants(base, inventory)
  const config = projectRosterConfig(base)
  config.operatorRecords = inventoryOperatorRecords(inventory)
  const projection = projectControlOutput(config)
  const values = variants.map(v => evaluateCombinationVariant(base, inventory, v, projection.complete ? projection.daily.score : undefined))
  values.sort((a, b) => (a.status === 'evaluated' ? 0 : 1) - (b.status === 'evaluated' ? 0 : 1) ||
    compareVariantPreference(b.variant, a.variant) ||
    (b.perCapita ?? -Infinity) - (a.perCapita ?? -Infinity) || (b.totalGain ?? -Infinity) - (a.totalGain ?? -Infinity) ||
    a.supportCount - b.supportCount || a.variant.id.localeCompare(b.variant.id))
  return { values, enumeratedCount: variants.length, diagnostics: [...new Set(values.filter(v => v.status !== 'evaluated').flatMap(v => v.diagnostics))] }
}
