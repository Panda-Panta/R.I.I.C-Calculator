// Port of handle_error(force=True), Mower alpha c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88.
// MIT, Copyright 2021 Nano. Clock advancement belongs to the device/controller adapter.
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,fromMowerMicros} from './mowerTaskQueue'
export function prepareMowerRunEntry(queue:MowerTaskQueue,nowMicros:number,alpha=false):void {
 const now=fromMowerMicros(nowMicros)
 if(!queue.find({time:now})&&!queue.find({type:T.SKILL_UPGRADE})){const task=new MowerTask();task.timeMicros=nowMicros;queue.tasks.push(task)}
 const preserved=[T.SKILL_UPGRADE,T.SWAP_SUPPORT,T.REFRESH_TIME,T.SWITCH_PRODUCT,...(alpha?[T.FIAMMETTA]:[])],future=[T.RUN_ORDER,T.FURNITURE,T.DEPOT,T.CLUE,T.WORKSHOP]
 if(alpha?queue.tasks.some(t=>t.timeMicros<nowMicros-900_000_000&&!preserved.includes(t.type)):queue.find({time:fromMowerMicros(nowMicros-900_000_000)})){
  queue.tasks=queue.tasks.filter(task=>preserved.includes(task.type)||alpha&&future.includes(task.type)&&task.timeMicros>nowMicros)
  const task=new MowerTask();task.timeMicros=nowMicros;queue.tasks.push(task)
 }
}
