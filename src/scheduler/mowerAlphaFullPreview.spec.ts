import {describe,it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {importMowerJson} from '../workbench/compat/mowerJson'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {createBackupPlanController} from './backupPlans'
import {prepareMowerShiftCycle} from './mowerShiftCycle'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState,type MowerSchedulingDataOptions} from './mowerSchedulingData'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,type MowerTaskPlan} from './mowerTaskQueue'

type SavedTask=Omit<Partial<MowerTask>,'type'|'productLockNames'|'productLockSlots'>&{type:{key:keyof typeof T};productLockNames:string[];productLockSlots:string[]}
type SavedData=Omit<MowerSchedulingDataOptions,'operators'|'dorms'|'busyRestingNames'|'excludedCandidates'|'dormMoodEstimates'|'reservedProductReplacements'|'reservedProductBeds'|'emergencyDormAgents'|'recentShiftOnByRestUnit'>&{
 operators:Record<string,MowerOperatorOptions>;dorms:{position:[string,number];name:string;timeMicros?:number;autoFree:boolean}[]
 busyRestingNames:string[];excludedCandidates:string[];dormMoodEstimates:[string,[number,number]][];reservedProductReplacements:string[];reservedProductBeds:[string,string][];emergencyDormAgents:string[];recentShiftOnByRestUnit:[string,number][]
}
type PreviewCase={data:SavedData;task:SavedTask;pending:SavedTask[];native:{error:string|null;preserved?:boolean;plan:MowerTaskPlan;fill:MowerTaskPlan;conditions:boolean[];remaining:number[]}}
type PreviewOracle={roster:unknown;names:Record<string,string>;cases:PreviewCase[]}
const oracles:PreviewOracle[]=['mower-alpha-full-preview.json','mower-alpha-late-cycle.json','mower-alpha-control-fill-order.json'].map(file=>JSON.parse(readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8')))
function restoreTask(raw:SavedTask):MowerTask {
 const task=new MowerTask({type:T[raw.type.key]})
 return Object.assign(task,structuredClone(raw),{type:T[raw.type.key],productLockNames:new Set(raw.productLockNames),productLockSlots:new Set(raw.productLockSlots)})
}
function restoreData(raw:SavedData):MowerSchedulingData {
 const operators=Object.fromEntries(Object.entries(raw.operators).map(([name,o])=>{
  const op=new MowerOperatorState(o)
  // Restore cached flags after position setters have initialized the observation.
  Object.assign(op,o);return [name,op]
 }))
 return new MowerSchedulingData({...structuredClone(raw),operators,dorms:raw.dorms.map(b=>new MowerDormState([...b.position],b.name,b.timeMicros,b.autoFree)),busyRestingNames:new Set(raw.busyRestingNames),excludedCandidates:new Set(raw.excludedCandidates),dormMoodEstimates:new Map(raw.dormMoodEstimates),reservedProductReplacements:new Set(raw.reservedProductReplacements),reservedProductBeds:new Map(raw.reservedProductBeds),emergencyDormAgents:new Set(raw.emergencyDormAgents),recentShiftOnByRestUnit:new Map(raw.recentShiftOnByRestUnit)})
}

for(const oracle of oracles)describe('complete preview against frozen Mower alpha Python results',()=>{
 const names=(plan:MowerTaskPlan)=>Object.fromEntries(Object.entries(plan).map(([room,row])=>[room,row.map(n=>oracle.names[n]??n)]))
 for(const [index,c] of oracle.cases.entries())it(`${index}: ${c.task.type.key} at ${c.data.nowMicros/3_600_000_000}h`,()=>{
  const workspace=importMowerJson(JSON.stringify(oracle.roster)),schedule=compileRosterSchedule(workspace,{restingThreshold:.65,rescueThreshold:.75,freeRoom:false,fiammettaFool:true,fiammettaThreshold:.9}),config=compiledScheduleToRuntimeConfig(schedule);config.mowerAlpha=true;config.availableIdleOperators=c.data.unregisteredIdleNames
  const state=createRosterRuntime(config);state.time=c.data.nowMicros/3_600_000_000;createBackupPlanController(schedule,state)
  const data=restoreData(c.data),task=restoreTask(c.task),queue=new MowerTaskQueue();queue.tasks=[task,...c.pending.map(restoreTask)]
  const before=JSON.stringify(data),original=[...queue.tasks],intent=structuredClone(task.plan)
  const execute=()=>prepareMowerShiftCycle(data,task,queue,state.mowerShiftModel!,{fiaTargets:config.fiammetta?.orderedTargets})
  if(c.native.error){expect(execute).toThrow(c.native.error.replace(/^ValueError: /,''));expect(task.plan).toEqual(intent);expect(queue.tasks).toEqual(original);expect(c.native.preserved).toBe(true)}
  else {execute();expect(names(task.plan)).toEqual(c.native.plan);expect(names(task.dormFillPlan)).toEqual(c.native.fill);expect(task.backupShiftConditions).toEqual(c.native.conditions);expect(queue.tasks.map(t=>original.indexOf(t))).toEqual(c.native.remaining)}
  expect(JSON.stringify(data)).toBe(before)
 })
})
