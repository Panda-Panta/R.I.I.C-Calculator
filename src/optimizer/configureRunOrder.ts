import { inventoryOperatorRecords, runOrderSkillRank } from '../domain/operatorContext'
import { EDITION } from '../domain/edition'
import type { OperatorInventory } from '../domain/operatorInventory'
import { isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { isTradeRunOrderOperator } from '../domain/shiftRunPolicy'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import type { RosterWorkspace } from '../workbench/model'

export function runOrderInventoryDiagnostics(workspace: RosterWorkspace, inventory: OperatorInventory) {
  if (!EDITION.allowShiftRun) return []
  const rooms = Object.values(workspace.mainPlan.facilities).filter(r => r.type === 'trading' && r.product === 'money')
  const needed = rooms.length ? ['但书', ...(rooms.some(r => r.level === 3) ? ['龙舌兰'] : [])] : []
  const context = { operatorRecords: inventoryOperatorRecords(inventory) }
  return needed.filter(name => !inventory.operators.some(o => o.charId === id(name) && runOrderSkillRank(context, o.charId, name === '但书' ? 'proviso' : 'tequila') > 0))
    .map(name => ({ code: 'RUN_ORDER_OPERATOR_UNAVAILABLE', message: '自动跑单需要已持有且解锁跑单技能的' + name + '。' }))
}

/** Mower uses replacement[0] for a temporary swap; ordinary backups follow it. */
export function configureRunOrder(workspace: RosterWorkspace, inventory: OperatorInventory): boolean {
  if (!EDITION.allowShiftRun) return true
  const context = { operatorRecords: inventoryOperatorRecords(inventory) }
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.type !== 'trading' || room.product !== 'money') continue
    const runners = (room.level === 3 ? ['但书', '龙舌兰'] : ['但书']).filter(name =>
      inventory.operators.some(o => o.charId === id(name) && runOrderSkillRank(context, o.charId, name === '但书' ? 'proviso' : 'tequila') > 0))
    // Reapplying after roster changes preserves the ordinary backup order.
    for (const slot of room.slots) slot.replacements = slot.replacements.filter(x => !isShiftRunOperator(x))
    const available = room.slots.filter(slot => !slot.replacements.some(isTradeRunOrderOperator))
    for (const [index, name] of runners.slice(0, available.length).entries()) {
      const slot = available[index]!
      if (slot.occupant.kind !== 'operator') return false
      slot.replacements.unshift(id(name))
    }
  }
  return true
}
