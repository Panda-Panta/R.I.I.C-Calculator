import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-run-selection-alpha.json'
import {MowerTask} from './mowerTaskQueue'
import {calibrateMowerRunSelection} from './mowerRunSelection'
import type {MowerRunOrderFinishingObservation,MowerRunOrderFinishingRequest} from './mowerRunOrderFinishing'
function run(remaining:number,adjusted=false,same=false,chooseError=0,restorationCount=1,bufferSeconds=15){
 const task=new MowerTask({time:-1/3600,adjusted}),trace:MowerRunOrderFinishingRequest[]=[]
 let clock=2_000_000
 const steps=calibrateMowerRunSelection({task,room:'room_1_1',same,chooseError,restorationCount,bufferSeconds,configuredDelayMinutes:3},{nowMicros:()=>clock})
 let next=steps.next()
 while(!next.done){const request=next.value;trace.push(request);if(request.kind==='back')clock+=request.intervalSeconds*1_000_000
  const observation:MowerRunOrderFinishingObservation={kind:request.kind,observedAtMicros:clock,value:request.kind==='read-remaining'?remaining:null}
  next=steps.next(observation)
 }
 return {task,trace,result:next.value,clock}
}
describe('native preselection calibration at agent_arrange_room 7623-7648',()=>{
 it('reads before selection, updates the existing task and performs the native one second back',()=>{
  const out=run(120)
  expect(out.task.timeMicros).toBe(-58_000_000)
  expect(out.trace).toEqual([{kind:'read-remaining'},{kind:'back',intervalSeconds:1},{kind:'turn-on-room-detail',room:'room_1_1'}])
  expect(out.clock).toBe(3_000_000);expect(out.result).toBe(true)
 })
 it('preserves a future calibrated task deadline without replacing task identity',()=>{
  const out=run(200);expect(out.task.timeMicros).toBe(22_000_000);expect(out.result).toBe(true)
 })
 it.each([0,-1,780,781])('aborts unadjusted missed order %s without a back or selection',remaining=>{
  const out=run(remaining)
  expect(out.result).toBe(false);expect(out.task.timeMicros).toBe(-1_000_000)
  expect(out.trace).toEqual([{kind:'read-remaining'},{kind:'notify-missed-order',message:'检测到漏单！',level:'WARNING'},{kind:'reset-room-time',room:'room_1_1'}])
 })
 it.each([0,-1,780])('adjusted invalid timer %s reenters without rewriting deadline',remaining=>{
  const out=run(remaining,true);expect(out.result).toBe(true);expect(out.task.timeMicros).toBe(-1_000_000);expect(out.trace.map(r=>r.kind)).toEqual(['read-remaining','back','turn-on-room-detail'])
 })
 it.each([[true,0,1,15],[false,1,1,15],[false,0,0,15],[false,0,2,15],[false,0,1,0]])('skips excluded native branch %j',(same,chooseError,count,buffer)=>{
  const out=run(120,false,same as boolean,chooseError as number,count as number,buffer as number)
  expect(out.trace).toEqual([]);expect(out.result).toBe(true)
 })
})

describe('actual whole agent_arrange_room oracle preselection boundaries',()=>{
 for(const entry of oracle.cases)it(entry.name,()=>{
  let clock=0
  const input=entry.input,task=new MowerTask({adjusted:'adjusted' in input?input.adjusted:false})
  const steps=calibrateMowerRunSelection({task,room:'room_1_1',same:input.current===input.target,chooseError:0,restorationCount:1,bufferSeconds:input.buffer,configuredDelayMinutes:3},{nowMicros:()=>clock})
  let next=steps.next()
  while(!next.done){const request=next.value
   if(request.kind==='back')clock+=request.intervalSeconds*1_000_000
   next=steps.next({kind:request.kind,observedAtMicros:clock,value:request.kind==='read-remaining'&&'remaining' in input?input.remaining![0]:null})
  }
  expect({deadline:task.timeMicros,timeMicros:clock,maySelect:next.value}).toEqual(entry.expected)
 })
})
