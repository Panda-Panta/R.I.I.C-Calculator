import {describe,it,expect} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerTaskQueue,fromMowerMicros,toMowerMicros,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {planMowerMetadata} from './mowerMetadata'
import {mowerResting} from './mowerOrdinaryPlanning'

describe('Mower grouped dorm return stability',()=>{
 it('does not return a whole group while another member still needs immediate rest',()=>{
  const operators={
   A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,group:'g',replacement:['R1'],operatorType:'high',restingPriority:'high',mood:23.6,currentRoom:'dormitory_1',currentIndex:3,timeStampMicros:0}),
   B:new MowerOperatorState({name:'B',room:'room_1_2',index:0,group:'g',replacement:['R2'],operatorType:'high',restingPriority:'high',mood:14,currentRoom:'dormitory_1',currentIndex:4,timeStampMicros:0}),
   R1:new MowerOperatorState({name:'R1',mood:24,timeStampMicros:0}),
   R2:new MowerOperatorState({name:'R2',mood:24,timeStampMicros:0}),
  }
  const data=new MowerSchedulingData({
   operators,
   plan:{room_1_1:['A'],room_1_2:['B'],dormitory_1:['Free','Free','Free','Free','Free']},
   dorms:[new MowerDormState(['dormitory_1',3],'A',toMowerMicros(.133333333)),new MowerDormState(['dormitory_1',4],'B',toMowerMicros(4))],
   nowMicros:0,policy:{restingThreshold:.65},
  })
  const queue=new MowerTaskQueue()
  planMowerMetadata(data,queue)
  const ordinary=queue.tasks.find(task=>task.type===T.SHIFT_ON)
  expect(ordinary).toBeDefined()
  expect(fromMowerMicros(ordinary!.timeMicros)).toBeLessThan(.01)
  // The same rest unit has just been returned and sent back to bed.
  data.recentShiftOnByRestUnit.set('group:g',0)
  planMowerMetadata(data,queue)
  const returning=queue.tasks.find(task=>task.type===T.SHIFT_ON)
  expect(returning).toBeDefined()
  // B reaches the integer ordinary-resting threshold of 15 after 0.4 h.
  expect(fromMowerMicros(returning!.timeMicros)).toBeGreaterThan(.4)
  const due=returning!.timeMicros
  for(const op of [operators.A,operators.B]){
   const bed=data.dorms.find(b=>b.name===op.name)!
   op.mood=Math.min(24,op.mood+(24-op.mood)*due/bed.timeMicros!)
   op.timeStampMicros=due
   op.currentRoom=op.room
   op.currentIndex=op.index
   bed.reset()
  }
  data.nowMicros=due
  expect(mowerResting(data,new MowerTaskQueue())).toEqual({})
 })
})
