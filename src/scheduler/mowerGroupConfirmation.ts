// Mower alpha ae9fc322, base_schedule.py group_shift_expected (MIT).
// Explicit execution targets outlive completed rooms; only observations confirm a shift.
import {alphaPosition,alphaRestingTier} from './mowerAlphaDorm'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {commitMowerGroupShifts,mowerArrangementGroupTransitions,mowerRestingBindingGroups,mowerSharedReplacements} from './mowerSharedGroups'
import type {MowerTaskPlan} from './mowerTaskQueue'

export type MowerGroupExpectedTargets=Record<string,string>
export interface MowerGroupConfirmationTask {
 plan:MowerTaskPlan
 groupShiftTransitions:Record<string,boolean>
 groupShiftExpected?:MowerGroupExpectedTargets
 simpleDormFill?:boolean
 trainingSkippedSlots?:readonly number[]
}
export interface MowerGroupConfirmationOptions {
 /** The existing mastery/facility adapter may suppress only its protected positions. */
 suppressFacilityArrangement?:(plan:MowerTaskPlan)=>void
}
const explicit=(name:string)=>!['Current','Free',''].includes(name)
function position(key:string):[string,number]{const separator=key.lastIndexOf('\0');return [key.slice(0,separator),Number(key.slice(separator+1))]}
function expectedPlan(data:MowerSchedulingData,targets:MowerGroupExpectedTargets):MowerTaskPlan {
 const plan:MowerTaskPlan={}
 for(const [key,name] of Object.entries(targets)){
  const [room,index]=position(key),slots=data.plan[room]
  if(!slots||!Number.isInteger(index)||index<0||index>=slots.length)continue
  ;(plan[room]??=Array(slots.length).fill('Current'))[index]=name
 }
 return plan
}
function targetsIn(plan:MowerTaskPlan):MowerGroupExpectedTargets {
 return Object.fromEntries(Object.entries(plan).flatMap(([room,row])=>row.flatMap((name,index)=>explicit(name)?[[alphaPosition(room,index),name]]:[])))
}
/** A fixed dorm post remains fixed even when its resident reaches a personal cap. */
function dynamicPosition(data:MowerSchedulingData,room:string,index:number,name:string,transitions:Record<string,boolean>):boolean {
 if(!room.startsWith('dorm'))return false
 const primary=data.plan[room]?.[index]
 if(primary==='Free')return true
 if(!data.alpha)return data.dynamicDormPosition(room,index,name)
 const owner=data.operators[primary??'']
 if(!owner?.group||!owner.room.startsWith('dorm')||owner.nativeName==='菲亚梅塔'||name===primary||name==='Current')return false
 const replacements=owner.multiGroup?mowerSharedReplacements(owner,mowerRestingBindingGroups(data,owner,transitions)):owner.replacement
 return replacements.includes('Free')
}
function cancelRecoveryTargets(data:MowerSchedulingData,task:MowerGroupConfirmationTask,plan:MowerTaskPlan,transitions:Record<string,boolean>):void {
 const expected=task.groupShiftExpected??={}
 for(const [room,row] of Object.entries(plan)){
  if(!room.startsWith('dorm'))continue
  row.forEach((name,index)=>{
   if(!explicit(name)||task.simpleDormFill&&data.currentOperator(room,index)?.name===name||!dynamicPosition(data,room,index,name,transitions))return
   if(alphaRestingTier(data,name)!==7&&!data.restMoodComplete(name))return
   const key=alphaPosition(room,index)
   if(expected[key]===name){
    delete expected[key]
    if(task.plan[room]?.[index]===name)task.plan[room]![index]='Free'
   }
   row[index]='Free'
  })
 }
}
function suppress(task:MowerGroupConfirmationTask,plan:MowerTaskPlan,options:MowerGroupConfirmationOptions):void {
 for(const index of task.trainingSkippedSlots??[])if(index<(plan.train?.length??0))plan.train![index]='Current'
 options.suppressFacilityArrangement?.(plan)
}

/** Synchronize legal cancellation before capacity/selection checks, without recreating completed rooms. */
export function prepareMowerGroupExecutionTargets(data:MowerSchedulingData,task:MowerGroupConfirmationTask,options:MowerGroupConfirmationOptions={}):void {
 const plan=expectedPlan(data,task.groupShiftExpected??{}),original=mowerArrangementGroupTransitions(data,plan)
 const transitions={...task.groupShiftTransitions,...mowerArrangementGroupTransitions(data,task.plan)}
 cancelRecoveryTargets(data,task,plan,transitions)
 suppress(task,task.plan,options);suppress(task,plan,options)
 const remaining=mowerArrangementGroupTransitions(data,plan)
 for(const group of Object.keys(original))if(!(group in remaining))delete task.groupShiftTransitions[group]
 for(const [group,resting] of Object.entries(remaining))if(resting!==original[group])task.groupShiftTransitions[group]=resting
 task.groupShiftExpected=targetsIn(plan)
}

/** Called after the full arrangement has been normalized and accepted for physical execution. */
export function rememberMowerGroupTargets(data:MowerSchedulingData,task:MowerGroupConfirmationTask,options:MowerGroupConfirmationOptions={}):void {
 if(Object.keys(task.groupShiftTransitions).length){
  const expected=task.groupShiftExpected??={}
  for(const [room,row] of Object.entries(task.plan))row.forEach((name,index)=>{
   if(name==='Current')return
   const key=alphaPosition(room,index);delete expected[key]
   if(explicit(name)){
    for(const [other,occupant] of Object.entries(expected))if(occupant===name)delete expected[other]
    expected[key]=name
   }
  })
 }
 prepareMowerGroupExecutionTargets(data,task,options)
}

/** Final dorm compaction may move a surviving target; temporary single-recovery lists must not call this. */
export function relocateMowerGroupTargets(task:MowerGroupConfirmationTask,room:string,agents:readonly string[]):void {
 const expected=task.groupShiftExpected??={},relocated:MowerGroupExpectedTargets={}
 for(const [key,name] of Object.entries(expected)){
  if(position(key)[0]!==room)continue
  const index=agents.indexOf(name)
  if(index<0)continue
  delete expected[key];relocated[alphaPosition(room,index)]=name
 }
 Object.assign(expected,relocated)
}

/** Restore final targets after incidental padding/recovery reordering; train is selected one slot at a time. */
export function enforceMowerGroupTargets(data:MowerSchedulingData,task:MowerGroupConfirmationTask,room:string,agents:string[],options:MowerGroupConfirmationOptions={}):boolean {
 if(room==='train')return false
 const requiredPlan=expectedPlan(data,task.groupShiftExpected??{})
 suppress(task,requiredPlan,options)
 const required=requiredPlan[room]?.flatMap((name,index)=>explicit(name)?[[index,name] as const]:[])??[]
 if(!required.length)return false
 const assignments=new Map(required),names=new Set(required.map(([,name])=>name))
 const conflicts=required.some(([index,name])=>agents[index]!==name&&!(agents[index]==='Current'&&data.currentOperator(room,index)?.name===name))
 const duplicate=agents.some((name,index)=>names.has(name)&&assignments.get(index)!==name)
 if(!conflicts&&!duplicate)return false
 const row=task.plan[room]??=[...agents]
 for(const target of [agents,row]){
  target.forEach((name,index)=>{if(names.has(name)&&assignments.get(index)!==name)target[index]='Free'})
  for(const [index,name] of required){while(target.length<=index)target.push('Current');target[index]=name}
 }
 return true
}

/** Actual personal-cap departure also cancels the same dynamic target in other retained tasks. */
export function cancelMowerReleasedGroupTargets(data:MowerSchedulingData,tasks:readonly MowerGroupConfirmationTask[],name:string):void {
 for(const task of tasks){
  const selected=Object.fromEntries(Object.entries(task.groupShiftExpected??{}).filter(([,target])=>target===name))
  if(!Object.keys(selected).length)continue
  const plan=expectedPlan(data,selected),pending=Object.keys(selected).filter(key=>{const [room,index]=position(key);return task.plan[room]?.[index]===name})
  cancelRecoveryTargets(data,task,plan,{...task.groupShiftTransitions,...mowerArrangementGroupTransitions(data,task.plan)})
  const changedRooms=new Set<string>()
  for(const key of pending)if(!(key in (task.groupShiftExpected??{}))){const [room,index]=position(key);task.plan[room]![index]='Current';changedRooms.add(room)}
  for(const room of changedRooms)if(task.plan[room]!.every(target=>target==='Current'))delete task.plan[room]
 }
}

export interface MowerGroupConfirmationResult {
 complete:boolean
 missing:MowerTaskPlan
 differences:{room:string;index:number;expected:string;actual:string}[]
}
/** Failure retains only missing work and leaves task time/group state untouched. */
export function completeMowerGroupConfirmation(data:MowerSchedulingData,task:MowerGroupConfirmationTask):MowerGroupConfirmationResult {
 const missing:MowerTaskPlan={},differences:MowerGroupConfirmationResult['differences']=[]
 for(const [key,name] of Object.entries(task.groupShiftExpected??{})){
  const [room,index]=position(key),actual=data.currentOperator(room,index)?.name??''
  if(actual===name)continue
  ;(missing[room]??=Array(data.plan[room]?.length??index+1).fill('Current'))[index]=name
  differences.push({room,index,expected:name,actual})
 }
 if(differences.length){task.plan=missing;return {complete:false,missing,differences}}
 commitMowerGroupShifts(data,task.groupShiftTransitions)
 task.groupShiftExpected={}
 return {complete:true,missing,differences}
}
