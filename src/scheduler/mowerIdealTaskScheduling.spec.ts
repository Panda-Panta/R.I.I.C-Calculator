import {describe,expect,it} from 'vitest'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {scheduleMowerTasks,type MowerTaskSchedulingOptions} from './mowerTaskScheduling'
import {deferMowerAlphaDorm} from './mowerAlphaTaskProtection'

const ideal=(alpha=false):MowerTaskSchedulingOptions=>Object.assign({alpha,enableMastery:false},{adjustForRunOrders:false})

describe('ideal run orders do not adjust roster task timing',()=>{
 it('keeps an ordinary downshift at its original time before a nearby order',()=>{
  const down=new MowerTask({type:T.SHIFT_OFF,plan:{central:['夕'],room_2_2:['多萝西'],dormitory_1:['歌蕾蒂娅']}})
  const order=new MowerTask({time:100/3600,type:T.RUN_ORDER,metadata:'room_1_1'})
  const tasks=[down,order]
  expect(scheduleMowerTasks(tasks,0,ideal())).toBeUndefined()
  expect(down.timeMicros).toBe(0)
  expect(tasks[0]).toBe(down)
  expect(order.timeMicros).toBe(100_000_000)
 })

 it('does not simplify or postpone alpha dorm filling for an ideal order',()=>{
  const fill=new MowerTask({type:T.FILL_DORM,plan:{dormitory_1:['A']}})
  const order=new MowerTask({time:60/3600,type:T.RUN_ORDER,metadata:'room_1_1'})
  const tasks=[fill,order]
  scheduleMowerTasks(tasks,0,ideal(true))
  expect(fill.simpleDormFill).toBe(false)
  expect(fill.timeMicros).toBe(0)
  expect(fill.plan).toEqual({dormitory_1:['A']})
  expect(tasks[0]).toBe(fill)
 })

 it('keeps the room execution boundary free from ideal-order dorm deferral',()=>{
  const down=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['歌蕾蒂娅']}})
  const order=new MowerTask({time:60/3600,type:T.RUN_ORDER,metadata:'room_1_1'})
  expect(deferMowerAlphaDorm(down,[down,order],'dormitory_1',0,ideal(true))).toBe(false)
  expect(down.timeMicros).toBe(0)
 })
})
