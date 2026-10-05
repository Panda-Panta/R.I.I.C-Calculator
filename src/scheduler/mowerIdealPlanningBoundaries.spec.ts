import {describe,expect,it} from 'vitest'
import {protectMowerAlphaTasks} from './mowerAlphaTaskProtection'
import {planMowerCorrection} from './mowerCorrection'
import {mergeMowerAlphaReleases} from './mowerDormTasks'
import {MowerOperatorState} from './mowerOperatorState'
import {mowerPlanningHasNearTask} from './mowerOrdinaryPlanning'
import {refreshMowerRunOrderTime} from './mowerRunOrderRefresh'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros,type MowerTaskType} from './mowerTaskQueue'
import {scheduleMowerTasks} from './mowerTaskScheduling'

const ideal={adjustForRunOrders:false}
const orderWakeTypes=[T.RUN_ORDER,T.REFRESH_TIME]
const seconds=(value:number)=>value/3600
function withTasks(...tasks:MowerTask[]):MowerTaskQueue {
 const queue=new MowerTaskQueue();queue.tasks=tasks;return queue
}
function nearbyOrder(type:MowerTaskType=T.RUN_ORDER):MowerTask {
 return new MowerTask({time:seconds(10),type,metadata:'room_1_1'})
}
function misplacedPrimary():MowerSchedulingData {
 return new MowerSchedulingData({
  plan:{room_1_1:['A']},dorms:[],nowMicros:0,
  operators:{
   A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,operatorType:'high',mood:24,timeStampMicros:0}),
   B:new MowerOperatorState({name:'B',currentRoom:'room_1_1',currentIndex:0,mood:24,timeStampMicros:0}),
  },
 })
}
function releasePair(type:MowerTaskType=T.RUN_ORDER) {
 const early=new MowerTask({time:0,type:T.RELEASE_DORM,metadata:'A',plan:{dormitory_1:['Current','Current','Current','Free','Current']}})
 const late=new MowerTask({time:seconds(480),type:T.RELEASE_DORM,metadata:'B',plan:{dormitory_1:['Current','Current','Current','Current','Free']}})
 const order=new MowerTask({time:seconds(240),type,metadata:'room_1_1'})
 return {early,late,order}
}

describe('ideal run-order wakes at native planning boundaries',()=>{
 it.each(orderWakeTypes)('can query real pending tasks past $key while retaining the native unfiltered query',type=>{
  const order=nearbyOrder(type),swap=new MowerTask({time:seconds(12),type:T.SWAP_SUPPORT}),queue=withTasks(order,swap)
  expect(queue.find({time:seconds(15)})).toBe(order)
  expect(queue.find({time:seconds(15),ignoreRunOrders:true})).toBe(swap)
  expect(queue.tasks).toEqual([order,swap])
 })

 it.each(orderWakeTypes)('does not block ordinary planning for a nearby ideal $key wake',type=>{
  const data=misplacedPrimary(),order=nearbyOrder(type),queue=withTasks(order)
  expect(mowerPlanningHasNearTask(data,queue)).toBe(true)
  expect(mowerPlanningHasNearTask(data,queue,ideal)).toBe(false)
  expect(queue.tasks).toEqual([order])
  queue.tasks.push(new MowerTask({time:seconds(12),type:T.SWAP_SUPPORT}))
  expect(mowerPlanningHasNearTask(data,queue,ideal)).toBe(true)
 })

 it.each(orderWakeTypes)('plans a real position correction despite a nearby ideal $key wake',type=>{
  const nativeQueue=withTasks(nearbyOrder(type))
  expect(planMowerCorrection(misplacedPrimary(),nativeQueue)).toBeUndefined()
  expect(nativeQueue.tasks).toHaveLength(1)
  const order=nearbyOrder(type),queue=withTasks(order),data=misplacedPrimary()
  const correction=planMowerCorrection(data,queue,false,undefined,false,undefined,ideal)
  expect(correction).toBeDefined()
  expect(correction?.type).toBe(T.SELF_CORRECTION)
  expect(correction?.timeMicros).toBe(0)
  expect(correction?.plan).toEqual({room_1_1:['A']})
  expect(queue.tasks).toEqual([order,correction])
  expect(order.timeMicros).toBe(10_000_000)
 })

 it('keeps native correction deferral and independent mastery protection',()=>{
  const nativeQueue=withTasks(nearbyOrder())
  expect(planMowerCorrection(misplacedPrimary(),nativeQueue)).toBeUndefined()
  expect(nativeQueue.tasks).toHaveLength(1)
  const swap=new MowerTask({time:seconds(10),type:T.SWAP_SUPPORT}),idealQueue=withTasks(nearbyOrder(),swap)
  expect(planMowerCorrection(misplacedPrimary(),idealQueue,false,undefined,false,undefined,ideal)).toBeUndefined()
  expect(idealQueue.tasks).toHaveLength(2)
 })

 it.each(orderWakeTypes)('makes ideal $key wakes transparent to alpha release merging',type=>{
  const native=releasePair(type),nativeTasks=[native.early,native.order,native.late]
  mergeMowerAlphaReleases(nativeTasks,10)
  expect(nativeTasks).toEqual([native.early,native.order,native.late])
  expect(native.early.timeMicros).toBe(0)
  const {early,late,order}=releasePair(type),tasks=[early,order,late]
  mergeMowerAlphaReleases(tasks,10,ideal)
  expect(tasks).toEqual([order,late])
  expect(late.timeMicros).toBe(480_000_000)
  expect(late.plan).toEqual({dormitory_1:['Current','Current','Current','Free','Free']})
  expect(late.releaseDormTargets()).toEqual({A:['dormitory_1',3],B:['dormitory_1',4]})
  expect(order.timeMicros).toBe(240_000_000)
  expect(order.plan).toEqual({})
 })

 it('retains native alpha release barriers and real mastery barriers',()=>{
  const native=releasePair(),nativeTasks=[native.early,native.order,native.late]
  mergeMowerAlphaReleases(nativeTasks,10)
  expect(nativeTasks).toEqual([native.early,native.order,native.late])
  expect(native.early.timeMicros).toBe(0)
  const master=releasePair(),swap=new MowerTask({time:seconds(240),type:T.SWAP_SUPPORT}),tasks=[master.early,swap,master.late]
  mergeMowerAlphaReleases(tasks,10,ideal)
  expect(tasks).toEqual([master.early,swap,master.late])
  expect(master.early.timeMicros).toBe(0)
 })

 it.each([false,true])('preserves independent support-swap scheduling with alpha=%s',alpha=>{
  const ordinary=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['B']}})
  const swap=new MowerTask({time:seconds(120),type:T.SWAP_SUPPORT}),tasks=[ordinary,swap]
  scheduleMowerTasks(tasks,0,{...ideal,alpha})
  expect(ordinary.timeMicros).toBe(300_000_000)
  expect(swap.timeMicros).toBe(120_000_000)
  expect(tasks).toEqual([swap,ordinary])
 })

 it.each(orderWakeTypes)('does not let an ideal $key wake suppress the independent fallback',type=>{
  const order=new MowerTask({time:1,type,metadata:'room_1_1'}),queue=withTasks(order)
  expect(queue.ensureFallback(0)).toBeUndefined()
  const fallback=queue.ensureFallback(0,ideal)
  expect(fallback).toBeDefined()
  expect(fallback?.type).toBe(T.NOT_SPECIFIC)
  expect(fallback?.timeMicros).toBe(toMowerMicros(2.5))
  expect(queue.tasks).toEqual([order,fallback])
  expect(queue.ensureFallback(0,ideal)).toBeUndefined()
 })

 it('keeps a native refresh created by a real room change transparent to ideal planning',()=>{
  const order=nearbyOrder(),fallback=new MowerTask({time:2.5,type:T.NOT_SPECIFIC}),queue=withTasks(order,fallback)
  refreshMowerRunOrderTime(queue,0,'room_1_1')
  queue.sort()
  const refresh=queue.tasks[0]!
  expect(refresh.type).toBe(T.REFRESH_TIME)
  expect(refresh.timeMicros).toBe(9_000_000)
  expect(refresh.plan).toEqual({})
  expect(queue.tasks).toEqual([refresh,fallback])
  expect(queue.tasks).not.toContain(order)
  const data=misplacedPrimary()
  expect(mowerPlanningHasNearTask(data,queue)).toBe(true)
  expect(mowerPlanningHasNearTask(data,queue,ideal)).toBe(false)
  const correction=planMowerCorrection(data,queue,false,undefined,false,undefined,ideal)
  expect(correction?.type).toBe(T.SELF_CORRECTION)
  expect(correction?.timeMicros).toBe(0)
  expect(correction?.plan).toEqual({room_1_1:['A']})
  expect(refresh.timeMicros).toBe(9_000_000)
 })

 it('keeps strict release at 30 seconds with an ideal refresh at 100 seconds',()=>{
  const makeRelease=()=>new MowerTask({time:seconds(120),type:T.RELEASE_DORM,strictMoodLimit:true,metadata:'A',plan:{dormitory_1:['Free']}})
  const baseline=makeRelease()
  protectMowerAlphaTasks([baseline],0,ideal)
  expect(baseline.timeMicros).toBe(30_000_000)
  const release=makeRelease(),refresh=new MowerTask({time:seconds(100),type:T.REFRESH_TIME,metadata:'room_1_1'})
  protectMowerAlphaTasks([refresh,release],0,ideal)
  expect(release.timeMicros).toBe(baseline.timeMicros)
  expect(release.moodLimitDeadlineMicros).toBe(120_000_000)
  expect(refresh.timeMicros).toBe(100_000_000)
  const nativeRelease=makeRelease(),nativeRefresh=new MowerTask({time:seconds(100),type:T.REFRESH_TIME,metadata:'room_1_1'})
  protectMowerAlphaTasks([nativeRefresh,nativeRelease],0)
  expect(nativeRelease.timeMicros).toBe(9_000_000)
  expect(nativeRefresh.timeMicros).toBe(100_000_000)
 })

 it('still suppresses fallback when an independent mastery task will wake the scheduler',()=>{
  const swap=new MowerTask({time:1,type:T.SWAP_SUPPORT}),queue=withTasks(swap)
  expect(queue.ensureFallback(0,ideal)).toBeUndefined()
  expect(queue.tasks).toEqual([swap])
 })
})
