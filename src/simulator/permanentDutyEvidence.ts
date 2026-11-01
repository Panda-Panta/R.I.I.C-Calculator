import {OPERATOR_MAP} from '../domain/operators'
import {resolveOperatorCharId} from '../domain/operatorIdentifiers'
import {mergeMowerBackupConfig,readMowerOperatorList,readMowerRemovedOperators} from '../scheduler/mowerBackupConfig'
import type {CompiledSchedule} from '../scheduler/types'

/**
 * The caller verifies the permanent policy and unique primary binding. This
 * measured counter must cover all physical work, including exhausted duty;
 * group standby or rest can occupy the rest of the observation window.
 */
export function hasMeasuredPermanentPrimaryDuty(op: {
  workHours: number; exhaustedHours: number; permanentPrimaryOccupancyHours?: number
}): boolean {
  const physicalDuty = op.workHours + op.exhaustedHours
  const measured = op.permanentPrimaryOccupancyHours
  return [op.workHours, op.exhaustedHours].every(value => Number.isFinite(value) && value >= 0)
    && Number.isFinite(physicalDuty) && physicalDuty > 0
    && typeof measured === 'number' && Number.isFinite(measured) && measured >= 0
    && Math.abs(measured - physicalDuty) <= 1e-5
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const knownOperator=(identifier:string):string=>{
 const name=resolveOperatorCharId(identifier)
 if(!OPERATOR_MAP.has(name))throw new Error('Unknown Mower policy operator')
 return name
}

/** Sufficient whole-window name permission; it does not certify any position assignment. */
export function hasContinuousMowerWorkaholicPolicy(schedule:CompiledSchedule,operatorId:string):boolean {
 try {
  const name=knownOperator(operatorId)
  if(!OPERATOR_MAP.has(name)||schedule?.schemaVersion!==1||!record(schedule.policies)||!Array.isArray(schedule.policies.workaholic)||!record(schedule.rawConf))return false
  if(!readMowerOperatorList('workaholic',schedule.policies.workaholic,knownOperator).includes(name)||!readMowerOperatorList('workaholic',schedule.rawConf.workaholic,knownOperator).includes(name))return false
  const workspace=schedule.sourceWorkspace
  if(!record(workspace)||workspace.schemaVersion!==8||!record(workspace.mainPlan)||!record(workspace.mainPlan.conf)||!record(workspace.mainPlan.facilities)||!record(workspace.compatibility)||!Array.isArray(workspace.compatibility.backupPlans)||!record(workspace.compatibility.otherPlans)||!record(workspace.compatibility.unrecognizedFields))return false
  if(!readMowerOperatorList('workaholic',workspace.mainPlan.conf.workaholic,knownOperator).includes(name))return false
  // Native merges lists by union and explicit removal. If every possible layer
  // preserves this base name, any selected combination preserves it as well.
  for(const raw of workspace.compatibility.backupPlans){
   if(!record(raw)||raw.conf!==undefined&&!record(raw.conf)||raw.plan!==undefined&&!record(raw.plan)||raw.task!==undefined&&!record(raw.task))return false
   const conf=record(raw.conf)?raw.conf:{}
   readMowerOperatorList('workaholic',conf.workaholic,knownOperator)
   readMowerRemovedOperators(conf.removed_operators,knownOperator)
   const merged:Record<string,unknown>={workaholic:[name]}
   mergeMowerBackupConfig(merged,conf)
   if(!readMowerOperatorList('workaholic',merged.workaholic).includes(name))return false
  }
  return true
 }catch{return false}
}
