import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-retry-lock.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {deferMowerArrangementRetry} from './mowerArrangementRetry'
import {MowerRoomArrangementDeferred} from './mowerNativeErrors'
import {executeMowerTaskArrangement} from './mowerTaskExecutor'
import {recordMowerDormAdmissions} from './mowerShiftCycle'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerOperatorState} from './mowerOperatorState'
describe('native alpha retry and admission state',()=>{
 it('preserves the original deadline, remaining plan and lock with the native bounded backoff',()=>{
  const t=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['A']}}),q=new MowerTaskQueue();q.tasks=[t];t.backupShiftActive=true
  const result=oracle.retries.map(c=>{deferMowerArrangementRetry(t,q,c.room,0);return {room:t.arrangementRetryRoom,count:t.arrangementRetryCount,timeMicros:t.timeMicros,dueMicros:t.arrangementRetryDueMicros,locked:t.backupShiftActive,plan:t.plan}})
  expect(result).toEqual(oracle.retries)
 })
 it('keeps the locked remaining task after a deferred physical selection error',()=>{
  const t=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['A']}}),q=new MowerTaskQueue();q.tasks=[t]
  expect(()=>executeMowerTaskArrangement(t,q,{alpha:true,protectShift:true,backup:()=>({changed:false,generated:[]}),arrangeRoom:room=>{if(room.startsWith('dorm'))throw new MowerRoomArrangementDeferred(room,new Error('recognition'))},metadata:()=>{throw new Error('premature metadata')}})).toThrow(MowerRoomArrangementDeferred)
  expect(t.plan).toEqual({dormitory_1:['A']});expect(t.backupShiftActive).toBe(true);expect(q.tasks[0]).toBe(t)
 })
 for(const [index,c] of oracle.admissions.entries())it('admission '+index,()=>{
  const d=new MowerSchedulingData({alpha:true,plan:{room_1_1:['A'],dormitory_1:['Free']},operators:{A:new MowerOperatorState({name:'A',operatorType:c.high?'high':'low',room:c.high?'room_1_1':'',index:c.high?0:-1})},dorms:[new MowerDormState(['dormitory_1',0])],nowMicros:0})
  const t=new MowerTask({type:T[c.type as keyof typeof T],plan:{dormitory_1:['A']}});if(c.ordinary)t.dormFillPlan={dormitory_1:['A']}
  recordMowerDormAdmissions(d,t,new Map([['A',c.previous as [string,number]]]))
  expect(d.operators.A!.temporaryDormFill).toBe(c.temporary)
 })
})
