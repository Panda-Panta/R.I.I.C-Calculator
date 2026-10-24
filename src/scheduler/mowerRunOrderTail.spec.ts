import {describe,expect,it} from 'vitest'
import {writeFileSync} from 'node:fs'
import {testEvidenceFile} from '../test/evidence'
import {executeMowerRunOrderTail,mowerOrderReadDispatchTasks,nextMowerOrderReadTask} from './mowerRunOrderTail'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import type {RunOrderPlanningState} from './mowerRunOrderPlanning'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,settleRoster,advanceRoster,nextRosterActionHours,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {planMowerMoodLimitReleases} from './mowerMetadata'
import {resolveOperatorCharId as id} from '../domain/operatorIdentifiers'

describe('f19a tail responsibility and priority view',()=>{
 it('retains an unread refresh and its time when a strict operation enters the window',()=>{
  const queue=new MowerTaskQueue(),release=new MowerTask({time:61/3600,type:T.RELEASE_DORM,strictMoodLimit:true,plan:{dormitory_1:['Free']}})
  queue.tasks=[release];let clock=0
  const state:RunOrderPlanningState={plan:{r1:[],r2:[]},runOrderRooms:['r1','r2'],queue,configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}
  const reads:string[]=[],steps=executeMowerRunOrderTail(state,{nowMicros:()=>clock,currentDormOccupants:()=>[],scheduling:{adjustForRunOrders:false,enableMastery:false},resumeFailures:()=>{},readRoom:function*(room,refresh){reads.push(room);clock=2_000_000;queue.consume(refresh);return true}})
  expect(steps.next().done).toBe(true);expect(reads).toEqual(['r1'])
  const pending=queue.tasks.find(task=>task.type===T.REFRESH_TIME)!
  expect(pending.metadata).toBe('r2');expect(pending.timeMicros).toBe(0)
  queue.sort();expect(nextMowerOrderReadTask(queue,clock,{adjustForRunOrders:false,enableMastery:false})).toBe(release)
  expect(mowerOrderReadDispatchTasks(queue.tasks,clock,{adjustForRunOrders:false,enableMastery:false})).not.toContain(pending)
  queue.consume(release);queue.sort()
  expect(nextMowerOrderReadTask(queue,clock,{adjustForRunOrders:false,enableMastery:false})).toBe(pending)
  expect(pending.timeMicros).toBe(0)
 })
 it('keeps failed/future refresh responsibility and stably prefers the last arranged room',()=>{
  const queue=new MowerTaskQueue(),failed=new MowerTask({type:T.REFRESH_TIME,metadata:'failed'}),future=new MowerTask({time:2,type:T.REFRESH_TIME,metadata:'future'})
  failed.executionFailure={reason:'unchanged',rooms:['failed'],snapshot:{intent:'',observations:{}}};queue.tasks=[failed,future]
  const state:RunOrderPlanningState={plan:{r1:[],r2:[],failed:[],future:[]},runOrderRooms:['r1','r2','failed','future'],queue,configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}
  const reads:string[]=[],steps=executeMowerRunOrderTail(state,{nowMicros:()=>0,currentDormOccupants:()=>[],scheduling:{adjustForRunOrders:false,enableMastery:false},resumeFailures:()=>{},readRoom:function*(room,refresh){reads.push(room);queue.consume(refresh);return true}},'r2')
  expect(steps.next().done).toBe(true);expect(reads).toEqual(['r2','r1'])
  expect(queue.tasks).toHaveLength(2);expect(queue.tasks).toContain(failed);expect(queue.tasks).toContain(future);expect(future.time).toBe(2);expect(failed.executionFailure).toBeDefined()
 })
 it('does not turn ideal RUN_ORDER or disabled mastery into a blocking operation',()=>{
  const queue=new MowerTaskQueue(),order=new MowerTask({type:T.RUN_ORDER,metadata:'other'}),mastery=new MowerTask({type:T.SWAP_SUPPORT})
  queue.tasks=[order,mastery]
  const state:RunOrderPlanningState={plan:{r1:[],r2:[]},runOrderRooms:['r1','r2'],queue,configuredDelayMinutes:3,droneRoom:null,flags:{planned:false,todoTask:false,collectNotification:false}}
  const reads:string[]=[],steps=executeMowerRunOrderTail(state,{nowMicros:()=>0,currentDormOccupants:()=>[],scheduling:{alpha:true,adjustForRunOrders:false,enableMastery:false},resumeFailures:()=>{},readRoom:function*(room,refresh){reads.push(room);queue.consume(refresh);return true}})
  expect(steps.next().done).toBe(true);expect(reads).toEqual(['r1','r2']);expect(order.time).toBe(0);expect(order.plan).toEqual({});expect(mastery.time).toBe(0)
 })
})

it.each([{alpha:false,blockedAtStart:false},{alpha:true,blockedAtStart:false},{alpha:false,blockedAtStart:true},{alpha:true,blockedAtStart:true}])('formal runtime preserves the unread room until its real cap release, alpha=$alpha, initially blocked=$blockedAtStart',({alpha,blockedAtStart})=>{
 const ws=createDefaultWorkspace();for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 const primary1=id('芬'),primary2=id('香草'),rest=id(alpha?'蓝毒':'令'),runner=id('但书'),deadline=(alpha?151:61)-(blockedAtStart ? .6 : 0)
 for(const [room,primary] of [['room_1_1',primary1],['room_1_2',primary2]] as const){
  ws.mainPlan.facilities[room].type='trading';ws.mainPlan.facilities[room].product='money'
  ws.mainPlan.facilities[room].slots=[{occupant:{kind:'operator',operatorId:primary},groupId:null,replacements:[runner,rest]}]
 }
 const fixed=['杜林','12F','黑角','夜刀'].map(id)
 ws.mainPlan.facilities.dormitory_1.slots=[...fixed.map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]})),{occupant:{kind:'free' as const},groupId:null,replacements:[]}]
 ws.mainPlan.conf.workaholic=[primary1,primary2];ws.mainPlan.conf.ling_xi=alpha?0:1
 if(alpha)ws.mainPlan.conf.operator_mood_limits={[rest]:{lower:0,upper:12}}
 const config=compiledScheduleToRuntimeConfig(compileRosterSchedule(ws));config.mowerAlpha=alpha;config.mowerTaskScheduling={...config.mowerTaskScheduling,adjustForRunOrders:false,enableMastery:false}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state)
 source.startupRunOrderCheckPending=false;source.initial=false;source.firstInit=false
 state.bedOccupants.dormitory_1_4=rest;state.morale[rest]=12-2*(deadline/3600)
 for(const [slot,name] of [...Object.entries(state.occupants),...Object.entries(state.bedOccupants)])Object.assign(source.data.operators[name]!,{currentRoom:slot.slice(0,slot.lastIndexOf('_')),currentIndex:Number(slot.slice(slot.lastIndexOf('_')+1)),mood:state.morale[name]??24,timeStampMicros:0,depletionRate:slot.startsWith('dorm')?-2:0,moodIsPrediction:false})
 const bed=source.data.dorms.find(b=>b.position[0]==='dormitory_1'&&b.position[1]===4)!
 bed.name=rest;bed.timeMicros=toMowerMicros(deadline/3600)
 const produced=planMowerMoodLimitReleases(source.data);expect(produced).toHaveLength(1)
 const task=new MowerTask({type:T.NOT_SPECIFIC,plan:{room_1_1:['Current']}});source.queue.tasks=[task,...produced]
 const trace:{kind:string;room:string;at:number;resting:boolean;releaseStart:number|undefined}[]=[]
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>{
  trace.push({kind:request.kind,room:request.room,at:toMowerMicros(s.time),resting:source.data.operators[rest]!.isResting(),releaseStart:source.queue.tasks.find(t=>t.strictMoodLimit&&Object.keys(t.plan).length)?.timeMicros})
  return {delayMicros:request.kind==='enter-room'?200_000:request.kind==='read-order'?300_000:request.kind==='return-main'?500_000:0,observe:()=>({observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:toMowerMicros(1)}:{})})}
 }}
 const settle=()=>settleRoster(state,rates),step=()=>{const next=nextRosterActionHours(state,rates);expect(next).toBeGreaterThan(0);advanceRoster(state,next,rates);settle()}
 settle()
 for(let n=0;n<20;n++){
  if(trace.some(t=>t.kind==='enter-room'&&t.room==='room_1_2'))break
  if(trace.some(t=>t.kind==='return-main'&&t.room==='room_1_1')&&!source.phaseExecution&&!source.execution)break
  if(state.time+nextRosterActionHours(state,rates)>5/3600)break
  step()
 }
 const first=trace.find(t=>t.kind==='enter-room'&&t.room==='room_1_1')!
 if(blockedAtStart)expect(first).toBeUndefined()
 else{expect(first).toBeDefined();expect(first.releaseStart).toBe(61_000_000);expect(first.at).toBe(500_000)}
 expect(trace.find(t=>t.kind==='enter-room'&&t.room==='room_1_2')).toBeUndefined()
 expect(source.queue.tasks.filter(t=>t.type===T.REFRESH_TIME)).toHaveLength(blockedAtStart?2:1)
 const pending=source.queue.tasks.find(t=>t.type===T.REFRESH_TIME&&t.metadata==='room_1_2')!
 expect(pending).toBeDefined();const originalTime=pending.timeMicros
 expect(nextRosterActionHours(state,rates)).toBeGreaterThan(0)
 for(let n=0;n<80&&!trace.some(t=>t.kind==='read-order'&&t.room==='room_1_2');n++)step()
 const second=trace.find(t=>t.kind==='enter-room'&&t.room==='room_1_2')!
 expect(second).toBeDefined();expect(second.resting).toBe(false)
 expect(pending.timeMicros).toBe(originalTime)
 for(let n=0;n<10&&(source.execution||source.phaseExecution);n++)step()
 expect(source.queue.tasks).not.toContain(pending)
 expect(state.diagnostics.some(d=>['mower-task-exception','mower-planning-exception'].includes(d.code))).toBe(false)
 writeFileSync(testEvidenceFile('f19a-tail-priority-'+(alpha?'alpha':'default')+'-'+(blockedAtStart?'first':'second')+'-room.json'),JSON.stringify({alpha,blockedAtStart,deadlineMicros:toMowerMicros(deadline/3600),first,second,originalRefreshTime:originalTime,finalRefreshTime:pending.timeMicros,refreshConsumed:!source.queue.tasks.includes(pending),trace,diagnostics:state.diagnostics},null,2))
})
