import {describe,it,expect} from 'vitest'
import preserveOracle from './fixtures/mower-dorm-selection-preserve-alpha.json'
import oracle from './fixtures/mower-dorm-selection-alpha.json'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerOperatorState} from './mowerOperatorState'
import {prepareMowerDormSelection} from './mowerSelection'
describe('actual Mower default selection preparation',()=>{
 for(const c of oracle.cases)it(c.id,()=>{
  const inputOps=c.ops as Record<string,{room:string;mood:number;upper:number;limited?:boolean}>
  const operators=Object.fromEntries(Object.entries(inputOps).map(([name,v])=>[name,new MowerOperatorState({name,room:v.room,mood:v.mood,upperLimit:v.upper,restMoodLimit:v.limited,depletionRate:3})]))
  const slot='slot' in c?c.slot as {agent:string;group:string;replacement:string[]}:undefined
  if(slot&&operators[slot.agent]){operators[slot.agent]!.group=slot.group;operators[slot.agent]!.replacement=slot.replacement}
  const data=new MowerSchedulingData({operators,plan:{[c.room]:c.names.map(()=>slot?.agent??'Free')},dorms:[],nowMicros:0}),names=[...c.names]
  prepareMowerDormSelection(data,names,c.room)
  expect(names).toEqual(c.output.names)
  expect(Object.fromEntries(Object.entries(operators).map(([n,o])=>[n,o.depletionRate]))).toEqual(c.output.rates)
 })
 for(const c of preserveOracle.cases)it(c.input.id,()=>{
  const name=c.input.names[0]!,op=new MowerOperatorState({name,room:'room_work',operatorType:'high',mood:c.input.mood,upperLimit:c.input.upper,restMoodLimit:c.input.lingMode===1,timeStampMicros:0,depletionRate:3})
  const data=new MowerSchedulingData({operators:{[name]:op},plan:{dormitory_1:c.input.names.map(()=>'Free')},dorms:[],nowMicros:0}),names=[...c.input.names]
  prepareMowerDormSelection(data,names,'dormitory_1',c.input.preserve)
  expect({names,depletionRate:op.depletionRate}).toEqual(c.output)
 })

})
