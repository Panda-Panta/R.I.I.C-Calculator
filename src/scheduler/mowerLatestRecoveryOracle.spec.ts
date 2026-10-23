import {describe,expect,it} from 'vitest'
import oracle from './fixtures/mower-recovery-ae9fc322.json'
import {MowerOperatorState,hasObservedFullMood} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerDormCandidateMood,mowerSchedulingMoodObservation} from './mowerAlphaCandidates'
import {mowerGroupRecoveryDeadline,mowerRecoveryMoodComplete} from './mowerGroupRecovery'
import {toMowerMicros,fromMowerMicros} from './mowerTaskQueue'

type Case={name:string;operators:{name:string;mood?:number;timestampHours?:number|null;depletion_rate?:number;current_room?:string;mood_is_prediction?:boolean;rest_in_full?:boolean;upper_limit?:number;fixedObservation?:[string,number,number,number]}[];beds?:Record<string,number>;estimates?:Record<string,[number,number]>;latches?:Record<string,string[]>;anchors?:Record<string,number>;maxExtraWaitHours?:number;gapEnabled?:boolean;expected:typeof oracle.cases[number]['expected']}

describe('Mower ae9fc322 unchanged native recovery AST oracle',()=>{
 for(const sample of oracle.cases as Case[])it(sample.name,()=>{
  const operators=Object.fromEntries(sample.operators.map((raw,index)=>[raw.name,new MowerOperatorState({name:raw.name,mood:raw.mood??10,timeStampMicros:raw.timestampHours===null?undefined:toMowerMicros(raw.timestampHours??10),depletionRate:raw.depletion_rate??0,currentRoom:raw.current_room??'dormitory_1',currentIndex:index,room:'room_1_1',index,group:'G',operatorType:'high',restingPriority:'high',moodIsPrediction:raw.mood_is_prediction,restInFull:raw.rest_in_full,upperLimit:raw.upper_limit,dormRecoveryObservation:raw.fixedObservation?[raw.fixedObservation[0],raw.fixedObservation[1],toMowerMicros(raw.fixedObservation[2]),toMowerMicros(raw.fixedObservation[3])]:undefined})]))
  const data=new MowerSchedulingData({alpha:true,operators,nowMicros:toMowerMicros(oracle.nowHours),plan:{room_1_1:Object.keys(operators),dormitory_1:sample.operators.map(()=> 'Free')},dorms:Object.entries(sample.beds??{}).map(([name,time])=>new MowerDormState(['dormitory_1',operators[name]!.currentIndex],name,toMowerMicros(time))),dormMoodEstimates:new Map(Object.entries(sample.estimates??{}).map(([name,[mood,time]])=>[name,[mood,toMowerMicros(time)]])),groupRecoveryFullMembers:sample.latches,groupRecoveryReturnMicros:Object.fromEntries(Object.entries(sample.anchors??{}).map(([group,time])=>[group,toMowerMicros(time)])),groupMoodGapMaxExtraWaitHours:sample.maxExtraWaitHours,groupRestInFullOnMoodGap:sample.gapEnabled??true})
  const before=JSON.stringify(operators),expected=sample.expected,observation=mowerSchedulingMoodObservation(data,'A'),recovery=mowerGroupRecoveryDeadline(data,'G')
  expect(mowerDormCandidateMood(data,'A')??null).toBe(expected.mood)
  expect(observation?fromMowerMicros(observation[1]):null).toBe(expected.observationHours)
  expect(hasObservedFullMood(operators.A)&&!operators.A!.moodIsPrediction).toBe(expected.observedFull)
  expect(mowerRecoveryMoodComplete(data,operators.A)).toBe(expected.recoveryComplete)
  expect(recovery.requiredNames).toEqual(expected.requiredNames)
  if(expected.deadlineHours===null)expect(recovery.timeMicros).toBeUndefined()
  else expect(fromMowerMicros(recovery.timeMicros!)).toBeCloseTo(expected.deadlineHours,8)
  expect(data.groupRecoveryFullMembers).toEqual(expected.latches)
  expect(Object.keys(data.groupRecoveryReturnMicros)).toEqual(Object.keys(expected.anchorsHours))
  for(const [group,time] of Object.entries(expected.anchorsHours))expect(fromMowerMicros(data.groupRecoveryReturnMicros[group]!)).toBeCloseTo(time,8)
  expect(JSON.stringify(operators)).toBe(before)
 })
})
