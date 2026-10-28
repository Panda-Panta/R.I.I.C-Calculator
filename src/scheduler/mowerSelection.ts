// Port of default prepare_dorm_selection, called by actual choose_agent after no-op checks.
// Default: c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88; alpha cancellation: ab0a4e5bec23f6f8d7c37b0648f05dda28f31866.
// Mower (MIT, Copyright 2021 Nano).
import type {MowerSchedulingData} from './mowerSchedulingData'
import {alphaRestingTier} from './mowerAlphaDorm'
import {mowerDormCapacityAllows} from './mowerDormCapacity'
import {mowerArrangementGroupTransitions,mowerRestingBindingGroups,mowerSharedReplacements,type MowerGroupTransitions} from './mowerSharedGroups'
import type {MowerTask} from './mowerTaskQueue'
function dynamicSelectionPosition(data:MowerSchedulingData,room:string,index:number,name:string,transitions:MowerGroupTransitions):boolean {
 const resident=data.plan[room]?.[index]
 if(!room.startsWith('dorm')||resident===undefined)return false
 if(resident==='Free')return true
 const owner=data.operators[resident]
 if(!owner?.group||!owner.room.startsWith('dorm')||owner.nativeName==='菲亚梅塔'||name===resident||name==='Current')return false
 return (owner.multiGroup?mowerSharedReplacements(owner,mowerRestingBindingGroups(data,owner,transitions)):owner.replacement).includes('Free')
}
export function mowerDormReplacementForSlot(data:MowerSchedulingData,name:string,room:string,index:number):boolean {
 const resident=data.operators[data.plan[room]?.[index]??'']
 if(data.alpha)return data.dormReplacementForSlot(name,room,index)
 return room.startsWith('dorm')&&!!resident?.group&&resident.nativeName!=='菲亚梅塔'&&resident.replacement.includes(name)
}
export function prepareMowerDormSelection(data:MowerSchedulingData,names:string[],room:string,preserve=false,moodProbe=false,task?:MowerTask):void {
 if(data.alpha&&(moodProbe||task?.type.key==='FIAMMETTA'))return
 if(data.policy.experimentalDormLogic)throw new Error('Experimental selection and recovery ordering require their source port')
 const capacityPlan={...task?.plan,[room]:names}
 const transitions={...data.pendingGroupTransitions,...task?.groupShiftTransitions,...mowerArrangementGroupTransitions(data,capacityPlan)}
 const seen=new Set<string>()
 for(const [index,name] of names.entries()){
  if(data.alpha&&task?.simpleDormFill&&data.currentOperator(room,index)?.name===name){seen.add(name);continue}
  if(!seen.has(name))seen.add(name)
  else if(!['','Free','Current'].includes(name))names[index]='Free'
  const op=data.operators[names[index]!]
  if(!room.startsWith('dorm')||!op)continue
  const dynamic=data.alpha?dynamicSelectionPosition(data,room,index,op.name,transitions):data.plan[room]?.[index]==='Free'
  const limited=!moodProbe&&data.restMoodComplete(op.name)&&dynamic
  // Alpha cancels excluded or personally capped recovery targets, not ordinary full-mood names.
  const excluded=data.alpha&&!preserve&&dynamic&&alphaRestingTier(data,op.name)===7
  const full=!data.alpha&&!preserve&&op.mood===op.upperLimit&&!op.room.startsWith('dorm')&&!mowerDormReplacementForSlot(data,op.name,room,index)
  if(limited||full||excluded){names[index]='Free';if(!data.alpha&&(limited||full))op.depletionRate=0}
 }
 // Native alpha rechecks the complete selected row after cancelling completed targets.
 if(data.alpha&&room.startsWith('dorm'))for(const [index,name] of names.entries()){
  if(['','Free','Current'].includes(name)||!dynamicSelectionPosition(data,room,index,name,transitions)||data.currentOperator(room,index)?.name===name)continue
  if(!mowerDormCapacityAllows(data,name,[room,index],capacityPlan,undefined,transitions))names[index]='Free'
 }
}

/** agent_arrange_room captures timer indexes before choose_agent mutates shared names. */
export function mowerArrangementReadIndexes(data:MowerSchedulingData,room:string,names:string[],getTime:boolean,task:import('./mowerTaskQueue').MowerTask):number[] {
 if(task.type.key==='FIAMMETTA'&&names.some(n=>data.operators[n]?.nativeName==='菲亚梅塔'))return names.flatMap((name,index)=>data.operators[name]?.nativeName==='菲亚梅塔'||name===task.metadata?[index]:[])
 if(!getTime)return []
 if(room.startsWith('dorm')&&data.freeRoom)return (data.plan[room]??[]).flatMap((name,index)=>name==='Free'||data.alpha&&data.dynamicDormPosition(room,index)?[index]:[])
 if(!data.dorms.some(b=>b.position[0]===room))return []
 return names.flatMap((name,index)=>{const op=data.operators[name];return op&&!op.room.startsWith('dorm')&&(data.freeRoom||op.isHigh())?[index]:[]})
}
