import {describe,expect,it} from 'vitest'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerDormCandidateMood} from './mowerAlphaCandidates'
import {mowerGroupRecoveryDeadline,mowerRecoveryReady} from './mowerGroupRecovery'
import {mowerRefreshDormTime,mowerUpdateDetail} from './mowerObservations'
import {alphaSlotTakable} from './mowerAlphaDorm'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {planMowerAlphaMetadata} from './mowerAlphaMetadata'
import {planMowerMetadata} from './mowerMetadata'

// Mower alpha ae9fc322: observation provenance and recovery execution decisions.
function fixture(options:Partial<MowerOperatorOptions>={},fixed=false){
 const A=new MowerOperatorState({name:'A',room:'room_1_1',index:0,operatorType:'high',currentRoom:'dormitory_1',currentIndex:0,mood:12,timeStampMicros:0,...options})
 const bed=new MowerDormState(['dormitory_1',0],'A')
 return new MowerSchedulingData({alpha:true,operators:{A},plan:{room_1_1:['A'],dormitory_1:[fixed?'Keeper':'Free']},dorms:fixed?[]:[bed],nowMicros:toMowerMicros(.5),groupRestInFullOnMoodGap:false})
}

describe('latest alpha recovery evidence',()=>{
 it('defers an exhausted ordinary replacement using its newer card without generating a timer',()=>{
  const data=fixture(),owner=new MowerOperatorState({name:'Owner',room:'room_1_1',replacement:['Next','Last']})
  data.operators.Next=new MowerOperatorState({name:'Next',mood:10,lowerLimit:4,timeStampMicros:0})
  data.operators.Last=new MowerOperatorState({name:'Last',mood:24,timeStampMicros:0})
  data.dormMoodEstimates.set('Next',[2,toMowerMicros(.25)])
  expect(data.replacementExhausted('Next',owner)).toBe(true)
  expect(data.replacementCandidates(owner)).toEqual(['Last','Next'])
  expect(data.operators.Next.timeStampMicros).toBe(0)
  expect(data.operators.Next.exhaustTimeMicros).toBeUndefined()
  expect(data.replacementCandidates(new MowerOperatorState({...owner,replacement:['Next']}))).toEqual(['Next'])
  data.operators.Next.workaholic=true
  expect(data.replacementExhausted('Next',owner)).toBe(false)
  expect(data.replacementCandidates(owner)).toEqual(['Next','Last'])
 })
 it('uses newer card completion and mood ordering for grouped dorm replacements',()=>{
  const data=fixture(),owner=new MowerOperatorState({name:'Keeper',room:'dormitory_1',group:'G',replacement:['Next','Last']})
  data.operators.Next=new MowerOperatorState({name:'Next',mood:10,restMoodLimit:true,timeStampMicros:0})
  data.operators.Last=new MowerOperatorState({name:'Last',mood:5,timeStampMicros:0})
  data.dormMoodEstimates.set('Next',[24,toMowerMicros(.25)])
  expect(data.replacementCandidates(owner)).toEqual(['Last'])
  data.dormMoodEstimates.set('Next',[2,toMowerMicros(.25)])
  expect(data.replacementCandidates(owner)).toEqual(['Next','Last'])
 })
 it('uses a newer card observation instead of an older measured value',()=>{
  const data=fixture({mood:24,restMoodLimit:true})
  data.dormMoodEstimates.set('A',[9,toMowerMicros(.25)])
  expect(mowerDormCandidateMood(data,'A')).toBe(9)
  expect(data.restMoodComplete('A')).toBe(false)
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(false)
 })
 it('keeps a newer measured observation and excludes future or hour-old cards',()=>{
  const data=fixture({mood:18,timeStampMicros:toMowerMicros(.4)})
  data.dormMoodEstimates.set('A',[9,toMowerMicros(.25)])
  expect(mowerDormCandidateMood(data,'A')).toBe(18)
  data.operators.A!.moodIsPrediction=true
  data.dormMoodEstimates.set('A',[9,toMowerMicros(.6)])
  expect(mowerDormCandidateMood(data,'A')).toBeUndefined()
  data.nowMicros=toMowerMicros(1.25);data.dormMoodEstimates.set('A',[9,toMowerMicros(.25)])
  expect(mowerDormCandidateMood(data,'A')).toBeUndefined()
 })
 it('does not deplete a saved resting observation with a retained working rate',()=>{
  const data=fixture({mood:24,depletionRate:2})
  expect(mowerDormCandidateMood(data,'A')).toBe(24)
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(true)
 })
 it('accepts a fresh full card but never derives a completion deadline from a partial card',()=>{
  const data=fixture({mood:12,moodIsPrediction:true})
  data.dormMoodEstimates.set('A',[24,toMowerMicros(.25)])
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(true)
  data.dormMoodEstimates.set('A',[23.99,toMowerMicros(.25)])
  data.dorms[0]!.timeMicros=data.nowMicros+toMowerMicros(1/60)
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(false)
 })
 it('uses fixed-slot countdowns at the personal upper limit without inventing a Free bed',()=>{
  const data=fixture({mood:20,upperLimit:22,restInFull:true},true)
  mowerRefreshDormTime(data,'dormitory_1',0,'A',toMowerMicros(1.02))
  expect(data.getDormByName('A')).toBeUndefined()
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(true)
  data.operators.A!.currentIndex=1
  expect(mowerRecoveryReady(data,data.operators.A)).toBe(false)
 })
 it('removes a group recovery latch only after an actual return to the home work slot',()=>{
  const data=fixture({group:'G'})
  data.groupRecoveryFullMembers={G:['A','B'],Other:['A','C']}
  mowerUpdateDetail(data,'A',12,'room_1_1',0,true)
  expect(data.groupRecoveryFullMembers).toEqual({G:['B'],Other:['C']})
 })
 it('does not add a newly idle group member to an already latched recovery cycle',()=>{
  const data=fixture({group:'G'})
  data.operators.B=new MowerOperatorState({name:'B',group:'G',room:'room_1_1',index:1,operatorType:'high',mood:5,timeStampMicros:0})
  data.groupRecoveryFullMembers.G=['A'];data.dorms[0]!.timeMicros=toMowerMicros(2)
  expect(mowerGroupRecoveryDeadline(data,'G')).toEqual({requiredNames:['A'],timeMicros:toMowerMicros(2)})
 })
 it('keeps known group deadlines while preserving unknown members as execution requirements',()=>{
  const data=fixture({group:'G',restInFull:true})
  data.operators.B=new MowerOperatorState({name:'B',group:'G',room:'room_1_1',index:1,operatorType:'high',mood:5,timeStampMicros:0,restInFull:true})
  data.dorms[0]!.timeMicros=toMowerMicros(2)
  expect(mowerGroupRecoveryDeadline(data,'G')).toEqual({requiredNames:['A','B'],timeMicros:toMowerMicros(2)})
  expect(mowerRecoveryReady(data,data.operators.B)).toBe(false)
 })
 it('protects a lower priority primary bed even from a higher priority recovery',()=>{
  const data=fixture({restingPriority:'low'})
  data.operators.Urgent=new MowerOperatorState({name:'Urgent',room:'room_1_2',operatorType:'high',restingPriority:'high',exhaustRequire:true,mood:2,timeStampMicros:0})
  expect(alphaSlotTakable(data,data.dorms[0]!,'Urgent')).toBe(false)
 })
 it('uses the newer card observation for the ordinary requester takeover limit',()=>{
  const data=fixture({operatorType:'low',room:'',mood:10})
  data.operators.Cover=new MowerOperatorState({name:'Cover',room:'room_1_1',replacement:['A','Requester']})
  data.operators.Requester=new MowerOperatorState({name:'Requester',mood:24,timeStampMicros:0,upperLimit:20})
  data.dormMoodEstimates.set('Requester',[16,toMowerMicros(.25)])
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
  // The resident is an ordinary idle worker (tier 6), not another protected replacement.
  data.operators.Cover.replacement=['Requester']
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(true)
  data.dormMoodEstimates.set('Requester',[16.01,toMowerMicros(.25)])
  expect(alphaSlotTakable(data,data.dorms[0]!,'Requester')).toBe(false)
 })
})

describe('latest alpha recovery deadline continuity',()=>{
 it.each(['backup','group'])('keeps unfinished %s execution and ordinary tasks while rebuilding personal-limit release',kind=>{
  const data=fixture({restMoodLimit:true,upperLimit:20}),queue=new MowerTaskQueue()
  data.dorms[0]!.timeMicros=toMowerMicros(3)
  const execution=new MowerTask({type:T.SHIFT_ON,time:1,plan:{room_1_1:['A']}})
  if(kind==='backup')execution.backupShiftActive=true
  else execution.groupShiftExpected={['room_1_1\0'+'0']:'A'}
  const ordinary=new MowerTask({type:T.SHIFT_ON,time:8,plan:{room_1_1:['A']}})
  const oldLimit=new MowerTask({type:T.RELEASE_DORM,time:9,strictMoodLimit:true,metadata:'A',plan:{dormitory_1:['Free']}})
  queue.tasks=[execution,ordinary,oldLimit]
  planMowerMetadata(data,queue)
  expect(queue.tasks.slice(0,2)).toEqual([execution,ordinary])
  expect(queue.tasks[0]).toBe(execution);expect(queue.tasks[1]).toBe(ordinary)
  expect(queue.tasks).not.toContain(oldLimit)
  expect(queue.tasks.filter(task=>task.strictMoodLimit).map(task=>[task.metadata,task.timeMicros])).toEqual([['A',toMowerMicros(3)]])
  expect(execution.timeMicros).toBe(toMowerMicros(1));expect(ordinary.timeMicros).toBe(toMowerMicros(8))
 })
 it.each([false,true])('retains the previous deadline after a missing timer with full=%s',restInFull=>{
  const data=fixture({restInFull}),queue=new MowerTaskQueue()
  data.dorms[0]!.timeMicros=toMowerMicros(3)
  const due=toMowerMicros(restInFull?3:3-8/60)
  planMowerAlphaMetadata(data,queue,[])
  expect(queue.tasks.find(task=>task.type===T.SHIFT_ON)?.timeMicros).toBe(due)
  data.dorms[0]!.timeMicros=undefined
  for(let repeat=0;repeat<3;repeat++){
   data.nowMicros+=toMowerMicros(.1)
   planMowerAlphaMetadata(data,queue,[])
   expect(queue.tasks.find(task=>task.type===T.SHIFT_ON)?.timeMicros).toBe(due)
  }
 })
 it('does not carry a return deadline across a new physical rest cycle',()=>{
  const data=fixture(),queue=new MowerTaskQueue()
  data.dorms[0]!.timeMicros=toMowerMicros(3)
  planMowerAlphaMetadata(data,queue,[])
  const op=data.operators.A!
  op.currentRoom='room_1_1';op.currentRoom='dormitory_1'
  data.dorms[0]!.timeMicros=undefined
  planMowerAlphaMetadata(data,queue,[])
  expect(queue.tasks.some(task=>task.type===T.SHIFT_ON)).toBe(false)
 })
 it('retains a full-rest group deadline while one member needs another timer read',()=>{
  const data=fixture({group:'G',restInFull:true}),queue=new MowerTaskQueue()
  data.operators.B=new MowerOperatorState({name:'B',group:'G',room:'room_1_1',index:1,operatorType:'high',restingPriority:'high',currentRoom:'dormitory_1',currentIndex:1,mood:10,timeStampMicros:0,restInFull:true})
  data.plan.room_1_1!.push('B');data.plan.dormitory_1!.push('Free')
  data.dorms[0]!.timeMicros=toMowerMicros(2);data.dorms.push(new MowerDormState(['dormitory_1',1],'B',toMowerMicros(4)))
  planMowerAlphaMetadata(data,queue,[])
  expect(queue.tasks.find(task=>task.type===T.SHIFT_ON)?.timeMicros).toBe(toMowerMicros(4))
  data.dorms[1]!.timeMicros=undefined
  planMowerAlphaMetadata(data,queue,[])
  expect(queue.tasks.find(task=>task.type===T.SHIFT_ON)?.timeMicros).toBe(toMowerMicros(4))
 })
})
