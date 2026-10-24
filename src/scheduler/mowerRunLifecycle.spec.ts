import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-run-entry-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {prepareMowerRunEntry,nextMowerRunRecoveryMicros} from './mowerRunLifecycle'
describe('actual default Mower run force entry',()=>{
 for(const c of oracle.predicateCases)it(c.input.id,()=>{
  const q=new MowerTaskQueue()
  if(c.input.id!=='empty'){const t=new MowerTask();t.timeMicros=c.input.id==='exact-now'?0:c.input.id==='past-one-microsecond'?-1:3_600_000_000;q.tasks.push(t)}
  const old=q.tasks.length;prepareMowerRunEntry(q,0)
  expect(q.tasks.length-old).toBe(c.output.added);expect(q.tasks.map(t=>t.timeMicros)).toEqual(c.output.timesMicros)
 })
 it('retains source protected types and appends a fresh empty task after a 15 minute stale clear',()=>{
  const q=new MowerTaskQueue();const old=new MowerTask({type:T.SHIFT_ON,plan:{room:['A']}});old.timeMicros=-900_000_001
  const protectedTask=new MowerTask({time:1,type:T.SKILL_UPGRADE});q.tasks=[old,protectedTask]
  prepareMowerRunEntry(q,0);expect(q.tasks[0]).toBe(protectedTask);expect(q.tasks).not.toContain(old);expect(q.tasks[1]!.timeMicros).toBe(0)
 })
 it('does not create an entry task when any skill-upgrade task is retained',()=>{
  const q=new MowerTaskQueue();q.tasks=[new MowerTask({time:1,type:T.SKILL_UPGRADE})];prepareMowerRunEntry(q,0);expect(q.tasks).toHaveLength(1)
 })
})

describe('October 24 native stale-task preservation',()=>{
 it('preserves an unconfirmed group target and its original deadline while rebuilding stale ordinary work',()=>{
  const queue=new MowerTaskQueue(),pending=new MowerTask({type:T.SHIFT_OFF,time:0,plan:{room_1_1:['cover']}})
  pending.groupShiftExpected={'room_1_1\u00000':'cover'}
  const stale=new MowerTask({type:T.SELF_CORRECTION,time:0})
  queue.tasks=[pending,stale]
  prepareMowerRunEntry(queue,3_600_000_000,true)
  expect(queue.tasks).toContain(pending)
  expect(pending.timeMicros).toBe(0)
  expect(queue.tasks).not.toContain(stale)
  queue.tasks=[pending]
  expect(nextMowerRunRecoveryMicros(queue,0,true)).toBe(1)
 })
 it('preserves the original personal-limit task and deadline when ordinary stale work is rebuilt',()=>{
  const queue=new MowerTaskQueue(),release=new MowerTask({type:T.RELEASE_DORM,time:0,plan:{dormitory_1:['Free']},strictMoodLimit:true})
  const stale=new MowerTask({type:T.SELF_CORRECTION,time:0,plan:{room_1_1:['A']}})
  queue.tasks=[release,stale]
  prepareMowerRunEntry(queue,3_600_000_000,true)
  expect(queue.tasks).toContain(release)
  expect(release.timeMicros).toBe(0)
  expect(queue.tasks).not.toContain(stale)
 })
 it('does not repeatedly rebuild a queue solely because personal release is overdue',()=>{
  const queue=new MowerTaskQueue(),release=new MowerTask({type:T.RELEASE_DORM,time:0,plan:{dormitory_1:['Free']},strictMoodLimit:true})
  queue.tasks=[release]
  prepareMowerRunEntry(queue,3_600_000_000,true)
  expect(queue.tasks).toEqual([release])
 })
})
