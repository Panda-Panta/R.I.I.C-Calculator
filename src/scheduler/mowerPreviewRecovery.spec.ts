import {describe,it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRosterRuntime,settleRoster,nextRosterActionHours,type RuntimeConfig} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerShiftPreviewError} from './mowerNativeErrors'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {importMowerJson} from '../workbench/compat/mowerJson'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'

const rates={workRate:()=>1,recoveryRate:()=>4}
function previewFixture(){
 const keepers=['K1','K2','K3','K4']
 const config:RuntimeConfig={mowerAlpha:true,mowerRunLoopClock:{minimumClockStepMicros:1,notificationSleepMicros:1_000_000},positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'A',candidates:['R'],shiftOffThreshold:15},...keepers.map((primary,i)=>({id:'dormitory_1_'+i,roomId:'dormitory_1',primary,candidates:[],permanent:true,dormitory:true}))],beds:[{id:'dormitory_1_4',roomId:'dormitory_1',vip:true}],initialMorale:{A:24,R:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},mowerSourcePlan:{room_1_1:[{agent:'A',group:'',replacement:['R']}],dormitory_1:[...keepers.map(agent=>({agent,group:'',replacement:[]})),{agent:'Free',group:'',replacement:[]}]},mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0}}
 const state=createRosterRuntime(config),source=getMowerSourceRuntime(state);source.initial=false
 state.mowerShiftModel={count:1,evaluate:()=>{throw new MowerShiftPreviewError('上下班副表推演出现循环，保留原任务，暂不执行换人')},swap:d=>d,transition:()=>({}),activate:()=>{}}
 const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:['R'],dormitory_1:['Current','Current','Current','Current','A']}})
 source.queue.tasks=[task]
 return {state,source,task}
}

describe('recoverable Mower preview failure',()=>{
 it('retains an empty-preview decision after resuming the planning I/O continuation',()=>{
  const {state,source,task}=previewFixture(),before={...state.occupants}
  source.runFlags={planned:true,todoTask:true,collectNotification:true}
  source.phaseExecution=Object.assign({steps:(function*(){})(),wakeMicros:0,skipPlanning:false},{previewNoop:true})
  const boundaryRates={...rates,thresholds:()=>[23.9]}
  settleRoster(state,boundaryRates)
  expect(nextRosterActionHours(state,boundaryRates)).toBeCloseTo(.1,8)
  expect(source.queue.tasks).toContain(task)
  expect(task.timeMicros).toBe(0)
  expect(state.occupants).toEqual(before)
 })

 it('finishes the original first-day roster with the default compatibility strategy and a bounded event budget',()=>{
  const workspace=importMowerJson(readFileSync(new URL('../../validation/mower-backup-2026-09-22/roster.json',import.meta.url),'utf8'))
  const result=runScheduleSimulationBridge(workspace,{sampleHours:24,warmupHours:0,maxEvents:2000,warmupModel:'hourly',recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'exp',seed:42}},{fiammettaFool:false,restingThreshold:.65})
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report?.production?.success).toBe(true)
  expect(result.report?.elapsedHours).toBe(24)
  expect(result.report?.assumptions.schedulingModel).toBe('mower-default')
  expect(result.report?.inputs.options.schedulingModel).toBe('mower-default')
  expect(workspace.compatibility.backupPlans).toHaveLength(9)
 },90000)

 it('keeps a rejected arrangement and physical occupants until the native stale-task rebuild boundary',()=>{
  const {state,source,task}=previewFixture(),plan=structuredClone(task.plan),occupants={...state.occupants}
  expect(()=>settleRoster(state,rates)).not.toThrow()
  expect(source.queue.tasks).toContain(task)
  expect(task.plan).toEqual(plan)
  expect(task.backupShiftActive).toBe(false)
  expect(state.occupants).toEqual(occupants)
  expect(state.bedOccupants).toEqual({})
  expect(source.activeTask).toBeUndefined()
  expect(nextRosterActionHours(state,rates)).toBe(900_000_001/3_600_000_000)
 })

 it('wakes for an earlier explicit task without changing either task deadline',()=>{
  const {state,source,task}=previewFixture(),fia=new MowerTask({time:5/60,type:T.FIAMMETTA})
  source.queue.tasks.push(fia)
  expect(()=>settleRoster(state,rates)).not.toThrow()
  expect(nextRosterActionHours(state,rates)).toBe(5/60)
  expect(task.timeMicros).toBe(0)
  expect(fia.timeMicros).toBe(300_000_000)
  expect(source.queue.tasks).toEqual(expect.arrayContaining([task,fia]))
 })

 it('rechecks a rejected preview at an earlier morale boundary',()=>{
  const {state,source,task}=previewFixture()
  const boundaryRates={...rates,thresholds:()=>[23.9]}
  settleRoster(state,boundaryRates)
  expect(nextRosterActionHours(state,boundaryRates)).toBeCloseTo(.1,8)
  expect(source.queue.tasks).toContain(task);expect(task.timeMicros).toBe(0)
 })

 it('passes both the rejected preview and a later unchanged shift without disabling backups',()=>{
  const json=readFileSync(new URL('../../validation/mower-backup-2026-09-22/roster.json',import.meta.url),'utf8')
  const workspace=importMowerJson(json),before=structuredClone(workspace)
  const result=runScheduleSimulationBridge(workspace,{sampleHours:48,warmupHours:0,maxEvents:3000,warmupModel:'hourly',recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'gold',seed:42}},{fiammettaFool:true,restingThreshold:.65})
  expect(result.error).toBeUndefined()
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report?.production?.success).toBe(true)
  expect(result.report?.elapsedHours).toBeCloseTo(48,7)
  expect(workspace).toEqual(before)
  expect(workspace.compatibility.backupPlans).toHaveLength(9)
  expect(result.report?.diagnostics.some(d=>d.code==='BACKUP_EXECUTION_FAILED')).toBe(false)
  for(const segment of result.report!.segments){
   const occupants=[...Object.values(segment.occupants),...Object.values(segment.bedOccupants)]
   expect(new Set(occupants).size).toBe(occupants.length)
   expect(Object.values(segment.morale).every(m=>Number.isFinite(m)&&m>=0&&m<=24)).toBe(true)
  }
 },90000)
})
