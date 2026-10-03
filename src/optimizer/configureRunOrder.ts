import { inventoryOperatorRecords, runOrderSkillRank, hasOperatorSkill } from '../domain/operatorContext'
import { EDITION } from '../domain/edition'
import type { OperatorInventory } from '../domain/operatorInventory'
import { isTradeRunOrderOperator } from '../domain/shiftRunPolicy'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import type { RosterWorkspace } from '../workbench/model'
import { compileMainPlanToAppConfig } from '../workbench/adapter'
import { createDefaultConfig } from '../domain/defaults'
import { evaluateOperators } from '../engine/operatorRules'
import { mowerRoomToOutputRoomId } from '../workbench/model'
import { calculateRunOrderGains } from './runOrderGains'

export function runOrderInventoryDiagnostics(workspace: RosterWorkspace, inventory: OperatorInventory) {
  if (!EDITION.allowShiftRun) return []
  const rooms = Object.values(workspace.mainPlan.facilities).filter(r => r.type === 'trading' && r.product === 'money')
  const context = { operatorRecords: inventoryOperatorRecords(inventory) }
  return rooms.filter(room=>!inventory.operators.some(o=>
    runOrderSkillRank(context,o.charId,'proviso')>0||room.level===3&&runOrderSkillRank(context,o.charId,'tequila')>0||
    hasOperatorSkill(context,o.charId,'trade_ord_closure[000]')||hasOperatorSkill(context,o.charId,'trade_ord_pepe[000]')))
    .map(room => ({ code: 'RUN_ORDER_OPERATOR_UNAVAILABLE', message: room.roomId+'：没有已解锁的跑单候补，保留普通订单。' }))
}

/** Dedicated ideal candidates lead the replacement lists; ordinary backup order is preserved. */
export function configureRunOrder(workspace: RosterWorkspace, inventory: OperatorInventory): boolean {
  if (!EDITION.allowShiftRun) return true
  const context = { operatorRecords: inventoryOperatorRecords(inventory) }
  const config=compileMainPlanToAppConfig(workspace.mainPlan,workspace,createDefaultConfig())
  config.operatorRecords=context.operatorRecords
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.type !== 'trading' || room.product !== 'money' || room.level===0) continue
    const target=config.rooms.find(r=>r.id===mowerRoomToOutputRoomId(room.roomId))!
    const evaluation=evaluateOperators(target,config)
    const ranks={proviso:runOrderSkillRank(context,id('但书'),'proviso'),tequila:runOrderSkillRank(context,id('龙舌兰'),'tequila')}
    const owned=new Set(inventory.operators.map(o=>o.charId))
    const availableSlots=room.slots.filter(s=>s.occupant.kind==='operator')
    let candidates=calculateRunOrderGains(room.level,evaluation.quality,Math.max(.01,evaluation.efficiencyPercent/100),workspace.productionWeights).filter(c=>
      c.allowed&&c.names.length<=availableSlots.length&&c.names.every(name=>owned.has(id(name)))&&
      (!c.names.includes('但书')||c.capture.proviso===ranks.proviso)&&
      (!c.names.includes('龙舌兰')||c.capture.tequila===ranks.tequila)&&
      (!c.names.includes('可露希尔')||c.capture.closure&&hasOperatorSkill(context,id('可露希尔'),'trade_ord_closure[000]'))&&
      (!c.names.includes('佩佩')||c.capture.pepe&&hasOperatorSkill(context,id('佩佩'),'trade_ord_pepe[000]')))
    // Availability, not relative profit, is the hard guard against choosing Pepe.
    if(candidates.some(c=>!c.names.includes('佩佩')))candidates=candidates.filter(c=>!c.names.includes('佩佩'))
    candidates.sort((a,b)=>(b.gainPercent??b.delta)-(a.gainPercent??a.delta))
    const best=candidates.find(c=>c.delta>1e-8)
    const runners=best?.names??[]
    // Reapplying after roster changes preserves the ordinary backup order.
    for (const slot of room.slots) slot.replacements = slot.replacements.filter(x => !isTradeRunOrderOperator(x))
    const available = availableSlots
    for (const [index, name] of runners.slice(0, available.length).entries()) {
      const slot = available[index]!
      if (slot.occupant.kind !== 'operator') return false
      slot.replacements.unshift(id(name))
    }
  }
  return true
}
