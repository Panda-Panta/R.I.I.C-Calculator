import {prepareMowerCorrectionRecovery,refreshMowerDerivedCorrection} from './mowerCorrection'
import {reconcileMowerRetainedRecovery} from './mowerRetainedRecovery'
// Port of base_schedule task failure snapshots, Mower alpha 3ad69f15 (MIT).
import {mowerReplacementDependencyNames,mowerReplacementReservations} from './mowerReplacementCoordination'
import {MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import type {RuntimeState} from './rosterRuntime'
import type {MowerSchedulingData} from './mowerSchedulingData'
import type {MowerTask,MowerTaskQueue} from './mowerTaskQueue'
import {mowerArrangementGroupTransitions,mowerRestingBindingGroups,mowerSharedReplacements} from './mowerSharedGroups'

export interface MowerTaskFailureSnapshot {
 intent:string
 observations:Record<string,[string,number,number|null]>
}

function snapshot(state:RuntimeState,data:MowerSchedulingData,task:MowerTask,rooms:readonly string[]):MowerTaskFailureSnapshot {
 rooms=[...new Set([...rooms,...Object.keys(task.groupShiftExpected??{}).map(key=>key.slice(0,key.lastIndexOf('\0')))])]
 const names=new Set([...Object.values(task.plan).flat(),...Object.values(task.groupShiftExpected??{})])
 if(task.type===T.EXHAUST_OFF||task.coordinationRequestNames.length){
  mowerReplacementDependencyNames(data,task.coordinationRequestNames.length?task.coordinationRequestNames:task.metadata.split(',')).forEach(name=>names.add(name))
  // Native coordination failures depend on the entire connected handoff and its beds.
  rooms=[...new Set([...rooms,...Object.keys(data.plan).filter(room=>room.startsWith('dorm')),...[...names].flatMap(name=>{
   const op=data.operators[name];return op?[op.room,...(op.currentRoom?[op.currentRoom]:[])]:[]
  })])]
 }
 const reservations=mowerReplacementReservations(data,state.mowerSource?.queue.tasks.filter(other=>other!==task)??[])
 const transitions={...mowerArrangementGroupTransitions(data,task.plan),...task.groupShiftTransitions}
 // A rejected normalization leaves implicit shared rooms out of task.plan.
 // Track only those followers and the covers required by their resting bindings.
 const shared=Object.values(data.operators).filter(op=>data.alpha&&op.multiGroup&&(op.index<(task.plan[op.room]?.length??0)||op.groupBindings.some(binding=>binding.group in transitions))).map(op=>{
  const groups=mowerRestingBindingGroups(data,op,transitions),replacements=groups.length?mowerSharedReplacements(op,groups):[]
  names.add(op.name);replacements.forEach(name=>names.add(name))
  return [op.name,op.room,op.index,groups,replacements]
 })
 const correctionGroups=task.derivedCorrection&&task.type===T.SELF_CORRECTION?new Set(Object.entries(task.plan).flatMap(([room,row])=>row.flatMap((name,index)=>name==='Current'?[]:[name,data.plan[room]?.[index]]).flatMap(name=>{const op=name?data.operators[name]:undefined;return op?[op.group,...op.groupBindings.map(binding=>binding.group)]:[]})).filter(Boolean)):new Set<string>()
 return {
  intent:JSON.stringify({plan:task.plan,metadata:task.metadata,expected:task.groupShiftExpected??{},
   correctionGroups:[...correctionGroups].sort().map(group=>[group,data.groupIsResting(group)]),
   effectivePlan:Object.fromEntries(rooms.map(room=>[room,state.config.mowerSourcePlan?.[room]])),
   // Local plan rows store names; native Plan slot vars also retain live replacement order.
   livePlan:Object.fromEntries(rooms.map(room=>[room,(data.plan[room]??[]).map(agent=>{
    const op=data.operators[agent];return {agent,group:op?.group??'',replacement:op?.replacement??[],groupBindings:op?.groupBindings??[]}
   })])),
   products:Object.fromEntries(rooms.map(room=>[room,state.mowerFacilityProducts?.[room]??null])),
   shared,
   eligibility:[...names].sort().map(name=>[name,data.busyRestingNames.has(name),data.excludedCandidates.has(name),reservations.reservedNames.has(name)]),
   reservedSlots:[...reservations.reservedSlots].filter(slot=>rooms.includes(slot.split('\0')[0]!)).sort(),
  }),
  observations:Object.fromEntries(Object.values(data.operators).filter(op=>names.has(op.name)||rooms.includes(op.currentRoom)).map(op=>
   [op.name,[op.currentRoom,op.currentIndex,op.moodIsPrediction?null:op.timeStampMicros??null]])),
 }
}

/** Retain remaining work and its deadline; only the dispatch view is suspended. */
export function retainMowerFailedTask(state:RuntimeState,data:MowerSchedulingData,task:MowerTask,reason:string,rooms=Object.keys(task.plan)):void {
 task.executionFailure={reason,rooms:[...rooms],snapshot:snapshot(state,data,task,rooms)}
}

/** Clock/prediction changes cannot admit an exhausted failure. */
export function resumeMowerFailedTasks(state:RuntimeState,data:MowerSchedulingData,queue:MowerTaskQueue):boolean {
 let changed=false
 for(const task of queue.tasks){
  // Replacement checks use their own scoped observation and reservation snapshots.
  if(task.replacementCheck)continue
  const failure=task.executionFailure
  if(!failure)continue
  if((failure.reason.startsWith('组员尚未确认回满心情')||failure.reason.startsWith('需要回满的主班心情尚未满足要求'))&&prepareMowerCorrectionRecovery(data,task,queue.tasks)){
   delete task.executionFailure;task.coordinationDependencyWait=false;task.executionRetained=false;changed=true
   continue
  }
  reconcileMowerRetainedRecovery(data,task)
  // A prediction replacing a measurement does not constitute new evidence.
  for(const [name,observation] of Object.entries(failure.snapshot.observations))if(data.operators[name]?.moodIsPrediction)observation[2]=null
  if(JSON.stringify(snapshot(state,data,task,failure.rooms))===JSON.stringify(failure.snapshot))continue
  refreshMowerDerivedCorrection(data,task,queue.tasks)
  delete task.executionFailure;task.coordinationDependencyWait=false;task.executionRetained=true;changed=true
 }
 return changed
}
