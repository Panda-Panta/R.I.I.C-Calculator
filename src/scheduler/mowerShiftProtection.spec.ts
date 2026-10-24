import {describe,it,expect,vi} from 'vitest'
import {createRosterRuntime,settleRoster,advanceRoster,nextRosterActionHours,type RuntimeConfig} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {planMowerMetadata} from './mowerMetadata'
import {executeMowerTaskArrangement} from './mowerTaskExecutor'
import {createBackupPlanController} from './backupPlans'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {retainMowerFailedTask} from './mowerTaskFailure'
import * as protection from './mowerShiftProtection'

const rates={workRate:()=>1,recoveryRate:()=>4}
function fixture(dormCount=2):RuntimeConfig {
 const config:RuntimeConfig={positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'A',candidates:['R'],group:'g',shiftOffThreshold:15}],beds:[],initialMorale:{A:14,R:24,N:10,L:24},idleOperators:['N','L'],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},mowerSourcePlan:{room_1_1:[{agent:'A',group:'g',replacement:['R']}]},mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0}}
 for(let d=1;d<=dormCount;d++){
  const room='dormitory_'+d,keepers=Array.from({length:4},(_,i)=>'K'+d+'_'+i)
  config.positions.push(...keepers.map((name,i)=>({id:room+'_'+i,roomId:room,primary:name,candidates:[],permanent:true,dormitory:true})))
  config.beds.push({id:room+'_4',roomId:room,vip:true})
  config.mowerSourcePlan![room]=[...keepers.map(agent=>({agent,group:'',replacement:[]})),{agent:'Free',group:'',replacement:[]}]
 }
 return config
}
function restingState(dormCount=2){
 const s=createRosterRuntime(fixture(dormCount))
 s.occupants.room_1_1_0='R';s.bedOccupants.dormitory_1_4='A'
 return s
}

describe('Mower complete shift protection',()=>{
 it('keeps the forced dorm assignment and relocates its unfinished resting occupant before committing',()=>{
  const s=restingState(),source=getMowerSourceRuntime(s)
  source.queue.tasks=[new MowerTask({plan:{dormitory_1:['Current','Current','Current','Current','N']}})]
  settleRoster(s,rates)
  expect(source.trace[0]!.plan.dormitory_1![4]).toBe('N')
  expect(source.trace[0]!.plan.dormitory_2![4]).toBe('A')
  // Default try_reorder may subsequently change the two bed positions.
  expect(Object.values(s.bedOccupants)).toEqual(expect.arrayContaining(['A','N']))
  expect(s.occupants.room_1_1_0).toBe('R')
  expect(s.events.filter(e=>e.reason==='position-correction'&&e.operators.includes('A'))).toEqual([])
  const present=[...Object.values(s.occupants),...Object.values(s.bedOccupants)]
  expect(new Set(present).size).toBe(present.length)
 })

 it('defers an infeasible forced rest without evicting an unfinished primary or losing the task',()=>{
  const s=restingState(1),source=getMowerSourceRuntime(s)
  const task=new MowerTask({plan:{dormitory_1:['Current','Current','Current','Current','N']}})
  source.queue.tasks=[task]
  settleRoster(s,rates)
  expect(s.bedOccupants.dormitory_1_4).toBe('A')
  expect(source.queue.tasks).toContain(task)
  expect(task.timeMicros).toBeGreaterThan(source.data.nowMicros)
  expect(task.plan.dormitory_1![4]).toBe('N')
  expect(s.diagnostics).toContainEqual(expect.objectContaining({code:'mower-shift-bed-conflict'}))
 })

 it('drains three independent due tasks after a bed deferral without retrying its future task',()=>{
  const s=restingState(1);s.config.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
  const source=getMowerSourceRuntime(s)
  const blocked=new MowerTask({plan:{dormitory_1:['Current','Current','Current','Current','N']}})
  const independent=Array.from({length:3},()=>new MowerTask({plan:{room_1_1:['Current']}}))
  source.queue.tasks=[blocked,...independent]
  const bed=s.bedOccupants.dormitory_1_4,spy=vi.spyOn(protection,'prepareMowerShiftBeds')
  try{
   settleRoster(s,rates)
   const deadline=blocked.timeMicros,plan=structuredClone(blocked.plan)
   expect(source.queue.tasks).toContain(blocked);expect(source.queue.tasks).not.toContain(independent[0])
   expect(deadline).toBeGreaterThan(source.data.nowMicros)
   const due=()=>source.queue.tasks.filter(task=>!task.executionFailure&&task.timeMicros<=source.data.nowMicros).length
   for(let pass=0;pass<5&&due();pass++){
    const before=due(),next=nextRosterActionHours(s,rates)
    expect(next).toBeGreaterThan(0);expect(next).toBeLessThanOrEqual(1/3_600_000_000)
    advanceRoster(s,next,rates);settleRoster(s,rates)
    expect(due()).toBeLessThan(before)
    expect(blocked.timeMicros).toBe(deadline);expect(blocked.plan).toEqual(plan)
   }
   expect(independent.every(task=>!source.queue.tasks.includes(task))).toBe(true)
   expect(source.queue.find()!.timeMicros).toBeGreaterThan(source.data.nowMicros)
   expect(nextRosterActionHours(s,rates)).toBeGreaterThan(0)
   expect(spy.mock.calls.filter(([,task])=>task===blocked)).toHaveLength(1)
   expect(s.bedOccupants.dormitory_1_4).toBe(bed)
  }finally{spy.mockRestore()}
 })

 it('leaves only the real bed deadline pending when all other queued tasks are suspended failures',()=>{
  const s=restingState(1);s.config.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
  const source=getMowerSourceRuntime(s),blocked=new MowerTask({plan:{dormitory_1:['Current','Current','Current','Current','N']}}),failed=new MowerTask({time:-1})
  source.queue.tasks=[blocked,failed];retainMowerFailedTask(s,source.data,failed,'waiting for unrelated evidence',[])
  const spy=vi.spyOn(protection,'prepareMowerShiftBeds')
  try{
   settleRoster(s,rates)
   const deadline=blocked.timeMicros
   expect(deadline).toBeGreaterThan(source.data.nowMicros);expect(nextRosterActionHours(s,rates)).toBeGreaterThan(1/60)
   expect(failed.executionFailure).toBeDefined();expect(source.queue.tasks).toContain(failed)
   settleRoster(s,rates)
   expect(blocked.timeMicros).toBe(deadline);expect(source.queue.tasks).toContain(blocked)
   expect(spy.mock.calls.filter(([,task])=>task===blocked)).toHaveLength(1)
   expect(failed.executionFailure).toBeDefined();expect(s.bedOccupants.dormitory_1_4).toBe('A')
  }finally{spy.mockRestore()}
 })

 it('executes the retained forced task after the protected occupant completes recovery',()=>{
  const s=restingState(1),source=getMowerSourceRuntime(s)
  const task=new MowerTask({plan:{dormitory_1:['Current','Current','Current','Current','N']}})
  source.queue.tasks=[task]
  settleRoster(s,rates)
  expect(source.queue.tasks).toContain(task)
  advanceRoster(s,task.time,rates);settleRoster(s,rates)
  expect(source.queue.tasks).not.toContain(task)
  expect(Object.values(s.bedOccupants)).toContain('N')
  expect(s.morale.A).toBeGreaterThan(23)
  expect(task.backupShiftActive).toBe(false)
 })

 it('freezes backup decisions and return-task rebuilding between physical room commits',()=>{
  const config=fixture(1);config.initialMorale!.A=24;config.mowerDeviceTiming={roomReturnMicros:500_000}
  const s=createRosterRuntime(config),source=getMowerSourceRuntime(s)
  const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['Current','Current','Current','Current','A']}})
  source.queue.tasks=[task]
  const phases:string[]=[]
  settleRoster(s,rates,0,phase=>{phases.push(phase);return false})
  expect(s.occupants.room_1_1_0).toBe('R')
  expect(s.bedOccupants.dormitory_1_4).toBeUndefined()
  expect(task).toHaveProperty('backupShiftActive',true)
  const returning=new MowerTask({time:1,type:T.SHIFT_ON,plan:{room_1_1:['A']}})
  source.queue.tasks.push(returning)
  planMowerMetadata(source.data,source.queue)
  expect(source.queue.tasks).toContain(returning)
  advanceRoster(s,500_000/3_600_000_000,rates);settleRoster(s,rates,0,phase=>{phases.push(phase);return false})
  expect(phases).not.toContain('BEFORE_DORM')
  expect(task).toHaveProperty('backupShiftActive',true)
  advanceRoster(s,500_000/3_600_000_000,rates);settleRoster(s,rates,0,phase=>{phases.push(phase);return false})
  expect(task).toHaveProperty('backupShiftActive',false)
  expect(source.queue.tasks).not.toContain(task)
  expect(phases).toContain('BEFORE_PLANNING')
 })

 it('blocks direct backup evaluation while a complete shift remains active and allows it afterwards',()=>{
  const ws=createDefaultWorkspace();ws.compatibility.backupPlans=[{trigger:'True',conf:{workaholic:'芬'}}]
  const schedule=compileRosterSchedule(ws),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  const controller=createBackupPlanController(schedule,s),source=getMowerSourceRuntime(s)
  const task=Object.assign(new MowerTask(),{backupShiftActive:true});source.queue.tasks=[task]
  controller.evaluate('END');expect(controller.active).toEqual([false])
  task.backupShiftActive=false;controller.evaluate('END');expect(controller.active).toEqual([true])
 })

 it('records successful correction recalls in the same rest-unit history as ordinary returns',()=>{
  const s=restingState(1),source=getMowerSourceRuntime(s)
  source.queue.tasks=[new MowerTask({type:T.SELF_CORRECTION,plan:{room_1_1:['A']}})]
  settleRoster(s,rates)
  expect(s.events).toContainEqual(expect.objectContaining({type:'shift-on',reason:'position-correction',operators:['A']}))
  expect(source.data.recentShiftOnByRestUnit.get('group:g')).toBe(source.data.nowMicros)
 })

 it('releases the process lock on an arrangement error so a retained task can be retried',()=>{
  const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R']}}),queue=new MowerTaskQueue();queue.tasks=[task]
  let lockedDuringIO=false
  const hooks={protectShift:true,backup:()=>({changed:false,generated:[]}),metadata:()=>{},arrangeRoom:()=>{lockedDuringIO=Reflect.get(task,'backupShiftActive')===true;throw new Error('observation failed')}}
  expect(()=>executeMowerTaskArrangement(task,queue,hooks)).toThrow('observation failed')
  expect(lockedDuringIO).toBe(true)
  expect(task).toHaveProperty('backupShiftActive',false)
  expect(queue.tasks).toContain(task)
 })

 it('releases the process lock when the physical driver rejects a yielded device boundary',()=>{
  const config=fixture(1);config.initialMorale!.A=24;config.mowerDeviceTiming={roomReturnMicros:-1}
  config.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:0}
  const s=createRosterRuntime(config),source=getMowerSourceRuntime(s)
  const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['Current','Current','Current','Current','A']}})
  source.queue.tasks=[task]
  expect(()=>settleRoster(s,rates)).not.toThrow()
  expect(s.diagnostics).toContainEqual(expect.objectContaining({code:'mower-task-exception',message:'Invalid Mower device clock'}))
  expect(task.backupShiftActive).toBe(false)
  expect(source.execution).toBeUndefined()
  expect(source.queue.tasks).toContain(task)
 })
})
