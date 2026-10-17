import {expect,it} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {simulateSchedule} from './scheduleSimulation'

it.each([.25,.13,.1,.07,1])('counts the exact 28-day EXP endpoint without completing early, step=%s',maxStepHours=>{
 const schedule=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
 schedule.rooms=schedule.rooms.filter(room=>room.roomId==='room_1_1')
 schedule.rooms[0]!.product='exp'
 const options={warmupHours:72,sampleHours:672,maxStepHours,production:{outputMode:'potential' as const,droneTarget:'none' as const}}
 const exact=simulateSchedule(schedule,options)
 const before=simulateSchedule(schedule,{...options,sampleHours:672-1e-6})
 expect(exact.success).toBe(true)
 expect(before.success).toBe(true)
 // An empty EXP factory completes 1000 EXP every three hours at 100% efficiency.
 // The 72-hour warmup leaves no partial batch; 672 measured hours contain 224 batches.
 expect(exact.production!.sample.completed.exp).toBe(224000)
 expect(before.production!.sample.completed.exp).toBe(223000)
},60000)
