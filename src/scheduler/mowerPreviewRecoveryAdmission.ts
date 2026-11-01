import {MowerBackupRecoveryBlocked} from './mowerBackupDepartureRecovery'
import {projectMowerArrangements} from './mowerObservations'
import {cloneMowerShiftTask,prepareMowerShiftBackup,type MowerShiftModel} from './mowerShiftCycle'
import type {MowerSchedulingData} from './mowerSchedulingData'
import type {MowerTask} from './mowerTaskQueue'
import type {MowerPreviewRecoveryAdmissionResult} from './mowerPreviewRecoveryWait'

/** A changed observation permits a fresh preview, not an unverified dispatch. */
export function previewMowerBackupRecoveryRetry(data:MowerSchedulingData,task:MowerTask,model:MowerShiftModel,pending:readonly MowerTask[]):MowerPreviewRecoveryAdmissionResult {
 if(!model.count)return {kind:'ready'}
 const projected=projectMowerArrangements(data,[]),probe=cloneMowerShiftTask(task)
 // Projection preserves these read-mostly references; a retry must not publish
 // any rule/intent changes into live data or another queued task.
 projected.plan=structuredClone(data.plan)
 projected.backupExplicitTasks=structuredClone(data.backupExplicitTasks)
 const projectedModel={...model,explicitTasks:model.explicitTasks?structuredClone(model.explicitTasks):undefined}
 const others=pending.filter(other=>other!==task).map(cloneMowerShiftTask)
 try {
  prepareMowerShiftBackup(projected,probe,projectedModel,others)
  return {kind:'ready'}
 }catch(error){
  if(error instanceof MowerBackupRecoveryBlocked)return {kind:'blocked',failure:error}
  throw error
 }
}
