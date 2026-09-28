import {MowerRecognizeError} from './mowerNativeErrors'
import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,advanceRoster,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
import {createMowerClueIO} from '../simulator/mowerNativeClueIO'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'

function scenario(enableParty=true){
 const ws=createDefaultWorkspace();for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:[]}]
 ws.mainPlan.conf.workaholic=['芬']
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws)))
 state.config.mowerServices!.enableParty=enableParty // Explicit native-oracle input; the application compiler fixes this off.
 state.config.mowerClueObservations={partyEndMicros:36_000_000_000,clueCount:0}
 const source=getMowerSourceRuntime(state),task=new MowerTask({time:-1/3600})
 source.queue.tasks=[task,new MowerTask({time:5})]
 const actions:string[]=[],backups:{phase:string;party:unknown;active:unknown}[]=[]
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,...createMowerClueIO(state),
  mowerTodoTaskIO:(request,s)=>({delayMicros:0,observe:()=>{actions.push(request.kind);return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='reload'?{reloadTimeMicros:toMowerMicros(s.time)}:null}}})}
 const settle=()=>settleMowerSource(state,rates,phase=>{backups.push({phase,party:source.data.partyTime,active:source.activeTask});return false})
 function finish(){
  let remaining=100
  while(source.phaseExecution||source.execution){
   if(--remaining<0)throw new Error('Native services did not finish')
   advanceRoster(state,nextMowerSourceActionHours(state),rates);settle()
  }
 }
 return {state,source,task,rates,actions,backups,settle,finish}
}
describe('native default service phases share runtime state',()=>{
 it('clears restored Party Time and queued clue tasks when application configuration is rebuilt',()=>{
  const {state,source}=scenario()
  source.data.partyTime={timeMicros:36_000_000_000};source.partyTimeMicros=36_000_000_000
  source.queue.tasks.push(new MowerTask({type:T.CLUE}),new MowerTask({type:T.CLUE_PARTY}))
  const kept=new MowerTask({type:T.RUN_ORDER,plan:{room_1_1:['芬']}});source.queue.tasks.push(kept)
  state.config={...state.config,mowerServices:{...state.config.mowerServices!,enableParty:false}}
  getMowerSourceRuntime(state)
  expect(source.data.partyTime??null).toBe(null);expect(source.partyTimeMicros).toBe(null)
  expect(source.queue.tasks.some(task=>[T.CLUE,T.CLUE_PARTY].includes(task.type))).toBe(false)
  expect(source.queue.tasks).toContain(kept)
 })
 it('returns from a stable Details scene before notification using the native one-second back',()=>{
  const {state,source,rates,settle,finish}=scenario(false)
  state.config.mowerDroneRoom='room_1_1';let detectedAt=-1
  rates.mowerTodoTaskIO=(request,s)=>({delayMicros:0,observe:()=>{
   if(request.kind==='drone')s.mowerUI={scene:'INFRA_DETAILS',lastRoom:request.room}
   return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:null}
  }})
  rates.mowerNotificationIO=(request,s)=>({delayMicros:request.kind==='sleep'?1_000_000:0,observe:()=>{
   if(request.kind==='detect-notification'){
    expect(s.mowerUI).toEqual({scene:'INFRA_MAIN',lastRoom:''});detectedAt=toMowerMicros(s.time)
   }
   return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:null}
  }})
  settle();finish()
  expect(detectedAt).toBe(2_000_000);expect(toMowerMicros(state.time)).toBe(2_000_000)
  expect(source.lastTodoMicros).toBeUndefined();expect(source.runFlags!.collectNotification).toBe(true)
 })
 it('resets recognition retries after notification succeeds before processing the todo page',()=>{
  const {state,source,rates,settle,finish}=scenario(false)
  let notificationAttempts=0,todoAttempts=0,page=false
  rates.mowerTodoListVisible=()=>page
  rates.mowerNotificationIO=(request,s)=>({delayMicros:['tap-notification','tap-close-todo'].includes(request.kind)?1_000_000:0,observe:()=>{
   let value:unknown=null
   if(request.kind==='detect-notification'){
    if(notificationAttempts++<2)throw new MowerRecognizeError('notification')
    value={control:'notification'}
   }
   if(request.kind==='tap-notification')page=true
   if(request.kind==='find-collect'&&request.resource==='bill'&&todoAttempts++<2)throw new MowerRecognizeError('todo')
   if(request.kind==='tap-close-todo')page=false
   return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value}
  }})
  settle();finish()
  expect(toMowerMicros(state.time)).toBe(14_000_000);expect(source.lastTodoMicros).toBe(13_000_000)
  expect(page).toBe(false);expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
 })

 it('fixes Party Time off in compiled application input and leaves its cache/tasks empty',()=>{
  const compiled=compileRosterSchedule(createDefaultWorkspace(),{enableParty:true})
  expect(compiled.assumptions.enableParty).toBe(false)
  expect(compiledScheduleToRuntimeConfig(compiled).mowerServices!.enableParty).toBe(false)
  const {source,settle,finish}=scenario(false)
  settle();finish()
  expect(source.lastClueMicros).toBeUndefined()
  expect(source.data.partyTime??null).toBe(null)
  expect(source.queue.find({type:T.CLUE_PARTY})).toBeUndefined()
 })
 it('confirms party cache before END backup and clears the completed task before planning',()=>{
  const {state,source,task,actions,backups,settle,finish}=scenario()
  expect(state.config.mowerServices).toMatchObject({enableParty:true,leifengMode:true,reloadRooms:[]})
  settle();finish()
  expect(source.queue.tasks).not.toContain(task)
  expect(source.activeTask).toBeUndefined()
  expect(source.data.partyTime).toEqual({timeMicros:36_000_000_000})
  expect(source.lastClueMicros).toBe(toMowerMicros(state.time))
  expect(backups.filter(entry=>entry.party!==undefined)).toEqual([{phase:'END',party:{timeMicros:36_000_000_000},active:undefined}])
  expect(source.queue.find({type:T.CLUE_PARTY})!.timeMicros).toBe(35_999_999_000)
  expect(actions).toEqual([])
  expect(source.reloadTimeMicros).toBe(toMowerMicros(state.time))
  expect(source.runFlags?.collectNotification).toBe(false)
 })
 it.each([1,3])('keeps todo state across %s RecognizeError retries and advances the native 3-second sleep',failures=>{
  const {state,source,rates,settle,finish}=scenario()
  state.config.mowerServices!.enableParty=false;state.config.mowerDroneRoom='room_1_1'
  let attempts=0
  rates.mowerTodoTaskIO=(request,s)=>({delayMicros:0,observe:()=>{
   if(request.kind==='drone'&&attempts++<failures)throw new MowerRecognizeError('controlled-drone')
   return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='reload'?{reloadTimeMicros:toMowerMicros(s.time)}:null}
  }})
  settle();finish()
  expect(toMowerMicros(state.time)).toBe(failures*3_000_000)
  expect(source.error).toBe(false)
  expect(source.activeTask).toBeUndefined()
  if(failures===1){
   expect(source.droneTimeMicros).toBe(3_000_000)
   expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:false})
  }else{
   expect(source.droneTimeMicros).toBeUndefined()
   expect(source.runFlags).toEqual({planned:true,todoTask:false,collectNotification:false})
  }
 })

 it('uses the CLUE wrapper to update last_clue and skip notification after consuming the original task',()=>{
  const {state,source,settle,finish}=scenario()
  const task=new MowerTask({time:-1/3600,type:T.CLUE})
  source.queue.tasks=[task,new MowerTask({time:5})]
  settle();finish()
  expect(source.queue.tasks).not.toContain(task)
  expect(source.lastClueMicros).toBe(toMowerMicros(state.time)-1_000_000) // Native Details back occurs after clue_flow records its timestamp.
  expect(source.runFlags?.collectNotification).toBe(true)
 })
})
