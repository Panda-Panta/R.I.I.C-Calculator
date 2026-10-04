import {it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-correct-dorm.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerCorrectDorm} from './mowerObservations'
import {toMowerMicros} from './mowerTaskQueue'

for(const c of oracle.cases)it('uses native completed bed correction: '+c.kind,()=>{
 const now=toMowerMicros(4),op=new MowerOperatorState({name:'A',room:'room_1_1',currentRoom:'dormitory_1',currentIndex:2,mood:c.input.mood,upperLimit:c.input.limit,timeStampMicros:c.input.observed?now-toMowerMicros(.5):undefined,depletionRate:1})
 const data=new MowerSchedulingData({alpha:true,plan:{dormitory_1:Array(5).fill('Free')},operators:{A:op},dorms:[new MowerDormState(['dormitory_1',2],'A',now-toMowerMicros(1))],nowMicros:now})
 mowerCorrectDorm(data)
 expect({mood:op.mood,stampSeconds:op.timeStampMicros===undefined?null:(op.timeStampMicros-now)/1_000_000,prediction:op.moodIsPrediction,depletion:op.depletionRate}).toEqual(c.output)
})
