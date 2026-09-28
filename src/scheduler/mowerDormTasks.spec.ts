import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-return-two-groups-alpha.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {generateMowerDormTasks} from './mowerDormTasks'
import {toMowerMicros} from './mowerTaskQueue'
describe('actual alpha generate_plan_by_drom future and overdue groups',()=>{
 for(const [index,fixture] of oracle.cases.entries())it('matches source case '+index,()=>{
  const h=new MowerOperatorState({name:'H',room:'room_1_2',index:0,group:'h',operatorType:'high',currentRoom:'dormitory_1',currentIndex:0,exhaustRequire:fixture.firstFullAndExhaust}),k=new MowerOperatorState({name:'K',room:'room_2_1',index:0,group:'k',operatorType:'high',currentRoom:'dormitory_2',currentIndex:0})
  const d=new MowerSchedulingData({plan:{room_1_2:['H'],room_2_1:['K'],dormitory_1:['Free'],dormitory_2:['Free']},operators:{H:h,K:k},dorms:[],nowMicros:0});const dh=new MowerDormState(['dormitory_1',0],'H',toMowerMicros(fixture.rawDeadlinesHours[0]!)),dk=new MowerDormState(['dormitory_2',0],'K',toMowerMicros(fixture.rawDeadlinesHours[1]!))
  const tasks=generateMowerDormTasks([{timeMicros:dh.timeMicros!,dorms:[dh],restInFull:fixture.firstFullAndExhaust},{timeMicros:dk.timeMicros!,dorms:[dk],restInFull:false}],d)
  expect(tasks.map(t=>({delayHours:t.time,plan:t.plan}))).toEqual(fixture.tasks)
 })
 it('preserves the old queued target only while a backup is active',()=>{
  const h=new MowerOperatorState({name:'H',room:'room_new',index:0,group:'g',operatorType:'high',currentRoom:'dormitory_1',currentIndex:0}),bed=new MowerDormState(['dormitory_1',0],'H',toMowerMicros(2));const data=new MowerSchedulingData({plan:{room_new:['H'],room_old:['H'],dormitory_1:['Free']},operators:{H:h},dorms:[bed],nowMicros:0});expect(generateMowerDormTasks([{timeMicros:bed.timeMicros!,dorms:[bed],restInFull:false}],data,{H:['room_old',0]})[0]!.plan).toEqual({room_old:['H']});expect(generateMowerDormTasks([{timeMicros:bed.timeMicros!,dorms:[bed],restInFull:false}],data)[0]!.plan).toEqual({room_new:['H']})
 })
})
