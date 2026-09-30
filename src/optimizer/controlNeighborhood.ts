import {OPERATOR_MAP} from '../domain/operators'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {isShiftRunOperator} from '../scheduler/scheduleAdapter'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import type {RosterWorkspace} from '../workbench/model'
import {validatePhysicalRoster} from './rosterDraft'
import {rankStaffingCandidates} from './staffingQuality'

export interface ControlMainNeighbor {
 label:string;workspace:RosterWorkspace
 move:{kind:'control-main';positions:string[]}
}
const canonical=(value:string)=>resolveId(value.trim())
const name=(value:string)=>OPERATOR_MAP.get(canonical(value))?.name??value
const special=(value:string)=>isShiftRunOperator(canonical(value))||name(value)==='菲亚梅塔'
/** Normalize only a validation copy; preserve untouched names and compatibility data. */
function physical(workspace:RosterWorkspace):boolean {
 const copy=structuredClone(workspace)
 for(const room of Object.values(copy.mainPlan.facilities))for(const slot of room.slots){
  if(slot.occupant.kind==='operator')slot.occupant.operatorId=canonical(slot.occupant.operatorId)
  slot.replacements=slot.replacements.map(canonical)
 }
 return validatePhysicalRoster(copy).length===0
}

/** One occupied control slot per candidate. Selection does not assert an income gain. */
export function generateControlMainNeighbors(workspace:RosterWorkspace,entries:OwnedOperatorInput[],limit=20,protectedIds:string[]=[],lockedPositions:readonly string[]=[]):ControlMainNeighbor[] {
 if(!Number.isSafeInteger(limit)||limit<0||limit>21)throw new Error('邻域预算须为 0–21 的整数')
 if(!Array.isArray(protectedIds)||protectedIds.some(id=>typeof id!=='string'))throw new Error('受保护干员须为代号或 ID 数组')
 const inventory=compileOperatorInventory(entries)
 if(!inventory.valid)throw new Error('无效的干员库')
 if(limit===0||!physical(workspace))return []
 const locked=new Set(lockedPositions.map(key=>key.replace(/:(\d+)$/,'_$1')))
 const reserved=new Set<string>(),protectedSet=new Set<string>()
 // Unknown metadata is opaque: reserve any explicit reference, including object keys.
 const protect=(value:unknown):void=>{
  if(typeof value==='string'){
   for(const token of [value,...value.split(/[,，;；\s"'()[\]{}:=<>!&|]+/)]){
    const id=canonical(token)
    if(OPERATOR_MAP.has(id)){reserved.add(id);protectedSet.add(id)}
   }
  }else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){protect(key);protect(child)}
 }
 protect(protectedIds);protect(workspace.mainPlan.conf);protect(workspace.compatibility)
 for(const room of Object.values(workspace.mainPlan.facilities))for(const slot of room.slots){
  if(slot.occupant.kind==='operator')reserved.add(canonical(slot.occupant.operatorId))
  slot.replacements.forEach(id=>reserved.add(canonical(id)))
  protect(slot.metadata)
  if(slot.occupant.kind==='operator'&&name(slot.occupant.operatorId)==='菲亚梅塔')protect(slot.replacements)
 }
 const slots=workspace.mainPlan.facilities.central.slots
 const positions=slots.flatMap((slot,index)=>{
  if(locked.has(`central_${index}`))return []
  if(slot.occupant.kind!=='operator'||special(slot.occupant.operatorId)||protectedSet.has(canonical(slot.occupant.operatorId)))return []
  if(slot.metadata&&Object.keys(slot.metadata).length)return []
  if(slot.replacements.some(id=>special(id)||protectedSet.has(canonical(id))))return []
  return [index]
 })
 const pool=inventory.operators.filter(o=>o.skills.some(s=>s.roomType==='CONTROL')&&!reserved.has(o.charId)&&!special(o.charId))
 const ranked=positions.map(index=>({index,ids:rankStaffingCandidates(workspace,inventory,{roomId:'central',slotIndex:index},pool.map(o=>o.charId),'main')}))
 const results:ControlMainNeighbor[]=[]
 for(let offset=0;offset<pool.length;offset++)for(const position of ranked){
  const id=position.ids[offset]
  if(!id)continue
  const index=position.index
  const copy=structuredClone(workspace)
  copy.mainPlan.facilities.central.slots[index]!.occupant={kind:'operator',operatorId:id}
  if(!physical(copy))continue
  results.push({label:`中枢第 ${index+1} 位主班 → ${name(id)}`,workspace:copy,move:{kind:'control-main',positions:[`central_${index}`]}})
  if(results.length===limit)return results
 }
 return results
}
