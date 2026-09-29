import {describe,it,expect} from 'vitest'
import {createRosterRuntime,settleRoster,advanceRoster,nextRosterActionHours,type RuntimeConfig} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {evaluateBackupExpression} from './backupPlans'
const rates={workRate:()=>1,recoveryRate:()=>4}
function fixture():RuntimeConfig {
 const keepers=['K1','K2','K3','K4']
 return {positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'A',candidates:['R'],lowerLimit:0,upperLimit:24,shiftOffThreshold:15},...keepers.map((name,i)=>({id:'dormitory_1_'+i,roomId:'dormitory_1',primary:name,candidates:[],permanent:true,dormitory:true}))],beds:[{id:'dormitory_1_4',roomId:'dormitory_1',vip:true}],initialMorale:{A:16,R:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},mowerSourcePlan:{room_1_1:[{agent:'A',group:'',replacement:['R']}],dormitory_1:[...keepers.map(name=>({agent:name,group:'',replacement:[]})),{agent:'Free',group:'',replacement:[]}]},mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0}}
}
describe('integrated Mower source scheduler',()=>{
 it('wakes from retained tasks rather than ordinary morale threshold crossings',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates)
  expect(s.occupants.room_1_1_0).toBe('A');expect(s.bedOccupants.dormitory_1_4).toBe('R')
  expect(nextRosterActionHours(s,rates)).toBe(2.5)
  advanceRoster(s,.4,rates)
  expect(nextRosterActionHours(s,rates)).toBeCloseTo(2.1)
  advanceRoster(s,2.1,rates);settleRoster(s,rates)
  expect(s.occupants.room_1_1_0).toBe('R');expect(s.bedOccupants.dormitory_1_4).toBe('A')
  const source=getMowerSourceRuntime(s),bed=source.data.dorms[0]!
  expect(bed.timeMicros!/3_600_000_000).toBeCloseTo(5.125)
  expect(nextRosterActionHours(s,rates)).toBeCloseTo(2.625-8/60)
 })
 it('records a completed return so only an immediate repeat receives the stability delay',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates)
  advanceRoster(s,2.5,rates);settleRoster(s,rates)
  advanceRoster(s,nextRosterActionHours(s,rates),rates);settleRoster(s,rates)
  const data=getMowerSourceRuntime(s).data
  expect(s.occupants.room_1_1_0).toBe('A')
  expect(data.recentShiftOnByRestUnit.get('operator:A')).toBe(data.nowMicros)
 })
 it('evaluates backup moods from the source cache rather than physical simulation values',()=>{
  const c=fixture(),id='char_237_gravel';c.positions[0]!.primary=id;c.mowerSourcePlan!.room_1_1![0]!.agent=id;c.initialMorale={[id]:10,R:24}
  const s=createRosterRuntime(c),data=getMowerSourceRuntime(s).data,op=data.operators[id]!
  op.mood=10;op.timeStampMicros=0;op.depletionRate=1;op.currentRoom='room_1_1';op.currentIndex=0
  s.time=1;data.nowMicros=3_600_000_000;s.morale[id]=8
  expect(evaluateBackupExpression("op_data.operators['砾'].current_mood() < 8.5",s)).toBe(false)
  expect(evaluateBackupExpression("op_data.operators['砾'].current_mood() == 9",s)).toBe(true)
 })
 it('keeps a task one microsecond in the future pending until the actual source clock advances',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates);const source=getMowerSourceRuntime(s),task=new MowerTask({type:T.NOT_SPECIFIC});task.timeMicros=1;source.queue.tasks.push(task)
  settleRoster(s,rates);expect(source.queue.tasks).toContain(task);expect(nextRosterActionHours(s,rates)).toBe(1/3_600_000_000)
  advanceRoster(s,1/3_600_000_000,rates);settleRoster(s,rates);expect(source.queue.tasks).not.toContain(task)
 })
 it('does not execute a derived task removed during the BEGINNING phase',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates);const source=getMowerSourceRuntime(s),old=new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['R']}});source.queue.tasks.unshift(old)
  settleRoster(s,rates,0,phase=>{if(phase==='BEGINNING'&&source.queue.tasks.includes(old))source.queue.consume(old);return false})
  expect(s.occupants.room_1_1_0).toBe('A');expect(source.trace.some(t=>t.type==='SHIFT_ON'&&t.plan.room_1_1?.includes('R'))).toBe(false)
 })
 it('preserves an old observation when a Current-only room task is an exact no-op',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates);const source=getMowerSourceRuntime(s),task=new MowerTask({time:1,plan:{room_1_1:['Current']}});source.queue.tasks.push(task)
  advanceRoster(s,1,rates);settleRoster(s,rates)
  expect(source.data.operators.A!.timeStampMicros).toBe(0);expect(source.data.operators.A!.mood).toBe(16)
 })
 it('checks BEGINNING once when task execution and ordinary planning belong to the same run',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates);const source=getMowerSourceRuntime(s),phases:string[]=[];source.queue.tasks.push(new MowerTask({time:1,plan:{room_1_1:['Current']}}))
  advanceRoster(s,1,rates);settleRoster(s,rates,0,phase=>{phases.push(phase);return false})
  expect(phases.filter(phase=>phase==='BEGINNING')).toEqual(['BEGINNING'])
 })
 it('checks AFTER_PLANNING after a blocked EXHAUST_OFF when the first retained task is SHIFT_ON',()=>{
  const s=createRosterRuntime(fixture());settleRoster(s,rates);const source=getMowerSourceRuntime(s),phases:string[]=[]
  source.data.operators.A!.replacement=[]
  source.queue.tasks=[new MowerTask({type:T.EXHAUST_OFF,metadata:'A'}),new MowerTask({time:1,type:T.SHIFT_ON,plan:{room_1_1:['A']}})]
  settleRoster(s,rates,0,phase=>{phases.push(phase);return false})
  expect(phases.filter(phase=>phase==='AFTER_PLANNING')).toEqual(['AFTER_PLANNING'])
 })
 it('advances the production clock between rooms without repeating the run entry or rebuilding metadata early',()=>{
  const c=fixture();c.mowerDeviceTiming={roomReturnMicros:500_000}
  const s=createRosterRuntime(c);settleRoster(s,rates)
  const source=getMowerSourceRuntime(s)
  expect(nextRosterActionHours(s,rates)).toBe(500_000/3_600_000_000)
  advanceRoster(s,500_000/3_600_000_000,rates);settleRoster(s,rates)
  const startedAt=s.time,phases:{phase:string;time:number}[]=[]
  source.queue.tasks=[new MowerTask({time:s.time,type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['K1','K2','K3','K4','A']}})]
  settleRoster(s,rates,0,phase=>{phases.push({phase,time:s.time});return false})
  expect(s.occupants.room_1_1_0).toBe('R');expect(s.bedOccupants.dormitory_1_4).toBeUndefined()
  expect(source.execution).toBeDefined();expect(phases.map(p=>p.phase)).not.toContain('BEFORE_PLANNING')
  advanceRoster(s,500_000/3_600_000_000,rates);settleRoster(s,rates)
  expect(s.bedOccupants.dormitory_1_4).toBe('A')
  expect(source.data.operators.A!.timeStampMicros).toBe(1_000_000)
  expect(source.queue.tasks.some(t=>t.type===T.SHIFT_ON)).toBe(false)
  advanceRoster(s,500_000/3_600_000_000,rates);settleRoster(s,rates)
  expect(source.execution).toBeUndefined();expect(source.queue.tasks.some(t=>t.type===T.SHIFT_ON)).toBe(true)
  expect(phases.filter(p=>p.phase==='BEGINNING')).toEqual([{phase:'BEGINNING',time:startedAt}])
  expect(phases.find(p=>p.phase==='BEFORE_DORM')?.time).toBeCloseTo(startedAt+500_000/3_600_000_000,12)
  expect(phases.find(p=>p.phase==='BEFORE_PLANNING')?.time).toBeCloseTo(startedAt+1_000_000/3_600_000_000,12)
 })
 it('establishes recovery before an exact dorm no-op and preserves the final list',()=>{
  const c=fixture(),s=createRosterRuntime(c);settleRoster(s,rates)
  const source=getMowerSourceRuntime(s),data=source.data
  data.operators.K1!.singleRecoveryManager=true
  data.operators.R!.mood=10;s.morale.R=10
  const list=['K1','K2','K3','K4','R'],task=new MowerTask({plan:{dormitory_1:list}})
  source.queue.tasks=[task];settleRoster(s,rates)
  expect(list).toEqual(['K1','K2','K3','K4','R'])
  expect(data.operators.R!.dormRecoveryRoom).toBe('dormitory_1')
  expect(data.operators.R!.dormRecoveryIndex).toBe(4)
  expect(Object.values(s.bedOccupants)).toContain('R')
 })

 it('preserves strict run entry and advances only at a completed run boundary',()=>{
  const c=fixture();c.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
  const s=createRosterRuntime(c);s.bedOccupants.dormitory_1_4='R'
  const source=getMowerSourceRuntime(s)
  const initial=source.queue.tasks[0]!,future=new MowerTask({time:1});source.queue.tasks.push(future)
  settleRoster(s,rates)
  expect(source.queue.tasks).not.toContain(initial)
  expect(source.queue.tasks.some(t=>t!==future&&t.timeMicros===0)).toBe(true)
  expect(s.time).toBe(0);expect(nextRosterActionHours(s,rates)).toBe(1/3_600_000_000)
  advanceRoster(s,1/3_600_000_000,rates);settleRoster(s,rates)
  expect(source.queue.tasks).toEqual([future])
  expect(nextRosterActionHours(s,rates)).toBe(1_000_000/3_600_000_000)
  advanceRoster(s,1_000_000/3_600_000_000,rates);settleRoster(s,rates)
  expect(source.queue.tasks).toEqual([future]);expect(future.timeMicros).toBe(3_600_000_000)
  expect(s.time*3_600_000_000).toBeCloseTo(1_000_001,5)
 })

 it('vacates a Current dorm bed when its operator is explicitly moved to another bed',()=>{
  const c=fixture();c.idleOperators=['X','Y'];c.mowerDeviceTiming={roomReturnMicros:500_000};c.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
  c.positions=c.positions.filter(p=>p.id!=='dormitory_1_3')
  c.beds=[{id:'dormitory_1_3',roomId:'dormitory_1',vip:true},{id:'dormitory_1_4',roomId:'dormitory_1',vip:false}]
  c.mowerSourcePlan!.dormitory_1=[...['K1','K2','K3'].map(agent=>({agent,group:'',replacement:[]})),{agent:'Free',group:'',replacement:[]},{agent:'Free',group:'',replacement:[]}]
  const s=createRosterRuntime(c),source=getMowerSourceRuntime(s);source.initial=false
  s.occupants.room_1_1_0='R';s.bedOccupants.dormitory_1_4='A';s.morale.A=8
  for(const [index,name] of ['K1','K2','K3','','A'].entries())if(name){const op=source.data.operators[name]!;op.currentRoom='dormitory_1';op.currentIndex=index;op.mood=s.morale[name]??24;op.timeStampMicros=0}
  source.data.operators.R!.currentRoom='room_1_1';source.data.operators.R!.currentIndex=0;source.data.operators.K1!.singleRecoveryManager=true
  const task=new MowerTask({plan:{dormitory_1:['Current','Current','Current','A','Current']}});source.queue.tasks=[task]
  for(let attempt=0;attempt<20&&source.queue.tasks.includes(task);attempt++){
   settleRoster(s,rates)
   if(source.queue.tasks.includes(task))advanceRoster(s,Math.max(nextRosterActionHours(s,rates),1/3_600_000_000),rates)
  }
  expect(source.queue.tasks).not.toContain(task)
  expect(source.error).toBeFalsy()
  expect(s.bedOccupants.dormitory_1_3).toBe('A')
  expect(Object.values(s.bedOccupants).filter(name=>name==='A')).toHaveLength(1)
  expect(s.diagnostics.some(d=>d.code==='mower-task-exception')).toBe(false)
 })

})
