import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-task-protection.json'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {scheduleMowerTasks} from './mowerTaskScheduling'
describe('native alpha priority and dorm protection',()=>{
 for(const fixture of oracle.cases)it(fixture.name,()=>{
  const tasks=fixture.input.map(t=>new MowerTask({type:T[t.type as keyof typeof T],time:t.time,plan:structuredClone(t.plan) as Record<string,string[]>,metadata:t.metadata,strictMoodLimit:t.strict})),original=[...tasks]
  if(fixture.name==='fill-simplification')tasks[0]!.dormFillPlan={dormitory_1:['Current','B']}
  for(let i=0;i<(fixture.name==='strict-deadline-stable'?2:1);i++)scheduleMowerTasks(tasks,0,{alpha:true})
  expect(tasks.map(t=>({index:original.indexOf(t),type:t.type.key,timeMicros:t.timeMicros,plan:t.plan,metadata:t.metadata,simple:t.simpleDormFill,targets:t.releaseDormTargets()}))).toEqual(fixture.output)
 })
})
