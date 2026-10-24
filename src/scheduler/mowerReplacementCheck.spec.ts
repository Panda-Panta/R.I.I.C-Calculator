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
  const {data,queue,operators,start}=fixture(),task=start();operators.cover.depletionRate=0;operators.cover.moodIsPrediction=true
  expect(runMowerReplacementCheck(data,queue,task,{readRoom:()=>({agent:'cover',mood:12,observed:false})})).toBe(false)
  expect(task.executionFailure).toBeDefined()
  delete task.executionFailure;delete task.replacementCheck!.failure
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>({agent:'cover',mood:12,endMicros:toMowerMicros(6)})})
  expect(task.timeMicros).toBe(toMowerMicros(4))
  const recycle=fixture('recycle'),check=recycle.start();recycle.operators.cover.depletionRate=0;recycle.operators.cover.moodIsPrediction=true
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
  operators.cover.moodIsPrediction=true
  runMowerReplacementCheck(data,queue,first,{readRoom:()=>{
   operators.cover.moodIsPrediction=false
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

describe('native safe working-mood cache and read barriers',()=>{
 it.each([
  {name:'ordinary',hours:1,reads:0},
  {name:'ordinary',hours:2,reads:0},
  {name:'ordinary',hours:2+1/3_600_000_000,reads:1},
  {name:'歌蕾蒂娅',hours:.5,reads:0},
  {name:'歌蕾蒂娅',hours:.5+1/3_600_000_000,reads:1},
  {name:'见行者',hours:.5+1/3_600_000_000,reads:1},
 ])('uses the native refresh window for $name at $hours hours',({name,hours,reads:expectedReads})=>{
  const {data,queue,operators,start}=fixture();operators.cover.nativeName=name
  data.nowMicros=toMowerMicros(hours)
  const task=start();let reads=0
  const measured=12-2*hours
  expect(runMowerReplacementCheck(data,queue,task,{readRoom:()=>{
   reads++;operators.cover.mood=measured;operators.cover.timeStampMicros=data.nowMicros
   return {agent:'cover',mood:measured,observed:true}
  }})).toBe(false)
  expect(reads).toBe(expectedReads);expect(task.timeMicros).toBe(toMowerMicros(4))
  expect(operators.cover.timeStampMicros).toBe(expectedReads?data.nowMicros:0)
  expect(operators.cover.mood).toBe(expectedReads?measured:12)
 })
 it.each(['missing','future','prediction','invalid','lower-limit'])('forces a real read for %s cached evidence',kind=>{
  const {data,queue,operators,start}=fixture();data.nowMicros=toMowerMicros(1)
  if(kind==='missing')operators.cover.timeStampMicros=undefined
  if(kind==='future')operators.cover.timeStampMicros=toMowerMicros(2)
  if(kind==='prediction')operators.cover.moodIsPrediction=true
  if(kind==='invalid')operators.cover.mood=NaN
  if(kind==='lower-limit')operators.cover.mood=6
  const task=start();let reads=0
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>{
   reads++;operators.cover.mood=10;operators.cover.timeStampMicros=data.nowMicros;operators.cover.moodIsPrediction=false
   return {agent:'cover',mood:10,observed:true}
  }})
  expect(reads).toBe(1);expect(task.timeMicros).toBe(toMowerMicros(4))
 })
 it.each(['environment','invalidation'])('requires a sample after the %s barrier before reusing the cache',change=>{
  const {data,queue,operators,start}=fixture(),task=start()
  runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(1)
  if(change==='environment')syncMowerReplacementChecks(data,queue,{productByRoom:{room_1_1:'gold'}})
  else invalidateMowerReplacementChecks(data,queue)
  let reads=0
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>{
   reads++;operators.cover.mood=10;operators.cover.timeStampMicros=data.nowMicros
   return {agent:'cover',mood:10,observed:true}
  }})
  expect(reads).toBe(1);expect(task.timeMicros).toBe(toMowerMicros(4))
  // The successful actual sample clears the barrier, even at the same wall clock.
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>{reads++;return {agent:'cover',mood:10,observed:true}}})
  expect(reads).toBe(1)
 })
 it.each([{sample:3.5,reads:1},{sample:4,reads:0}])('keeps the original deadline as a read barrier for a sample at $sample hours',({sample,reads:expectedReads})=>{
  const {data,queue,operators,start}=fixture(),task=start()
  runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(4);operators.cover.timeStampMicros=toMowerMicros(sample);operators.cover.mood=6
  let reads=0
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>{
   reads++;operators.cover.mood=6-2*(4-sample);operators.cover.timeStampMicros=data.nowMicros
   return {agent:'cover',mood:operators.cover.mood,observed:true}
  }})
  expect(reads).toBe(expectedReads);expect(task.timeMicros).toBe(toMowerMicros(sample+1))
 })
 it('retains unsafe stale evidence when no real observation can be supplied',()=>{
  const {data,queue,operators,start}=fixture();data.nowMicros=toMowerMicros(3)
  const task=start()
  expect(runMowerReplacementCheck(data,queue,task)).toBe(false)
  expect(task.executionFailure).toBeDefined();expect(task.timeMicros).toBe(data.nowMicros)
  expect(operators.cover.timeStampMicros).toBe(0)
 })
 it('preserves the old saved task deadline as a read barrier when the new cache field is absent',()=>{
  const {data,queue,operators,start}=fixture(),task=start()
  runMowerReplacementCheck(data,queue,task)
  Reflect.deleteProperty(task.replacementCheck!,'deadlineMicros')
  data.nowMicros=toMowerMicros(4);operators.cover.timeStampMicros=toMowerMicros(3.5);operators.cover.mood=6
  let reads=0
  runMowerReplacementCheck(data,queue,task,{readRoom:()=>{
   reads++;operators.cover.mood=5;operators.cover.timeStampMicros=data.nowMicros
   return {agent:'cover',mood:5,observed:true}
  }})
  expect(reads).toBe(1);expect(task.timeMicros).toBe(toMowerMicros(4.5))
 })
 it('clones cache deadlines and invalidation barriers with the rest of a retained check',()=>{
  const {data,queue,start}=fixture(),task=start()
  runMowerReplacementCheck(data,queue,task)
  data.nowMicros=toMowerMicros(1);invalidateMowerReplacementChecks(data,queue)
  const copy=cloneMowerReplacementCheck(task)!
  expect(copy).toMatchObject({deadlineMicros:toMowerMicros(4),readAfterMicros:data.nowMicros})
  Object.assign(copy,{deadlineMicros:0,readAfterMicros:0})
  expect(task.replacementCheck).toMatchObject({deadlineMicros:toMowerMicros(4),readAfterMicros:data.nowMicros})
 })
})
