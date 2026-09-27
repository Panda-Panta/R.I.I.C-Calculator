import { inventoryOperatorRecords } from '../domain/operatorContext'
import type { OperatorInventory } from '../domain/operatorInventory'
import type { OperatorSkill } from '../domain/operators'
import type { AppConfig } from '../domain/types'
import { evaluateOperators } from '../engine/operatorRules'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { MOWER_OUTPUT_ROOM_IDS, type MowerRoomId, type RosterWorkspace } from '../workbench/model'
import { projectRosterConfig } from './rosterProjection'

/** User reference: 常用组合.md; 血猎 was explicitly corrected to 雪猎.
 * Only additive/self-dependent production skills belong here. Copying, clearing
 * colleagues' effects, automation and special-order mechanics belong to units.
 * 吉星 counts working colleagues: an additive room bonus, not a rewrite of their skills.
 * 槐琥 is deliberately excluded because she clears colleagues' morale effects.
 */
export const PRODUCTION_SINGLETONS: Record<'generalManufacture' | 'goldManufacture' | 'expManufacture' | 'trading', readonly string[]> = {
  generalManufacture: ['维伊', '雪猎', '铅踝', '淬羽赫默', '至简', '梅尔'],
  goldManufacture: ['阿罗玛', '苍苔', '砾', '引星棘刺', '斑点', '夜烟', '温米', '清流'],
  expManufacture: ['机械师', '酒神', '弑君者', '食铁兽', '断罪者', '裂响', '怒潮凛冬', 'Castle-3', '红豆', '霜叶', '白雪', '圣约送葬人'],
  trading: ['吉星', '伺夜', '空弦', '赫德雷', '深巡', '石英', '能天使', '海蒂'],
}

/** Conservative fallback: every skill in this facility must belong to a known
 * self-only family. Unknown mechanisms require a named combination instead.
 */
export function isSelfOnlyProductionFallback(skills: readonly OperatorSkill[], type: string): boolean {
  const facility = type === 'manufacture' ? 'MANUFACTURE' : type === 'trading' ? 'TRADING' : ''
  if (!facility) return false
  const relevant = skills.filter(s => s.roomType === facility)
  const family = type === 'manufacture'
    ? /^(manu_prod_spd|manu_formula_spd|manu_prod_spd_addition|manu_formula_spd&cost|manu_prod_spd&limit&cost|manu_formula_spd&limit&cost|manu_prod_limit|manu_formula_limit|manu_cost)\[\d+\]$/
    : /^(trade_ord_spd|trade_ord_spd&limit|trade_ord_spd&cost|trade_ord_limit&cost|trade_cost)\[\d+\]$/
  return relevant.length > 0 && relevant.every(s => family.test(s.buffId) && !/其他干员|全体干员|所有干员|清零|视作|复制/.test(s.description))
}

export function productionSingletonNames(workspace: RosterWorkspace, roomId: MowerRoomId): readonly string[] {
  const room = workspace.mainPlan.facilities[roomId]
  if (room.type === 'trading') return PRODUCTION_SINGLETONS.trading
  if (room.type !== 'manufacture') return []
  const powerCount = Object.values(workspace.mainPlan.facilities).filter(r => r.type === 'power').length
  return [...PRODUCTION_SINGLETONS.generalManufacture,
    ...(room.product === 'gold' ? PRODUCTION_SINGLETONS.goldManufacture : room.product === 'exp' ? PRODUCTION_SINGLETONS.expManufacture : [])]
    .filter(name => name !== '至简' || powerCount > 2)
}

export function productionRoomId(roomId: MowerRoomId): string {
  const index = MOWER_OUTPUT_ROOM_IDS.findIndex(id => id === roomId)
  if (index < 0) return roomId
  const floor = Math.floor(index / 3) + 1
  const col = (index % 3) + 1
  return `B${floor}0${col}`
}

/** Warm-up defaults to its theoretical cap. This is NOT a duty-cycle income estimate.
 * Room level, product, present supporters and actual unlocked skills still apply.
 * Excludes the universal 1% staffing bonus and room/global bonuses from a singleton's score.
 */
export function singletonTheory(config: AppConfig, roomId: MowerRoomId, operatorId: string): number | undefined {
  const room = config.rooms.find(r => r.id === productionRoomId(roomId))
  if (!room) return undefined
  const result = evaluateOperators(room, config)
  const contribution = result.operatorContributions.find(o => o.operatorId === operatorId)
  if (!contribution || result.unquantifiedSkills.some(s => s.startsWith(`${contribution.operatorName}·`))) return undefined
  return Number.isFinite(contribution.skillBonus) ? contribution.skillBonus : undefined
}

/** Compare complete teams in the same room, including effects on their colleagues. */
export function productionTeamTheory(workspace: RosterWorkspace, inventory: OperatorInventory, roomId: MowerRoomId): number | undefined {
  const config = projectRosterConfig(workspace)
  config.operatorRecords = inventoryOperatorRecords(inventory)
  const room = config.rooms.find(r => r.id === productionRoomId(roomId))
  if (!room) return undefined
  const result = evaluateOperators(room, config)
  if (result.unquantifiedSkills.length || !Number.isFinite(result.efficiencyPercent)) return undefined
  return result.efficiencyPercent - 100 - result.staffBonus
}

/** An ordinary singleton must not inherit another team's shared rest trigger. */
export function applySingletonWorkPolicy(workspace: RosterWorkspace, roomId: MowerRoomId, slotIndex: number): void {
  if (workspace.mainPlan.facilities[roomId].type !== 'manufacture') return
  const slot = workspace.mainPlan.facilities[roomId].slots[slotIndex]!
  if (slot.occupant.kind !== 'operator' || resolveId(slot.occupant.operatorId) !== resolveId('机械师')) return
  slot.groupId = null
  if (!workspace.mainPlan.conf.exhaust_require.some(id => resolveId(id) === resolveId('机械师'))) {
    workspace.mainPlan.conf.exhaust_require.push('机械师')
  }
}
