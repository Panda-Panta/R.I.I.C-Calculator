import {describe,expect,it} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {validateRosterWorkspace} from '../workbench/validate'
import type {ScheduleSimulationOptions} from '../simulator/scheduleSimulation'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createBackupPlanController,evaluateBackupExpression} from './backupPlans'
import {advanceRoster,createRosterRuntime,nextRosterActionHours,settleRoster} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerShiftPreviewError} from './mowerNativeErrors'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
import {mowerUpdateDetail} from './mowerObservations'

const aroma=resolveOperatorCharId('阿罗玛'),gravel=resolveOperatorCharId('砾')
const residents=['闪灵','夜莺','杜林','安比尔','克洛丝'].map(resolveOperatorCharId)
const windowCondition="23.85 < op_data.operators['阿罗玛'].current_mood() < 23.9"

function emptyWorkspace(){
 const workspace=createDefaultWorkspace()
 for(const facility of Object.values(workspace.mainPlan.facilities))for(const slot of facility.slots){
  slot.occupant={kind:'empty'};slot.groupId=null;slot.replacements=[]
 }
 workspace.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:aroma},groupId:null,replacements:[gravel]}]
 workspace.mainPlan.facilities.room_1_1.type='manufacture'
 workspace.mainPlan.facilities.room_1_1.product='exp'
 return workspace
}

describe('Mower simulation event boundaries',()=>{
 it('integrates recovery in a dynamic group bed independently of an inert backup plan',()=>{
  // Public bridge reproducer: no explicit Free bed; Durin's group makes slot 2
  // a dynamic recovery bed when Aroma and Durin take their rest together.
  const workspace=emptyWorkspace()
  workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId='test-group'
  workspace.mainPlan.facilities.dormitory_1.slots=residents.map((operatorId,index)=>({
   occupant:{kind:'operator' as const,operatorId},groupId:index===2?'test-group':null,replacements:index===2?['Free']:[],
  }))
  const before=structuredClone(workspace)
  const options:ScheduleSimulationOptions={schedulingModel:'mower-alpha',sampleHours:1,maxEvents:1000,recordSegments:true,warmupModel:'hourly',consumptionOverrides:{[aroma]:1,[gravel]:1},recoveryOverrides:{[aroma]:4}}
  const assumptions={operatorMorale:{[aroma]:10},idleOperators:[]}
  const validation=validateRosterWorkspace(workspace)
  expect(validation.isValid).toBe(true)
  expect(validation.criticalErrors).toEqual([])
  expect(validation.warnings).toEqual([])

  const result=runScheduleSimulationBridge(workspace,options,assumptions)
  const withInertBackup=structuredClone(workspace)
  withInertBackup.compatibility.backupPlans=[{name:'Inert false backup',trigger:'False',trigger_timing:'END',plan:{},task:{},conf:{}}]
  const inertResult=runScheduleSimulationBridge(withInertBackup,options,assumptions)
  expect(result.error).toBeUndefined()
  expect(inertResult.error).toBeUndefined()
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(inertResult.report?.success,JSON.stringify(inertResult.report?.diagnostics)).toBe(true)
  expect(result.report!.elapsedHours).toBe(1)
  expect(inertResult.report!.elapsedHours).toBe(1)
  expect(workspace).toEqual(before)

  const operator=result.report!.operators.find(o=>o.operatorId===aroma)!
  const inertOperator=inertResult.report!.operators.find(o=>o.operatorId===aroma)!
  expect(operator.initialMorale).toBe(10)
  expect(operator.restHours).toBeGreaterThan(.99)
  expect(result.report!.segments.some(segment=>segment.bedOccupants.dormitory_1_2===aroma)).toBe(true)
  // Physical conservation, including the short room-confirmation intervals.
  expect.soft(operator.finalMorale).toBeCloseTo(operator.initialMorale-operator.workHours+4*operator.restHours,8)
  expect.soft(operator.finalMorale).toBeCloseTo(inertOperator.finalMorale,8)
 })

 it('keeps a rejected preview suspended across a predicted mood window until a relevant measurement',()=>{
  const workspace=emptyWorkspace()
  workspace.mainPlan.facilities.dormitory_1.slots=[
   ...residents.slice(0,4).map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]})),
   {occupant:{kind:'free'},groupId:null,replacements:[]},
  ]
  workspace.compatibility.backupPlans=[{name:'Narrow cached-mood window',trigger:windowCondition,trigger_timing:'END',plan:{},task:{},conf:{}}]
  const schedule=compileRosterSchedule(workspace,{operatorMorale:{[aroma]:24,[gravel]:24},idleOperators:[]})
  const config=compiledScheduleToRuntimeConfig(schedule)
  config.mowerAlpha=true
  const state=createRosterRuntime(config),controller=createBackupPlanController(schedule,state),source=getMowerSourceRuntime(state)
  source.initial=false
  for(const op of Object.values(source.data.operators))if(op.room){
   op.currentRoom=op.room;op.currentIndex=op.index;op.mood=24;op.timeStampMicros=0;op.depletionRate=op.room.startsWith('dorm')?0:1
  }
  // Only the first preview rejects. Its retry still needs relevant measured
  // evidence even after the original cause is removed and the clock advances.
  const originalModel=state.mowerShiftModel!
  let rejectPreview=true,previewCalls=0
  state.mowerShiftModel={...originalModel,select:data=>{
   previewCalls++
   if(rejectPreview)throw new MowerShiftPreviewError('Controlled rejection to test measured-only recovery')
   return originalModel.select!(data)
  }}
  const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:[gravel],dormitory_1:['Current','Current','Current','Current',aroma]}})
  source.queue.tasks=[task]
  const plan=structuredClone(task.plan),occupants={...state.occupants}
  const rates={workRate:()=>1,recoveryRate:()=>4,thresholds:()=>[4,8,12,16,18,20]}
  expect(evaluateBackupExpression(windowCondition,state)).toBe(false)
  expect(evaluateBackupExpression(windowCondition,{...state,time:.12})).toBe(true)
  expect(evaluateBackupExpression(windowCondition,{...state,time:.25})).toBe(false)
  settleRoster(state,rates,0,controller.evaluate)
  const failedCalls=previewCalls
  expect(failedCalls).toBeGreaterThan(0)
  expect(task.executionFailure).toBeDefined()
  expect(source.queue.tasks).toContain(task)
  expect(task.plan).toEqual(plan);expect(task.timeMicros).toBe(0)
  expect(state.occupants).toEqual(occupants);expect(state.bedOccupants).toEqual({})

  rejectPreview=false
  expect(nextRosterActionHours(state,rates)).toBeGreaterThan(.15)
  advanceRoster(state,.12,rates)
  expect(evaluateBackupExpression(windowCondition,state)).toBe(true)
  expect(source.data.operators[aroma]!.timeStampMicros).toBe(0)
  expect(source.data.operators[aroma]!.mood).toBe(24)
   // Isolate a prediction-only retry. An END activation also needs a related
   // effective configuration change before it can resume this work.
  settleRoster(state,rates)
  expect(previewCalls).toBe(failedCalls)
  expect(task.executionFailure).toBeDefined()
  expect(source.queue.tasks).toContain(task)
  expect(task.plan).toEqual(plan);expect(task.timeMicros).toBe(0)
  expect(state.occupants).toEqual(occupants);expect(state.bedOccupants).toEqual({})

  // Read actual physical morale through the normal observation update seam.
  mowerUpdateDetail(source.data,aroma,state.morale[aroma]!, 'room_1_1',0,true)
  expect(source.data.operators[aroma]!.timeStampMicros).toBe(toMowerMicros(state.time))
  expect(nextRosterActionHours(state,rates)).toBe(0)
  expect(task.timeMicros).toBe(0)
  settleRoster(state,rates,0,controller.evaluate)
  expect(previewCalls).toBeGreaterThan(failedCalls)
  expect(task.executionFailure).toBeUndefined()
  expect(source.execution?.task).toBe(task)
  // Finish the original room-return continuations without a prediction retry.
  for(let step=0;step<8&&source.queue.tasks.includes(task);step++){
   const hours=nextRosterActionHours(state,rates)
   expect(Number.isFinite(hours)&&hours>0).toBe(true)
   advanceRoster(state,hours,rates)
   settleRoster(state,rates,0,controller.evaluate)
   expect(task.executionFailure).toBeUndefined();expect(task.timeMicros).toBe(0)
  }
  expect(source.queue.tasks).not.toContain(task)
  expect(state.occupants.room_1_1_0).toBe(gravel)
  expect(state.bedOccupants.dormitory_1_4).toBe(aroma)
  const activation=state.events.find(e=>e.type==='backup-plan'&&e.backupIndex===0&&e.active)
  expect(activation).toBeDefined()
  expect(activation!.time).toBeGreaterThan(.1)
  expect(activation!.time).toBeLessThan(.15)
 })
  it.each([{label:'empty payload',related:false},{label:'related replacement row',related:true}])('resumes after an END activation only for a relevant effective change: $label',({related})=>{
  const workspace=emptyWorkspace()
  workspace.mainPlan.facilities.dormitory_1.slots=[...residents.slice(0,4).map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]})),{occupant:{kind:'free'},groupId:null,replacements:[]}]
   workspace.compatibility.backupPlans=[{name:'Measured phase configuration',trigger:windowCondition,trigger_timing:'END',plan:related?{room_1_1:{plans:[{agent:aroma,group:'',replacement:[gravel,resolveOperatorCharId('香草')]}]}}:{},task:{},conf:{}}]
  const schedule=compileRosterSchedule(workspace),config=compiledScheduleToRuntimeConfig(schedule);config.mowerAlpha=true
  const state=createRosterRuntime(config),controller=createBackupPlanController(schedule,state),source=getMowerSourceRuntime(state)
  source.initial=false
  for(const op of Object.values(source.data.operators))if(op.room)Object.assign(op,{currentRoom:op.room,currentIndex:op.index,mood:24,timeStampMicros:0,depletionRate:op.room.startsWith('dorm')?0:1})
  const model=state.mowerShiftModel!;let rejecting=true
  state.mowerShiftModel={...model,select:data=>{if(rejecting)throw new MowerShiftPreviewError('Controlled rejection');return model.select!(data)}}
  const task=new MowerTask({type:T.SHIFT_OFF,plan:{room_1_1:[gravel],dormitory_1:['Current','Current','Current','Current',aroma]}})
  source.queue.tasks=[task]
  const rates={workRate:()=>1,recoveryRate:()=>4}
  settleRoster(state,rates,0,controller.evaluate)
  expect(task.executionFailure).toBeDefined()
   const failure=task.executionFailure,plan=structuredClone(task.plan)
  rejecting=false;advanceRoster(state,.12,rates)
  expect(source.data.operators[aroma]!.timeStampMicros).toBe(0)
  controller.evaluate('END')
  expect(source.data.planConditions).toEqual([true])
   if(related){
    expect(nextRosterActionHours(state,rates)).toBe(0)
    expect(task.executionFailure).toBeUndefined()
   }else{
    expect(nextRosterActionHours(state,rates)).toBeGreaterThan(0)
    expect(task.executionFailure).toBe(failure)
   }
   expect(task.plan).toEqual(plan)
  expect(source.queue.tasks).toContain(task);expect(task.timeMicros).toBe(0)
  expect(state.events.some(event=>event.type==='backup-plan'&&event.active&&event.timing==='END')).toBe(true)
 })

})
