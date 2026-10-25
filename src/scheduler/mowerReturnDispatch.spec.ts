import {describe,expect,it} from 'vitest'
import {createRosterRuntime,settleRoster,type RuntimeConfig} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {planMowerMetadata} from './mowerMetadata'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'

const room='dormitory_1',now=240,rates={workRate:()=>1,recoveryRate:()=>4}
function fixture(){
 const keepers=['K1','K2','K3']
 const config:RuntimeConfig={
  positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'A',candidates:['R'],group:'g'},{id:'room_1_2_0',roomId:'room_1_2',primary:'B',candidates:['S'],group:'g'},...keepers.map((primary,index)=>({id:room+'_'+index,roomId:room,primary,candidates:[],permanent:true,dormitory:true}))],
  beds:[{id:room+'_3',roomId:room,vip:true},{id:room+'_4',roomId:room,vip:false}],
  initialMorale:{A:22.15,B:24,R:24,S:24},mowerAlpha:true,
  mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],groupRestInFullOnMoodGap:true,groupMoodGapThresholdMinutes:60,groupMoodGapMaxExtraWaitHours:0},
  mowerTaskScheduling:{adjustForRunOrders:false},mowerDeviceTiming:{roomReturnMicros:0},
  mowerSourcePlan:{room_1_1:[{agent:'A',group:'g',replacement:['R']}],room_1_2:[{agent:'B',group:'g',replacement:['S']}],[room]:[...keepers.map(agent=>({agent,group:'',replacement:[]})),...['Free','Free'].map(agent=>({agent,group:'',replacement:[]}))]},
  mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0},
 }
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state),data=source.data
 source.initial=false;source.firstInit=false;state.time=now;data.nowMicros=toMowerMicros(now)
 state.occupants={room_1_1_0:'R',room_1_2_0:'S',...Object.fromEntries(keepers.map((name,index)=>[room+'_'+index,name]))}
 state.bedOccupants={[room+'_4']:'B'}
 for(const op of Object.values(data.operators)){op.currentRoom='';op.currentIndex=-1;op.mood=state.morale[op.name]??24;op.timeStampMicros=data.nowMicros;op.moodIsPrediction=false;op.depletionRate=0}
 for(const [slot,name] of Object.entries({...state.occupants,...state.bedOccupants})){const op=data.operators[name]!;op.currentRoom=slot.slice(0,slot.lastIndexOf('_'));op.currentIndex=Number(slot.slice(slot.lastIndexOf('_')+1))}
 for(const bed of data.dorms){bed.name=state.bedOccupants[bed.position[0]+'_'+bed.position[1]]??'';bed.timeMicros=bed.name?data.nowMicros:undefined}
 data.groupShiftState.g=true;data.groupRecoveryFullMembers.g=['A','B'];source.queue.tasks=[]
 return {state,source,data}
}

describe('native observed return dispatch scope',()=>{
 // f19abfa3 infra_main:2691–2752 dispatches saved observed tasks after preview.
 // Its optional calculated tap validation:1421–1506 skips retained execution.
 // An existing due task is distinct from metadata generating a new early return.
 it.each([
  {name:'ordinary SHIFT_ON',type:T.SHIFT_ON,retained:false,derived:false},
  {name:'retained SHIFT_ON',type:T.SHIFT_ON,retained:true,derived:false},
  {name:'derived SELF_CORRECTION',type:T.SELF_CORRECTION,retained:false,derived:true},
  {name:'ordinary RE_ORDER',type:T.RE_ORDER,retained:false,derived:false},
 ])('dispatches an existing $name without adding a group-full failure',({type,retained,derived})=>{
  const {state,source}=fixture(),plan={room_1_1:['A'],room_1_2:['B']},task=new MowerTask({type,time:now,plan})
  task.executionRetained=retained;task.derivedCorrection=derived;source.queue.tasks=[task]
  const originalTime=task.timeMicros
  settleRoster(state,rates)
  expect(task.executionFailure).toBeUndefined()
  expect(task.timeMicros).toBe(originalTime)
  expect(source.queue.tasks).not.toContain(task)
  expect(source.trace.some(entry=>entry.type===type.key&&entry.plan.room_1_1?.[0]==='A')).toBe(true)
  expect(state.occupants.room_1_1_0).toBe('A')
  expect(state.occupants.room_1_2_0).toBe('B')
  expect(state.morale.A).toBe(22.15)
  expect(state.time).toBe(now)
  expect(state.diagnostics.some(item=>item.code==='mower-task-exception')).toBe(false)
 })

 it.each(['gap latch','explicit full'] as const)('keeps the generated %s return at its real recovery deadline',mode=>{
  const {state,source,data}=fixture(),op=data.operators.A!,due=toMowerMicros(now+2)
  state.bedOccupants[room+'_3']='A';op.currentRoom=room;op.currentIndex=3
  const bed=data.dorms.find(bed=>bed.position[1]===3)!;bed.name='A';bed.timeMicros=due
  if(mode==='explicit full'){data.groupRestInFullOnMoodGap=false;data.groupRecoveryFullMembers={};op.restInFull=true}
  planMowerMetadata(data,source.queue)
  const returns=source.queue.tasks.filter(task=>task.type===T.SHIFT_ON&&task.plan.room_1_1?.includes('A'))
  expect(returns).toHaveLength(1)
  expect(returns[0]!.timeMicros).toBe(due)
  expect(op.currentRoom).toBe(room)
  expect(state.morale.A).toBe(22.15)
  expect(state.time).toBe(now)
 })
})
