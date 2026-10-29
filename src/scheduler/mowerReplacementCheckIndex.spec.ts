import {describe,expect,it} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerTask,MowerTaskQueue,toMowerMicros} from './mowerTaskQueue'
import {runMowerReplacementCheck,syncMowerReplacementChecks} from './mowerReplacementCheck'

function scene() {
 const operators={
  owner:new MowerOperatorState({name:'owner',operatorType:'high',room:'room_1_1',index:0,replacement:['first','last','next'],currentRoom:'dorm1',currentIndex:0,mood:8,timeStampMicros:0}),
  first:new MowerOperatorState({name:'first',currentRoom:'room_1_1',currentIndex:0,mood:12,timeStampMicros:0,depletionRate:2,lowerLimit:4}),
  last:new MowerOperatorState({name:'last',currentRoom:'room_1_1',currentIndex:0,mood:14,timeStampMicros:0,depletionRate:2,lowerLimit:4}),
  next:new MowerOperatorState({name:'next',mood:24,timeStampMicros:0}),
 }
 const data=new MowerSchedulingData({alpha:true,operators,plan:{room_1_1:['owner'],dorm1:['Free','Free','Free']},dorms:[],nowMicros:0})
 return {data,operators,queue:new MowerTaskQueue()}
}

describe('replacement-check discovery position index',()=>{
 it('preserves the first duplicate actor and a same-actor concrete plan does not suppress its check',()=>{
  const {data,queue}=scene()
  const sameOccupant=new MowerTask({time:0,plan:{room_1_1:['first']}})
  queue.tasks.push(sameOccupant)
  expect(data.currentRoom('room_1_1',true)).toEqual(['last'])
  expect(data.currentOperator('room_1_1',0)?.name).toBe('first')
  syncMowerReplacementChecks(data,queue)
  const check=queue.tasks.find(task=>task.replacementCheck)!
  expect(check.replacementCheck!.target).toEqual({room:'room_1_1',index:0,owner:'owner',cover:'first'})
  check.timeMicros=toMowerMicros(3)
  data.nowMicros=toMowerMicros(1)
  syncMowerReplacementChecks(data,queue)
  expect(queue.tasks).toEqual([sameOccupant,check])
  expect(check.timeMicros).toBe(toMowerMicros(3))
 })

 it('rebuilds positions after actors move between sync calls and removes the stale target',()=>{
  const {data,operators,queue}=scene()
  syncMowerReplacementChecks(data,queue)
  const firstCheck=queue.tasks[0]!
  operators.first.currentRoom='';operators.first.currentIndex=-1
  syncMowerReplacementChecks(data,queue)
  expect(queue.tasks).not.toContain(firstCheck)
  expect(queue.tasks).toHaveLength(1)
  expect(queue.tasks[0]!.replacementCheck!.target.cover).toBe('last')
  operators.last.currentRoom='';operators.last.currentIndex=-1
  syncMowerReplacementChecks(data,queue)
  expect(queue.tasks).toEqual([])
 })

 it('keeps independent positions and task order while a due replacement blocks only its own slot',()=>{
  const {data,queue}=scene()
  for(const [name,room,index] of [['second','room_1_1',1],['third','room_2_1',0]] as const){
   data.plan[room]??=[];data.plan[room]![index]=`${name}-owner`
   data.operators[`${name}-owner`]=new MowerOperatorState({name:`${name}-owner`,operatorType:'high',room,index,replacement:[`${name}-cover`,`${name}-next`],currentRoom:'dorm2',currentIndex:index})
   data.operators[`${name}-cover`]=new MowerOperatorState({name:`${name}-cover`,currentRoom:room,currentIndex:index,mood:12,timeStampMicros:0})
   data.operators[`${name}-next`]=new MowerOperatorState({name:`${name}-next`,mood:24,timeStampMicros:0})
  }
  syncMowerReplacementChecks(data,queue)
  const original=[...queue.tasks]
  expect(original.map(task=>task.replacementCheck!.target.cover)).toEqual(['first','second-cover','third-cover'])
  queue.tasks.unshift(new MowerTask({time:0,plan:{room_1_1:['Current','second-next']}}))
  syncMowerReplacementChecks(data,queue)
  expect(queue.tasks.filter(task=>task.replacementCheck)).toEqual([original[0],original[2]])
  expect(data.currentOperator('room_1_1',1)?.name).toBe('second-cover')
  expect(data.currentOperator('room_2_1',0)?.name).toBe('third-cover')
 })

 it('does not index positions before the existing alpha and initial-read barriers',()=>{
  const {data,queue}=scene()
  let reads=0
  data.operators=new Proxy(data.operators,{ownKeys:target=>{reads++;return Reflect.ownKeys(target)}})
  data.alpha=false
  syncMowerReplacementChecks(data,queue)
  data.alpha=true
  syncMowerReplacementChecks(data,queue,{initialMoodReadPending:true})
  expect(reads).toBe(0)
  expect(queue.tasks).toEqual([])
 })

 it('keeps real room observations current when an actor changes after target discovery',()=>{
  const {data,operators,queue}=scene()
  syncMowerReplacementChecks(data,queue)
  const check=queue.tasks[0]!
  operators.first.moodIsPrediction=true
  let reads=0
  const done=runMowerReplacementCheck(data,queue,check,{readRoom:()=>{
   reads++;operators.first.currentRoom='';operators.first.currentIndex=-1
   operators.last.mood=10;operators.last.timeStampMicros=data.nowMicros
  }})
  expect(reads).toBe(1)
  expect(done).toBe(true)
  expect(data.currentOperator('room_1_1',0)?.name).toBe('last')
  expect(check.executionFailure).toBeUndefined()
  expect(queue.tasks).toEqual([check])
 })

 it('discovers many occupied primary slots with a linear number of position reads',()=>{
  const operators:Record<string,MowerOperatorState>={},plan:Record<string,string[]>={}
  let roomReads=0
  const observe=(op:MowerOperatorState)=>new Proxy(op,{get:(target,property,receiver)=>{
   if(property==='currentRoom')roomReads++
   return Reflect.get(target,property,receiver)
  }})
  for(let index=0;index<408;index++)operators[`idle-${index}`]=observe(new MowerOperatorState({name:`idle-${index}`}))
  for(let index=0;index<24;index++){
   const room=`room_${Math.floor(index/3)}`,slot=index%3,name=`primary-${index}`
   plan[room]??=[];plan[room]![slot]=name
   operators[name]=observe(new MowerOperatorState({name,operatorType:'high',room,index:slot,currentRoom:room,currentIndex:slot}))
  }
  const data=new MowerSchedulingData({alpha:true,operators,plan,dorms:[],nowMicros:0}),queue=new MowerTaskQueue()
  roomReads=0
  syncMowerReplacementChecks(data,queue)
  expect(queue.tasks).toEqual([])
  // No ordinary covers means no snapshots: this isolates position discovery,
  // whose cost must not rescan the 432-person inventory for every primary slot.
  expect(roomReads).toBeLessThanOrEqual(Object.keys(operators).length*2)
 })
})
