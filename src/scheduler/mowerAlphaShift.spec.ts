import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-shift-primitives.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {projectMowerArrangements} from './mowerObservations'
import {mowerGetRestingPlan} from './mowerOrdinaryPlanning'
import {mowerCorrectionPlan} from './mowerCorrection'
import {prepareMowerShiftBeds} from './mowerShiftProtection'
import {MowerTask,toMowerMicros,MOWER_TASK_TYPES as T} from './mowerTaskQueue'

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

describe('October 3 Mower alpha source decisions',()=>{
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
 for(const test of oracle.restore)it('uses native displaced-bed handling, standby='+test.standby,()=>{
  const data=fixture(test.standby),task=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['Current','Current','Current','N','Current']}})
  const before=data.currentRoom('room_1_1',true)
  const result=prepareMowerShiftBeds(data,task,[])
  expect(result.ready).toBe(true)
  if(result.ready)expect(result.plan).toEqual(test.output)
  expect(data.currentRoom('room_1_1',true)).toEqual(before)
 })
})
