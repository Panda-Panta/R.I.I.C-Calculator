import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-resting-boundaries.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerResting} from './mowerOrdinaryPlanning'
import {MowerTaskQueue} from './mowerTaskQueue'

describe('native alpha resting boundaries',()=>{
 for(const c of oracle.cases)it(c.kind,()=>{
  const standby=c.kind==='standby'
  const operators={A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,currentRoom:'room_1_1',currentIndex:0,operatorType:'high',mood:4,timeStampMicros:['unknown','estimated'].includes(c.kind)?undefined:0,replacement:['R'],restingPriority:standby?'standby':'high'}),R:new MowerOperatorState({name:'R',mood:10,timeStampMicros:0}),...Object.fromEntries(['K1','K2'].map((name,index)=>[name,new MowerOperatorState({name,room:'dormitory_1',index,currentRoom:'dormitory_1',currentIndex:index,operatorType:'high',mood:24,timeStampMicros:0})]))}
  const data=new MowerSchedulingData({alpha:true,plan:{room_1_1:['A'],dormitory_1:['K1','K2','Free','Free','Free']},operators,dorms:[new MowerDormState(['dormitory_1',2])],nowMicros:0,standbyNames:standby?['A']:[],dormMoodEstimates:c.kind==='estimated'?new Map([['A',[4,0]]]):undefined,reservedProductReplacements:new Set(c.kind==='reserved-primary'?['A']:c.kind==='reserved-cover'?['R']:[])})
  expect(mowerResting(data,new MowerTaskQueue())).toEqual(c.plan)
  expect(data.dorms.map(b=>b.name)).toEqual(c.bedNames)
  expect(operators.A.standbyLowPriority).toBe(c.standbyLow)
 })
})
