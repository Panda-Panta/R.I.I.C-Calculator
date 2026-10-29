// Ordinary replacement checks from ArkMowers/arknights-mower alpha ae9fc322 (MIT).
// Device reads are supplied by the caller; elapsed time and predictions are not new observations.
import {isTradeRunOrderOperator} from '../domain/shiftRunPolicy'
import {mowerDormTaskReservations} from './mowerAlphaCandidates'
import {alphaPosition} from './mowerAlphaDorm'
import {mowerRecoveryMoodComplete} from './mowerGroupRecovery'
import {MowerOperatorState} from './mowerOperatorState'
import {mowerReplacementReservations} from './mowerReplacementCoordination'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {mowerRestingBindingGroups,mowerSharedReplacements,mowerSameGroupPrimaryReplacement} from './mowerSharedGroups'
import {MowerTask,MOWER_TASK_TYPES as T,fromMowerMicros,toMowerMicros,roundMowerMicros,type MowerTaskQueue} from './mowerTaskQueue'

export interface MowerReplacementCheckTarget {room:string;index:number;owner:string;cover:string}
type Observation=[room:string,index:number,mood:number|null,timeMicros:number|null,rate:number|null]
export interface MowerReplacementCheckSnapshot {
 target:MowerReplacementCheckTarget
 environment:string
 observations:Record<string,Observation>
 reservations:[names:string[],slots:string[]]
 roomObservations:Record<string,unknown>
 revision:number
}
export interface MowerReplacementCheckState {
 target:MowerReplacementCheckTarget
 revision:number
 /** New checks have no prior working deadline; omitted values preserve old task deadlines. */
 deadlineMicros?:number|null
 /** Environmental changes require a newer real sample before cache reuse. */
 readAfterMicros?:number
 source?:MowerReplacementCheckSnapshot
 failure?:{reason:string;dependency:boolean;snapshot:MowerReplacementCheckSnapshot}
}
export interface MowerReplacementCheckObservation {agent?:string;mood?:number;observed?:boolean;endMicros?:number}
export interface MowerReplacementCheckOptions {
 currentTask?:MowerTask
 initialMoodReadPending?:boolean
 emergencyFrozen?:boolean
 protectedNames?:ReadonlySet<string>
 productByRoom?:Readonly<Record<string,unknown>>
 roomObservations?:Readonly<Record<string,unknown>>
 refreshDrainedNames?:readonly string[]
 /** When cache reuse is unsafe, force a real target read. A void result uses its updated observation. */
 readRoom?:(room:string,index:number)=>MowerReplacementCheckObservation|void
 /** Ideal simulation may supply the actual working rate for the next deadline. */
 effectiveDepletionRate?:(name:string)=>number|undefined
}
const finiteMood=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=24
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const key=(target:MowerReplacementCheckTarget)=>JSON.stringify([target.room,target.index,target.owner,target.cover])
const trade=(data:MowerSchedulingData,name:string)=>isTradeRunOrderOperator(data.operators[name]?.nativeName??name)
function ordinaryReplacements(data:MowerSchedulingData,owner:MowerOperatorState):string[]{
 const candidates=owner.multiGroup?mowerSharedReplacements(owner,mowerRestingBindingGroups(data,owner)):owner.replacement
 return candidates.filter(name=>name!=='Free'&&!trade(data,name))
}
function applies(data:MowerSchedulingData,target:MowerReplacementCheckTarget):boolean {
 const owner=data.operators[target.owner],cover=data.operators[target.cover]
 if(target.room.startsWith('dorm')||target.room==='train'||target.index<0||data.plan[target.room]?.[target.index]!==target.owner||!owner?.isHigh()||!cover||cover.isHigh()||cover.workaholic||cover.currentRoom!==target.room||cover.currentIndex!==target.index)return false
 const candidates=ordinaryReplacements(data,owner)
 return candidates.includes(target.cover)&&new Set(candidates).size>1
}
function reservations(data:MowerSchedulingData,queue:MowerTaskQueue,task:MowerTask,options:MowerReplacementCheckOptions){
 const tasks=queue.tasks.filter(other=>other!==task)
 if(options.currentTask&&options.currentTask!==task&&!tasks.includes(options.currentTask))tasks.push(options.currentTask)
 const dorm=mowerDormTaskReservations(data,tasks),retained=mowerReplacementReservations(data,tasks)
 for(const name of retained.reservedNames)dorm.names.add(name)
 for(const position of retained.reservedSlots)dorm.slots.add(position)
 // Failed concrete tasks retain their intended work positions as well as dorm admissions.
 for(const pending of tasks)if(pending.retainsExecution)for(const [room,row] of Object.entries(pending.plan))row.forEach((name,index)=>{if(name!=='Current')dorm.slots.add(alphaPosition(room,index))})
 for(const name of options.protectedNames??[])dorm.names.add(name)
 return dorm
}
export function mowerReplacementCheckSnapshot(data:MowerSchedulingData,queue:MowerTaskQueue,task:MowerTask,options:MowerReplacementCheckOptions={}):MowerReplacementCheckSnapshot {
 const check=task.replacementCheck!,target=check.target,owner=data.operators[target.owner]
 const candidates=owner?ordinaryReplacements(data,owner):[],names=new Set([...candidates,target.owner,target.cover])
 const rooms=new Set([target.room]),positions=new Set([alphaPosition(target.room,target.index)]),observations:Record<string,Observation>={}
 for(const name of [...names].sort()){
  const op=data.operators[name];if(!op)continue
  if(op.currentRoom)rooms.add(op.currentRoom)
  positions.add(alphaPosition(op.currentRoom,op.currentIndex))
  const previous=check.source?.observations[name]
  const sample:Observation=op.moodIsPrediction||op.timeStampMicros===undefined||!finiteMood(op.mood)
   ?[op.currentRoom,op.currentIndex,previous?.[2]??null,previous?.[3]??null,previous?.[4]??null]
   :[op.currentRoom,op.currentIndex,op.mood,op.timeStampMicros,Number.isFinite(op.depletionRate)?op.depletionRate:null]
  observations[name]=sample
 }
 const reserved=reservations(data,queue,task,options)
 return structuredClone({target,environment:JSON.stringify({
  slots:data.plan[target.room],candidates,
  limits:[...names].sort().flatMap(name=>{const op=data.operators[name];return op?[[name,op.lowerLimit,op.upperLimit,op.restInFull,op.workaholic,data.excludedCandidates.has(name)]]:[]}),
  occupants:Object.values(data.operators).filter(op=>op.currentRoom===target.room).map(op=>[op.currentIndex,op.name]).sort((a,b)=>Number(a[0])-Number(b[0])||String(a[1]).localeCompare(String(b[1]))),
  product:options.productByRoom?.[target.room]??null,
  refreshDrained:(options.refreshDrainedNames??[]).flatMap(name=>{const op=data.operators[name];return op?[[name,op.currentRoom,op.currentIndex]]:[]}).sort(),
 }),observations,reservations:[[...names].filter(name=>reserved.names.has(name)).sort(),[...positions].filter(position=>reserved.slots.has(position)).sort()],
 roomObservations:Object.fromEntries([...rooms].sort().map(room=>[room,options.roomObservations?.[room]??null])),revision:check.revision})
}
/** Preserve original task identity/deadline until relevant measured facts change. */
export function syncMowerReplacementChecks(data:MowerSchedulingData,queue:MowerTaskQueue,options:MowerReplacementCheckOptions={}):void {
 if(!data.alpha||options.initialMoodReadPending)return
 // Discovery does not move operators. Match currentOperator's first actor at a
 // coordinate, rather than currentRoom's deliberately last-write room view.
 const occupants=new Map<string,Map<number,MowerOperatorState>>()
 for(const op of Object.values(data.operators)){
  const room=op.currentRoom,index=op.currentIndex
  let row=occupants.get(room);if(!row){row=new Map();occupants.set(room,row)}
  if(!row.has(index))row.set(index,op)
 }
 const concrete=new Set(queue.tasks.filter(task=>!task.replacementCheck&&(task===options.currentTask||task.timeMicros<=data.nowMicros)).flatMap(task=>Object.entries(task.plan).flatMap(([room,row])=>row.flatMap((name,index)=>name!=='Current'&&name!==occupants.get(room)?.get(index)?.name?[alphaPosition(room,index)]:[]))))
 const targets=new Map<string,MowerReplacementCheckTarget>()
 if(!options.emergencyFrozen)for(const [room,row] of Object.entries(data.plan))row.forEach((owner,index)=>{
  const cover=occupants.get(room)?.get(index)?.name;if(!cover)return
  const target={room,index,owner,cover};if(applies(data,target))targets.set(key(target),target)
 })
 const existing=new Set<string>(),remove=new Set<MowerTask>()
 for(const task of queue.tasks){
  const check=task.replacementCheck;if(!check)continue
  const id=key(check.target)
  if(!targets.has(id)||existing.has(id)||concrete.has(alphaPosition(check.target.room,check.target.index))&&!task.retainsExecution){remove.add(task);continue}
  existing.add(id)
  const previous=check.source,snapshot=mowerReplacementCheckSnapshot(data,queue,task,options),cover=data.operators[check.target.cover]!
  if(previous&&(previous.environment!==snapshot.environment||previous.revision!==snapshot.revision&&check.readAfterMicros===undefined))check.readAfterMicros=data.nowMicros
  const observation=snapshot.observations[cover.name]!,prior=previous?.observations[cover.name]
  const rateChanged=observation[4]!==null&&observation[4]>0&&observation[4]!==prior?.[4]
  if(previous&&!task.retainsExecution&&(previous.environment!==snapshot.environment||!equal(prior,observation)&&!cover.moodIsPrediction&&cover.timeStampMicros!==undefined&&finiteMood(cover.mood)&&(cover.mood<=cover.lowerLimit||rateChanged)||previous.revision!==snapshot.revision))task.timeMicros=Math.min(task.timeMicros,data.nowMicros)
  check.source=snapshot
  if(check.failure&&!equal(check.failure.snapshot,snapshot)){
   delete check.failure;delete task.executionFailure;task.executionRetained=true
  }
 }
 queue.tasks=queue.tasks.filter(task=>!remove.has(task))
 for(const [id,target] of targets){
  if(existing.has(id)||concrete.has(alphaPosition(target.room,target.index)))continue
  const task=new MowerTask({time:fromMowerMicros(data.nowMicros),metadata:`替班心情检查：${data.operators[target.cover]!.nativeName}`})
  task.replacementCheck={target,revision:0,deadlineMicros:null}
  task.replacementCheck.source=mowerReplacementCheckSnapshot(data,queue,task,options)
  queue.tasks.push(task)
 }
}
export function invalidateMowerReplacementChecks(data:MowerSchedulingData,queue:MowerTaskQueue):void {
 for(const task of queue.tasks)if(task.replacementCheck){task.replacementCheck.readAfterMicros=data.nowMicros;task.replacementCheck.revision++;if(!task.retainsExecution)task.timeMicros=Math.min(task.timeMicros,data.nowMicros)}
}
export function cloneMowerReplacementCheck(task:MowerTask):MowerReplacementCheckState|undefined {
 return task.replacementCheck?structuredClone(task.replacementCheck):undefined
}
function retain(data:MowerSchedulingData,queue:MowerTaskQueue,task:MowerTask,reason:string,options:MowerReplacementCheckOptions,dependency=false):false {
 const check=task.replacementCheck!,snapshot=mowerReplacementCheckSnapshot(data,queue,task,options)
 check.source=snapshot;check.failure={reason,dependency,snapshot:structuredClone(snapshot)}
 task.executionFailure={reason,rooms:[check.target.room],snapshot:{intent:JSON.stringify(snapshot),observations:{}}}
 return false
}
function readValues(snapshot:MowerReplacementCheckSnapshot,room:string):MowerReplacementCheckSnapshot {
 const values=structuredClone(snapshot)
 for(const observation of Object.values(values.observations))if(observation[0]===room)observation[3]=null
 delete values.roomObservations[room]
 return values
}
// Native replacement_check._cached_work_mood, alpha 94a49b4 (MIT).
function cachedWorkMood(cover:MowerOperatorState,task:MowerTask,nowMicros:number):number|undefined {
 const sampledAt=cover.timeStampMicros,check=task.replacementCheck!
 const deadline=check.deadlineMicros===undefined?task.timeMicros:check.deadlineMicros
 if(sampledAt===undefined||!(sampledAt<=nowMicros)||cover.moodIsPrediction||!finiteMood(cover.mood)||cover.needToRefresh(nowMicros,2,cover.currentRoom)
  ||check.readAfterMicros!==undefined&&sampledAt<=check.readAfterMicros||deadline!==null&&sampledAt<deadline&&deadline<=nowMicros)return undefined
 const rate=cover.depletionRate,mood=cover.mood-(Number.isFinite(rate)&&rate>0?rate*fromMowerMicros(nowMicros-sampledAt):0)
 return mood>cover.lowerLimit?mood:undefined
}
/** Safe recent evidence may set a deadline; correction at its lower limit still requires a real read. */
export function runMowerReplacementCheck(data:MowerSchedulingData,queue:MowerTaskQueue,task:MowerTask,options:MowerReplacementCheckOptions={}):boolean {
 const check=task.replacementCheck;if(!check||!applies(data,check.target))return true
 const {target}=check,room=target.room
 const cached=cachedWorkMood(data.operators[target.cover]!,task,data.nowMicros)
 let observed:MowerReplacementCheckObservation|void=cached===undefined?undefined:{agent:target.cover,mood:cached}
 if(cached===undefined){
  const peers=queue.tasks.flatMap(peer=>peer!==task&&peer.replacementCheck?.failure?[{peer,failure:peer.replacementCheck.failure,before:mowerReplacementCheckSnapshot(data,queue,peer,options)}]:[])
  const preservePeers=()=>{
   for(const {peer,failure,before} of peers){
    if(peer.replacementCheck?.failure!==failure||!equal(failure.snapshot,before))continue
    const after=mowerReplacementCheckSnapshot(data,queue,peer,options)
    if(equal(readValues(before,room),readValues(after,room))){failure.snapshot=after;if(peer.executionFailure)peer.executionFailure.snapshot.intent=JSON.stringify(after)}
   }
  }
  try{observed=options.readRoom?.(room,target.index)}catch(error){
   preservePeers()
   return retain(data,queue,task,`替班心情检查未取得有效读数：${error instanceof Error?error.message:String(error)}`,options)
  }
  preservePeers()
  const actual=data.currentOperator(room,target.index)
  if(!observed)observed=actual?{agent:actual.name,mood:actual.mood,observed:!actual.moodIsPrediction&&actual.timeStampMicros===data.nowMicros}:{observed:false}
 }
 if(!observed||observed.observed===false||!finiteMood(observed.mood))return retain(data,queue,task,'替班心情检查未取得有效读数',options)
 if(observed.agent!==target.cover)return typeof observed.agent==='string'?true:retain(data,queue,task,'替班心情检查未确认原岗位驻员',options)
 if(!applies(data,target))return true
 delete check.readAfterMicros
 const cover=data.operators[target.cover]!,mood=observed.mood
 if(mood>cover.lowerLimit){
  const supplied=options.effectiveDepletionRate?.(cover.name),rate=supplied??cover.depletionRate,end=observed.endMicros
  let deadline:number
  if(Number.isFinite(rate)&&rate>0)deadline=data.nowMicros+toMowerMicros((mood-cover.lowerLimit)/rate)
  else if(room!=='recycle'&&end!==undefined&&Number.isSafeInteger(end)&&end>data.nowMicros)deadline=data.nowMicros+roundMowerMicros((end-data.nowMicros)*(mood-cover.lowerLimit)/mood)
  else return retain(data,queue,task,'替班心情仍高于下限，等待有效心情消耗观测',options,true)
  if(task.retainsExecution){
   const successor=new MowerTask({time:fromMowerMicros(deadline),metadata:task.metadata})
   successor.replacementCheck={target:structuredClone(target),revision:check.revision,deadlineMicros:deadline}
   successor.replacementCheck.source=mowerReplacementCheckSnapshot(data,queue,successor,options)
   queue.tasks.push(successor);return true
  }
  task.timeMicros=deadline;check.deadlineMicros=deadline;check.source=mowerReplacementCheckSnapshot(data,queue,task,options);return false
 }
 const reserved=reservations(data,queue,task,options)
 if(reserved.names.has(target.cover)||reserved.slots.has(alphaPosition(room,target.index)))return retain(data,queue,task,'替班岗位仍由其他任务预约',options)
 const owner=data.operators[target.owner]!,candidates=ordinaryReplacements(data,owner)
 const current=data.currentRoom(room,true)
 if(!current||target.index>=current.length)return retain(data,queue,task,'替班心情检查未确认房间驻员',options)
 current.forEach((name,index)=>{if(index!==target.index&&!['','Current','Free'].includes(name))reserved.names.add(name)})
 const ranked=data.replacementCandidates(new MowerOperatorState({...owner,replacement:candidates}))
 const replacement=ranked.find(name=>{
  const candidate=data.operators[name]
  return !!candidate&&name!==target.cover&&!reserved.names.has(name)&&!trade(data,name)&&!data.excludedCandidates.has(name)
   &&(!candidate.isHigh()||mowerSameGroupPrimaryReplacement(data,owner,name))&&(!candidate.currentRoom||candidate.isResting())
   &&candidate.timeStampMicros!==undefined&&finiteMood(candidate.mood)
   &&(!candidate.restInFull||!candidate.isResting()||mowerRecoveryMoodComplete(data,candidate))
   &&!data.dormReplacementForSlot(name,candidate.currentRoom,candidate.currentIndex)&&!data.busyRestingNames.has(name)&&!data.replacementExhausted(name,owner)
 })
 if(!replacement)return retain(data,queue,task,'替班达到个人心情下限，尚无可用候补',options)
 const row=Array<string>(data.plan[room]!.length).fill('Current');row[target.index]=replacement
 queue.tasks.push(new MowerTask({time:fromMowerMicros(data.nowMicros),type:T.SELF_CORRECTION,plan:{[room]:row}}))
 return true
}
