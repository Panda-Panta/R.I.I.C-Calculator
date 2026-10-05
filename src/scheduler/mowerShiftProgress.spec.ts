import {describe,expect,it} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerDormState,MowerSchedulingData} from './mowerSchedulingData'
import {MowerShiftPreviewError} from './mowerNativeErrors'
import {projectMowerArrangements} from './mowerObservations'
import {prepareMowerShiftCycle,type MowerShiftModel} from './mowerShiftCycle'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros,type MowerTaskPlan} from './mowerTaskQueue'

const now=toMowerMicros(1)
function fixture(){
 const op=(name:string,room:string,index:number,currentRoom=room,currentIndex=index,mood=24,replacement:string[]=[])=>(new MowerOperatorState({name,room,index,currentRoom,currentIndex,mood,replacement,timeStampMicros:now,operatorType:room?'high':'low'}))
 const a=op('A','room_1',0,'room_1',0,4,['B']),x=op('X','room_2',0,'room_2',0,24,['B']),y=op('Y','room_2',1,'room_2',1,24,['D'])
 x.workaholic=true;y.workaholic=true
 const b=op('B','',-1,'dormitory_1',0,10),d=op('D','',-1,'dormitory_2',0,6)
 const data=new MowerSchedulingData({alpha:true,plan:{room_1:['A'],room_2:['X','Y'],dormitory_1:['Free'],dormitory_2:['Free']},operators:{A:a,X:x,Y:y,B:b,D:d},dorms:[new MowerDormState(['dormitory_1',0],'B',now+toMowerMicros(1)),new MowerDormState(['dormitory_2',0],'D',now+toMowerMicros(1))],nowMicros:now,planConditions:[false]})
 const task=new MowerTask({time:1,type:T.SHIFT_OFF,plan:{room_1:['B'],dormitory_1:['A']}}),queue=new MowerTaskQueue();queue.tasks=[task]
 // An entry action takes both ordinary residents to work. Its temporary plan
 // also invalidates A's cover, so real correction recalls A; exit restores X/Y.
 const model:MowerShiftModel={count:1,evaluate:d=>[d.operators.A!.isResting()],swap:(d,c)=>{
  const next=projectMowerArrangements(d,[]);next.planConditions=[...c];next.operators.A!.replacement=c[0]?[]:['B'];return next
 },transition:(_previous,_next,original,conditions):MowerTaskPlan=>original[0]===conditions[0]?{}:{room_2:conditions[0]?['B','D']:['X','Y']},activate:()=>{}}
 return {data,task,queue,model}
}

describe('alpha complete-preview progress protection',()=>{
 it('rejects canceled off-duty intent with only ordinary bed swaps before mutating task, data or coalesced queue',()=>{
  const {data,task,queue,model}=fixture()
  const fill=new MowerTask({time:1,type:T.FILL_DORM,plan:{dormitory_1:['Free']}});queue.tasks.push(fill)
  const tasks=[...queue.tasks],beforeData=JSON.stringify(data),beforeTask=JSON.stringify(task),deadline=task.timeMicros
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).toThrow(MowerShiftPreviewError)
  expect(JSON.stringify(data)).toBe(beforeData);expect(JSON.stringify(task)).toBe(beforeTask)
  expect(task.timeMicros).toBe(deadline);expect(task.backupShiftActive).toBe(false)
  expect(queue.tasks).toEqual(tasks);expect(queue.tasks[0]).toBe(task);expect(queue.tasks[1]).toBe(fill)
 })

 it('allows normal off-duty progress together with ordinary dorm filling',()=>{
  const {data,task,queue}=fixture();data.planConditions=[]
  data.plan.dormitory_3=['Free'];data.dorms.push(new MowerDormState(['dormitory_3',0]))
  data.operators.E=new MowerOperatorState({name:'E',operatorType:'low',mood:5,timeStampMicros:now})
  const model:MowerShiftModel={count:0,evaluate:()=>[],swap:d=>d,transition:()=>({}),activate:()=>{}}
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.plan.room_1).toEqual(['B']);expect(task.plan.dormitory_1).toEqual(['A'])
  expect(task.plan.dormitory_3).toEqual(['E']);expect(task.dormFillPlan.dormitory_3).toEqual(['E'])
 })

 it('also preserves canceled EXHAUST_OFF work intent rather than consuming its bed swap',()=>{
  const {data,task,queue,model}=fixture();task.type=T.EXHAUST_OFF
  const original=structuredClone(task.plan)
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).toThrow(MowerShiftPreviewError)
  expect(task.plan).toEqual(original);expect(queue.tasks[0]).toBe(task)
 })

 it('allows a stable backup to supersede the old shift and change the working plan',()=>{
  const {data,task,queue}=fixture()
  const model:MowerShiftModel={count:1,evaluate:()=>[true],swap:(d,c)=>{
   const next=projectMowerArrangements(d,[]);next.planConditions=[...c]
   next.plan.room_2=['B','D'];next.operators.A!.replacement=[]
   for(const [index,name] of ['B','D'].entries()){const op=next.operators[name]!;op.room='room_2';op.index=index;op.operatorType='high';op.workaholic=true}
   for(const name of ['X','Y']){const op=next.operators[name]!;op.room='';op.index=-1;op.operatorType='low';op.workaholic=false}
   return next
  },transition:(_previous,_next,original,conditions):MowerTaskPlan=>original[0]===conditions[0]?{}:{room_1:['A'],room_2:['B','D']},activate:()=>{}}
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.backupShiftConditions).toEqual([true]);expect(task.plan.room_2).toEqual(['B','D'])
  // The author's stable backup deliberately keeps A on its original work slot.
  expect(task.plan.room_1).toBeUndefined()
 })

 it('allows EXHAUST_OFF with only explicit dorm targets and no working-to-rest intent',()=>{
  const {data,task,queue,model}=fixture();data.operators.A!.mood=24;task.type=T.EXHAUST_OFF;task.plan={dormitory_1:['D'],dormitory_2:['B']}
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.plan.dormitory_1).toEqual(['D']);expect(task.plan.dormitory_2).toEqual(['B'])
 })

 it('leaves an unresolved Free arrangement to its existing execution boundary',()=>{
  const {data,task,queue,model}=fixture()
  data.plan.dormitory_3=['Free'];data.dorms.push(new MowerDormState(['dormitory_3',0]));task.plan.dormitory_3=['Free']
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.plan.dormitory_3).toEqual(['Free'])
 })

 it('allows an independent FILL_DORM task',()=>{
  const {data,task,queue,model}=fixture();data.operators.A!.mood=24;task.type=T.FILL_DORM;task.plan={dormitory_1:['D'],dormitory_2:['B']};task.dormFillPlan=structuredClone(task.plan)
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.plan.dormitory_1).toEqual(['D']);expect(task.plan.dormitory_2).toEqual(['B'])
 })
})
