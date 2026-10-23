import {describe,expect,it} from 'vitest'
import nativeOracle from './fixtures/mower-dynamic-priority-84e3926.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {alphaRestingTier,alphaSlotTakable,alphaFindDormSlot,alphaPrioritizeRecovery,alphaFullDynamicCandidate,alphaFullDormFiller,alphaBedTakeoverAllowed} from './mowerAlphaDorm'
import {mowerAlphaDormCandidates,planMowerAlphaDormFill} from './mowerAlphaCandidates'
import {mowerAssignDormGroup} from './mowerDormAssignment'
import {MowerTaskQueue,toMowerMicros} from './mowerTaskQueue'
import {planMowerMetadata} from './mowerMetadata'

// Mower 84e3926 #1600: fully recovered dynamic residents release recovery
// priority; fixed dorm posts and explicitly retained residents keep protection.
function fixture(){
 const operators={
  Resident:new MowerOperatorState({name:'Resident',room:'room_1_1',index:0,operatorType:'high',restingPriority:'high',currentRoom:'dormitory_1',currentIndex:0,mood:24,timeStampMicros:0}),
  Requester:new MowerOperatorState({name:'Requester',mood:23,timeStampMicros:0}),
  Owner:new MowerOperatorState({name:'Owner',replacement:['Requester']}),
 }
 return new MowerSchedulingData({alpha:true,operators,nowMicros:toMowerMicros(.5),plan:{room_1_1:['Resident'],dormitory_1:['Free']},dorms:[new MowerDormState(['dormitory_1',0],'Resident')],restingPriorityNames:['Resident']})
}

describe('latest dynamic recovery priority',()=>{
 it('reassigns recovery priorities after a dorm configuration change while ordinary mood changes preserve actual beds',()=>{
  const data=fixture();data.restingPriorityNames=['Requester'];data.operators.Requester!.mood=2
  Object.assign(data.operators.Requester!,{currentRoom:'dormitory_1',currentIndex:1})
  data.operators.Resident!.mood=10;data.operators.Resident!.restingPriority='low'
  data.plan.dormitory_1=['Free','Free'];data.dorms.push(new MowerDormState(['dormitory_1',1],'Requester'))
  const before=JSON.stringify(data)
  expect(alphaPrioritizeRecovery(data,{})).toEqual({})
  expect(alphaPrioritizeRecovery(data,{}, {},new Set(),new Set(),true)).toEqual({dormitory_1:['Requester','Resident']})
  expect(alphaPrioritizeRecovery(data,{}, {},new Set(['dormitory_1\0'+'0']),new Set(),true)).toEqual({})
  expect(JSON.stringify(data)).toBe(before)
 })
 it.each([false,true])('retains a listed resident independently of idle clearing and still releases at its personal cap (freeRoom=%s)',freeRoom=>{
  const data=fixture();data.freeRoom=freeRoom;data.freeRoomExclusions=['Resident'];data.restingPriorityNames=['Requester']
  Object.assign(data.operators.Resident!,{operatorType:'low',room:'',mood:10})
  data.operators.Requester!.mood=2
  expect(data.freeRoomExcluded('Resident')).toBe(true)
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
  expect(planMowerAlphaDormFill(data,new MowerTaskQueue())).toBeUndefined()
  Object.assign(data.operators.Resident!,{restMoodLimit:true,upperLimit:20,mood:20})
  const queue=new MowerTaskQueue();planMowerMetadata(data,queue)
  expect(data.freeRoomExcluded('Resident')).toBe(false)
  expect(queue.tasks.filter(task=>task.strictMoodLimit).map(task=>[task.metadata,task.timeMicros])).toEqual([['Resident',data.nowMicros]])
 })
 it('demotes a recovered dynamic primary at its personal cap before configured priority',()=>{
  const data=fixture();data.operators.Resident!.upperLimit=20;data.operators.Resident!.mood=20
  expect(alphaRestingTier(data,'Resident')).toBe(6)
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(true)
 })
 it.each(['fixed','retained'] as const)('keeps a recovered %s dorm resident protected',kind=>{
  const data=fixture()
  if(kind==='fixed')data.operators.Resident!.room='dormitory_1'
  else data.freeRoomExclusions=['Resident']
  expect(alphaRestingTier(data,'Resident')).toBe(0)
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
 })
 it('requires a real saved full reading before bypassing the ordinary eighty-percent gate',()=>{
  const data=fixture();data.restingPriorityNames=[]
  data.operators.Resident!.moodIsPrediction=true
  data.dormMoodEstimates.set('Resident',[24,toMowerMicros(.25)])
  expect(alphaRestingTier(data,'Resident')).toBe(6)
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
 })
 it('never displaces a resident for a requester already at its personal cap',()=>{
  const data=fixture();data.operators.Requester!.mood=24
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
 })
 it('applies standby tier to any configured worker and ignores the retired low-priority promotion',()=>{
  const data=fixture();data.operators.Requester!.mood=0;data.standbyNames=['Requester','Resident']
  expect(alphaRestingTier(data,'Requester')).toBe(4)
  data.operators.Resident!.mood=1;data.operators.Resident!.restingPriority='standby';data.operators.Resident!.standbyLowPriority=true;data.restingPriorityNames=[]
  expect(alphaRestingTier(data,'Resident')).toBe(4)
 })
 it('uses an empty bed first, then a recovered filler before unfinished recovery',()=>{
  const data=fixture();data.restingPriorityNames=['Requester'];data.operators.Requester!.mood=2
  data.operators.Other=new MowerOperatorState({name:'Other',mood:10,timeStampMicros:0,currentRoom:'dormitory_1',currentIndex:1})
  data.plan.dormitory_1=['Free','Free','Free']
  data.dorms=[new MowerDormState(['dormitory_1',1],'Other'),new MowerDormState(['dormitory_1',0],'Resident'),new MowerDormState(['dormitory_1',2])]
  expect(alphaFindDormSlot(data,'Requester',new Set())).toBe(2)
  expect(alphaFindDormSlot(data,'Requester',new Set([2]))).toBe(1)
 })
 it('reserves the only bed for a required member before a low-mood optional standby',()=>{
  const data=fixture();data.operators.Resident!.currentRoom='room_1_1';data.operators.Resident!.mood=10;data.operators.Resident!.group='G'
  data.dorms[0]!.reset();data.restingPriorityNames=[]
  data.operators.Standby=new MowerOperatorState({name:'Standby',room:'room_1_2',group:'G',operatorType:'high',restingPriority:'standby',standbyLowPriority:true,mood:0,timeStampMicros:0,currentRoom:'room_1_2',currentIndex:0})
  data.plan.room_1_2=['Standby'];data.standbyNames=['Standby']
  expect(mowerAssignDormGroup(data,['Standby','Resident'])?.map(bed=>bed.name)).toEqual(['Resident'])
 })
 it('can observe a limited ordinary candidate from a partial card without inventing a measured value',()=>{
  const data=fixture();data.operators.Requester!.timeStampMicros=undefined;data.operators.Requester!.restMoodLimit=true
  data.dormMoodEstimates.set('Requester',[2,toMowerMicros(.25)])
  expect(mowerAlphaDormCandidates(data).estimatedRecovering).toEqual(['Requester'])
  expect(data.operators.Requester!.timeStampMicros).toBeUndefined()
 })
 it('fills a recovered dynamic bed with an ordinary card candidate but does not use it to evict unfinished recovery',()=>{
  const data=fixture();data.operators.Requester!.timeStampMicros=undefined
  data.dormMoodEstimates.set('Requester',[23,toMowerMicros(.25)])
  expect(planMowerAlphaDormFill(data,new MowerTaskQueue())?.plan.dormitory_1).toEqual(['Requester'])
  data.restingPriorityNames=[];data.operators.Resident!.operatorType='low';data.operators.Resident!.room='';data.operators.Resident!.mood=10
  data.dormMoodEstimates.set('Requester',[2,toMowerMicros(.25)])
  expect(planMowerAlphaDormFill(data,new MowerTaskQueue())).toBeUndefined()
 })
})

interface NativeObservation {
 room?:string;index?:number;current_room?:string;current_index?:number;mood?:number
 operator_type?:'high'|'low';resting_priority?:'high'|'low'|'standby';workaholic?:boolean
 upper_limit?:number;lower_limit?:number;depletion_rate?:number;mood_is_prediction?:boolean
 standby_low_priority?:boolean;resting_from_train?:boolean;timestampHours?:number|null
}
interface NativeCase {
 name:string;requester:NativeObservation;resident:NativeObservation
 priority?:string[];standby?:string[];blacklist?:string[];excluded?:string[];referenced?:string[]
 priorityReplacement?:string[];estimates?:Record<string,[number,number]>
 expected:{tier:Record<string,number>;fullDynamic:Record<string,boolean>;fullFiller:Record<string,boolean>;takeover:boolean}
}
describe('Mower 84e3926 unmodified native priority AST oracle',()=>{
 for(const sample of nativeOracle.cases as NativeCase[])it(sample.name,()=>{
  const operators=Object.fromEntries((['requester','resident'] as const).map(name=>{
   const raw=sample[name]
   return [name,new MowerOperatorState({name,room:raw.room,index:raw.index,currentRoom:raw.current_room,currentIndex:raw.current_index,mood:raw.mood??10,operatorType:raw.operator_type??'low',restingPriority:raw.resting_priority,workaholic:raw.workaholic,upperLimit:raw.upper_limit,lowerLimit:raw.lower_limit,depletionRate:raw.depletion_rate,moodIsPrediction:raw.mood_is_prediction,standbyLowPriority:raw.standby_low_priority,restingFromTrain:raw.resting_from_train,timeStampMicros:raw.timestampHours===null?undefined:toMowerMicros(10+(raw.timestampHours??0))})]
  }))
  operators.Owner=new MowerOperatorState({name:'Owner',replacement:sample.referenced??[]})
  const data=new MowerSchedulingData({alpha:true,operators,plan:{work:['Owner']},dorms:[],nowMicros:toMowerMicros(10),restingPriorityNames:sample.priority,priorityReplacement:sample.priorityReplacement,standbyNames:sample.standby,freeBlacklist:sample.blacklist,freeRoomExclusions:sample.excluded,dormMoodEstimates:new Map(Object.entries(sample.estimates??{}).map(([name,[mood,time]])=>[name,[mood,toMowerMicros(10+time)]]))})
  const before=JSON.stringify(data)
  for(const name of ['requester','resident']){
   expect(alphaRestingTier(data,name)).toBe(sample.expected.tier[name])
   expect(alphaFullDynamicCandidate(data,name)).toBe(sample.expected.fullDynamic[name])
   expect(alphaFullDormFiller(data,name)).toBe(sample.expected.fullFiller[name])
  }
  expect(alphaBedTakeoverAllowed(data,'requester','resident')).toBe(sample.expected.takeover)
  expect(JSON.stringify(data)).toBe(before)
 })
})
