import type { OperatorInventory } from '../domain/operatorInventory'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import type { MowerRoomId, RosterWorkspace } from '../workbench/model'
import { configureRunOrder } from './configureRunOrder'
import { applySingletonWorkPolicy } from './productionSingletons'
import { validatePhysicalRoster } from './rosterDraft'
import { rankStaffingCandidates } from './staffingQuality'
import { ensureBuiltDormKeepers } from './dormKeepers'

/** Last resort: jointly match independent mains and relief staff at their actual levels.
 * No atomic bonuses, promoted skills, shared backups or unowned staff are assumed.
 */
export function buildSingletonFallback(base: RosterWorkspace, inventory: OperatorInventory, locked: Set<string>): RosterWorkspace | null {
  const ws = structuredClone(base)
  if (!ensureBuiltDormKeepers(ws, inventory, locked)) return null
  const reserved = new Set(Object.values(ws.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[
    ...(s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []), ...s.replacements.map(id),
  ])))
  if ([...reserved].some(ref=>!inventory.operators.some(o=>o.charId===ref))) return null
  const available = inventory.operators.filter(o=>!reserved.has(o.charId) && !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔')
  const positions: {roomId:MowerRoomId; slotIndex:number; backup:boolean; pool:string[]}[] = []
  const skillTypes: Record<string,string> = {manufacture:'MANUFACTURE',trading:'TRADING',power:'POWER',central:'CONTROL'}
  for (const room of Object.values(ws.mainPlan.facilities)) {
    if (room.level === 0) continue
    if (room.type === 'dormitory') {
      for (const slot of room.slots) if (slot.occupant.kind === 'empty') slot.occupant = {kind:'free'}
    }
    if (!skillTypes[room.type]) continue
    const cap = room.type === 'central' ? 5 : room.type === 'power' ? 1 : room.level
    while (room.slots.length < cap) room.slots.push({occupant:{kind:'empty'},groupId:null,replacements:[]})
    const pool = rankStaffingCandidates(ws, inventory, {roomId:room.roomId,slotIndex:0}, available.map(o=>o.charId), 'main', {allowNeutral:true})
    // Keep skilled auxiliary staff ahead of people contributing only a base staffing effect.
    if (room.type === 'power' || room.type === 'central') pool.sort((a,b)=>
      Number(available.find(o=>o.charId===b)!.skills.some(s=>s.roomType===skillTypes[room.type])) -
      Number(available.find(o=>o.charId===a)!.skills.some(s=>s.roomType===skillTypes[room.type])))
    for (let slotIndex=0;slotIndex<cap;slotIndex++) {
      const slot = room.slots[slotIndex]!
      if (locked.has(`${room.roomId}:${slotIndex}`)) continue
      if (slot.occupant.kind === 'empty') positions.push({roomId:room.roomId,slotIndex,backup:false,pool})
      const mainId = slot.occupant.kind === 'operator' ? id(slot.occupant.operatorId) : undefined
      const permanent = mainId !== undefined && ws.mainPlan.conf.workaholic.some(ref=>id(ref)===mainId)
      if (!permanent && !slot.replacements.some(ref=>isOrdinaryReplacementCandidate(ref,room.type))) positions.push({roomId:room.roomId,slotIndex,backup:true,pool:pool.filter(ref=>isOrdinaryReplacementCandidate(ref,room.type))})
    }
  }
  const owner = new Map<string,number>()
  function match(index:number, seen:Set<string>):boolean {
    for (const ref of positions[index]!.pool) {
      if (seen.has(ref)) continue
      seen.add(ref)
      const previous = owner.get(ref)
      if (previous === undefined || match(previous,seen)) {owner.set(ref,index);return true}
    }
    return false
  }
  // Solve the scarce production pools first; augmentation can relocate a flexible worker.
  const order = positions.map((_,i)=>i).sort((a,b)=>positions[a]!.pool.length-positions[b]!.pool.length)
  for (const index of order) if (!match(index,new Set())) return null
  for (const [ref,index] of owner) {
    const p = positions[index]!, slot = ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!
    if (p.backup) slot.replacements.push(ref)
    else {slot.occupant={kind:'operator',operatorId:ref};slot.groupId=null;applySingletonWorkPolicy(ws,p.roomId,p.slotIndex)}
  }
  if (!configureRunOrder(ws,inventory) || validatePhysicalRoster(ws).length) return null
  return ws
}
