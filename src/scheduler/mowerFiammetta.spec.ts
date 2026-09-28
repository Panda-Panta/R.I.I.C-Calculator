import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-fia-ready-cache-alpha.json'
import {MowerOperatorState} from './mowerOperatorState'
import {mowerFiaReadyMicros} from './mowerFiammetta'
describe('actual alpha Fiammetta cached readiness',()=>{
 for(const c of oracle.cases)it(c.id,()=>{
  const op=new MowerOperatorState({name:'Fia',mood:c.mood,timeStampMicros:c.stampMicros??undefined});let reads=0
  const readyMicros=mowerFiaReadyMicros(op,c.nowMicros,()=>{reads++;return c.timerMicros})
  expect({readyMicros,reads}).toEqual(c.output)
 })
})
