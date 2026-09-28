import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-fia-ready-cache-alpha.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData} from './mowerSchedulingData'
import {mowerFiaReadyMicros,selectMowerFiaTarget} from './mowerFiammetta'
describe('actual alpha Fiammetta cached readiness',()=>{
 for(const c of oracle.cases)it(c.id,()=>{
  const op=new MowerOperatorState({name:'Fia',mood:c.mood,timeStampMicros:c.stampMicros??undefined});let reads=0
  const readyMicros=mowerFiaReadyMicros(op,c.nowMicros,()=>{reads++;return c.timerMicros})
  expect({readyMicros,reads}).toEqual(c.output)
 })
})

it('uses ordered candidates below the threshold and the lowest mood only when fool protection is off',()=>{
 const data=new MowerSchedulingData({plan:{},operators:{A:new MowerOperatorState({name:'A',mood:18,timeStampMicros:0}),B:new MowerOperatorState({name:'B',mood:10,timeStampMicros:0})},dorms:[],nowMicros:0})
 expect(selectMowerFiaTarget(data,['A','B'],false,.8)).toBe('A')
 expect(selectMowerFiaTarget(data,['A','B'],false,.4)).toBe('B')
 expect(selectMowerFiaTarget(data,['A','B'],true,.4)).toBeUndefined()
})
