import {describe,it,expect} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData} from './mowerSchedulingData'
import {alphaPosition} from './mowerAlphaDorm'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {
 cancelMowerReleasedGroupTargets,completeMowerGroupConfirmation,enforceMowerGroupTargets,
 prepareMowerGroupExecutionTargets,rememberMowerGroupTargets,relocateMowerGroupTargets,type MowerGroupConfirmationTask,
} from './mowerGroupConfirmation'

// Scenarios mirror ae9fc322 tests/group_shift_confirmation_tests.py:
// partial confirmation, personal-cap cancellation, fixed dorm posts and target revalidation.
function setup(){
 const operators={
  A:new MowerOperatorState({name:'A',room:'work',index:0,group:'G',replacement:['R'],operatorType:'high',currentRoom:'work',currentIndex:0,mood:5,timeStampMicros:0}),
  R:new MowerOperatorState({name:'R',currentRoom:'',currentIndex:-1,mood:24,timeStampMicros:0}),
  Manager:new MowerOperatorState({name:'Manager',room:'dormitory_1',index:0,operatorType:'high',currentRoom:'dormitory_1',currentIndex:0,mood:24,timeStampMicros:0}),
 }
 const data=new MowerSchedulingData({alpha:true,plan:{work:['A'],dormitory_1:['Manager','Free','Free'],train:['A','R']},operators,dorms:[],nowMicros:0,groupShiftState:{G:false}})
 const task:MowerTask&MowerGroupConfirmationTask=new MowerTask({time:2,type:T.SHIFT_OFF,plan:{work:['R'],dormitory_1:['Current','A','Current']}})
 task.groupShiftTransitions={G:true}
 return {data,task,operators}
}
function at(op:MowerOperatorState,room:string,index:number){op.currentRoom=room;op.currentIndex=index}

describe('Mower ae9fc322 observed group execution confirmation',()=>{
 it('remembers both fixed work and recovery targets before execution without committing the group',()=>{
  const {data,task}=setup();rememberMowerGroupTargets(data,task)
  expect(task.groupShiftExpected).toEqual({[alphaPosition('work',0)]:'R',[alphaPosition('dormitory_1',1)]:'A'})
  expect(data.groupShiftState.G).toBe(false)
  expect(data.operators.A!.currentRoom).toBe('work')
 })
 it('keeps original time and expected targets while retrying only missing physical work',()=>{
  const {data,task,operators}=setup();rememberMowerGroupTargets(data,task)
  at(operators.A,'dormitory_1',1);task.plan={}
  const expected=structuredClone(task.groupShiftExpected),time=task.timeMicros
  expect(completeMowerGroupConfirmation(data,task)).toEqual({complete:false,missing:{work:['R']},differences:[{room:'work',index:0,expected:'R',actual:''}]})
  expect(task.plan).toEqual({work:['R']});expect(task.timeMicros).toBe(time)
  expect(task.groupShiftExpected).toEqual(expected);expect(data.groupShiftState.G).toBe(false)
  at(operators.R,'work',0)
  expect(completeMowerGroupConfirmation(data,task).complete).toBe(true)
  expect(data.groupShiftState.G).toBe(true);expect(task.groupShiftExpected).toEqual({})
 })
 it('does not put a completed room back into the remaining plan during revalidation',()=>{
  const {data,task,operators}=setup();rememberMowerGroupTargets(data,task)
  at(operators.R,'work',0);at(operators.A,'',-1);delete task.plan.work
  prepareMowerGroupExecutionTargets(data,task)
  expect(task.plan).not.toHaveProperty('work')
  expect(task.groupShiftExpected?.[alphaPosition('work',0)]).toBe('R')
 })
 it('updates a moved final target once, removing its old expected position',()=>{
  const {data,task}=setup();rememberMowerGroupTargets(data,task)
  task.plan.dormitory_1=['Current','Free','A'];rememberMowerGroupTargets(data,task)
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',1)]).toBeUndefined()
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',2)]).toBe('A')
 })
 it('follows surviving final recovery targets when legal cancellation compacts the room',()=>{
  const {data,task,operators}=setup();task.plan.dormitory_1=['Manager','R','A'];rememberMowerGroupTargets(data,task)
  Object.assign(operators.R,{restMoodLimit:true,mood:12,upperLimit:12})
  prepareMowerGroupExecutionTargets(data,task)
  const agents=['Manager','A',''];relocateMowerGroupTargets(task,'dormitory_1',agents)
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',1)]).toBe('A')
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',2)]).toBeUndefined()
  expect(enforceMowerGroupTargets(data,task,'dormitory_1',agents)).toBe(false)
 })
 it('cancels capped dynamic recovery targets while preserving the fixed dorm post',()=>{
  const {data,task,operators}=setup()
  Object.assign(operators.A,{mood:12,upperLimit:12,restMoodLimit:true})
  Object.assign(operators.Manager,{mood:12,upperLimit:12,restMoodLimit:true})
  task.plan.dormitory_1=['Manager','A','Current'];rememberMowerGroupTargets(data,task)
  expect(task.plan.dormitory_1).toEqual(['Manager','Free','Current'])
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',0)]).toBe('Manager')
  expect(Object.values(task.groupShiftExpected??{})).not.toContain('A')
 })
 it('cancels excluded recovery targets only at dynamic positions',()=>{
  const {data,task,operators}=setup();operators.A.workaholic=true;operators.Manager.workaholic=true
  task.plan.dormitory_1=['Manager','A','Current'];rememberMowerGroupTargets(data,task)
  expect(task.plan.dormitory_1).toEqual(['Manager','Free','Current'])
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',0)]).toBe('Manager')
 })
 it('does not cancel a simple fill that already names the observed resident',()=>{
  const {data,task,operators}=setup();at(operators.A,'dormitory_1',1)
  Object.assign(operators.A,{mood:12,upperLimit:12,restMoodLimit:true})
  task.simpleDormFill=true;rememberMowerGroupTargets(data,task)
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',1)]).toBe('A')
 })
 it('removes actually released dynamic targets in waiting tasks without changing their time or other rooms',()=>{
  const {data,task,operators}=setup();rememberMowerGroupTargets(data,task)
  Object.assign(operators.A,{mood:12,upperLimit:12,restMoodLimit:true});at(operators.A,'',-1)
  const time=task.timeMicros
  cancelMowerReleasedGroupTargets(data,[task],'A')
  expect(task.plan).toEqual({work:['R']});expect(task.timeMicros).toBe(time)
  expect(task.groupShiftExpected).toEqual({[alphaPosition('work',0)]:'R'})
  expect(data.groupShiftState.G).toBe(false)
 })
 it('does not remove a fixed dorm target after a personal-cap departure',()=>{
  const {data,task,operators}=setup();task.plan.dormitory_1=['Manager','A','Current'];rememberMowerGroupTargets(data,task)
  Object.assign(operators.Manager,{mood:12,upperLimit:12,restMoodLimit:true});at(operators.Manager,'',-1)
  cancelMowerReleasedGroupTargets(data,[task],'Manager')
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',0)]).toBe('Manager')
  expect(task.plan.dormitory_1?.[0]).toBe('Manager')
 })
 it('restores mandatory slots after padding and removes duplicate occupants from another slot',()=>{
  const {data,task}=setup();rememberMowerGroupTargets(data,task)
  const agents=['A','R','']
  expect(enforceMowerGroupTargets(data,task,'dormitory_1',agents)).toBe(true)
  expect(agents).toEqual(['Free','A',''])
  expect(task.plan.dormitory_1?.[1]).toBe('A')
  expect(task.groupShiftExpected?.[alphaPosition('dormitory_1',1)]).toBe('A')
 })
 it('accepts Current only when the expected occupant was actually observed at that slot',()=>{
  const {data,task,operators}=setup();rememberMowerGroupTargets(data,task)
  at(operators.A,'dormitory_1',1)
  expect(enforceMowerGroupTargets(data,task,'dormitory_1',['Current','Current','Current'])).toBe(false)
  at(operators.A,'work',0)
  const agents=['Current','Current','Current']
  expect(enforceMowerGroupTargets(data,task,'dormitory_1',agents)).toBe(true)
  expect(agents[1]).toBe('A')
 })
 it('keeps one-slot training selections outside whole-room enforcement',()=>{
  const {data,task}=setup();task.plan.train=['A','R'];rememberMowerGroupTargets(data,task)
  const agents=['R'];expect(enforceMowerGroupTargets(data,task,'train',agents)).toBe(false);expect(agents).toEqual(['R'])
 })
 it('removes only adapter-protected training targets from confirmation',()=>{
  const {data,task}=setup();task.plan.train=['A','R'];task.trainingSkippedSlots=[0]
  rememberMowerGroupTargets(data,task,{suppressFacilityArrangement:plan=>{if(plan.train)plan.train[1]='Current'}})
  expect(task.plan.train).toEqual(['Current','Current'])
  expect(Object.keys(task.groupShiftExpected??{}).some(key=>key.startsWith('train\0'))).toBe(false)
 })
})
