import {OPERATOR_MAP} from '../domain/operators'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {isShiftRunOperator} from '../scheduler/scheduleAdapter'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import type {RosterWorkspace} from '../workbench/model'
import {validatePhysicalRoster} from './rosterDraft'
import {rankStaffingCandidates} from './staffingQuality'
import {applySingletonWorkPolicy,productionTeamTheory} from './productionSingletons'

export interface ProductionMainNeighbor {
 label:string;workspace:RosterWorkspace
 move:{kind:'production-main';positions:string[]}
}
const canonical=(value:string)=>resolveId(value.trim())
const name=(value:string)=>OPERATOR_MAP.get(canonical(value))?.name??value
const special=(value:string)=>isShiftRunOperator(canonical(value))||name(value)==='菲亚梅塔'
const roomTypes={manufacture:'MANUFACTURE',trading:'TRADING',power:'POWER'} as const
/** Canonicalize a validation copy only; imported source names remain untouched. */
function physical(workspace:RosterWorkspace):boolean {
 const copy=structuredClone(workspace)
 for(const room of Object.values(copy.mainPlan.facilities))for(const slot of room.slots){
  if(slot.occupant.kind==='operator')slot.occupant.operatorId=canonical(slot.occupant.operatorId)
  slot.replacements=slot.replacements.map(canonical)
 }
 return validatePhysicalRoster(copy).length===0
}

/** Single occupied production-seat moves, not full combination replacement or an income claim. */
export function generateProductionMainNeighbors(workspace:RosterWorkspace,entries:OwnedOperatorInput[],limit=20,protectedIds:string[]=[],lockedPositions:readonly string[]=[]):ProductionMainNeighbor[] {
 if(!Number.isSafeInteger(limit)||limit<0||limit>21)throw new Error('邻域预算须为 0–21 的整数')
 if(!Array.isArray(protectedIds)||protectedIds.some(id=>typeof id!=='string'))throw new Error('受保护干员须为代号或 ID 数组')
 const inventory=compileOperatorInventory(entries)
 if(!inventory.valid)throw new Error('无效的干员库')
 if(limit===0||!physical(workspace))return []
 const locked=new Set(lockedPositions.map(key=>key.replace(/:(\d+)$/,'_$1')))
 const reserved=new Set<string>(),protectedSet=new Set<string>()
 const protect=(value:unknown):void=>{
  if(typeof value==='string'){
   for(const token of [value,...value.split(/[,，;；\s"'()[\]{}:=<>!&|]+/)]){
    const id=canonical(token)
    if(OPERATOR_MAP.has(id)){reserved.add(id);protectedSet.add(id)}
   }
  }else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){protect(key);protect(child)}
 }
 protect(protectedIds);protect(workspace.mainPlan.conf);protect(workspace.compatibility)
 const rooms=Object.values(workspace.mainPlan.facilities)
 for(const room of rooms)for(const slot of room.slots){
  if(slot.occupant.kind==='operator')reserved.add(canonical(slot.occupant.operatorId))
  slot.replacements.forEach(id=>reserved.add(canonical(id)))
  protect(slot.metadata)
  if(slot.occupant.kind==='operator'&&name(slot.occupant.operatorId)==='菲亚梅塔')protect(slot.replacements)
 }
 const unused=inventory.operators.filter(o=>!reserved.has(o.charId)&&!special(o.charId))
 const positions=rooms.flatMap(room=>{
  if(room.type!=='manufacture'&&room.type!=='trading'&&room.type!=='power')return []
  const roomType=roomTypes[room.type]
  return room.slots.flatMap((slot,index)=>{
   if(locked.has(`${room.roomId}_${index}`))return []
   if(slot.occupant.kind!=='operator'||special(slot.occupant.operatorId)||protectedSet.has(canonical(slot.occupant.operatorId)))return []
   if(slot.metadata&&Object.keys(slot.metadata).length)return []
   if(slot.groupId&&!slot.groupId.includes('散件')&&rooms.some(r=>r.slots.some(s=>s!==slot&&s.groupId===slot.groupId)))return []
   if(slot.replacements.some(id=>name(id)==='菲亚梅塔'||protectedSet.has(canonical(id))))return []
   // A member placed solely for a named/passive link must not be replaced by this neighborhood.
   if(!OPERATOR_MAP.get(canonical(slot.occupant.operatorId))?.skills.some(s=>s.roomType===roomType))return []
   const pool=unused.filter(o=>o.skills.some(s=>s.roomType===roomType))
   const ranked=rankStaffingCandidates(workspace,inventory,{roomId:room.roomId,slotIndex:index},pool.map(o=>o.charId),'main')
   return [{roomId:room.roomId,index,pool:ranked.map(id=>pool.find(o=>o.charId===id)!)}]
  })
 })
 const results:ProductionMainNeighbor[]=[]
 // Each seat gets its next candidate before another seat consumes the budget again.
 for(let offset=0;positions.some(p=>offset<p.pool.length);offset++)for(const position of positions){
  const operator=position.pool[offset]
  if(!operator)continue
  const copy=structuredClone(workspace)
  copy.mainPlan.facilities[position.roomId].slots[position.index]!.occupant={kind:'operator',operatorId:operator.charId}
  applySingletonWorkPolicy(copy,position.roomId,position.index)
  if(copy.mainPlan.facilities[position.roomId].type!=='power'){
   const before=productionTeamTheory(workspace,inventory,position.roomId),after=productionTeamTheory(copy,inventory,position.roomId)
   if(before===undefined||after===undefined||after<=before)continue
  }
  if(!physical(copy))continue
  results.push({label:`${position.roomId} 第 ${position.index+1} 位主班 → ${operator.name}`,workspace:copy,move:{kind:'production-main',positions:[`${position.roomId}_${position.index}`]}})
  if(results.length===limit)return results
 }
 return results
}
