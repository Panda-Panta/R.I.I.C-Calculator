import {describe,it,expect} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {mowerGroupShiftPredecessors} from './mowerGroupPredecessors'

// Direct decision cases of native ae9fc322 _group_shift_predecessors (6917-7005).
function fixture(){
 const operators={
  A:new MowerOperatorState({name:'A',room:'room_1_1',index:0,group:'g',replacement:['R'],operatorType:'high',mood:16,timeStampMicros:0}),
  R:new MowerOperatorState({name:'R',currentRoom:'room_1_1',currentIndex:0,mood:24,timeStampMicros:0}),
  B:new MowerOperatorState({name:'B',room:'room_2_1',index:0,group:'h',replacement:['S'],operatorType:'high',currentRoom:'room_2_1',currentIndex:0}),
  S:new MowerOperatorState({name:'S',mood:24,timeStampMicros:0}),
 }
 const data=new MowerSchedulingData({alpha:true,nowMicros:0,operators,plan:{room_1_1:['A'],room_2_1:['B'],dormitory_1:['Free','Free']},dorms:[]})
 const previous=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['A','Current']}})
 previous.arrangementStarted=true;previous.groupShiftTransitions={g:true};previous.groupShiftExpected={['room_1_1\0'+'0']:'R',['dormitory_1\0'+'0']:'A'}
 const blocked=(task:MowerTask,transitions=task.groupShiftTransitions)=>mowerGroupShiftPredecessors(data,task,task.plan,transitions,[previous,task])
 return {data,operators,previous,blocked}
}
describe('unconfirmed group predecessor footprints',()=>{
 it('keeps a completed work-room target owned while another room remains unconfirmed',()=>{
  const {previous,blocked}=fixture(),task=new MowerTask({type:T.SELF_CORRECTION,plan:{room_1_1:['S']}})
  expect(blocked(task)).toEqual([previous])
  expect(previous.plan).toEqual({dormitory_1:['A','Current']})
 })
 it('owns explicit Free slots and named operators moved to a different room',()=>{
  const {previous,blocked}=fixture()
  expect(blocked(new MowerTask({type:T.FILL_DORM,plan:{dormitory_1:['Free']}}))).toEqual([previous])
  expect(blocked(new MowerTask({plan:{room_2_1:['R']}}))).toEqual([previous])
 })
 it('includes the current occupant of a proposed explicit slot',()=>{
  const {data,operators,previous,blocked}=fixture()
  operators.R.currentRoom='room_2_1';operators.B.currentRoom=''
  expect(blocked(new MowerTask({plan:{room_2_1:['S']}}))).toEqual([previous])
  expect(data.currentOperator('room_2_1',0)?.name).toBe('R')
 })
 it('owns a whole named group even when the requested slot and names are different',()=>{
  const {data,previous,blocked}=fixture()
  data.plan.room_3_1=['C'];data.operators.C=new MowerOperatorState({name:'C',room:'room_3_1',index:0,group:'g',operatorType:'high',currentRoom:'room_3_1',currentIndex:0})
  const task=new MowerTask({plan:{room_3_1:['S']}});task.groupShiftTransitions={g:true}
  expect(blocked(task)).toEqual([previous])
 })
 it('includes shared-binding members and their primary slots in both footprints',()=>{
  const {data,previous,blocked}=fixture()
  data.plan.room_3_1=['F'];data.operators.F=new MowerOperatorState({name:'F',room:'room_3_1',index:0,operatorType:'high',currentRoom:'room_3_1',currentIndex:0,groupBindings:[{group:'g',replacement:['R']},{group:'h',replacement:['S']}]})
  expect(blocked(new MowerTask({plan:{room_3_1:['S']}}))).toEqual([previous])
  const task=new MowerTask({plan:{room_2_1:['S']}});task.groupShiftTransitions={h:true}
  expect(blocked(task)).toEqual([previous])
  expect(mowerGroupShiftPredecessors(data,task,task.plan,task.groupShiftTransitions,[previous],{protectedNames:new Set(['F'])})).toEqual([])
 })
 it('lets independent group, slot and names proceed and ignores expected-free historical tasks',()=>{
  const {previous,blocked}=fixture(),task=new MowerTask({plan:{room_2_1:['S']}});task.groupShiftTransitions={h:true}
  expect(blocked(task)).toEqual([])
  previous.groupShiftExpected={};expect(blocked(new MowerTask({plan:{room_1_1:['S']}}))).toEqual([])
 })
 it('honors facility suppression before constructing an ownership footprint',()=>{
  const {data,previous}=fixture(),task=new MowerTask({plan:{room_1_1:['S']}})
  expect(mowerGroupShiftPredecessors(data,task,task.plan,{},[previous],{suppressFacilityArrangement:plan=>{delete plan.room_1_1}})).toEqual([])
  expect(task.plan).toEqual({room_1_1:['S']})
 })
})
