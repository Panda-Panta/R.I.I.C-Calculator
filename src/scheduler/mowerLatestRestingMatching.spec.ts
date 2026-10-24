import {describe,expect,it} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerGetRestingPlan} from './mowerOrdinaryPlanning'
import type {MowerTaskPlan} from './mowerTaskQueue'

// ae9fc322 base_schedule._get_resting_plan retries the complete cover matching
// with working primaries preferred only when configured first choices cannot fit.
function fixture(beds:number){
 const operators={
  A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,currentRoom:'room_1_1',currentIndex:0,group:'G',replacement:['X','B'],operatorType:'high',restingPriority:'high',mood:12,timeStampMicros:0}),
  B:new MowerOperatorState({name:'B',room:'room_1_1',index:1,currentRoom:'room_1_1',currentIndex:1,group:'G',replacement:['Y'],operatorType:'high',restingPriority:'high',mood:20,timeStampMicros:0}),
  X:new MowerOperatorState({name:'X',mood:24,timeStampMicros:0}),
  Y:new MowerOperatorState({name:'Y',mood:24,timeStampMicros:0}),
 }
 return new MowerSchedulingData({alpha:true,operators,nowMicros:0,plan:{room_1_1:['A','B'],dormitory_1:Array(beds).fill('Free')},dorms:Array.from({length:beds},(_,index)=>new MowerDormState(['dormitory_1',index]))})
}

describe('latest alpha complete replacement matching with limited beds',()=>{
 it('keeps configured first choices when all resting primaries fit',()=>{
  const data=fixture(2),plan:MowerTaskPlan={},replacements:string[]=[]
  expect(mowerGetRestingPlan(data,['A','B'],replacements,plan)).toBe(true)
  expect(plan).toEqual({room_1_1:['X','Y']})
  expect(replacements).toEqual(['X','Y'])
  expect(data.dorms.map(bed=>bed.name)).toEqual(['A','B'])
 })
 it('uses a same-group working cover in a second complete matching so the remaining primary can recover',()=>{
  const data=fixture(1),plan:MowerTaskPlan={},replacements:string[]=[]
  expect(mowerGetRestingPlan(data,['A','B'],replacements,plan)).toBe(true)
  expect(plan).toEqual({room_1_1:['B','Y']})
  expect(replacements).toEqual(['B','Y'])
  expect(data.dorms.map(bed=>bed.name)).toEqual(['A'])
  expect(data.operators.B!.currentIndex).toBe(1)
  expect(data.groupShiftState).toEqual({})
 })
 it('rejects both complete assignments without mutating input when neither has enough beds',()=>{
  const data=fixture(0),plan:MowerTaskPlan={},replacements:string[]=[],before=JSON.stringify(data)
  expect(mowerGetRestingPlan(data,['A','B'],replacements,plan)).toBe(false)
  expect(plan).toEqual({});expect(replacements).toEqual([])
  expect(JSON.stringify(data)).toBe(before)
 })
})
