import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-alpha-metadata.json'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,settleRoster} from './rosterRuntime'
import {createBackupPlanController} from './backupPlans'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {prepareMowerShiftCycle,mergeMowerShiftTransition,coalesceMowerBackupTransition} from './mowerShiftCycle'
import {MowerSchedulingData} from './mowerSchedulingData'

function setup(trigger:unknown,extra:Record<string,unknown>={}){
 const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'char_123_fang'},groupId:null,replacements:['char_502_nblade']}]
 w.compatibility.backupPlans=[{name:'alpha',trigger,plan:{room_1_1:{plans:[{agent:'香草',group:'',replacement:['芬']}]}},trigger_timing:'END',...extra}]
 const schedule=compileRosterSchedule(w),config=compiledScheduleToRuntimeConfig(schedule);config.mowerAlpha=true
 const state=createRosterRuntime(config),controller=createBackupPlanController(schedule,state)
 return {state,controller,source:getMowerSourceRuntime(state)}
}
describe('alpha final backup and shift convergence',()=>{
 it('evaluates all backup conditions at each entry, independent of obsolete phase fields',()=>{
  const {state,controller}=setup('True')
  controller.evaluate('BEGINNING')
  expect(controller.active).toEqual([true])
  expect(state.mowerBackupGenerated?.filter(t=>Object.keys(t.plan).length)).toHaveLength(1)
  expect(state.mowerBackupGenerated?.map(t=>t.type)).toEqual([T.SELF_CORRECTION,T.NOT_SPECIFIC])
 })
 it('rolls back a conditional plan cycle before any physical occupancy, event or task changes',()=>{
  const {state,controller,source}=setup("op_data.operators['芬'].room == 'room_1_1'")
  const before={config:state.config,occupants:{...state.occupants},tasks:[...source.queue.tasks]}
  expect(controller.evaluate('END')).toBe(false)
  expect(controller.active).toEqual([false]);expect(state.config).toBe(before.config)
  expect(state.occupants).toEqual(before.occupants);expect(source.queue.tasks).toEqual(before.tasks)
  expect(state.events).toEqual([]);expect(state.diagnostics).toContainEqual(expect.objectContaining({code:'mower-backup-cycle'}))
 })
 it('cancels an obsolete destination when a newer intent moves the same person elsewhere',()=>{
  const data=new MowerSchedulingData({alpha:true,plan:{room_1_1:['A'],dormitory_1:['Free']},operators:{},dorms:[],nowMicros:0}),plan={dormitory_1:['A']}
  mergeMowerShiftTransition(plan,{room_1_1:['A']},data)
  expect(plan).toEqual({dormitory_1:['Current'],room_1_1:['A']})
 })
 it('coalesces transitively related due intents and preserves unrelated future work',()=>{
  const data=new MowerSchedulingData({alpha:true,plan:{room_1_1:['A'],room_1_2:['B'],room_1_3:['C'],dormitory_1:['Free','Free']},operators:{},dorms:[],nowMicros:0})
  const a=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['A','Current']}}),b=new MowerTask({type:T.RE_ORDER,plan:{room_1_2:['A'],dormitory_1:['Current','B']}}),future=new MowerTask({time:2,type:T.SHIFT_ON,plan:{room_1_3:['C']}})
  const result=coalesceMowerBackupTransition(data,{room_1_2:['R']},[a,b,future])
  expect(result.consumed).toEqual(oracle.coalesce.consumed.map(index=>[a,b,future][index]));expect(result.plan).toEqual(oracle.coalesce.plan)
 })
 it('preserves the original task and physical observations when full-cycle conditions oscillate',()=>{
  const {state,source}=setup('True'),task=new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['char_123_fang']}}),queue=new MowerTaskQueue();queue.tasks=[task]
  let calls=0
  const model={count:1,evaluate:()=>[Boolean(++calls%2)],swap:(d:MowerSchedulingData)=>d,transition:()=>({}),activate:()=>{throw new Error('must not commit')}}
  const before=structuredClone(task.plan),occupants={...state.occupants}
  expect(()=>prepareMowerShiftCycle(source.data,task,queue,model)).toThrow(/循环/)
  expect(task.plan).toEqual(before);expect(queue.tasks).toEqual([task]);expect(state.occupants).toEqual(occupants)
 })
 it('commits only after preview and keeps the process lock until all physical room returns complete',()=>{
  const {state,controller,source}=setup('True',{task:{room_1_1:['香草']}})
  settleRoster(state,{workRate:()=>1,recoveryRate:()=>4},0,phase=>controller.evaluate(phase))
  for(let tick=1;tick<=4&&!source.execution;tick++){state.time=tick/3_600_000_000;settleRoster(state,{workRate:()=>1,recoveryRate:()=>4},0,phase=>controller.evaluate(phase))}
  expect(state.events.filter(e=>e.type==='backup-plan'&&e.active)).toHaveLength(1)
  expect({locked:source.queue.tasks.filter(t=>t.backupShiftActive).length,diagnostics:state.diagnostics,queue:source.queue.tasks.map(t=>({type:t.type.key,plan:t.plan,time:t.time})),trace:source.trace}).toMatchObject({locked:1})
 })
 it('reports a rejected headless preview immediately and retains its unexecuted task',()=>{
  const {state,source}=setup('True'),task=new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['char_123_fang']}})
  source.queue.tasks=[task];source.initial=false
  let calls=0
  state.mowerShiftModel={count:1,evaluate:()=>[Boolean(++calls%2)],swap:d=>d,transition:()=>({}),activate:()=>{throw new Error('must not commit')}}
  const original=structuredClone(task.plan),occupants={...state.occupants}
  expect(()=>settleRoster(state,{workRate:()=>1,recoveryRate:()=>4},0)).toThrow(/循环/)
  expect(task.plan).toEqual(original);expect(source.queue.tasks).toContain(task)
  expect(state.occupants).toEqual(occupants);expect(task.backupShiftActive).toBe(false)
 })
})
