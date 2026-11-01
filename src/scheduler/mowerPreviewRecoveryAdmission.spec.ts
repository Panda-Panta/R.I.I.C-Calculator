import {describe,expect,it,vi} from 'vitest'
import {resolveOperatorCharId as id} from '../domain/operatorIdentifiers'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createBackupPlanController} from './backupPlans'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime,nextMowerSourceActionHours,settleMowerSource} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {cloneMowerShiftTask,prepareMowerShiftBackup} from './mowerShiftCycle'
import {MowerBackupRecoveryBlocked} from './mowerBackupDepartureRecovery'
import {parkMowerBackupDepartureRecovery,resumeMowerPreviewRecovery} from './mowerPreviewRecoveryWait'
import {invalidateMowerDormTime,mowerUpdateDetail,mowerRefreshDormTime} from './mowerObservations'
import {previewMowerBackupRecoveryRetry} from './mowerPreviewRecoveryAdmission'

const fang='char_123_fang',vanilla='char_240_wyvern',melantha='char_208_melan',beagle='char_122_beagle'
const rates={workRate:()=>1,recoveryRate:()=>4}
function fixture(slotReservation=false){
 const workspace=createDefaultWorkspace(),slot=(operatorId:string,groupId:string|null=null,replacements:string[]=[])=>({occupant:{kind:'operator' as const,operatorId},groupId,replacements})
 workspace.mainPlan.facilities.room_1_1.slots=[slot(fang,'a',[vanilla])]
 workspace.mainPlan.facilities.recycle.level=1;workspace.mainPlan.facilities.recycle.slots=[slot(melantha,'a',[beagle])]
 workspace.mainPlan.facilities.dormitory_1.slots=Array.from({length:5},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]}))
 const keepers=[id('夜莺'),id('克洛丝'),id('芙蓉')]
 keepers.forEach((name,index)=>workspace.mainPlan.facilities.dormitory_1.slots[index+2]=slot(name))
 workspace.compatibility.backupPlans=[{name:'departure',trigger:"op_data.operators['芬'].is_working() and op_data.operators['芬'].current_mood() < 10",plan:{},task:{room_1_1:['香草']}}]
 const schedule=compileRosterSchedule(workspace),config=compiledScheduleToRuntimeConfig(schedule);config.mowerAlpha=true;config.freeBlacklist=[beagle]
 config.mowerRunLoopClock={minimumClockStepMicros:1,notificationSleepMicros:1_000_000}
 const state=createRosterRuntime(config),controller=createBackupPlanController(schedule,state),source=getMowerSourceRuntime(state),data=source.data
 source.initial=false;source.firstInit=false;source.startupRunOrderCheckPending=false;source.initialStaffingPending=false
 for(const op of Object.values(data.operators)){op.setProjectedPosition('',-1);op.mood=24;op.timeStampMicros=0;op.depletionRate=0}
 state.occupants={room_1_1_0:vanilla,...Object.fromEntries(keepers.map((name,index)=>['dormitory_1_'+(index+2),name]))}
 state.bedOccupants={dormitory_1_0:fang,dormitory_1_1:melantha}
 for(const [position,name] of Object.entries({...state.occupants,...state.bedOccupants}))data.operators[name]!.setProjectedPosition(position.slice(0,position.lastIndexOf('_')),Number(position.slice(position.lastIndexOf('_')+1)))
 for(const name of [fang,melantha]){data.operators[name]!.mood=5;state.morale[name]=5}
 for(const bed of data.dorms){const name=state.bedOccupants[bed.position[0]+'_'+bed.position[1]];if(name){bed.name=name;bed.timeMicros=toMowerMicros(19/4)}}
 data.groupShiftState.a=true
 const task=new MowerTask({type:T.SELF_CORRECTION,plan:{room_1_1:[fang],...(slotReservation?{}:{recycle:[melantha]})}}),owner=new MowerTask({time:6,type:T.SELF_CORRECTION})
 if(slotReservation)data.reservedProductBeds.set('dormitory_1\0'+'0','other-product-owner')
 else owner.groupShiftExpected={['room_1_1\0'+'0']:fang}
 source.queue.tasks=[task,owner]
 const fail=(target=task)=>{
  try{prepareMowerShiftBackup(data,target,state.mowerShiftModel!,source.queue.tasks.filter(other=>other!==target))}catch(error){if(error instanceof MowerBackupRecoveryBlocked)return error;throw error}
  throw new Error('Expected a real backup recovery failure')
 }
 const live=()=>({physical:structuredClone([state.occupants,state.bedOccupants,state.morale]),data:JSON.stringify(data),queue:source.queue.tasks.map(current=>[current,JSON.stringify(current)])})
 const probe=(target:MowerTask)=>previewMowerBackupRecoveryRetry(data,target,state.mowerShiftModel!,source.queue.tasks)
 return {state,controller,source,data,task,owner,fail,live,probe}
}

describe('real backup preview before recovery readmission (0 H/F)',()=>{
 it('revalidates changed protection while still blocked, then admits the same intent after actual release',()=>{
  const f=fixture(),{source,data,task,owner}=f,intent=structuredClone(task.plan),time=task.timeMicros
  expect(parkMowerBackupDepartureRecovery(source,task,f.fail())).toBe(true)
  owner.urgentRecoveryReservedNames=[fang]
  const before=f.live(),explicit=data.backupExplicitTasks,admit=vi.fn(f.probe)
  expect(f.probe(task).kind).toBe('blocked')
  expect(resumeMowerPreviewRecovery(source,admit)).toBe(false)
  expect(admit).toHaveBeenCalledTimes(1);expect(source.waitingRecovery?.[0]?.task).toBe(task)
  expect(source.queue.tasks).not.toContain(task);expect(f.live()).toEqual(before);expect(data.backupExplicitTasks).toBe(explicit)
  expect(resumeMowerPreviewRecovery(source,admit)).toBe(false);expect(admit).toHaveBeenCalledTimes(1)
  owner.groupShiftExpected={};owner.urgentRecoveryReservedNames=[]
  expect(resumeMowerPreviewRecovery(source,admit)).toBe(true)
  expect(source.queue.tasks.filter(current=>current===task)).toEqual([task]);expect(task.timeMicros).toBe(time);expect(task.plan).toEqual(intent)
  expect(task.backupShiftConditions).toBeUndefined();expect(task.backupShiftIntent).toBeUndefined();expect(task.arrangementStarted).toBe(false)
 })

 it('keeps multiple still-blocked waits off dispatch when parking another task changes queued reservations',()=>{
  const f=fixture(),{state,source,task,owner}=f,second=cloneMowerShiftTask(task)
  second.timeMicros=1;source.queue.tasks=[task,second,owner]
  expect(parkMowerBackupDepartureRecovery(source,task,f.fail(task))).toBe(true)
  expect(parkMowerBackupDepartureRecovery(source,second,f.fail(second))).toBe(true)
  const before=f.live()
  settleMowerSource(state,rates,f.controller.evaluate)
  expect(source.waitingRecovery?.map(wait=>wait.task)).toEqual([task,second]);expect(source.queue.tasks).toEqual([owner])
  const next=nextMowerSourceActionHours(state)
  // Keep the real Native future wake and independent work; no overdue wait
  // may win merely because another request moved out of active dispatch.
  expect(next).toBeGreaterThan(0)
  expect(nextMowerSourceActionHours(state)).toBe(next)
  expect(f.live()).toEqual(before)
 })

 it('keeps an unobserved overdue bed deadline and replaces it only after a real fresh dorm observation',()=>{
  const f=fixture(true),{source,data,task,owner}=f
  expect(parkMowerBackupDepartureRecovery(source,task,f.fail())).toBe(true)
  const due=source.waitingRecovery![0]!.deadlines.dormitory_1!
  expect(due).toBe(toMowerMicros(19/4))
  data.nowMicros=due+1
  owner.plan={room_1_1:['Current']}
  expect(resumeMowerPreviewRecovery(source,f.probe)).toBe(false)
  expect(source.waitingRecovery![0]!.deadlines.dormitory_1).toBe(due)
  for(const name of [fang,melantha]){data.operators[name]!.timeStampMicros=data.nowMicros;data.operators[name]!.moodIsPrediction=true}
  owner.plan={room_1_1:['Current'],recycle:['Current']}
  expect(resumeMowerPreviewRecovery(source,f.probe)).toBe(false)
  expect(source.waitingRecovery![0]!.deadlines.dormitory_1).toBe(due)
  invalidateMowerDormTime(data,'dormitory_1')
  for(const [index,name] of [fang,melantha].entries()){
   mowerUpdateDetail(data,name,5,'dormitory_1',index,true)
   mowerRefreshDormTime(data,'dormitory_1',index,name,data.nowMicros+toMowerMicros(2))
  }
  expect(resumeMowerPreviewRecovery(source,f.probe)).toBe(false)
  expect(source.waitingRecovery![0]!.deadlines.dormitory_1).toBe(data.nowMicros+toMowerMicros(2))
  expect(source.queue.tasks).not.toContain(task)
 })

 it('does not mutate live observations, explicit tasks or pending objects when the real isolated preview succeeds',()=>{
  const f=fixture(),{data,task,owner}=f
  owner.groupShiftExpected={}
  const before=f.live(),plan=data.plan,explicit=data.backupExplicitTasks,intent=structuredClone(task.plan)
  expect(f.probe(task).kind).toBe('ready')
  expect(f.live()).toEqual(before);expect(data.plan).toBe(plan);expect(data.backupExplicitTasks).toBe(explicit);expect(task.plan).toEqual(intent)
 })

 it('propagates an unknown real-preview exception without publishing any probe changes',()=>{
  const f=fixture(),sentinel=new Error('unexpected transition failure'),before=f.live(),explicit=f.data.backupExplicitTasks
  const model={...f.state.mowerShiftModel!,transition(){throw sentinel}}
  expect(()=>previewMowerBackupRecoveryRetry(f.data,f.task,model,f.source.queue.tasks)).toThrow(sentinel)
  expect(f.live()).toEqual(before);expect(f.data.backupExplicitTasks).toBe(explicit)
 })

 it('skips all cloning when the existing backup model has no plans',()=>{
  const f=fixture(),before=f.live(),model={...f.state.mowerShiftModel!,count:0}
  const noClone=new Proxy(f.task,{ownKeys(){throw new Error('zero-plan model cloned task')}})
  expect(previewMowerBackupRecoveryRetry(f.data,noClone,model,f.source.queue.tasks)).toEqual({kind:'ready'})
  expect(f.live()).toEqual(before)
 })
})
