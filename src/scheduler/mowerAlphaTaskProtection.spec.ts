import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-task-protection.json'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {protectMowerAlphaTasks,sortMowerAlphaDispatch} from './mowerAlphaTaskProtection'
import {scheduleMowerTasks} from './mowerTaskScheduling'
describe('native alpha priority and dorm protection',()=>{
 for(const fixture of oracle.cases)it(fixture.name,()=>{
  const tasks=fixture.input.map(t=>new MowerTask({type:T[t.type as keyof typeof T],time:t.time,plan:structuredClone(t.plan) as Record<string,string[]>,metadata:t.metadata,strictMoodLimit:t.strict})),original=[...tasks]
  if(fixture.name==='fill-simplification')tasks[0]!.dormFillPlan={dormitory_1:['Current','B']}
  for(let i=0;i<(fixture.name==='strict-deadline-stable'?2:1);i++)scheduleMowerTasks(tasks,0,{alpha:true})
  expect(tasks.map(t=>({index:original.indexOf(t),type:t.type.key,timeMicros:t.timeMicros,plan:t.plan,metadata:t.metadata,simple:t.simpleDormFill,targets:t.releaseDormTargets()}))).toEqual(fixture.output)
 })
})

describe('October 24 native personal mood release priority',()=>{
 it('dispatches an overdue personal-limit release before older ordinary work, while due orders remain first',()=>{
  const ordinary=new MowerTask({type:T.SELF_CORRECTION,time:0,plan:{room_1_1:['A']}})
  const release=new MowerTask({type:T.RELEASE_DORM,time:1,plan:{dormitory_1:['Free']},strictMoodLimit:true})
  const order=new MowerTask({type:T.RUN_ORDER,time:1.5})
  const tasks=[ordinary,release,order]
  sortMowerAlphaDispatch(tasks,toMowerMicros(2))
  expect(tasks).toEqual([order,release,ordinary])
 })
 it('uses the current time when an old ordinary task overlaps the personal release window',()=>{
  const old=new MowerTask({type:T.SELF_CORRECTION,time:1,plan:{room_1_1:['A']}})
  const release=new MowerTask({type:T.RELEASE_DORM,time:2.025,plan:{dormitory_1:['Free']},strictMoodLimit:true})
  protectMowerAlphaTasks([old,release],toMowerMicros(2),{adjustForRunOrders:false})
  expect(release.timeMicros).toBe(toMowerMicros(2)-toMowerMicros(1.5/60)-1_000_000)
 })
 it('does not treat an empty routine wake as an operation blocking personal release',()=>{
  const empty=new MowerTask({time:0}),release=new MowerTask({type:T.RELEASE_DORM,time:.1,plan:{dormitory_1:['Free']},strictMoodLimit:true})
  protectMowerAlphaTasks([empty,release],0,{adjustForRunOrders:false})
  expect(release.timeMicros).toBe(toMowerMicros(.1-1.5/60))
 })
})
