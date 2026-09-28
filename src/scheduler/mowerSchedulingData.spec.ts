import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-current-room-duplicate-cache-alpha.json'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerOperatorState} from './mowerOperatorState'
import {mowerCorrectionPlan} from './mowerCorrection'
describe('actual Mower duplicate cached positions',()=>{
 for(const fixture of oracle.cases)it('preserves separate room and per-slot lookups for '+fixture.input.order.join(','),()=>{
  const operators=Object.fromEntries(fixture.input.order.map(name=>[name,new MowerOperatorState({name,room:name==='A'?'room_A':'',index:name==='A'?0:-1,operatorType:name==='A'?'high':'low',currentRoom:'room_A',currentIndex:0,mood:20,timeStampMicros:0})]))
  const data=new MowerSchedulingData({operators,plan:{room_A:['A']},dorms:[],nowMicros:0})
  expect(data.currentRoom('room_A',true)).toEqual(fixture.output.currentRoom)
  expect(data.currentOperator('room_A',0)?.name).toBe(fixture.output.currentOperator)
  expect(mowerCorrectionPlan(data)).toEqual(fixture.output.correction)
 })
})
