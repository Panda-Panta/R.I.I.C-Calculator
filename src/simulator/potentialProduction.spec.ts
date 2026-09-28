import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {simulateSchedule} from './scheduleSimulation'
describe('unconstrained direct production accounting',()=>{
 it.each([.25,.13])('counts the exact EXP sample endpoint at step %s without counting a batch before it completes',maxStepHours=>{
  const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]});s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1');s.rooms[0]!.product='exp'
  const options={warmupHours:3,sampleHours:48,maxStepHours,production:{outputMode:'potential' as const,droneTarget:'none' as const}}
  const exact=simulateSchedule(s,options).production!,before=simulateSchedule(s,{...options,sampleHours:48-1e-6}).production!
  expect(exact.manufacturing[0]!.completedItems).toBe(17);expect(exact.sample.completed.exp).toBe(16000)
  expect(before.manufacturing[0]!.completedItems).toBe(16);expect(before.sample.completed.exp).toBe(15000)
  expect(exact.manufacturing[0]!.blockedHours).toBe(0)
 })

 it('continues completing orders with no gold, instead of filling a waiting queue',()=>{
  const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]});s.rooms=s.rooms.filter(r=>r.roomId==='room_3_1')
  const finite=simulateSchedule(s,{sampleHours:72,production:{droneTarget:'none',inventoryMode:'finite'}})
  const potential=simulateSchedule(s,{sampleHours:72,production:{droneTarget:'none',outputMode:'potential'}})
  expect(finite.production!.trading[0]!.blockedHours).toBeGreaterThan(0)
  expect(potential.production!.trading[0]!.blockedHours).toBe(0)
  expect(potential.production!.sample.completed.orderLmd).toBeGreaterThan(finite.production!.sample.completed.orderLmd)
  expect(potential.production!.ledger.outflows.gold??0).toBe(0)
  expect(potential.production!.assumptions.outputMode).toBe('potential')
 })
 it('keeps completed EXP separate from native collected EXP after warmup',()=>{
  const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]});s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1');s.rooms[0]!.product='exp'
  const p=simulateSchedule(s,{warmupHours:3,sampleHours:48,production:{outputMode:'potential',droneTarget:'none',collectionIntervalHours:1000}}).production!
  expect(p.sample.completed.exp).toBe(16000);expect(p.manufacturing[0]!.blockedHours).toBe(0)
 })
 it('has identical direct output regardless of initial gold, materials or collection interval',()=>{
  const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
  const a=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'none',seed:17}})
  const b=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'none',seed:17,initialResources:{gold:100000,lmd:999999,orirock:1000},collectionIntervalHours:100}})
  expect(a.production!.sample.completed).toEqual(b.production!.sample.completed)
 })
 it('accelerates trading post order completion when droneTarget is trading',()=>{
  const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
  s.rooms=s.rooms.filter(r=>r.roomId==='room_3_1')
  const unaccelerated=simulateSchedule(s,{sampleHours:72,production:{droneTarget:'none',outputMode:'potential'}})
  const accelerated=simulateSchedule(s,{sampleHours:72,production:{droneTarget:'trading',droneTradingRoomId:'room_3_1',outputMode:'potential'}})
  expect(accelerated.production!.sample.completed.orderLmd).toBeGreaterThan(unaccelerated.production!.sample.completed.orderLmd)
 })
})

it('spends manufacturing drones only in the selected room',()=>{
 const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
 s.rooms=s.rooms.filter(r=>['room_1_1','room_1_2'].includes(r.roomId))
 for(const r of s.rooms){r.type='manufacture';r.product='gold'}
 const p=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'gold',droneRoomId:'room_1_2'}}).production!
 const events=p.events.filter(e=>e.type==='native-manufacture-drone' && e.roomId)
 expect(events.length).toBeGreaterThan(0)
 expect([...new Set(events.map(e=>e.roomId))]).toEqual(['room_1_2'])
})

it('does not redirect drones to another facility when the selected room is unavailable',()=>{
 const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
 const p=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'gold',droneRoomId:'room_1_3'}}).production!
 expect(p.events.filter(e=>e.type==='native-manufacture-drone' && e.roomId)).toHaveLength(0)
})
it('uses the selected trading room through the shared facility target',()=>{
 const s=compileRosterSchedule(createDefaultWorkspace(),{idleOperators:[]})
 const p=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'trading',droneRoomId:'room_3_2'}}).production!
 const events=p.events.filter(e=>e.type==='native-trade-drone' && e.roomId)
 expect(events.length).toBeGreaterThan(0)
 expect([...new Set(events.map(e=>e.roomId))]).toEqual(['room_3_2'])
})
