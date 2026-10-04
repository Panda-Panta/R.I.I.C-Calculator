import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-idle-search.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerUpdateDetail} from './mowerObservations'
import {mowerDormCandidateMood,mowerAlphaDormCandidates} from './mowerAlphaCandidates'
import {toMowerMicros} from './mowerTaskQueue'
function data(){return new MowerSchedulingData({alpha:true,plan:{dormitory_1:['Free']},operators:{A:new MowerOperatorState({name:'A',mood:8,timeStampMicros:0}),B:new MowerOperatorState({name:'B',mood:10,timeStampMicros:0}),N:new MowerOperatorState({name:'N',mood:24,timeStampMicros:0,currentRoom:'dormitory_1',currentIndex:0})},dorms:[new MowerDormState(['dormitory_1',0],'N',0)],nowMicros:0,freeRoom:true,unregisteredIdleNames:['U']})}
describe('native alpha idle search protections',()=>{
 it('retains bed timers and permits a shared search reset only after the source interval',()=>{
  const d=data();d.stopIdleDormSearch();const stopped=d.idleDormSearchStoppedAtMicros;d.nowMicros=toMowerMicros(.5);d.stopIdleDormSearch()
  const actual=oracle.refresh.map(c=>{
   const a=d.operators.A!;a.dormMoodFallback='dormitory_1';a.idleRestCheck=[24,8,0];d.dormMoodEstimates.set('A',[8,0]);d.nowMicros=toMowerMicros(c.hours)
   const changed=d.refreshIdleDormSearch()
   return {hours:c.hours,changed,stopped:d.idleDormSearchExhausted,stampUnchanged:stopped===0,fallback:a.dormMoodFallback,checked:!!a.idleRestCheck,estimates:!!d.dormMoodEstimates.size,bedName:d.dorms[0]!.name,bedTime:d.dorms[0]!.timeMicros!/1_000_000}
  });expect(actual).toEqual(oracle.refresh)
 })
 it('protects peers after reading a full lowest candidate without inventing their morale',()=>{
  const d=data(),n=d.operators.N!;n.dormMoodFallback='dormitory_1';n.dormMoodPeers={A:0,B:0}
  mowerUpdateDetail(d,'N',24,'dormitory_1',0,true)
  expect(Object.fromEntries(['A','B'].map(name=>[name,{mood:d.operators[name]!.mood,checked:d.idleRestChecked(name)}]))).toEqual(oracle.peers)
 })
 it('expires card estimates and uses the same recovering, unknown and filling order',()=>{
  const d=data();d.operators.A!.timeStampMicros=undefined;d.dormMoodEstimates.set('A',[8,0])
  expect(oracle.estimates.map(c=>{d.nowMicros=toMowerMicros(c.hours);return {hours:c.hours,mood:mowerDormCandidateMood(d,'A')??null}})).toEqual(oracle.estimates)
  d.nowMicros=0;const candidates=mowerAlphaDormCandidates(d)
  expect({...candidates,estimated_recovering:candidates.estimatedRecovering,estimatedRecovering:undefined}).toEqual({...oracle.candidates,estimatedRecovering:undefined})
 })
})
