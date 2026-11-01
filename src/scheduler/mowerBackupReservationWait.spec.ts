import {describe,expect,it} from 'vitest'
import {resolveOperatorCharId as id} from '../domain/operatorIdentifiers'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createBackupPlanController} from './backupPlans'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {prepareMowerShiftBackup} from './mowerShiftCycle'
import {MowerBackupRecoveryBlocked} from './mowerBackupDepartureRecovery'
import {mowerDormTaskReservations} from './mowerAlphaCandidates'
import {mowerAssignDormGroup} from './mowerDormAssignment'
import {projectMowerArrangements} from './mowerObservations'
import {parkMowerBackupDepartureRecovery,resumeMowerPreviewRecovery} from './mowerPreviewRecoveryWait'

const fang='char_123_fang',vanilla='char_240_wyvern',melantha='char_208_melan',beagle='char_122_beagle'

/** The existing real backup-preview fixture, with an available projected bed. */
function fixture(reservation:'expected'|'urgent'='expected',nonmissingReservation=false){
 const workspace=createDefaultWorkspace(),slot=(operatorId:string,groupId:string|null=null,replacements:string[]=[])=>({occupant:{kind:'operator' as const,operatorId},groupId,replacements})
 workspace.mainPlan.facilities.room_1_1.slots=[slot(fang,'a',[vanilla])]
 workspace.mainPlan.facilities.recycle.level=1
 workspace.mainPlan.facilities.recycle.slots=[slot(melantha,'a',[beagle])]
 workspace.mainPlan.facilities.dormitory_1.slots=Array.from({length:5},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]}))
 const keepers=[id('夜莺'),id('克洛丝'),id('芙蓉')]
 keepers.forEach((name,index)=>workspace.mainPlan.facilities.dormitory_1.slots[index+2]=slot(name))
 if(nonmissingReservation)workspace.mainPlan.conf.workaholic=[melantha]
 workspace.compatibility.backupPlans=[{name:'departure',trigger:"op_data.operators['芬'].is_working() and op_data.operators['芬'].current_mood() < 10",plan:{},task:{room_1_1:['香草'],...(nonmissingReservation?{recycle:['米格鲁']}:{})}}]
 const schedule=compileRosterSchedule(workspace),config=compiledScheduleToRuntimeConfig(schedule)
 config.mowerAlpha=true;config.freeBlacklist=[beagle]
 const state=createRosterRuntime(config)
 createBackupPlanController(schedule,state)
 const source=getMowerSourceRuntime(state),data=source.data
 source.initial=false
 for(const op of Object.values(data.operators)){
  op.setProjectedPosition('',-1);op.mood=24;op.timeStampMicros=0;op.depletionRate=0
 }
 state.occupants={room_1_1_0:vanilla,...Object.fromEntries(keepers.map((name,index)=>['dormitory_1_'+(index+2),name]))}
 state.bedOccupants={dormitory_1_0:fang,dormitory_1_1:melantha}
 for(const [position,name] of Object.entries({...state.occupants,...state.bedOccupants}))data.operators[name]!.setProjectedPosition(position.slice(0,position.lastIndexOf('_')),Number(position.slice(position.lastIndexOf('_')+1)))
 data.operators[fang]!.mood=5;state.morale[fang]=5
 data.operators[melantha]!.mood=5;state.morale[melantha]=5
 for(const bed of data.dorms){
  const name=state.bedOccupants[bed.position[0]+'_'+bed.position[1]]
  if(name){bed.name=name;bed.timeMicros=toMowerMicros(19/4)}
 }
 data.groupShiftState.a=true
 const task=new MowerTask({time:.01,type:T.SELF_CORRECTION,plan:{room_1_1:[fang],recycle:[melantha]}})
 const owner=new MowerTask({time:1,type:T.SELF_CORRECTION})
 if(reservation==='expected')owner.groupShiftExpected={['room_1_1\0'+'0']:nonmissingReservation?melantha:fang}
 else owner.urgentRecoveryReservedNames=[fang]
 if(nonmissingReservation){
  state.occupants.recycle_0=melantha;delete state.bedOccupants.dormitory_1_1
  data.operators[melantha]!.setProjectedPosition('recycle',0)
  data.dorms.find(bed=>bed.position[0]==='dormitory_1'&&bed.position[1]===1)!.reset()
  for(const index of [0,1])data.reservedProductBeds.set('dormitory_1\0'+index,'unrelated-product-owner')
 }
 source.queue.tasks=[task,owner]
 const preview=()=>prepareMowerShiftBackup(data,task,state.mowerShiftModel!,source.queue.tasks.filter(other=>other!==task))
 const failure=()=>{
  try{preview()}catch(error){if(error instanceof MowerBackupRecoveryBlocked)return error;throw error}
  throw new Error('Expected the real backup departure admission to be blocked')
 }
 const physical=()=>({occupants:{...state.occupants},beds:{...state.bedOccupants},morale:{...state.morale},operators:Object.values(data.operators).map(op=>[op.name,op.currentRoom,op.currentIndex,op.mood,op.timeStampMicros]),dorms:data.dorms.map(bed=>[bed.position,bed.name,bed.timeMicros]),conditions:[...data.planConditions],groups:{...data.groupShiftState}})
 return {state,source,data,task,owner,preview,failure,physical}
}

describe('backup departure waiting on effective name reservations (0 H/F)',()=>{
 it('parks a real missing departure despite an available bed and resumes only when its effective reservation changes',()=>{
  const {source,data,task,owner,preview,failure,physical}=fixture(),before=physical(),intent=structuredClone(task.plan),deadline=task.timeMicros
  const blocked=failure()
  expect(blocked.names).toEqual([fang])
  const missing=blocked.projection.operators[fang]!
  expect(missing.currentRoom).toBe('');expect(missing.workaholic).toBe(false)
  expect(blocked.projection.restMoodComplete(fang)).toBe(false);expect(missing.mood).toBeLessThan(missing.upperLimit)
  expect(mowerDormTaskReservations(blocked.projection,[owner]).names.has(fang)).toBe(true)
  expect(mowerAssignDormGroup(projectMowerArrangements(blocked.projection,[]),[fang],new Set(['a']),undefined,{},new Set([...blocked.explicitSlots,...blocked.reservedSlots]))).toBeDefined()
  expect(task.plan).toEqual(intent);expect(physical()).toEqual(before)
  expect(parkMowerBackupDepartureRecovery(source,task,blocked)).toBe(true)
  const wait=source.waitingRecovery![0]!
  expect(wait.task).toBe(task);expect(wait.reason).toBe('departure-bed');expect(wait.deadlines).toEqual({})
  expect(source.queue.tasks).toEqual([owner]);expect(task.timeMicros).toBe(deadline);expect(task.plan).toEqual(intent)
  expect(task.arrangementStarted).toBe(false);expect(task.backupShiftActive).toBe(false);expect(task.executionFailure).toBeUndefined()
  expect(resumeMowerPreviewRecovery(source)).toBe(false)
  data.nowMicros+=1_000_000
  owner.timeMicros+=1_000_000
  const unrelated=new MowerTask({time:2});unrelated.urgentRecoveryReservedNames=['unrelated']
  source.queue.tasks.push(unrelated)
  expect(resumeMowerPreviewRecovery(source)).toBe(false)
  // A raw no-op room row changes, while shared effective name/slot sets do not.
  const effectiveBefore=mowerDormTaskReservations(data,[owner])
  owner.plan={room_1_1:['Current']}
  const effectiveAfter=mowerDormTaskReservations(data,[owner])
  expect([...effectiveAfter.names].sort()).toEqual([...effectiveBefore.names].sort())
  expect([...effectiveAfter.slots].sort()).toEqual([...effectiveBefore.slots].sort())
  expect(resumeMowerPreviewRecovery(source)).toBe(false)
  owner.groupShiftExpected={}
  expect(resumeMowerPreviewRecovery(source)).toBe(true)
  expect(source.queue.tasks.filter(candidate=>candidate===task)).toEqual([task])
  expect(source.queue.tasks).toContain(owner);expect(source.queue.tasks).toContain(unrelated)
  expect(source.waitingRecovery??[]).toHaveLength(0);expect(task.executionRetained).toBe(true)
  expect(task.timeMicros).toBe(deadline);expect(task.plan).toEqual(intent);expect(physical()).toEqual(before)
  expect(preview).not.toThrow()
  expect(task.plan.room_1_1).toEqual([vanilla])
  expect(physical()).toEqual(before);expect(task.timeMicros).toBe(deadline)
 })

 it('rechecks bed reservations at the real execution preview after releasing the name prerequisite',()=>{
  const {source,task,owner,failure,physical}=fixture('urgent'),before=physical(),intent=structuredClone(task.plan),deadline=task.timeMicros
  expect(parkMowerBackupDepartureRecovery(source,task,failure())).toBe(true)
  owner.urgentRecoveryReservedNames=[]
  expect(resumeMowerPreviewRecovery(source)).toBe(true)
  owner.urgentRecoveryReservedSlots=['dormitory_1\0'+'0','dormitory_1\0'+'1']
  const stillBlocked=failure()
  expect(stillBlocked.reservedSlots).toEqual(new Set(owner.urgentRecoveryReservedSlots))
  expect(task.plan).toEqual(intent);expect(task.timeMicros).toBe(deadline);expect(physical()).toEqual(before)
  expect(task.arrangementStarted).toBe(false)
  expect(parkMowerBackupDepartureRecovery(source,task,stillBlocked)).toBe(true)
  expect(source.waitingRecovery?.[0]?.task).toBe(task);expect(source.queue.tasks).not.toContain(task)
 })

 it('does not park a partially started task even when the real preview produced a name conflict',()=>{
  const {source,task,failure,physical}=fixture(),blocked=failure(),before=physical()
  task.arrangementStarted=true
  expect(parkMowerBackupDepartureRecovery(source,task,blocked)).toBe(false)
  expect(source.queue.tasks).toContain(task);expect(source.waitingRecovery??[]).toHaveLength(0)
  expect(physical()).toEqual(before)
 })

 it('does not treat a reserved nonmissing workaholic as proof that the missing departure waits on a name',()=>{
  const {source,task,owner,failure,physical}=fixture('expected',true),blocked=failure(),before=physical()
  expect(new Set(blocked.names)).toEqual(new Set([fang,melantha]))
  expect(blocked.projection.operators[fang]!.currentRoom).toBe('')
  expect(blocked.projection.operators[fang]!.workaholic).toBe(false)
  expect(blocked.projection.operators[melantha]!.workaholic).toBe(true)
  const reserved=mowerDormTaskReservations(blocked.projection,[owner])
  expect(reserved.names.has(melantha)).toBe(true);expect(reserved.names.has(fang)).toBe(false)
  // Product reservations still prevent a bed even if all observed residents finish.
  // A reserved name intersecting all departing names is insufficient evidence.
  expect(parkMowerBackupDepartureRecovery(source,task,blocked)).toBe(false)
  expect(source.queue.tasks).toContain(task);expect(source.waitingRecovery??[]).toHaveLength(0)
  expect(physical()).toEqual(before)
 })
})
