import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-default-task-queue-alpha.json'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue,type MowerTaskPlan} from './mowerTaskQueue'
import {executeMowerTaskArrangement,executeMowerTaskArrangementSteps,type MowerTaskExecutionHooks} from './mowerTaskExecutor'
describe('actual alpha agent_arrange and infra_main task continuation',()=>{
 it('retains the original remaining task across BEFORE_DORM and reproduces the source trace',()=>{
  const queue=new MowerTaskQueue(),task=new MowerTask({time:0,type:T.SHIFT_OFF,plan:{room_1_1:['R'],room_1_2:['Y'],dormitory_1:['A','L']}});queue.tasks.push(task)
  const physical:MowerTaskPlan={},trace:unknown[]=[];let interrupted=false
  const hooks:MowerTaskExecutionHooks={backup:(phase,active)=>{trace.push({phase,physical:structuredClone(physical),remainingPlan:structuredClone(active.plan)});if(phase==='BEFORE_DORM'&&!interrupted){interrupted=true;return {changed:true,generated:[new MowerTask({time:0,plan:{room_extra:['Q']}})]}}return {changed:false,generated:[]}},arrangeRoom:(room,names)=>{physical[room]=[...names]},metadata:()=>{trace.push({metadata:'rebuilt'})}}
  expect(executeMowerTaskArrangement(task,queue,hooks)).toBe(false);expect(queue.tasks.includes(task)).toBe(true);expect(task.plan).toEqual(oracle.cases.before_dorm_deferred_resume.remainingDormPlanAfterDeferral)
  queue.sort();expect(queue.tasks[0]).not.toBe(task);expect(executeMowerTaskArrangement(queue.tasks[0]!,queue,hooks)).toBe(true);expect(queue.tasks.includes(task)).toBe(true)
  expect(executeMowerTaskArrangement(task,queue,hooks)).toBe(true);expect(queue.tasks).toEqual([]);expect(trace).toEqual(oracle.cases.before_dorm_deferred_resume.trace)
 })
 it('anchors all generated tasks before the pending queue and preserves their generation order',()=>{
  const q=new MowerTaskQueue(),original=new MowerTask({time:1,type:T.SHIFT_OFF,plan:{room_1_1:['A'],room_1_2:['B']}}),earlier=new MowerTask({time:.5,type:T.FIAMMETTA}),one=new MowerTask({time:1,plan:{room_1_1:['X']}}),two=new MowerTask({time:1,plan:{room_extra:['Y']}});q.tasks.push(original,earlier)
  const hooks:MowerTaskExecutionHooks={backup:()=>({changed:true,generated:[one,two]}),arrangeRoom:()=>{throw Error('must defer before physical move')},metadata:()=>{throw Error('must defer before metadata')}}
  expect(executeMowerTaskArrangement(original,q,hooks)).toBe(false);q.sort();expect(q.tasks.slice(0,2)).toEqual([one,two]);expect(one.timeMicros).toBe(earlier.timeMicros-2);expect(two.timeMicros).toBe(earlier.timeMicros-1);expect(original.plan).toEqual({room_1_2:['B']})
 })
 it('suppresses the original dorm room superseded by a BEFORE_DORM generated task',()=>{
  const q=new MowerTaskQueue(),t=new MowerTask({time:0,type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['A'],dormitory_2:['B']}});q.tasks.push(t);const moved:string[]=[]
  const hooks:MowerTaskExecutionHooks={backup:phase=>({changed:phase==='BEFORE_DORM',generated:phase==='BEFORE_DORM'?[new MowerTask({time:0,plan:{dormitory_1:['Z']}})]:[]}),arrangeRoom:room=>{moved.push(room)},metadata:()=>{throw Error('must not finish interrupted task')}}
  expect(executeMowerTaskArrangement(t,q,hooks)).toBe(false);expect(moved).toEqual(['room_1_1']);expect(t.plan).toEqual({dormitory_2:['B']});expect(q.tasks.includes(t)).toBe(true)
 })
 it('does not run BEFORE_PLANNING for SHIFT_ON default get_time=false',()=>{
  const q=new MowerTaskQueue(),t=new MowerTask({time:0,type:T.SHIFT_ON,plan:{room_1_1:['A']}});q.tasks.push(t);const phases:string[]=[]
  expect(executeMowerTaskArrangement(t,q,{backup:p=>{phases.push(p);return {changed:false,generated:[]}},arrangeRoom:()=>{},metadata:()=>{throw Error('return task must not use downshift metadata hook')}})).toBe(true);expect(phases).toEqual(['BEFORE_WORK'])
 })
})

it('uses prepare_release_dorm get_time for a validated default release',()=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type:T.RELEASE_DORM,plan:{dormitory_1:['Free']},metadata:'A'});q.tasks.push(t);const phases:string[]=[];let metadata=0
 expect(executeMowerTaskArrangement(t,q,{prepareRelease:()=>true,backup:p=>{phases.push(p);return {changed:false,generated:[]}},arrangeRoom:()=>{},metadata:()=>{metadata++}})).toBe(true);expect(phases).toEqual(['BEFORE_DORM','BEFORE_PLANNING']);expect(metadata).toBe(1)
})
it('consumes an invalid release with its cleared plan without touching the new resident',()=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type:T.RELEASE_DORM,plan:{dormitory_1:['Free']},metadata:'old'});q.tasks.push(t)
 expect(executeMowerTaskArrangement(t,q,{prepareRelease:task=>{task.plan={};return false},backup:()=>{throw Error('cleared task has no entry phase')},arrangeRoom:()=>{throw Error('old resident must not release new resident')},metadata:()=>{throw Error('get_time=false')}})).toBe(true);expect(q.tasks).toEqual([])
})
it('anchors only newly created SELF_CORRECTION tasks after BEFORE_PLANNING',()=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R']}}),old=new MowerTask({time:2,type:T.SELF_CORRECTION}),backup=new MowerTask({time:1,plan:{room_extra:['Q']}}),fresh=new MowerTask({time:3,type:T.SELF_CORRECTION}),reorder=new MowerTask({time:4,type:T.RE_ORDER});q.tasks.push(t,old)
 expect(executeMowerTaskArrangement(t,q,{backup:p=>({changed:p==='BEFORE_PLANNING',generated:p==='BEFORE_PLANNING'?[backup]:[]}),arrangeRoom:()=>{},metadata:()=>{},corrections:()=>[old,fresh,reorder]})).toBe(true);expect(old.time).toBe(2);expect(reorder.time).toBe(4);expect(fresh.timeMicros).toBe(backup.timeMicros-1)
})

it('consumes an initially empty SHIFT_OFF without downshift planning phases',()=>{const q=new MowerTaskQueue(),t=new MowerTask({type:T.SHIFT_OFF});q.tasks.push(t);expect(executeMowerTaskArrangement(t,q,{backup:()=>{throw Error('no arrangement phases')},arrangeRoom:()=>{throw Error('empty')},metadata:()=>{throw Error('no get_time')} })).toBe(true);expect(q.tasks).toEqual([])})

it.each([T.SHIFT_OFF,T.SHIFT_ON])('finishes an activated shift when full preview removes every physical move: %s',type=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type}),returnTask=new MowerTask({time:1,type:T.SHIFT_ON,plan:{room_1_1:['A']}});q.tasks=[t,returnTask]
 t.backupShiftIntent={room_1_1:['R']};t.backupShiftConditions=[true];t.backupShiftActive=true
 const trace:string[]=[]
 expect(executeMowerTaskArrangement(t,q,{alpha:true,backup:phase=>{expect(t.backupShiftActive).toBe(false);trace.push(phase);return {changed:false,generated:[]}},arrangeRoom:()=>{throw Error('preview requires no physical move')},metadata:()=>{trace.push('metadata')}})).toBe(true)
 expect(trace).toEqual(['BEFORE_PLANNING','metadata','AFTER_PLANNING'])
 expect(t.backupShiftActive).toBe(false);expect(q.tasks).toEqual([returnTask])
})

it('keeps one arrangement and its phase flags alive across the source room-return clock boundaries',()=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['A']}});q.tasks.push(t)
 let now=0;const trace:{what:string;at:number}[]=[]
 const steps=executeMowerTaskArrangementSteps(t,q,{backup:p=>{trace.push({what:p,at:now});return {changed:false,generated:[]}},arrangeRoom:room=>{trace.push({what:room,at:now})},metadata:()=>{trace.push({what:'metadata',at:now})}})
 expect(steps.next()).toEqual({done:false,value:{room:'room_1_1',delayMicros:500_000}})
 expect(t.plan).toEqual({dormitory_1:['A']});expect(q.tasks).toContain(t)
 now=500_000
 expect(steps.next()).toEqual({done:false,value:{room:'dormitory_1',delayMicros:500_000}})
 expect(q.tasks).toContain(t);expect(trace.map(v=>v.what)).not.toContain('BEFORE_PLANNING')
 now=1_000_000
 expect(steps.next()).toEqual({done:true,value:true});expect(q.tasks).not.toContain(t)
 expect(trace).toEqual([{what:'BEFORE_WORK',at:0},{what:'room_1_1',at:0},{what:'BEFORE_DORM',at:500_000},{what:'dormitory_1',at:500_000},{what:'BEFORE_PLANNING',at:1_000_000},{what:'metadata',at:1_000_000}])
})

it('retains the alpha process lock and only uncommitted rooms when a priority deadline defers a dorm',()=>{
 const q=new MowerTaskQueue(),t=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['A'],dormitory_2:['B']}});q.tasks=[t]
 let deferred=true;const committed:string[]=[],hooks:MowerTaskExecutionHooks&{deferRoom:(room:string)=>boolean}={alpha:true,protectShift:true,
  backup:()=>({changed:false,generated:[]}),deferRoom:room=>room==='dormitory_2'&&deferred,
  arrangeRoom:room=>{committed.push(room)},metadata:()=>{expect(t.backupShiftActive).toBe(false)}}
 expect(executeMowerTaskArrangement(t,q,hooks)).toBe(false)
 expect(t.plan).toEqual({dormitory_2:['B']});expect(t.backupShiftActive).toBe(true);expect(q.tasks).toContain(t)
 deferred=false;expect(executeMowerTaskArrangement(t,q,hooks)).toBe(true)
 expect(committed).toEqual(['room_1_1','dormitory_1','dormitory_2']);expect(t.backupShiftActive).toBe(false);expect(q.tasks).not.toContain(t)
})
