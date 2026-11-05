import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-metadata.json'
import selectionOracle from './fixtures/mower-alpha-selection-20261013.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {prepareMowerDormSelection} from './mowerSelection'
import {prepareMowerRelease} from './mowerRelease'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'

function setup(free:boolean){
 const n=new MowerOperatorState({name:'N',currentRoom:'dormitory_1',currentIndex:3,mood:20,timeStampMicros:0})
 return new MowerSchedulingData({alpha:true,operators:{N:n},plan:{dormitory_1:['K1','K2','Free','Free','Free']},dorms:[new MowerDormState(['dormitory_1',3],'N',toMowerMicros(1))],nowMicros:0,freeRoom:free})
}
describe('alpha execution boundary native decisions',()=>{
 for(const fixture of selectionOracle.cases)it('pinned alpha admission: '+fixture.name,()=>{
  const input=fixture.input,data=setup(true),op=data.operators.N!
  op.room='central';op.index=0;op.currentRoom='';op.currentIndex=-1;op.operatorType='high';op.restingPriority='high'
  op.mood=input.mood;op.depletionRate=input.depletionRate;op.upperLimit=input.limit??24;op.restMoodLimit=input.limit!==null
  op.workaholic=input.excluded==='workaholic';data.freeBlacklist=input.excluded==='blacklist'?['N']:[]
  data.restingPriorityNames=input.priority?['N']:[];data.nowMicros=toMowerMicros(input.elapsedHours)
  expect(op.currentMood(data.nowMicros)).toBeCloseTo(fixture.predictedBefore,10)
  const selected=['Current','Current','Current','N','Current']
  prepareMowerDormSelection(data,selected,'dormitory_1')
  expect(selected).toEqual(fixture.output)
  // alpha.14 base_schedule.py 13031–13072 preserves measured depletion on cancellation.
  // Keep the older ab0 oracle intact and apply the current execution contract here.
  expect(op.depletionRate).toBe(input.depletionRate)
  expect(op.currentMood(data.nowMicros)).toBeCloseTo(fixture.predictionAfter,10)
 })
 for(const [i,fixture] of oracle.release.entries())it('identity and recovery deadline '+i,()=>{
  const data=setup(true);data.dorms[0]!.timeMicros=toMowerMicros(fixture.due)
  if(fixture.excluded)data.freeRoomExclusions=['N']
  const task=new MowerTask({type:T.RELEASE_DORM,metadata:fixture.identity,plan:{dormitory_1:['Current','Current','Current','Free','Current']}}),queue=new MowerTaskQueue();queue.tasks=[task]
  expect(prepareMowerRelease(data,queue,task)).toBe(fixture.ready)
  expect(task.plan).toEqual(fixture.plan)
  expect(queue.tasks.filter(t=>t!==task).map(t=>({type:t.type.key,time:t.time,plan:t.plan,metadata:t.metadata,strict:t.strictMoodLimit}))).toEqual(fixture.retries)
 })
})
