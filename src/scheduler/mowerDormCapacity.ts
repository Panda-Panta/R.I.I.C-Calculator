// Operators.dorm_capacity_allows, Mower alpha 94a49b4c (MIT).
import {alphaPosition,alphaRestingTier,mowerMatchReplacements} from './mowerAlphaDorm'
import {mowerArrangementGroupTransitions} from './mowerSharedGroups'
import {MowerDormState,type MowerSchedulingData} from './mowerSchedulingData'
import type {MowerTaskPlan} from './mowerTaskQueue'

/** Grouped Free contributes recovery quota, independent of its physical position. */
export function mowerDormCapacityAllows(data:MowerSchedulingData,name:string,position:readonly [string,number],plan:MowerTaskPlan={},activeGroups:ReadonlySet<string>=new Set(),groupTransitions:Readonly<Record<string,boolean>>={}):boolean {
 if(!data.alpha)return true
 if(alphaRestingTier(data,name)>3)return true
 if(!Object.entries(data.plan).some(([room,row])=>room.startsWith('dorm')&&row.some(owner=>owner!=='Free'&&(data.operators[owner]?.replacement.includes('Free')||data.operators[owner]?.groupBindings.some(binding=>binding.replacement.includes('Free'))))))return true
 const transitions={...data.pendingGroupTransitions,...groupTransitions,...mowerArrangementGroupTransitions(data,plan),...Object.fromEntries([...activeGroups].map(group=>[group,true]))}
 const active=new Set(Object.keys(transitions).filter(group=>transitions[group])),inactive=new Set(Object.keys(transitions).filter(group=>!transitions[group]))
 const moving=new Set([...Object.values(plan).flat().filter(member=>!['','Current','Free'].includes(member)),name])
 const beds=new Map(data.dorms.map(bed=>[alphaPosition(...bed.position),bed]))
 const capacities:(Set<string>|undefined)[]=[],residents=new Set<string>()
 for(const [room,row] of Object.entries(data.plan)){
  if(!room.startsWith('dorm'))continue
  row.forEach((ownerName,index)=>{
   const actual=data.currentOperator(room,index),bed=beds.get(alphaPosition(room,index))??new MowerDormState([room,index],actual?.name??'',undefined,true)
   if(!data.effectiveFreeSlot(bed,inactive,active))return
   const owner=data.operators[ownerName],groups=owner?.multiGroup?owner.groupBindings.map(binding=>binding.group):[owner?.group??'']
   capacities.push(ownerName==='Free'?undefined:new Set(groups.filter(group=>owner?.replacementsForGroup(group).includes('Free')&&!inactive.has(group)&&(active.has(group)||data.groupIsResting(group)))))
   let resident=plan[room]?.[index]??'Current'
   if(resident==='Current'){resident=actual?.name??'';if(moving.has(resident))resident=''}
   if(alphaPosition(room,index)===alphaPosition(...position))resident=name
   if(data.operators[resident]&&resident!==ownerName&&alphaRestingTier(data,resident)<=3)residents.add(resident)
  })
 }
 residents.add(name)
 const choices=Object.fromEntries([...residents].sort().map(resident=>{
  const op=data.operators[resident],groups=op?.multiGroup?op.groupBindings.map(binding=>binding.group):[op?.group??'']
  const allowed=capacities.flatMap((capacity,index)=>capacity===undefined||op?.isHigh()&&!op.room.startsWith('dorm')&&groups.some(group=>capacity.has(group))?[index]:[])
  return [resident,allowed.map(String)]
 }))
 return mowerMatchReplacements(choices,false,capacities.flatMap((capacity,index)=>capacity===undefined?[]:[String(index)]))!==undefined
}
