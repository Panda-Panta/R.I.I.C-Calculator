import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-mood-limits.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {initializeMowerAlphaMoodLimits,readMowerMoodLimits} from './mowerMoodLimits'
import {toMowerMicros} from './mowerTaskQueue'
describe('native alpha mood limits and saved recovery times',()=>{
 for(const [i,fixture] of oracle.cases.entries())it('precedence '+i,()=>{
  const input=fixture.input,operators=Object.fromEntries(input.rows.map(r=>[r.name,new MowerOperatorState({name:r.name,room:r.room,index:r.index,group:r.group,replacement:r.replacement,operatorType:r.operator_type as 'high'|'low'|undefined,currentRoom:r.current_room,currentIndex:r.current_index,mood:r.mood,timeStampMicros:0})]))
  const data=new MowerSchedulingData({alpha:true,operators,plan:structuredClone(input.plan),dorms:input.beds.map(b=>new MowerDormState([String(b.position[0]),Number(b.position[1])],b.name,toMowerMicros(b.time))),nowMicros:0})
  const config=readMowerMoodLimits({mood_limits:input.globalLimit,operator_mood_limits:input.personal},name=>name)
  initializeMowerAlphaMoodLimits(data,input.mode,config,{B:24})
  expect(Object.fromEntries(Object.entries(operators).map(([n,o])=>[n,{lower:o.lowerLimit,upper:o.upperLimit,strict:o.restMoodLimit}]))).toEqual(fixture.output.operators)
  expect(data.dorms[0]!.timeMicros).toBe(toMowerMicros(fixture.output.bedTime))
 })
 it('applies native defaults and rejects invalid personal ranges',()=>{
  expect(readMowerMoodLimits({operator_mood_limits:{A:{upper:12}}},n=>n)).toEqual({operators:{A:{lower:0,upper:12}}})
  expect(()=>readMowerMoodLimits({mood_limits:{lower:12,upper:12}},n=>n)).toThrow(/lower/)
  expect(()=>readMowerMoodLimits({operator_mood_limits:{A:{lower:NaN}}},n=>n)).toThrow(/lower/)
 })
})
