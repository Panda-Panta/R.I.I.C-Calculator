import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-planning-entry.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {fillMowerAlphaEmptyDorms} from './mowerAlphaDormPlanning'
import {prepareMowerRunEntry} from './mowerRunLifecycle'

describe('native alpha pre-dispatch and recovery entry',()=>{
 for(const c of oracle.entry)it(c.kind,()=>{
  const operators={A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,currentRoom:'room_1_1',currentIndex:0,operatorType:'high',restingPriority:'high',replacement:['R'],mood:c.kind==='due-fill-primary-needs-rest'?4:24,timeStampMicros:0}),R:new MowerOperatorState({name:'R',mood:10,timeStampMicros:0}),...Object.fromEntries(['K1','K2'].map((name,index)=>[name,new MowerOperatorState({name,room:'dormitory_1',index,currentRoom:'dormitory_1',currentIndex:index,operatorType:'high',mood:24,timeStampMicros:0})]))}
  const data=new MowerSchedulingData({alpha:true,plan:{room_1_1:['A'],dormitory_1:['K1','K2','Free','Free','Free']},operators,dorms:[new MowerDormState(['dormitory_1',2])],nowMicros:0}),queue=new MowerTaskQueue()
  if(c.kind.includes('fill')){const fill=new MowerTask({type:T.FILL_DORM,time:c.kind==='future-fill'?1:0,plan:{dormitory_1:['Current','Current','R','Current','Current']}});fill.dormFillPlan=structuredClone(fill.plan);queue.tasks=[fill]}
  if(c.kind==='due-shift')queue.tasks=[new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['A']}})]
  expect(fillMowerAlphaEmptyDorms(data,queue,{},c.kind==='primary-planned')).toBe(c.result)
  expect(queue.tasks.map(t=>({type:t.type.key,timeMicros:t.timeMicros,plan:t.plan}))).toEqual(c.tasks)
 })
 it('keeps critical reservations and future explicit work when reconstructing a stale queue',()=>{
  const queue=new MowerTaskQueue();queue.tasks=oracle.stale.input.map(([kind,seconds])=>new MowerTask({type:T[kind as keyof typeof T],time:Number(seconds)/3600}))
  prepareMowerRunEntry(queue,0,true)
  expect(queue.tasks.map(t=>({type:t.type.key,timeMicros:t.timeMicros}))).toEqual(oracle.stale.tasks)
 })
})
