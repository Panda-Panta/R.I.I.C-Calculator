import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-run-order-refresh-alpha.json'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {mowerRefreshTradingSpec,refreshMowerRunOrderTime} from './mowerRunOrderRefresh'
describe('actual alpha refresh_trading config and queue mutations',()=>{
 it.each(native.queries)('matches config $name / $rules',test=>expect(mowerRefreshTradingSpec(test.name,test.rules)).toEqual(test.output))
 it.each(native.cases)('matches queue mutation $name',test=>{
  const q=new MowerTaskQueue()
  q.tasks=test.input.tasks.map(task=>new MowerTask({time:task.seconds/3600,type:T[task.type as keyof typeof T],metadata:task.metadata}))
  const originals=[...q.tasks]
  refreshMowerRunOrderTime(q,0,test.input.room)
  expect(q.tasks.map(task=>({timeMicros:task.timeMicros,type:task.type.key,metadata:task.metadata,originalIndex:originals.includes(task)?originals.indexOf(task):null}))).toEqual(test.output)
 })
})

import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource} from './mowerSourceRuntime'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
it('executes configured refresh_trading during an actual current-room observation change',()=>{
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.central.slots=[{occupant:{kind:'operator',operatorId:'夕'},groupId:null,replacements:['芬']}]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:['但书']}]
 ws.mainPlan.conf.refresh_trading=['夕']
 const s=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(s)
 for(const op of Object.values(source.data.operators)){
  const room=Object.entries(s.occupants).find(([,name])=>name===op.name)
  op.currentRoom=room?room[0].slice(0,room[0].lastIndexOf('_')):'';op.currentIndex=room?0:-1
  op.mood=s.morale[op.name]!;op.timeStampMicros=0
 }
 source.initial=false;source.firstInit=false
 const distant=new MowerTask({time:1,type:T.RUN_ORDER,metadata:'room_1_1'})
 const swap=new MowerTask({time:-1/3_600_000_000,type:T.SELF_CORRECTION,plan:{central:[id('芬')]}})
 source.queue.tasks=[swap,distant]
 settleMowerSource(s,{workRate:()=>1,recoveryRate:()=>2})
 expect(s.occupants.central_0).toBe(id('芬'))
 expect(source.queue.tasks).not.toContain(distant)
})
