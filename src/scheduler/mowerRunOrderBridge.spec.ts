import {describe,it,expect} from 'vitest'
import {MowerTaskQueue} from './mowerTaskQueue'
import {planDefaultRunOrder,type RunOrderPlanningState,type RunOrderPlanningSeam,type RunOrderIORequest} from './mowerRunOrderPlanning'
import {bridgeMowerNativeIO} from './mowerRunOrderBridge'
function scenario(){
  let clock=0
  const state:RunOrderPlanningState={plan:{room_1_1:[{replacement:['但书']}]},runOrderRooms:['room_1_1'],queue:new MowerTaskQueue(),configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}
  const seam:RunOrderPlanningSeam={nowMicros:()=>clock,currentDormOccupants:()=>undefined,scheduling:{}}
  return {state,seam,advance:(micros:number)=>{clock+=micros}}
}
describe('native scheduling continuation shares the host clock',()=>{
 it('reads after host advancement and freezes the deadline before returning to main',()=>{
  const {state,seam,advance}=scenario(),observations:string[]=[]
  const duration={ 'enter-room':200_000,'wait-interface':0,'read-order':300_000,'return-main':500_000,drone:0 }
  const steps=bridgeMowerNativeIO(planDefaultRunOrder(state,seam,'room_1_1'),request=>({
   delayMicros:duration[request.kind],
   observe:()=>{observations.push(request.kind);return {observedAtMicros:seam.nowMicros(),...(request.kind==='read-order'?{absoluteDueMicros:900_123_456}:{})}}
  }))
  let next=steps.next()
  let issued=0
  while(!next.done){
   expect(observations).toHaveLength(issued++)
   const before=observations.length
   advance(next.value.delayMicros)
   next=steps.next()
   expect(observations).toHaveLength(before+1)
  }
  expect(observations).toEqual(['enter-room','wait-interface','read-order','return-main'])
  expect(seam.nowMicros()).toBe(1_000_000)
  expect(state.queue.tasks[0]!.timeMicros).toBe(720_123_456)
  expect(next.value).toBe(state.queue.tasks[0])
 })
 it('does not read before an I/O continuation is resumed',()=>{
  const {state,seam}=scenario()
  let reads=0
  const steps=bridgeMowerNativeIO(planDefaultRunOrder(state,seam,'room_1_1'),()=>({delayMicros:500_000,observe:()=>{reads++;return {observedAtMicros:seam.nowMicros()}}}))
  expect(steps.next().done).toBe(false)
  expect(reads).toBe(0)
  steps.return(undefined)
  expect(reads).toBe(0);expect(state.queue.tasks).toHaveLength(0)
 })
 it.each([-1,NaN,1.5,Infinity])('rejects invalid host durations %s before mutating the queue',delay=>{
  const {state,seam}=scenario()
  const steps=bridgeMowerNativeIO(planDefaultRunOrder(state,seam,'room_1_1'),()=>({delayMicros:delay,observe:()=>({observedAtMicros:0})}))
  expect(()=>steps.next()).toThrow('duration')
  expect(state.queue.tasks).toHaveLength(0)
 })
 it('propagates real observation failures and leaves an unread task uncreated',()=>{
  const {state,seam}=scenario()
  const steps=bridgeMowerNativeIO(planDefaultRunOrder(state,seam,'room_1_1'),(_request:RunOrderIORequest)=>({delayMicros:0,observe:()=>{throw new Error('unavailable timer')}}))
  steps.next()
  expect(()=>steps.next()).toThrow('unavailable timer')
  expect(state.queue.tasks).toHaveLength(0)
 })
 it('delivers actual I/O errors to the native generator catch before rethrowing',()=>{
  const original={room_1_1:['但书']},task={plan:{room_1_1:[] as string[]}}
  function* finishing():Generator<{kind:string;room:string},void,{observedAtMicros:number}>{
   try{yield {kind:'drone',room:'room_1_1'}}
   catch(error){task.plan=original;throw error}
  }
  const steps=bridgeMowerNativeIO(finishing(),()=>({delayMicros:500_000,observe:()=>{throw new Error('device failure')}}))
  steps.next()
  expect(()=>steps.next()).toThrow('device failure')
  expect(task.plan).toBe(original)
 })

})
