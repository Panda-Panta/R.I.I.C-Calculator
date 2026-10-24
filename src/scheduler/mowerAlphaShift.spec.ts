import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-shift-primitives.json'
import currentOracle from './fixtures/mower-displaced-bed-84e3926.json'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {projectMowerArrangements} from './mowerObservations'
import {mowerGetRestingPlan} from './mowerOrdinaryPlanning'
import {mowerCorrectionPlan} from './mowerCorrection'
import {prepareMowerShiftBeds} from './mowerShiftProtection'
import {initializeMowerAlphaMoodLimits,readMowerMoodLimits} from './mowerMoodLimits'
import {prepareMowerShiftCycle,type MowerShiftModel} from './mowerShiftCycle'
import {MowerTask,MowerTaskQueue,toMowerMicros,MOWER_TASK_TYPES as T} from './mowerTaskQueue'

function fixture(standby=false){
 const plan={room_1_1:['A'],room_1_2:['B'],dormitory_1:['K1','K2','Free','Free','Free']}
 const operators:Record<string,MowerOperatorState>={}
 for(const [name,room,index,currentRoom,currentIndex,priority] of [
  ['A','room_1_1',0,'dormitory_1',2,'high'],['B','room_1_2',0,'dormitory_1',3,standby?'standby':'high'],
  ['R','',-1,'room_1_1',0,'low'],['S','',-1,'room_1_2',0,'low'],['N','',-1,'',-1,'low'],
 ] as const)operators[name]=new MowerOperatorState({name,room,index,currentRoom,currentIndex,restingPriority:priority,group:room?'g':'',replacement:room?[name==='A'?'R':'S']:[],operatorType:room?'high':'low',mood:10,timeStampMicros:0})
 const data=new MowerSchedulingData({plan,operators,dorms:[new MowerDormState(['dormitory_1',2],'A',toMowerMicros(3)),new MowerDormState(['dormitory_1',3],'B',toMowerMicros(3)),new MowerDormState(['dormitory_1',4])],nowMicros:0})
 Reflect.set(data,'alpha',true)
 return data
}

describe('alpha primitives over frozen October 3 input cases',()=>{
 it('leaves an empty dynamic bed for candidate driven filling during cached correction',()=>{
  const data=new MowerSchedulingData({alpha:true,plan:{dormitory_1:['Free']},operators:{},dorms:[new MowerDormState(['dormitory_1',0])],nowMicros:0})
  expect(mowerCorrectionPlan(data)).toEqual({})
 })
 for(const [i,test] of oracle.projections.entries())it('uses native projected bed identity and recovery timer '+i,()=>{
  const data=fixture();delete data.operators.B;delete data.operators.S;data.dorms[1]!.reset()
  const before=JSON.stringify(data.dorms)
  const input:Record<string,string[]>={};for(const [room,names] of Object.entries(test.input))if(names)input[room]=names
  const projected=projectMowerArrangements(data,[input])
  expect(projected.dorms.map(b=>({position:b.position,name:b.name,time:b.timeMicros===undefined?null:b.timeMicros/toMowerMicros(1)}))).toEqual(test.output)
  expect(JSON.stringify(data.dorms)).toBe(before)
 })
 it('matches an entire group instead of rejecting a feasible replacement assignment',()=>{
  const data=fixture()
  for(const op of Object.values(data.operators)){op.currentRoom='';op.currentIndex=-1}
  data.dorms.forEach(b=>b.reset())
  data.operators.A!.replacement=['R','S'];data.operators.B!.replacement=['R']
  const plan:Record<string,string[]>={},reserved:string[]=[]
  expect(mowerGetRestingPlan(data,['A','B'],reserved,plan)).toBe(true)
  expect(plan).toEqual({room_1_1:['S'],room_1_2:['R']})
  expect(new Set(reserved).size).toBe(2)
 })
 for(const test of oracle.restore)it('leaves an explicit occupied-bed replacement for the complete alpha cycle, standby='+test.standby,()=>{
  const data=fixture(test.standby),task=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['Current','Current','Current','N','Current']}})
  const before=data.currentRoom('room_1_1',true)
  const intent=structuredClone(task.plan)
  const result=prepareMowerShiftBeds(data,task,[])
  expect(result.ready).toBe(true)
  // Current alpha validates the whole arrangement; the retired local preflight
  // must not force a group recall from the historical October 3 output.
  if(result.ready)expect(result.plan).toEqual(intent)
  expect(data.currentRoom('room_1_1',true)).toEqual(before)
 })
})

describe('84e3926 native complete-preview displaced-bed decisions',()=>{
 for(const sample of currentOracle.cases)it(sample.name,()=>{
  const raw=sample.input.data
  const operators=Object.fromEntries(Object.entries(raw.operators).map(([name,options])=>[name,new MowerOperatorState(options as MowerOperatorOptions)]))
  const data=new MowerSchedulingData({...raw,alpha:true,operators,plan:structuredClone(raw.plan),dorms:raw.dorms.map(bed=>new MowerDormState([String(bed.position[0]),Number(bed.position[1])],bed.name,'timeMicros' in bed?bed.timeMicros:undefined))})
  // The native host refreshes the captured plan before preview, so config-derived
  // strict personal caps must accompany the saved operator observations here.
  initializeMowerAlphaMoodLimits(data,0,readMowerMoodLimits(sample.input.roster.conf,name=>name))
  const task=new MowerTask({type:T.SHIFT_OFF,plan:structuredClone(sample.input.task.plan),metadata:sample.input.task.metadata})
  task.timeMicros=sample.input.task.timeMicros
  const queue=new MowerTaskQueue();queue.tasks=[task]
  const model:MowerShiftModel={count:0,evaluate:()=>[],swap:state=>projectMowerArrangements(state,[]),transition:()=>({}),activate:()=>{}}
  const before=JSON.stringify(data)
  expect(()=>prepareMowerShiftCycle(data,task,queue,model)).not.toThrow()
  expect(task.plan).toEqual(sample.result.plan)
  expect(task.dormFillPlan).toEqual(sample.result.fill)
  expect(JSON.stringify(data)).toBe(before)
 })
})
