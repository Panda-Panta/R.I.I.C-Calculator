import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-run-entry-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {prepareMowerRunEntry} from './mowerRunLifecycle'
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