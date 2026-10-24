// Port of _group_shift_predecessors, Mower alpha ae9fc322 (MIT).
// Started arrangements own their groups, named positions and actual occupants.
import {alphaPosition} from './mowerAlphaDorm'
import {mowerRetainedRecoveryMayReturn} from './mowerRetainedRecovery'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {mowerArrangementGroupTransitions} from './mowerSharedGroups'
import type {MowerTask,MowerTaskPlan} from './mowerTaskQueue'

export interface MowerGroupPredecessorOptions {
 protectedNames?:ReadonlySet<string>
 suppressFacilityArrangement?:(plan:MowerTaskPlan)=>void
}
type Footprint={groups:Set<string>;slots:Set<string>;names:Set<string>}
const explicit=(name:string)=>!['Current','Free',''].includes(name)
function footprint(data:MowerSchedulingData,input:MowerTaskPlan,shifts:Record<string,boolean>,options:MowerGroupPredecessorOptions):Footprint {
 const plan=structuredClone(input),original=mowerArrangementGroupTransitions(data,plan)
 options.suppressFacilityArrangement?.(plan)
 const remaining=mowerArrangementGroupTransitions(data,plan)
 const groups=new Set(Object.keys(shifts).filter(group=>!(group in original)||group in remaining)),slots=new Set<string>(),names=new Set<string>()
 if(!Object.keys(plan).length)return {groups:new Set(),slots,names}
 for(const [room,row] of Object.entries(plan))row.forEach((name,index)=>{
  if(name!=='Current')slots.add(alphaPosition(room,index))
  if(explicit(name))names.add(name)
 })
 for(const op of Object.values(data.operators))if(op.multiGroup&&!options.protectedNames?.has(op.name)&&op.groupBindings.some(binding=>groups.has(binding.group))){names.add(op.name);slots.add(alphaPosition(op.room,op.index))}
 for(const slot of slots){const separator=slot.lastIndexOf('\0'),op=data.currentOperator(slot.slice(0,separator),Number(slot.slice(separator+1)));if(op)names.add(op.name)}
 return {groups,slots,names}
}
const intersects=(left:Set<string>,right:Set<string>)=>[...left].some(value=>right.has(value))

/** Returns real task identities; their completion/removal, rather than clock time, releases admission. */
export function mowerGroupShiftPredecessors(data:MowerSchedulingData,task:MowerTask,plan:MowerTaskPlan,transitions:Record<string,boolean>,pending:readonly MowerTask[],options:MowerGroupPredecessorOptions={}):MowerTask[] {
 const desired=footprint(data,plan,transitions,options),predecessors:MowerTask[]=[]
 for(const previous of pending){
  const expected=previous.groupShiftExpected??{}
  if(previous===task||!Object.keys(expected).length)continue
  const arrangement=structuredClone(previous.plan)
  for(const [slot,name] of Object.entries(expected)){
   const separator=slot.lastIndexOf('\0'),room=slot.slice(0,separator),index=Number(slot.slice(separator+1))
   if(!Number.isInteger(index)||index<0)continue
   const row=arrangement[room]??=Array(Math.max(data.plan[room]?.length??0,index+1)).fill('Current')
   while(row.length<=index)row.push('Current')
   row[index]=name
  }
  const owned=footprint(data,arrangement,previous.groupShiftTransitions,options)
  const releasedGroups=Object.entries(transitions).flatMap(([group,resting])=>!resting&&mowerRetainedRecoveryMayReturn(data,previous,group)?[group]:[])
  for(const group of releasedGroups){
   owned.groups.delete(group)
   for(const name of data.shiftGroupMembers(group)){
    owned.names.delete(name)
    const op=data.operators[name];if(!op)continue
    owned.slots.delete(alphaPosition(op.room,op.index));owned.slots.delete(alphaPosition(op.currentRoom,op.currentIndex))
   }
  }
  if(intersects(desired.groups,owned.groups)||intersects(desired.slots,owned.slots)||intersects(desired.names,owned.names))predecessors.push(previous)
 }
 return predecessors
}

export class MowerGroupPredecessorBlocked extends Error {
 override name='MowerGroupPredecessorBlocked'
 constructor(readonly predecessors:readonly MowerTask[]){super('前序换班尚未完成实测确认，保留原任务等待前序完成')}
}
