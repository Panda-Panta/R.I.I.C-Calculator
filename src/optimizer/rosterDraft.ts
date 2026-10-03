import { mainPlanOnly } from './mainPlanOnly'
import {OPERATOR_MAP} from '../domain/operators'
import {compileOperatorInventory,type OwnedOperatorInput,type OperatorInventory} from '../domain/operatorInventory'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {isOrdinaryReplacementCandidate} from '../scheduler/scheduleAdapter'
import {MOWER_ROOM_IDS,MOWER_OUTPUT_ROOM_IDS,type MowerFacilityType,type MowerProduct,type MowerRoomId,type RosterWorkspace} from '../workbench/model'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import {validateRosterWorkspace} from '../workbench/validate'
import {admitCombinationCandidates} from './inventoryAdmission'
import type {CandidateAvailability,CandidateRoom} from './combinationCandidates'
import {rankStaffingCandidates} from './staffingQuality'

export const CANDIDATE_FACILITY_TYPES:Record<CandidateRoom,MowerFacilityType>={MANUFACTURE:'manufacture',TRADING:'trading',POWER:'power',CONTROL:'central',DORMITORY:'dormitory',HIRE:'contact',TRAINING:'train',MEETING:'meeting'}
export interface LayoutAssignment {
 candidateId:string;roomKey:string;facility:MowerFacilityType;operatorIds:string[]
 occupancy:'exact'|'contains';product?:MowerProduct;minimumLevel:number;role:'target'|'support'
}
export interface LayoutContract {
 candidateId:string;assignments:LayoutAssignment[];temporal:boolean
 uncheckedConditions:{kind:string;text:string}[]
}
export interface DraftDiagnostic {code:string;message:string}
export interface DraftPlacement {candidateId:string;roomKey:string;roomId:MowerRoomId;operatorIds:string[]}
export interface RosterDraftResult {
 status:'blocked'|'draft';workspace:RosterWorkspace|null;placements:DraftPlacement[]
 diagnostics:DraftDiagnostic[];statesVisited:number
 uncheckedConditions:LayoutContract['uncheckedConditions']
 restResources:{freeBeds:number;minimumFreeBedsForNewGroup:number;missingReplacementIds:string[]}
}
const TEMPORAL_TEMPLATES=new Set(['trade-run-kafka-bibeak','trade-run-tequila-shamare','dorm-fiammetta-exchange'])
/** Structural fields only: never infer a product or an executable predicate from prose/IDs. */
export function compileCandidateLayout(candidate:CandidateAvailability):LayoutContract {
 let product:MowerProduct|undefined
 if(candidate.facility==='MANUFACTURE'){
  const products:Record<string,MowerProduct|undefined>={gold:'gold',exp:'exp',originium:'fragment',all:undefined}
  if(!(candidate.product in products))throw new Error(`Unsupported manufacture product: ${candidate.product}`)
  product=products[candidate.product]
 }else if(candidate.facility==='TRADING'){
  if(candidate.product!=='gold')throw new Error(`Unsupported trade product: ${candidate.product}`)
  product='money'
 }
 const assignments=[candidate.targetAssignment,...candidate.supportAssignments].map(a=>({
  candidateId:candidate.id,roomKey:a.roomKey,facility:CANDIDATE_FACILITY_TYPES[a.facility],
  operatorIds:a.operators.map(o=>o.charId),role:a.role,
  occupancy:(a.role==='target'&&['MANUFACTURE','TRADING','POWER'].includes(a.facility)?'exact':'contains') as 'exact'|'contains',
  product:a.role==='target'?product:undefined,
  minimumLevel:a.role==='target'&&product==='fragment'?3:1,
 }))
 const uncheckedConditions=['facility','roster','morale','resources','conflicts','moraleCaveats'].flatMap(kind=>
  (candidate.constraints[kind as 'facility'|'roster'|'morale'|'resources'|'conflicts'|'moraleCaveats']??[]).map(text=>({kind,text:`${candidate.name}：${text}`})))
 return {candidateId:candidate.id,assignments,temporal:TEMPORAL_TEMPLATES.has(candidate.id),uncheckedConditions}
}
function capacity(type:MowerFacilityType,level:number){
 if(level===0)return 0
 if(type==='manufacture'||type==='trading')return level
 if(type==='central'||type==='dormitory')return 5
 if(type==='meeting'||type==='train')return 2
 return ['power','contact','factory'].includes(type)?1:0
}
export function validatePhysicalRoster(workspace:RosterWorkspace):DraftDiagnostic[]{
 const diagnostics:DraftDiagnostic[]=[]
 const fixed:Partial<Record<MowerRoomId,MowerFacilityType>>={central:'central',meeting:'meeting',factory:'factory',contact:'contact',train:'train'}
 for(const roomId of MOWER_ROOM_IDS){
  const room=workspace.mainPlan.facilities[roomId]
  if(!room)continue
  if(!Array.isArray(room.slots)){diagnostics.push({code:'INVALID_ROOM',message:`设施工位数据无效：${roomId}`});continue}
  if(room.roomId!==roomId)diagnostics.push({code:'ROOM_ID_MISMATCH',message:`${roomId}：设施标识与记录位置不一致`})
  const expected=fixed[roomId]??(roomId.startsWith('dormitory_')?'dormitory':roomId.startsWith('gaming_')?'gaming':undefined)
  if(expected&&room.type!==expected)diagnostics.push({code:'FIXED_ROOM_TYPE',message:`${roomId}：固定功能房类型不能改为${room.type}`})
 }
 if(Object.keys(workspace.mainPlan.facilities).some(id=>!(MOWER_ROOM_IDS as readonly string[]).includes(id)))diagnostics.push({code:'UNKNOWN_ROOM',message:'存在未定义的额外设施记录'})
 if(diagnostics.length)return diagnostics
 diagnostics.push(...validateRosterWorkspace(workspace).criticalErrors.map(d=>({code:d.code,message:d.message})))
 const counts={manufacture:0,trading:0,power:0}
 for(const id of MOWER_OUTPUT_ROOM_IDS){const room=workspace.mainPlan.facilities[id];if(!room||room.level===0)continue;const t=room.type;if(t in counts)counts[t as keyof typeof counts]++}
 if(counts.manufacture>5||counts.trading>5||counts.power>3)diagnostics.push({code:'FACILITY_COUNT',message:'实体制造/贸易/发电站最多分别为5/5/3间；虚拟设施不增加工位'})
 const assigned=new Set<string>()
 for(const room of Object.values(workspace.mainPlan.facilities)){
  if(!Number.isInteger(room.level))diagnostics.push({code:'INVALID_LEVEL',message:`${room.roomId}：设施等级须为整数`})
  if(room.level===0)continue
  if(room.type==='manufacture'){
   if(!room.product)diagnostics.push({code:'PRODUCT_REQUIRED',message:`${room.roomId}：请明确制造配方`})
   if(room.product==='fragment'&&room.level<3)diagnostics.push({code:'RECIPE_LEVEL',message:`${room.roomId}：当前源石碎片配方要求3级制造站`})
  }
  if(room.type==='trading'&&!room.product)diagnostics.push({code:'PRODUCT_REQUIRED',message:`${room.roomId}：请明确贸易策略`})
  room.slots.forEach((slot,index)=>{
   if(slot.occupant.kind==='current')diagnostics.push({code:'CURRENT_UNRESOLVED',message:`${room.roomId}：先明确Current实际干员，再生成草案`})
   if(slot.occupant.kind!=='empty'&&index>=capacity(room.type,room.level))diagnostics.push({code:'SLOT_INDEX',message:`${room.roomId}：占位超出当前等级工位范围`})
   if(slot.occupant.kind==='operator'){
    const id=resolveId(slot.occupant.operatorId)
    if(assigned.has(id))diagnostics.push({code:'DUPLICATE_OPERATOR',message:`${OPERATOR_MAP.get(id)?.name??id}：主班重复占位`})
    assigned.add(id)
   }
  })
 }
 return diagnostics
}
interface SearchState {occupants:Record<string,string[]>;exact:Record<string,string[]>;placements:DraftPlacement[]}
function sameMembers(a:string[],b:string[]){return a.length===b.length&&a.every(id=>b.includes(id))}

/** Bounded physical placement plus ordinary backup matching. It does not rank efficiency. */
export function generateRosterDraft(base:RosterWorkspace,entries:readonly OwnedOperatorInput[],candidateIds:readonly string[],options:{maxStates?:number}={}):RosterDraftResult {
 base = mainPlanOnly(base)
 const result:RosterDraftResult={status:'blocked',workspace:null,placements:[],diagnostics:[],statesVisited:0,uncheckedConditions:[],restResources:{freeBeds:0,minimumFreeBedsForNewGroup:0,missingReplacementIds:[]}}
 const maxStates=options.maxStates??2000
 if(!Number.isSafeInteger(maxStates)||maxStates<1||maxStates>100000){result.diagnostics.push({code:'INVALID_BUDGET',message:'布局搜索预算须为1–100000的整数'});return result}
 if(!candidateIds.length){result.diagnostics.push({code:'NO_SELECTION',message:'请先选择需要组合的模板'});return result}
 const inventory=compileOperatorInventory(entries)
 if(!inventory.valid){result.diagnostics.push(...inventory.diagnostics);return result}
 result.diagnostics.push(...validatePhysicalRoster(base))
 if(result.diagnostics.length)return result
 const baselineSchedule=compileRosterSchedule(base)
 result.diagnostics.push(...baselineSchedule.diagnostics.filter(d=>d.severity==='error'||d.code==='UNKNOWN_OPERATOR'))
 const admitted=new Map(admitCombinationCandidates(inventory).map(a=>[a.candidate.id,a]))
 const contracts:LayoutContract[]=[]
 for(const candidateId of new Set(candidateIds)){
  const candidate=admitted.get(candidateId)
  if(!candidate){result.diagnostics.push({code:'UNKNOWN_CANDIDATE',message:`未知组合：${candidateId}`});continue}
  if(candidate.status!=='needs-context'){result.diagnostics.push({code:'CANDIDATE_NOT_ADMITTED',message:`${candidate.candidate.name}：成员或目录技能未齐备`});continue}
  const contract=compileCandidateLayout(candidate.candidate)
  if(contract.temporal)result.diagnostics.push({code:'TEMPORAL_TEMPLATE',message:`${candidate.candidate.name}：需要明确临时换入或心情交换目标，不能自动编译为常驻主班`})
  contracts.push(contract)
 }
 result.uncheckedConditions=contracts.flatMap(c=>c.uncheckedConditions)
 if(result.diagnostics.length)return result
 const tasks=contracts.flatMap(c=>c.assignments)
 const initial:SearchState={occupants:{},exact:{},placements:[]}
 const fillable:Record<string,boolean[]>={}
 for(const room of Object.values(base.mainPlan.facilities)){
  const cap=capacity(room.type,room.level)
  initial.occupants[room.roomId]=Array.from({length:cap},(_,i)=>{const o=room.slots[i]?.occupant;return o?.kind==='operator'?resolveId(o.operatorId):''})
  fillable[room.roomId]=Array.from({length:cap},(_,i)=>{const s=room.slots[i];return !s||(s.occupant.kind==='empty'&&!s.replacements.length&&!s.groupId&&!Object.keys(s.metadata??{}).length)})
 }
 let budgetExhausted=false
 const failures=new Set<string>()
 function search(index:number,state:SearchState):SearchState|null{
  if(index===tasks.length)return state
  const task=tasks[index]!
  for(const roomId of MOWER_ROOM_IDS){
   const room=base.mainPlan.facilities[roomId]
   if(room.type!==task.facility)continue
   if(result.statesVisited>=maxStates){budgetExhausted=true;return null}
   result.statesVisited++
   if(room.level<task.minimumLevel||(task.product&&room.product!==task.product)){failures.add('设施等级或配方不匹配');continue}
   // roomKey separation is a retained template choice, not a universal game rule.
   if(state.placements.some(p=>p.candidateId===task.candidateId&&p.roomKey!==task.roomKey&&p.roomId===roomId)){failures.add('模板要求不同房间');continue}
   if(task.operatorIds.some(id=>Object.entries(state.occupants).some(([other,ids])=>other!==roomId&&ids.includes(id)))){failures.add('同一干员需要占用不同房间');continue}
   const occupants=[...state.occupants[roomId]!],members=occupants.filter(Boolean)
   const combined=[...new Set([...members,...task.operatorIds])]
   if((task.occupancy==='exact'&&!sameMembers(combined,task.operatorIds))||(state.exact[roomId]&&!sameMembers(combined,state.exact[roomId]!))){failures.add('目标编组人数或成员冲突');continue}
   const missing=task.operatorIds.filter(id=>!members.includes(id))
   const empty=occupants.flatMap((id,i)=>!id&&fillable[roomId]![i]?[i]:[])
   if(missing.length>empty.length){failures.add('工位不足或已被原班/Free保留');continue}
   missing.forEach((id,i)=>occupants[empty[i]!]=id)
   const next:SearchState={occupants:{...state.occupants,[roomId]:occupants},exact:task.occupancy==='exact'?{...state.exact,[roomId]:task.operatorIds}:state.exact,placements:[...state.placements,{candidateId:task.candidateId,roomKey:task.roomKey,roomId,operatorIds:[...task.operatorIds]}]}
   const found=search(index+1,next)
   if(found)return found
   if(budgetExhausted)return null
  }
  return null
 }
 const solved=search(0,initial)
 if(!solved){result.diagnostics.push({code:budgetExhausted?'SEARCH_BUDGET':'NO_PLACEMENT',message:budgetExhausted?'布局搜索预算用尽，未证明无解':'当前固定布局没有找到符合所选模板的摆放；'+[...failures].join('；')});return result}
 const draft=structuredClone(base)
 draft.name=base.name+' · 组合草案'
 const added:{roomId:MowerRoomId;slotIndex:number;operatorId:string}[]=[]
 for(const roomId of MOWER_ROOM_IDS){
  const room=draft.mainPlan.facilities[roomId]
  for(const [index,operatorId] of solved.occupants[roomId]!.entries()){
   if(!operatorId||initial.occupants[roomId]![index])continue
   while(room.slots.length<=index)room.slots.push({occupant:{kind:'empty'},groupId:null,replacements:[]})
   room.slots[index]!.occupant={kind:'operator',operatorId}
   added.push({roomId,slotIndex:index,operatorId})
   const present=draft.compatibility.importedPresentRooms
   if(present&&!present.includes(roomId))present.push(roomId)
  }
 }
 // New output teams shift atomically. Existing groups and occupied slots stay untouched.
 const existingGroups=new Set(Object.values(base.mainPlan.facilities).flatMap(r=>r.slots.map(s=>s.groupId).filter(Boolean)))
 for(const roomId of MOWER_OUTPUT_ROOM_IDS){
  const slots=added.filter(s=>s.roomId===roomId)
  if(slots.length<2||initial.occupants[roomId]!.some(Boolean))continue
  let group=`组合_${roomId}`;while(existingGroups.has(group))group+='_' ;existingGroups.add(group)
  for(const slot of slots)draft.mainPlan.facilities[roomId].slots[slot.slotIndex]!.groupId=group
 }
 result.restResources=assignBackups(draft,inventory,added)
 result.placements=solved.placements
 const validation=validateRosterWorkspace(draft)
 if(!validation.isValid){result.diagnostics.push(...validation.criticalErrors.map(d=>({code:d.code,message:d.message})));return result}
 const compiled=compileRosterSchedule(draft)
 const invalid=compiled.diagnostics.filter(d=>d.severity==='error'||d.code==='UNKNOWN_OPERATOR')
 if(invalid.length){result.diagnostics.push(...invalid);return result}
 if(result.restResources.missingReplacementIds.length||result.restResources.freeBeds<result.restResources.minimumFreeBedsForNewGroup)result.diagnostics.push({code:'REST_RESOURCES_INCOMPLETE',message:'新增主班存在候补或Free床位不足；仅物理可放置，须补足并模拟工休'})
 result.diagnostics.push({code:'CONDITIONAL_DRAFT',message:'这是固定布局草案；普通候补按主替混班和跨站条件筛选，静态筛选不代表长期工休已验证'})
 result.status='draft';result.workspace=draft
 return result
}

export function assignBackups(draft:RosterWorkspace,inventory:OperatorInventory,added:{roomId:MowerRoomId;slotIndex:number;operatorId:string}[],options:{excludedOperatorIds?:readonly string[]}={}):RosterDraftResult['restResources']{
 const reserved=new Set(Object.values(draft.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[...(s.occupant.kind==='operator'?[resolveId(s.occupant.operatorId)]:[]),...s.replacements.map(resolveId)])))
 const excluded=new Set((options.excludedOperatorIds??[]).map(resolveId))
 excluded.forEach(id=>reserved.add(id))
 const permanent=new Set(draft.mainPlan.conf.workaholic.map(resolveId))
 const seen=new Set<string>()
 const ordinaryPositions=added.filter(p=>{
  const room=draft.mainPlan.facilities[p.roomId],slot=room.slots[p.slotIndex],key=`${p.roomId}:${p.slotIndex}`
  if(room.type==='dormitory'||slot?.occupant.kind!=='operator'||permanent.has(resolveId(slot.occupant.operatorId))||seen.has(key))return false
  seen.add(key);return true
 })
 // Filling gaps must not discard an existing ordered list or consume a backup for a permanent worker.
 const positions=ordinaryPositions.filter(p=>{const room=draft.mainPlan.facilities[p.roomId];return !room.slots[p.slotIndex]!.replacements.some(id=>isOrdinaryReplacementCandidate(id,room.type))})
 const roomTypes=new Map(Object.entries(CANDIDATE_FACILITY_TYPES).map(([game,type])=>[type,game]))
 roomTypes.set('factory', 'WORKSHOP')
 const pools=positions.map(p=>rankStaffingCandidates(draft,inventory,p,inventory.operators.filter(o=>!reserved.has(o.charId)&&isOrdinaryReplacementCandidate(o.charId,draft.mainPlan.facilities[p.roomId].type)&&o.name!=='菲亚梅塔'&&o.skills.some(s=>s.roomType===roomTypes.get(draft.mainPlan.facilities[p.roomId].type))).map(o=>o.charId),'backup',{completingReliefTeam:true}))
 // Bipartite augmentation avoids consuming a scarce multi-facility backup greedily.
 const owner=new Map<string,number>()
 function match(index:number,seen:Set<string>):boolean{
  for(const id of pools[index]!){if(seen.has(id))continue;seen.add(id);const previous=owner.get(id);if(previous===undefined||match(previous,seen)){owner.set(id,index);return true}}
  return false
 }
 positions.forEach((_,i)=>match(i,new Set()))
 const matched=new Map([...owner].map(([id,index])=>[index,id]))
 for(const id of matched.values())reserved.add(id)
 positions.forEach((p,i)=>{
  const id=matched.get(i)
  if(id){const room=draft.mainPlan.facilities[p.roomId],slot=room.slots[p.slotIndex]!;slot.replacements=[...slot.replacements.filter(ref=>!isOrdinaryReplacementCandidate(ref,room.type)),id]}
 })
 const groupSizes=new Map<string,number>()
 for(const p of ordinaryPositions){const group=draft.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.groupId??`${p.roomId}:${p.slotIndex}`;groupSizes.set(group,(groupSizes.get(group)??0)+1)}
 // Re-evaluate the complete relief teams after matching: a candidate can suppress its new peers.
 improveBackups(draft,inventory,positions,[...excluded])
 return {freeBeds:Object.values(draft.mainPlan.facilities).filter(r=>r.type==='dormitory').reduce((n,r)=>n+r.slots.filter(s=>s.occupant.kind==='free').length,0),minimumFreeBedsForNewGroup:Math.max(0,...groupSizes.values()),missingReplacementIds:ordinaryPositions.flatMap(p=>{const room=draft.mainPlan.facilities[p.roomId];return room.slots[p.slotIndex]!.replacements.some(id=>isOrdinaryReplacementCandidate(id,room.type))?[]:[p.operatorId]})}
}

/** Coordinate improvement over actual relief teams, preserving special candidates and locked positions. */
export function improveBackups(draft:RosterWorkspace,inventory:OperatorInventory,positions:{roomId:MowerRoomId;slotIndex:number}[],excludedOperatorIds:readonly string[]=[]):void {
 const excluded=new Set(excludedOperatorIds.map(resolveId))
 const roomTypes=new Map(Object.entries(CANDIDATE_FACILITY_TYPES).map(([game,type])=>[type,game]))
 roomTypes.set('factory','WORKSHOP')
 for(let pass=0;pass<2;pass++){
  let changed=false
  for(const p of positions){
   const room=draft.mainPlan.facilities[p.roomId],slot=room.slots[p.slotIndex]!
   if(room.type==='dormitory'||slot.occupant.kind!=='operator')continue
   // Self-contained singletons without colleague synergies (manufacture, power) cannot improve from unassigned pool
   if(room.type==='manufacture'||room.type==='power')continue
   const index=slot.replacements.findIndex(id=>isOrdinaryReplacementCandidate(id,room.type))
   if(index<0)continue
   const current=resolveId(slot.replacements[index]!)
   if(excluded.has(current))continue
   const reserved=new Set(Object.values(draft.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>[...(s.occupant.kind==='operator'?[resolveId(s.occupant.operatorId)]:[]),...s.replacements.map(resolveId)])))
   const pool=inventory.operators.filter(o=>!excluded.has(o.charId)&&!reserved.has(o.charId)&&isOrdinaryReplacementCandidate(o.charId,room.type)&&o.name!=='菲亚梅塔'&&o.skills.some(s=>s.roomType===roomTypes.get(room.type)))
   const best=rankStaffingCandidates(draft,inventory,p,[current,...pool.map(o=>o.charId)],'backup')[0]
   if(best&&best!==current){slot.replacements[index]=best;changed=true}
   else if(!best&&room.type==='trading'){slot.replacements.splice(index,1);changed=true}
  }
  if(!changed)break
 }
}
