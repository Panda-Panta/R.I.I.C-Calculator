import {describe,expect,it} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {cloneMowerReplacementCheck,invalidateMowerReplacementChecks,runMowerReplacementCheck,syncMowerReplacementChecks} from './mowerReplacementCheck'

function fixture(room='room_1_1'){
 const operators={
  owner:new MowerOperatorState({name:'owner',operatorType:'high',room,index:0,replacement:['cover','next','last'],currentRoom:'dorm1',currentIndex:2,mood:8,timeStampMicros:0}),
  cover:new MowerOperatorState({name:'cover',currentRoom:room,currentIndex:0,mood:12,lowerLimit:4,timeStampMicros:0,depletionRate:2}),
  next:new MowerOperatorState({name:'next',mood:15,timeStampMicros:0}),
  last:new MowerOperatorState({name:'last',mood:24,timeStampMicros:0}),
 }
 const data=new MowerSchedulingData({alpha:true,plan:{[room]:['owner'],'dorm1':['Free','Free','Free']},operators,dorms:[],nowMicros:0})
 const queue=new MowerTaskQueue()
 const start=()=>{syncMowerReplacementChecks(data,queue);return queue.tasks.find(t=>t.replacementCheck)!}
 return {data,queue,operators,start}
}
describe('native ordinary cover mood checks (ae9fc322)',()=>{
 it('registers a current ordinary cover once and schedules its personal lower limit from a real read',()=>{
  const {data,queue,start}=fixture(),task=start()
  expect(task.timeMicros).toBe(0);expect(task.type).toBe(T.NOT_SPECIFIC)
  expect(runMowerReplacementCheck(data,queue,task)).toBe(false)
  expect(task.timeMicros).toBe(toMowerMicros(4));expect(queue.tasks).toEqual([task])
  data.nowMicros=toMowerMicros(1);syncMowerReplacementChecks(data,queue)
  expect(task.timeMicros).toBe(toMowerMicros(4));expect(queue.tasks).toEqual([task])
 })
 it.each(['dorm2','train'])('does not monitor %s',room=>{expect(fixture(room).start()).toBeUndefined()})
 it.each(['primary','workaholic','one ordinary','trade cover'])('does not monitor an ineligible %s',kind=>{
  const {operators,start}=fixture()
  if(kind==='primary')operators.cover.operatorType='high'
  if(kind==='workaholic')operators.cover.workaholic=true
  if(kind==='one ordinary')operators.owner.replacement=['cover','cover','Free','但书','U-Official']
  if(kind==='trade cover'){operators.cover.nativeName='但书';operators.owner.replacement=['cover','next']}
  expect(start()).toBeUndefined()
 })
 it('keeps the original deadline after a later normal sample, but invalidates a changed measured rate',()=>{
  const {data,queue,operators,start}=fixture(),task=start();runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(1);operators.cover.timeStampMicros=data.nowMicros;operators.cover.mood=11
  syncMowerReplacementChecks(data,queue);expect(task.timeMicros).toBe(toMowerMicros(4))
  operators.cover.depletionRate=3;syncMowerReplacementChecks(data,queue)
  expect(task.timeMicros).toBe(data.nowMicros)
 })
 it('replaces only the expired slot in configured order while its owner stays in recovery',()=>{
  const {data,queue,operators,start}=fixture();data.plan.room_1_1!.push('peer')
  data.operators.peer=new MowerOperatorState({name:'peer',operatorType:'high',room:'room_1_1',index:1,currentRoom:'room_1_1',currentIndex:1})
  const task=start();operators.cover.mood=4
  expect(runMowerReplacementCheck(data,queue,task)).toBe(true)
  expect(queue.tasks.find(t=>t.type===T.SELF_CORRECTION)?.plan).toEqual({room_1_1:['next','Current']})
  expect(operators.owner.currentRoom).toBe('dorm1');expect(operators.cover.currentRoom).toBe('room_1_1')
 })
 it('retains the original task and deadline without timer or available cover, and never polls',()=>{
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.depletionRate=0
  expect(runMowerReplacementCheck(data,queue,task)).toBe(false)
  const failure=task.executionFailure;expect(failure).toBeDefined()
  data.nowMicros=toMowerMicros(8);syncMowerReplacementChecks(data,queue)
  expect(task.timeMicros).toBe(0);expect(task.executionFailure).toBe(failure);expect(queue.find()).toBeUndefined()
  operators.cover.moodIsPrediction=true;operators.cover.mood=1;operators.cover.timeStampMicros=data.nowMicros
  syncMowerReplacementChecks(data,queue);expect(task.executionFailure).toBe(failure)
 })
 it('reopens an exhausted check only on related observations and reservation releases',()=>{
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.mood=4;data.reservedProductReplacements.add('next');data.reservedProductReplacements.add('last')
  runMowerReplacementCheck(data,queue,task);const failure=task.executionFailure
  data.nowMicros=toMowerMicros(5);data.operators.other=new MowerOperatorState({name:'other',mood:24,timeStampMicros:data.nowMicros})
  syncMowerReplacementChecks(data,queue);expect(task.executionFailure).toBe(failure)
  data.reservedProductReplacements.delete('next');syncMowerReplacementChecks(data,queue)
  expect(task.executionFailure).toBeUndefined();expect(task.executionRetained).toBe(true);expect(task.timeMicros).toBe(0)
  operators.cover.timeStampMicros=data.nowMicros
  expect(runMowerReplacementCheck(data,queue,task)).toBe(true)
  expect(queue.tasks.find(t=>t.type===T.SELF_CORRECTION)?.plan).toEqual({room_1_1:['next']})
 })
 it('uses a successor after a retained task receives a usable countdown',()=>{
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.depletionRate=0
  runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(2);operators.cover.timeStampMicros=data.nowMicros;operators.cover.depletionRate=2
  syncMowerReplacementChecks(data,queue);expect(task.timeMicros).toBe(0)
  expect(runMowerReplacementCheck(data,queue,task)).toBe(true)
  const next=queue.tasks.find(t=>t!==task)!;expect(next.timeMicros).toBe(toMowerMicros(6));expect(next.replacementCheck?.target).toEqual(task.replacementCheck?.target)
 })
 it('requires an actual read and uses countdown fallback outside recycle only',()=>{
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.depletionRate=0
  expect(runMowerReplacementCheck(data,queue,task,{readRoom:()=>({agent:'cover',mood:12,observed:false})})).toBe(false)
  expect(task.executionFailure).toBeDefined()
  delete task.executionFailure;delete task.replacementCheck!.failure
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>({agent:'cover',mood:12,endMicros:toMowerMicros(6)})})
  expect(task.timeMicros).toBe(toMowerMicros(4))
  const recycle=fixture('recycle'),check=recycle.start();recycle.operators.cover.depletionRate=0
  runMowerReplacementCheck(recycle.data,recycle.queue,check,{readRoom:()=>({agent:'cover',mood:12,endMicros:toMowerMicros(6)})})
  expect(check.executionFailure).toBeDefined();expect(check.timeMicros).toBe(0)
 })
 it('cancels stale targets and concrete due replacements but leaves future plans alone',()=>{
  const {data,queue,operators,start}=fixture(),task=start()
  const future=new MowerTask({time:2,plan:{room_1_1:['next']}});queue.tasks.push(future)
  syncMowerReplacementChecks(data,queue);expect(queue.tasks).toContain(task)
  future.time=0;syncMowerReplacementChecks(data,queue);expect(queue.tasks).not.toContain(task)
  queue.tasks=[];const next=start();operators.cover.currentRoom='';syncMowerReplacementChecks(data,queue)
  expect(queue.tasks).not.toContain(next)
 })
 it('preserves retained targets over concrete plans and invalidates without moving their deadline',()=>{
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.depletionRate=0;runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(1);queue.tasks.push(new MowerTask({time:1,plan:{room_1_1:['next']}}))
  syncMowerReplacementChecks(data,queue);expect(queue.tasks).toContain(task)
  invalidateMowerReplacementChecks(data,queue);expect(task.timeMicros).toBe(0)
  syncMowerReplacementChecks(data,queue);expect(task.executionFailure).toBeUndefined()
 })
 it('deep clones check state so preview changes cannot affect the original task',()=>{
  const {data,queue,start}=fixture(),task=start();runMowerReplacementCheck(data,queue,task)
  const copy=cloneMowerReplacementCheck(task)!;copy.target.index=9;copy.source!.observations.cover![2]=1
  expect(task.replacementCheck!.target.index).toBe(0);expect(task.replacementCheck!.source!.observations.cover![2]).toBe(12)
 })
 it('keeps another failed check in the same room suspended after a read that changes timestamps alone',()=>{
  const {data,queue,operators,start}=fixture();operators.cover.depletionRate=0
  data.plan.room_1_1!.push('owner2')
  data.operators.owner2=new MowerOperatorState({name:'owner2',operatorType:'high',room:'room_1_1',index:1,replacement:['cover2','next2']})
  data.operators.cover2=new MowerOperatorState({name:'cover2',currentRoom:'room_1_1',currentIndex:1,mood:10,timeStampMicros:0})
  data.operators.next2=new MowerOperatorState({name:'next2',mood:24,timeStampMicros:0})
  const first=start(),peer=queue.tasks.find(task=>task!==first&&task.replacementCheck)!
  runMowerReplacementCheck(data,queue,first);runMowerReplacementCheck(data,queue,peer)
  const peerFailure=peer.executionFailure
  data.nowMicros=toMowerMicros(1)
  runMowerReplacementCheck(data,queue,first,{readRoom:()=>{
   operators.cover.timeStampMicros=data.nowMicros;data.operators.cover2!.timeStampMicros=data.nowMicros
   return {agent:'cover',mood:12,observed:true}
  }})
  syncMowerReplacementChecks(data,queue)
  expect(peer.executionFailure).toBe(peerFailure);expect(peer.timeMicros).toBe(0)
 })
 it('rechecks a failed cover when a configured fatigue-rate provider actually moves',()=>{
  const {data,queue,operators,start}=fixture();operators.cover.depletionRate=0
  const provider=data.operators.provider=new MowerOperatorState({name:'provider',currentRoom:'central',currentIndex:0})
  const task=start(),options={refreshDrainedNames:['provider']}
  runMowerReplacementCheck(data,queue,task,options);const failure=task.executionFailure
  data.nowMicros=toMowerMicros(1);syncMowerReplacementChecks(data,queue,options)
  expect(task.executionFailure).toBe(failure)
  provider.currentRoom='';provider.currentIndex=-1
  syncMowerReplacementChecks(data,queue,options)
  expect(task.executionFailure).toBeUndefined();expect(task.timeMicros).toBe(0)
 })
})
