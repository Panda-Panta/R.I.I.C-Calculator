import {describe,it,expect} from 'vitest'
import {createRosterRuntime,settleRoster,advanceRoster,nextRosterActionHours,type RuntimeConfig} from './rosterRuntime'
import {getMowerSourceRuntime,makeMowerSchedulingData,settleMowerSource} from './mowerSourceRuntime'
import {mowerUpdateDetail} from './mowerObservations'
import {alphaRestingTier} from './mowerAlphaDorm'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {evaluateBackupExpression} from './backupPlans'
import {retainMowerFailedTask} from './mowerTaskFailure'
import {invalidateMowerReplacementChecks} from './mowerReplacementCheck'
import {completeMowerGroupConfirmation} from './mowerGroupConfirmation'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {resolveOperatorCharId} from '../domain/operatorIdentifiers'
const rates={workRate:()=>1,recoveryRate:()=>4}
function fixture():RuntimeConfig {
 const keepers=['K1','K2','K3','K4']
 return {positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'A',candidates:['R'],lowerLimit:0,upperLimit:24,shiftOffThreshold:15},...keepers.map((name,i)=>({id:'dormitory_1_'+i,roomId:'dormitory_1',primary:name,candidates:[],permanent:true,dormitory:true}))],beds:[{id:'dormitory_1_4',roomId:'dormitory_1',vip:true}],initialMorale:{A:16,R:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},mowerSourcePlan:{room_1_1:[{agent:'A',group:'',replacement:['R']}],dormitory_1:[...keepers.map(name=>({agent:name,group:'',replacement:[]})),{agent:'Free',group:'',replacement:[]}]},mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0}}
}
describe('integrated Mower source scheduler',()=>{
 it('keeps standby policy and independent state while retiring temporary promotion during a rebuild',()=>{
  const config=fixture();config.mowerAlpha=true;config.mowerSourceRules!.standby=['A']
  config.mowerSourcePlan!.room_1_1![0]!.group='g'
  config.mowerPolicy!.groupMoodGapExclusions=['other','saved']
  const state=createRosterRuntime(config),source=getMowerSourceRuntime(state)
  mowerUpdateDetail(source.data,'A',0,'dormitory_1',4,true)
  mowerUpdateDetail(source.data,'A',24,'dormitory_1',4,true)
  source.data.groupShiftState.g=true
  source.data.groupRecoveryFullMembers.g=['A']
  source.data.groupRecoveryReturnMicros.g=12345
  source.data.operators.A!.standbyLowPriority=true // Legacy snapshots may still contain the retired marker.
  const rebuilt=makeMowerSchedulingData(state,source),op=rebuilt.operators.A!
  expect(rebuilt.groupMoodGapExclusions).toEqual(['other','saved'])
  rebuilt.groupMoodGapExclusions.push('extra')
  expect(source.data.groupMoodGapExclusions).toEqual(['other','saved'])
  expect(config.mowerPolicy!.groupMoodGapExclusions).toEqual(['other','saved'])
  expect(rebuilt.groupRecoveryReturnMicros.g).toBe(12345)
  rebuilt.groupRecoveryReturnMicros.g=67890
  expect(source.data.groupRecoveryReturnMicros.g).toBe(12345)
  expect(op).not.toBe(source.data.operators.A)
  expect(op.mood).toBe(24)
  expect(op.standbyLowPriority).toBe(false)
  expect(alphaRestingTier(rebuilt,'A')).toBe(6)
  expect(rebuilt.canStandby(op)).toBe(true)
  expect(rebuilt.isGroupShiftAnchor(op)).toBe(false)
  mowerUpdateDetail(rebuilt,'A',12,'room_1_1',0,true)
  expect(op.standbyLowPriority).toBe(false)
  expect(alphaRestingTier(rebuilt,'A')).toBe(4)
 })
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
 it.each([false,true])('ends a removed entry task on the existing clock even with a future queue head (unsorted=%s)',unsorted=>{
  const config=fixture();config.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
  const s=createRosterRuntime(config);settleRoster(s,rates)
  const source=getMowerSourceRuntime(s),removed=new MowerTask({type:T.SHIFT_ON,plan:{room_1_1:['R']}}),next=new MowerTask({plan:{room_1_1:['Current']}})
  source.queue.tasks=[removed,next];delete source.runReturn
  settleRoster(s,rates,0,phase=>{if(phase==='BEGINNING'){source.queue.consume(removed);if(unsorted)source.queue.tasks=[new MowerTask({time:1}),next]}return false})
  expect(source.queue.tasks).not.toContain(removed);expect(source.queue.tasks).toContain(next)
  expect(next.timeMicros).toBe(0)
  expect(nextRosterActionHours(s,rates)).toBe(1/3_600_000_000)
  advanceRoster(s,1/3_600_000_000,rates);settleRoster(s,rates)
  expect(source.queue.tasks).not.toContain(next)
  expect(s.occupants.room_1_1_0).toBe('A')
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
  // A protected complete shift does not expose its intermediate occupancy to backups.
  expect(phases.some(p=>p.phase==='BEFORE_DORM')).toBe(false)
  expect(phases.find(p=>p.phase==='BEFORE_PLANNING')?.time).toBeCloseTo(startedAt+1_000_000/3_600_000_000,12)
 })
 it('preserves the actual working departure observation while waiting for a dorm room',()=>{
  const c=fixture();c.mowerAlpha=true;c.mowerDeviceTiming={roomReturnMicros:500_000}
  const s=createRosterRuntime(c);settleRoster(s,rates)
  advanceRoster(s,nextRosterActionHours(s,rates),rates);settleRoster(s,rates)
  const source=getMowerSourceRuntime(s),op=source.data.operators.A!
  s.morale.A=5;op.mood=16;op.timeStampMicros=0;op.depletionRate=1
  source.queue.tasks=[new MowerTask({time:s.time,type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['K1','K2','K3','K4','A']}})]
  settleRoster(s,rates)
  expect(s.occupants.room_1_1_0).toBe('R')
  expect(op.currentRoom).toBe('')
  expect(op.mood).toBe(5)
  expect(op.timeStampMicros).toBe(source.data.nowMicros)
  expect(op.moodIsPrediction).toBe(false)
  expect(op.depletionRate).toBe(0)
  expect(op.currentMood(source.data.nowMicros+3_600_000_000)).toBe(5)
 })
 it.each([undefined,0])('does not promote an unread working departure with timestamp %s',stamp=>{
  const c=fixture();c.mowerAlpha=true;c.mowerDeviceTiming={roomReturnMicros:500_000}
  const s=createRosterRuntime(c);settleRoster(s,rates)
  advanceRoster(s,nextRosterActionHours(s,rates),rates);settleRoster(s,rates)
  const source=getMowerSourceRuntime(s),op=source.data.operators.A!
  s.morale.A=5;op.mood=16;op.timeStampMicros=stamp;op.depletionRate=1
  // A Fiammetta restoration does not read the departing work-room operator.
  source.queue.tasks=[new MowerTask({time:s.time,type:T.FIAMMETTA,plan:{room_1_1:['R']}})]
  settleRoster(s,rates)
  expect(s.occupants.room_1_1_0).toBe('R')
  expect(op.currentRoom).toBe('')
  expect(op.mood).toBe(16)
  expect(op.timeStampMicros).toBeUndefined()
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

 it('selects Fiammetta targets from cached mood without an extra candidate-room read',()=>{
  const config=fixture(),fia='char_300_phenxi';config.mowerAlpha=true
  config.positions[1]!.primary=fia;config.mowerSourcePlan!.dormitory_1![0]!.agent=fia
  config.initialMorale={A:24,R:24,[fia]:24};config.fiammetta={operatorId:fia,orderedTargets:['A'],fool:true,threshold:1}
  const state=createRosterRuntime(config);settleRoster(state,rates)
  const source=getMowerSourceRuntime(state),candidate=source.data.operators.A!
  // Start this cached-selection scenario after Fiammetta has recovered from her initial 16.
  expect(state.morale[fia]).toBe(16)
  state.morale[fia]=24;source.data.operators[fia]!.mood=24
  expect(candidate.mood).toBe(24);candidate.depletionRate=0;candidate.timeStampMicros=source.data.nowMicros
  state.morale.A=10;source.queue.tasks=[new MowerTask({time:state.time,type:T.FIAMMETTA})]
  settleRoster(state,rates)
  expect(state.events.find(event=>event.type==='fiammetta')).toBeUndefined()
  expect(state.morale.A).toBe(10);expect(state.morale[fia]).toBe(24)
  expect(candidate.mood).toBe(24)
  expect(source.queue.tasks.find(task=>task.type===T.FIAMMETTA)!.time).toBe(11.5)
 })

 it('resets learned working depletion after Fiammetta charge-room restoration',()=>{
  const config=fixture(),fia='char_300_phenxi';config.mowerAlpha=true
  config.positions[1]!.primary=fia;config.mowerSourcePlan!.dormitory_1![0]!.agent=fia
  config.initialMorale={A:24,R:24,[fia]:24};config.fiammetta={operatorId:fia,orderedTargets:['A'],fool:true,threshold:21.6}
  const state=createRosterRuntime(config);settleRoster(state,rates)
  const source=getMowerSourceRuntime(state);source.data.operators.A!.depletionRate=.7;source.data.operators.A!.mood=10;state.morale.A=10
  source.queue.tasks=[new MowerTask({time:state.time,type:T.FIAMMETTA})]
  settleRoster(state,rates)
  expect(state.events.some(e=>e.type==='fiammetta')).toBe(true)
  expect(state.occupants.room_1_1_0).toBe('A')
  expect(source.data.operators.A!.depletionRate).toBe(0)
 })

 it.each([false,true])('refreshes alpha dorm timers after a confirmed arrangement (exact no-op=%s)',same=>{
  const config=fixture();config.mowerAlpha=true;config.idleOperators=['X']
  const state=createRosterRuntime(config);settleRoster(state,rates)
  const source=getMowerSourceRuntime(state),op=source.data.operators.R!,bed=source.data.getDormByName('R')![1]
  state.time=1;source.data.nowMicros=3_600_000_000
  state.morale.R=24;op.mood=24;op.timeStampMicros=0;op.depletionRate=.75;bed.timeMicros=5*3_600_000_000
  source.queue.tasks=[new MowerTask({time:1,type:T.NOT_SPECIFIC,plan:{dormitory_1:[same?'K1':'X','K2','K3','K4','R']}})]
  settleRoster(state,rates)
  expect(op.timeStampMicros).toBe(3_600_000_000)
  expect(bed.timeMicros).toBe(3_600_000_000)
  expect(op.mood).toBe(24)
 })

 it('keeps a Fiammetta restoration no-op free of additional room reads',()=>{
  const config=fixture(),fia='char_300_phenxi';config.mowerAlpha=true
  config.positions[1]!.primary=fia;config.mowerSourcePlan!.dormitory_1![0]!.agent=fia
  config.initialMorale={A:24,R:24,[fia]:24};config.fiammetta={operatorId:fia,orderedTargets:['A'],fool:true,threshold:21.6}
  const state=createRosterRuntime(config);settleRoster(state,rates)
  const source=getMowerSourceRuntime(state),bed=source.data.getDormByName('R')![1],op=source.data.operators.R!
  // The restoration is a no-op after the initial recovery, with no extra room read.
  expect(state.morale[fia]).toBe(16)
  state.morale[fia]=24;source.data.operators[fia]!.mood=24
  state.time=1;source.data.nowMicros=3_600_000_000;bed.timeMicros=5*3_600_000_000;op.timeStampMicros=0
  const fiaTimestamp=source.data.operators[fia]!.timeStampMicros
  source.queue.tasks=[new MowerTask({time:1,type:T.FIAMMETTA,plan:{dormitory_1:[fia,'K2','K3','K4','R']}})]
  settleRoster(state,rates)
  expect(bed.timeMicros).toBe(5*3_600_000_000)
  expect(op.timeStampMicros).toBe(0)
  expect(source.data.operators[fia]!.timeStampMicros).toBe(fiaTimestamp)
 })

 it.each([{alpha:false,named:false},{alpha:true,named:false},{alpha:false,named:true},{alpha:true,named:true}])('retains a full-to-full Fiammetta charge without polling ($alpha, named=$named)',({alpha,named})=>{
  const config=fixture(),fia='char_300_phenxi';config.mowerAlpha=alpha
  config.positions[1]!.primary=fia;config.mowerSourcePlan!.dormitory_1![0]!.agent=fia
  config.idleOperators=['X'];config.initialMorale={A:24,R:24,X:24,[fia]:24}
  config.fiammetta={operatorId:fia,orderedTargets:['A'],fool:false,threshold:21.6}
  const state=createRosterRuntime(config),source=getMowerSourceRuntime(state);source.initial=false
  // Retained full-to-full attempts occur after recovery; first registration still starts at 16.
  expect(state.morale[fia]).toBe(16)
  state.morale[fia]=24
  for(const [slot,name] of Object.entries(state.occupants)){const op=source.data.operators[name]!;op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]!;op.timeStampMicros=0}
  source.queue.tasks=[new MowerTask({type:T.FIAMMETTA,...(named?{plan:{room_1_1:['Current'],dormitory_1:['A',fia]},metadata:'A'}:{})})]
  const before={...state.occupants}
  settleRoster(state,rates)
  const retained=source.queue.tasks.find(task=>task.type===T.FIAMMETTA)!
  expect(retained.executionFailure).toBeDefined();expect(retained.timeMicros).toBe(0)
  expect(retained.plan.room_1_1).toBeUndefined()
  expect(state.events.filter(e=>e.type==='fiammetta')).toHaveLength(0)
  expect(state.occupants).toEqual(before)
  const traceCount=source.trace.filter(t=>t.type==='FIAMMETTA').length
  const independent=new MowerTask({time:.01});source.queue.tasks.push(independent)
  state.time=.01;settleRoster(state,rates)
  expect(source.queue.tasks).not.toContain(independent)
  expect(source.queue.tasks.filter(task=>task.type===T.FIAMMETTA)).toEqual([retained])
  // The independent arrangement moved R into a Free bed and refreshed the observed state.
  expect(source.trace.filter(t=>t.type==='FIAMMETTA')).toHaveLength(traceCount+1)
  expect(source.data.operators.R!.currentRoom).toBe('dormitory_1')
  expect(retained.executionFailure).toBeDefined()
  for(let attempt=0;attempt<3;attempt++)settleRoster(state,rates)
  expect(source.trace.filter(t=>t.type==='FIAMMETTA')).toHaveLength(traceCount+1)
  expect(source.queue.tasks.filter(task=>task.type===T.FIAMMETTA)).toEqual([retained])
  expect(state.events.filter(e=>e.type==='fiammetta')).toHaveLength(0)
  expect(retained.timeMicros).toBe(0)
  expect(state.diagnostics.some(d=>d.message.includes('五分钟'))).toBe(false)
  const target=retained.plan.dormitory_1![0]!
  state.morale[target]=10
  const op=source.data.operators[target]!;op.mood=10;op.timeStampMicros=36_000_000;op.moodIsPrediction=false
  settleRoster(state,rates)
  expect(retained.executionFailure).toBeUndefined()
  expect(state.events.some(e=>e.type==='fiammetta'&&e.operators[1]===target)).toBe(true)
  expect(source.queue.tasks).not.toContain(retained)
  expect(state.occupants.dormitory_1_0).toBe(fia)
  expect(state.occupants.room_1_1_0).toBe('A')
 })


it('starts an exhausted shift before observed morale reaches zero',()=>{
 const config=fixture();config.mowerAlpha=true;config.initialMorale={...config.initialMorale,A:.18};config.mowerSourceRules!.exhaustRequire=['A']
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state)
 source.initial=false;source.firstInit=false
 for(const [slot,name] of Object.entries(state.occupants)){const op=source.data.operators[name]!;op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]??24;op.timeStampMicros=0}
 source.queue.tasks=[new MowerTask({type:T.EXHAUST_OFF,metadata:'A'})]
 for(let i=0;i<20&&!source.data.operators.A!.isResting();i++){
  settleRoster(state,rates)
  if(!source.data.operators.A!.isResting())advanceRoster(state,nextRosterActionHours(state,rates),rates)
 }
 expect(source.data.operators.A!.isResting()).toBe(true)
 expect(state.morale.A).toBeGreaterThan(0)
 expect(state.occupants.room_1_1_0).toBe('R')
})

it('checks a working ordinary cover at its personal lower limit and replaces only that slot',()=>{
 const config=fixture();config.mowerAlpha=true;config.idleOperators=['S']
 config.mowerSourcePlan!.room_1_1![0]!.replacement=['R','S'];config.positions[0]!.candidates=['R','S']
 config.mowerSourceRules!.restInFull=['A'];config.initialMorale={A:8,R:12,S:24}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),slowRecovery={workRate:()=>2,recoveryRate:()=>.1}
 source.initial=false;source.firstInit=false
 state.occupants.room_1_1_0='R';state.bedOccupants.dormitory_1_4='A'
 for(const [slot,name] of Object.entries({...state.occupants,...state.bedOccupants})){
  const op=source.data.operators[name]!
  op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]??24;op.timeStampMicros=0
 }
 source.data.operators.R!.lowerLimit=4;source.data.operators.S!.mood=24;source.data.operators.S!.timeStampMicros=0;source.queue.tasks=[]
 settleRoster(state,slowRecovery)
 const check=source.queue.tasks.find(task=>task.replacementCheck)!
 expect(check.time).toBe(4);expect(state.occupants.room_1_1_0).toBe('R')
 advanceRoster(state,4,slowRecovery);settleRoster(state,slowRecovery)
 expect(state.occupants.room_1_1_0).toBe('S')
 expect(source.data.operators.A!.isResting()).toBe(true);expect(state.morale.A).toBeLessThan(24)
 expect(source.queue.tasks).not.toContain(check)
 expect(state.diagnostics.some(d=>d.code==='mower-task-exception')).toBe(false)
})

function workingOrdinaryCoverClockFixture(minimumClockStepMicros=1){
 const config=fixture();config.mowerAlpha=true;config.idleOperators=['S']
 config.mowerSourcePlan!.room_1_1![0]!.replacement=['R','S'];config.positions[0]!.candidates=['R','S']
 config.mowerSourceRules!.restInFull=['A'];config.initialMorale={A:8,R:12,S:24}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),slowRecovery={workRate:()=>2,recoveryRate:()=>.1}
 source.initial=false;source.firstInit=false
 state.occupants.room_1_1_0='R';state.bedOccupants.dormitory_1_4='A'
 for(const [slot,name] of Object.entries({...state.occupants,...state.bedOccupants})){
  const op=source.data.operators[name]!
  op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]??24;op.timeStampMicros=0
 }
 source.data.operators.R!.lowerLimit=4;source.data.operators.S!.mood=24;source.data.operators.S!.timeStampMicros=0;source.queue.tasks=[]
 settleRoster(state,slowRecovery)
 const check=source.queue.tasks.find(task=>task.replacementCheck)!
 expect(check.time).toBe(4)
 state.config.mowerRunLoopClock={minimumClockStepMicros,notificationSleepMicros:1_000_000}
 return {state,source,slowRecovery,check}
}

it.each([{lateSeconds:0,step:1},{lateSeconds:6,step:1},{lateSeconds:0,step:7},{lateSeconds:6,step:7}])('executes a due cover check after the existing outer wake without rolling it back or postponing it ($lateSeconds seconds late, $step microseconds)',({lateSeconds,step})=>{
 const {state,source,slowRecovery,check}=workingOrdinaryCoverClockFixture(step)
 advanceRoster(state,4+lateSeconds/3600,slowRecovery)
 const now=toMowerMicros(state.time),deadline=check.timeMicros,wake=now+step
 source.runReturn={wakeMicros:wake,finishFallback:false}
 for(let query=0;query<3;query++){
  expect(nextRosterActionHours(state,slowRecovery)).toBe(step/3_600_000_000)
  expect(source.runReturn?.wakeMicros).toBe(wake)
  expect(check.timeMicros).toBe(deadline)
 }
 advanceRoster(state,step/3_600_000_000,slowRecovery)
 settleRoster(state,slowRecovery)
 expect(state.occupants.room_1_1_0).toBe('S')
 expect(source.queue.tasks).not.toContain(check)
 expect(source.data.operators.A!.isResting()).toBe(true)
 expect(state.morale.A).toBeLessThan(24)
 expect(state.diagnostics.some(d=>d.code==='mower-task-exception')).toBe(false)
})

it('rechecks a stale invalidated cover after a completed room operation without replacing it before its lower limit',()=>{
 const {state,source,slowRecovery,check}=workingOrdinaryCoverClockFixture()
 advanceRoster(state,1,slowRecovery)
 invalidateMowerReplacementChecks(getMowerSourceRuntime(state).data,source.queue)
 const originalTime=check.timeMicros
 expect(originalTime).toBe(toMowerMicros(1))
 advanceRoster(state,6/3600,slowRecovery)
 const now=toMowerMicros(state.time)
 source.runReturn={wakeMicros:now+1,finishFallback:false}
 expect(nextRosterActionHours(state,slowRecovery)).toBe(1/3_600_000_000)
 expect(check.timeMicros).toBe(originalTime)
 advanceRoster(state,1/3_600_000_000,slowRecovery);settleRoster(state,slowRecovery)
 expect(source.data.operators.R!.timeStampMicros).toBe(toMowerMicros(state.time))
 expect(state.occupants.room_1_1_0).toBe('R')
 expect(source.queue.tasks).toContain(check)
 expect(check.timeMicros).toBeGreaterThan(toMowerMicros(state.time))
 expect(check.replacementCheck!.readAfterMicros).toBeUndefined()
})
it('wakes an outer sleep at a future cover deadline and actually executes the check at that deadline',()=>{
 const {state,source,slowRecovery,check}=workingOrdinaryCoverClockFixture(7)
 advanceRoster(state,1,slowRecovery)
 source.runReturn={wakeMicros:toMowerMicros(6),finishFallback:false}
 const deadline=check.timeMicros
 expect(nextRosterActionHours(state,slowRecovery)).toBe(3)
 expect(source.runReturn.wakeMicros).toBe(deadline)
 expect(nextRosterActionHours(state,slowRecovery)).toBe(3)
 expect(check.timeMicros).toBe(deadline)
 advanceRoster(state,3,slowRecovery);settleRoster(state,slowRecovery)
 expect(source.queue.tasks).not.toContain(check)
 expect(source.queue.tasks.find(task=>task.type===T.SELF_CORRECTION)?.plan).toEqual({room_1_1:['S']})
 expect(nextRosterActionHours(state,slowRecovery)).toBe(7/3_600_000_000)
 advanceRoster(state,7/3_600_000_000,slowRecovery);settleRoster(state,slowRecovery)
 expect(state.occupants.room_1_1_0).toBe('S')
 expect(source.queue.tasks).not.toContain(check)
})

it('executes an overdue cover check immediately when no outer return is pending',()=>{
 const {state,source,slowRecovery,check}=workingOrdinaryCoverClockFixture(7)
 advanceRoster(state,4+6/3600,slowRecovery)
 delete source.runReturn
 expect(nextRosterActionHours(state,slowRecovery)).toBe(0)
 expect(source.runReturn).toBeUndefined()
 settleRoster(state,slowRecovery)
 expect(state.occupants.room_1_1_0).toBe('S')
 expect(source.queue.tasks).not.toContain(check)
})
it('enables fatigue-rate invalidation after initial reads when a configured provider really changes rooms',()=>{
 const config=fixture();config.mowerAlpha=true;config.idleOperators=['S']
 config.mowerSourcePlan!.room_1_1![0]!.replacement=['R','S'];config.positions[0]!.candidates=['R','S']
 config.mowerSourcePlan!.room_2_1=[{agent:'B',group:'',replacement:['S']}]
 config.positions.push({id:'room_2_1_0',roomId:'room_2_1',primary:'B',candidates:['S']})
 config.mowerSourceRules!.restInFull=['A'];config.mowerSourceRules!.refreshDrained=['B'];config.initialMorale={A:8,R:12,S:24,B:24}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state)
 state.occupants.room_1_1_0='R';state.bedOccupants.dormitory_1_4='A'
 settleRoster(state,rates)
 expect(source.firstInit).toBe(false)
 const check=source.queue.tasks.find(task=>task.replacementCheck?.target.cover==='R')!
 expect(check.replacementCheck!.revision).toBe(0)
 source.queue.tasks.push(new MowerTask({type:T.NOT_SPECIFIC,plan:{room_2_1:['S']}}))
 settleRoster(state,rates)
 expect(check.replacementCheck!.revision).toBeGreaterThan(0)
 expect(state.diagnostics.some(d=>d.code==='mower-task-exception')).toBe(false)
})

it('retains an incomplete group after physical execution and confirms the original task only after all targets are observed',()=>{
 const config=fixture();config.mowerAlpha=true;config.mowerSourcePlan!.room_1_1![0]!.group='G';config.mowerDeviceTiming={roomReturnMicros:500_000}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state)
 source.initial=false;source.firstInit=false
 for(const [slot,name] of Object.entries(state.occupants)){
  const op=source.data.operators[name]!
  op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]??24;op.timeStampMicros=0
 }
 const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['K1','K2','K3','K4','A']}})
 source.data.groupShiftState.G=false;source.queue.tasks=[task]
 settleRoster(state,rates)
 expect(source.execution?.task).toBe(task);expect(state.occupants.room_1_1_0).toBe('R')
 expect(source.data.groupShiftState.G).toBe(false)
 // A later real position observation invalidates a room that was already executed.
 delete state.occupants.room_1_1_0;source.data.operators.R!.currentRoom='';source.data.operators.R!.currentIndex=-1
 for(let attempt=0;attempt<5&&source.execution;attempt++){
  advanceRoster(state,nextRosterActionHours(state,rates),rates);settleRoster(state,rates)
 }
 expect(task.executionFailure?.reason).toBe('换班实测驻员与目标不一致')
 expect(source.queue.tasks).toContain(task);expect(task.timeMicros).toBe(0)
 expect(task.plan).toEqual({room_1_1:['R']});expect(source.data.groupShiftState.G).toBe(false)
 state.occupants.room_1_1_0='R';source.data.operators.R!.currentRoom='room_1_1';source.data.operators.R!.currentIndex=0;source.data.operators.R!.timeStampMicros=source.data.nowMicros
 for(let attempt=0;attempt<8&&source.queue.tasks.includes(task);attempt++){
  settleRoster(state,rates)
  if(source.queue.tasks.includes(task))advanceRoster(state,nextRosterActionHours(state,rates),rates)
 }
 expect(source.queue.tasks).not.toContain(task);expect(task.groupShiftExpected).toEqual({})
 expect(source.data.groupShiftState.G).toBe(true)
})

function predecessorFixture(independent=false){
 const config=fixture();config.mowerAlpha=true;config.idleOperators=['S'];config.initialMorale={A:16,R:24,S:24,B:24};config.mowerDeviceTiming={roomReturnMicros:500_000}
 config.mowerSourcePlan!.room_1_1![0]!.group='G'
 if(independent){config.mowerSourcePlan!.room_2_1=[{agent:'B',group:'H',replacement:['S']}];config.positions.push({id:'room_2_1_0',roomId:'room_2_1',primary:'B',candidates:['S']})}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),data=source.data
 source.initial=false;source.firstInit=false;state.occupants.room_1_1_0='R'
 for(const [slot,name] of Object.entries(state.occupants)){const op=data.operators[name]!;op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1));op.mood=state.morale[name]??24;op.timeStampMicros=0}
 Object.assign(data.operators.A!,{currentRoom:'',currentIndex:-1,mood:16,timeStampMicros:0})
 data.groupShiftState.G=false
 const pending=new MowerTask({type:T.SHIFT_OFF,plan:{dormitory_1:['Current','Current','Current','Current','A']}})
 pending.arrangementStarted=true;pending.groupShiftTransitions={G:true};pending.groupShiftExpected={['room_1_1\0'+'0']:'R',['dormitory_1\0'+'4']:'A'}
 source.queue.tasks=[pending];retainMowerFailedTask(state,data,pending,'unconfirmed group target',['dormitory_1'])
 return {state,source,data,pending}
}
it.each([T.SELF_CORRECTION,T.NOT_SPECIFIC])('parks overlapping %s work while a predecessor still owns its completed targets',type=>{
 const {state,source,pending}=predecessorFixture(),task=new MowerTask({type,plan:{room_1_1:['S']}});source.queue.tasks.push(task)
 settleRoster(state,rates)
 expect(state.occupants.room_1_1_0).toBe('R')
 expect(source.waitingGroupShifts?.some(wait=>wait.task===task&&wait.predecessors.includes(pending))).toBe(true)
 expect(source.queue.tasks).not.toContain(task);expect(task.timeMicros).toBe(0)
 const trace=source.trace.length;settleRoster(state,rates);expect(source.trace.length).toBe(trace)
 expect(state.diagnostics.some(d=>d.code==='mower-task-exception')).toBe(false)
})
it('executes independent work and resumes the same overlapping task only after actual predecessor confirmation',()=>{
 const {state,source,data,pending}=predecessorFixture(true),task=new MowerTask({type:T.NOT_SPECIFIC,plan:{room_1_1:['S']}}),independent=new MowerTask({type:T.NOT_SPECIFIC,plan:{room_2_1:['S']}})
 source.queue.tasks.push(task,independent);settleRoster(state,rates)
 expect(state.occupants.room_1_1_0).toBe('R');expect(state.occupants.room_2_1_0).toBe('S')
 expect(source.execution?.task).toBe(independent);expect(source.waitingGroupShifts?.some(wait=>wait.task===task)).toBe(true)
 // Complete the independent room boundary, then provide the predecessor's missing real observation.
 while(source.execution){advanceRoster(state,nextRosterActionHours(state,rates),rates);settleRoster(state,rates)}
 state.bedOccupants.dormitory_1_4='A';Object.assign(data.operators.A!,{currentRoom:'dormitory_1',currentIndex:4,mood:16,timeStampMicros:data.nowMicros})
 expect(completeMowerGroupConfirmation(data,pending).complete).toBe(true);source.queue.consume(pending)
 for(let n=0;n<8&&source.waitingGroupShifts?.some(wait=>wait.task===task);n++){settleRoster(state,rates);if(source.execution)advanceRoster(state,nextRosterActionHours(state,rates),rates)}
 expect(source.waitingGroupShifts?.some(wait=>wait.task===task)).toBe(false)
 expect(task.timeMicros).toBe(0);expect(state.occupants.room_1_1_0).toBe('S')
 expect(source.trace.some(entry=>entry.type==='NOT_SPECIFIC'&&entry.plan.room_1_1?.[0]==='S')).toBe(true)
})
it('keeps personal-cap release on its independent validation path while canceling a waiting dynamic target',()=>{
 const {state,source,data,pending}=predecessorFixture()
 state.bedOccupants.dormitory_1_4='A';state.morale.A=12
 Object.assign(data.operators.A!,{currentRoom:'dormitory_1',currentIndex:4,mood:12,timeStampMicros:0,upperLimit:12,restMoodLimit:true})
 retainMowerFailedTask(state,data,pending,'unconfirmed group target',['dormitory_1'])
 const release=new MowerTask({type:T.RELEASE_DORM,plan:{dormitory_1:['Current','Current','Current','Current','Free']},metadata:'A',strictMoodLimit:true,moodLimit:12});release.releaseTargets={A:['dormitory_1',4]}
 source.queue.tasks.push(release)
 for(let n=0;n<8&&source.queue.tasks.includes(release);n++){settleRoster(state,rates);if(source.queue.tasks.includes(release))advanceRoster(state,nextRosterActionHours(state,rates),rates)}
 expect(source.waitingGroupShifts?.some(wait=>wait.task===release)).toBeFalsy()
 expect(source.queue.tasks).not.toContain(release);expect(Object.values(state.bedOccupants)).not.toContain('A')
 expect(Object.values(pending.groupShiftExpected)).not.toContain('A');expect(pending.timeMicros).toBe(0)
})

describe.each([false,true])('native observed exhaustion deadlines, alpha=%s',alpha=>{
 it.each([
  {kind:'ordinary',lower:0,leadMinutes:30},
  {kind:'personal lower limit',lower:12,leadMinutes:30},
  {kind:'self full-rest',lower:0,leadMinutes:10},
  {kind:'group full-rest',lower:0,leadMinutes:10},
 ])('uses the configured lower limit and $leadMinutes minute lead for $kind',({kind,lower,leadMinutes})=>{
  const workspace=createDefaultWorkspace(),dusk=resolveOperatorCharId('夕'),peer=resolveOperatorCharId('芬')
  const cover=resolveOperatorCharId('砾'),peerCover=resolveOperatorCharId('克洛丝'),group=kind==='group full-rest'?'g':null
  for(const room of Object.values(workspace.mainPlan.facilities))room.slots=[]
  workspace.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:dusk},groupId:group,replacements:[cover]}]
  if(group)workspace.mainPlan.facilities.room_1_1.slots.push({occupant:{kind:'operator',operatorId:peer},groupId:group,replacements:[peerCover]})
  workspace.mainPlan.conf.ling_xi=lower?1:0
  workspace.mainPlan.conf.exhaust_require=[dusk]
  workspace.mainPlan.conf.rest_in_full=kind==='self full-rest'?[dusk]:group?[peer]:[]
  const config=compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace,{operatorMorale:{[dusk]:lower+2,[peer]:24}}))
  config.mowerAlpha=alpha
  const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),op=source.data.operators[dusk]!
  source.initial=false;source.firstInit=false
  for(const position of config.positions)Object.assign(source.data.operators[position.primary]!,{currentRoom:position.roomId,currentIndex:Number(position.id.slice(-1)),mood:state.morale[position.primary],timeStampMicros:0,depletionRate:1})
  source.queue.tasks=[new MowerTask({time:-1/3600})]
  settleMowerSource(state,rates)
  expect(op.lowerLimit).toBe(lower)
  const task=source.queue.tasks.find(task=>task.type===T.EXHAUST_OFF&&task.metadata===dusk)
  // Native first converts the observed zero timer to lowerLimit, then applies its lead.
  expect(task?.timeMicros).toBe(toMowerMicros(2-leadMinutes/60))
 })
})

it.each([false,true])('checks the grouped quota when actual Free selection resolves an unknown-mood priority replacement, alpha=%s',alpha=>{
 const priority=resolveOperatorCharId('阿罗玛'),idle=resolveOperatorCharId('砾')
 const config:RuntimeConfig={
  mowerAlpha:alpha,positions:[
   {id:'room_1_1_0',roomId:'room_1_1',primary:'H1',candidates:['R']},
   {id:'dormitory_1_0',roomId:'dormitory_1',primary:'Keeper',candidates:[],dormitory:true,group:'g'},
  ],beds:[{id:'dormitory_1_1',roomId:'dormitory_1',vip:true}],
  mowerSourcePlan:{room_1_1:[{agent:'H1',group:'h',replacement:['R',priority]}],dormitory_1:[{agent:'Keeper',group:'g',replacement:['Free']},{agent:'Free',group:'',replacement:[]}]},
  mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0,priorityReplacement:[priority]},
  mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},availableIdleOperators:[priority,idle],
  initialMorale:{H1:5,R:24,Keeper:24,[priority]:2,[idle]:24},
 }
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),data=source.data
 source.initial=false;source.firstInit=false
 state.occupants={room_1_1_0:'R'};state.bedOccupants={dormitory_1_1:'H1'}
 Object.assign(data.operators.H1!,{currentRoom:'dormitory_1',currentIndex:1,mood:5,timeStampMicros:0})
 Object.assign(data.operators.R!,{currentRoom:'room_1_1',currentIndex:0,mood:24,timeStampMicros:0})
 Object.assign(data.operators.Keeper!,{currentRoom:'',currentIndex:-1,mood:24,timeStampMicros:0})
 expect(data.operators[priority]!.timeStampMicros).toBeUndefined()
 data.groupShiftState={g:true,h:true}
 const bed=data.dorms.find(bed=>bed.position[1]===1)!
 bed.name='H1';bed.timeMicros=toMowerMicros(5)
 const task=new MowerTask({plan:{dormitory_1:['Free','Current']}})
 task.groupShiftTransitions={g:true};source.queue.tasks=[task]
 settleRoster(state,rates)
 expect(state.bedOccupants.dormitory_1_1).toBe('H1')
 expect(state.bedOccupants.dormitory_1_0??state.occupants.dormitory_1_0).toBe(alpha?idle:'Keeper')
})
