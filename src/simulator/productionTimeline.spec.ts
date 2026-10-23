import {readFileSync} from 'node:fs'
import {importMowerJson} from '../workbench/compat/mowerJson'
import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {simulateSchedule} from './scheduleSimulation'

function emptyBase(){const w=createDefaultWorkspace();for(const r of Object.values(w.mainPlan.facilities))if(r.type==='manufacture')r.product='gold';return compileRosterSchedule(w)}
function assertNativeManufactureReserve(report:NonNullable<ReturnType<typeof simulateSchedule>['production']>,reserve:number){
 let stock=report.ledger.initial.drone??0,debits=0
 for(const entry of report.ledger.entries){
  const delta=entry.delta.drone??0
  if(entry.reason.endsWith(':native-manufacture-drone')){
   // Native entry uses the observed whole stock, then reserves the configured
   // quantity even when there are no run-order rooms. The debit can be <100.
   const observed=Math.floor(stock+1e-7)
   expect(observed).toBeGreaterThan(reserve)
   expect(-delta).toBe(observed-reserve)
   expect(stock+delta).toBeGreaterThanOrEqual(reserve-1e-7)
   debits++
  }
  stock+=delta
 }
 expect(debits).toBeGreaterThan(0)
 expect(stock).toBeCloseTo(report.drones.stock,7)
}
describe('joint production event clock',()=>{
 it('collects waiting trades through a later native notification action',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>['room_1_1','room_3_1','room_3_2'].includes(r.roomId))
  s.rooms.filter(r=>r.type==='trading').forEach(r=>r.level=1)
  const r=simulateSchedule(s,{sampleHours:5.1,production:{droneTarget:'gold',initialResources:{drone:205}}})
  const second=r.production!.events.find(e=>e.type==='order-collected'&&e.orderId==='room_3_2:1')!
  expect(r.success).toBe(true)
  const completed=r.production!.events.find(e=>e.type==='order-completed'&&e.orderId===second.orderId)!
  expect(second.time).toBeGreaterThan(completed.time)
  expect(r.production!.ledger.balances.gold).toBeGreaterThanOrEqual(0)
 })
 it('carries native drone work across manufacturing batches with one real debit',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1')
  const r=simulateSchedule(s,{sampleHours:.03,production:{droneTarget:'gold',initialResources:{drone:250}}})
  expect(r.success).toBe(true)
  expect(r.production!.manufacturing[0]!.completedItems).toBe(6)
  // The native default reserves 100: 150 drones supply 450 base minutes;
  // 1.8 elapsed minutes leave 52.2 in the seventh 72-minute batch.
  expect(r.production!.manufacturing[0]!.remainingBaseMinutes).toBeCloseTo(52.2,7)
  expect(r.production!.drones.consumed).toBe(150)
  expect(r.production!.ledger.outflows.drone).toBe(150)
  expect(r.production!.events.filter(e=>e.type==='native-manufacture-drone'&&e.amount!==undefined)).toHaveLength(1)
  assertNativeManufactureReserve(r.production!,100)
 })
 it('accepts a reserve below 250 but rejects a full-capacity reserve or an over-capacity initial stock',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1')
  const production={droneTarget:'none' as const,droneReserve:249,initialResources:{drone:250}}
  const r=simulateSchedule(s,{sampleHours:.03,production})
  expect(r.success).toBe(true)
  expect(r.production!.drones.stock).toBe(250)
  expect(r.production!.assumptions.droneReserve).toBe(249)
  expect(()=>simulateSchedule(s,{sampleHours:.03,production:{...production,droneReserve:250}})).toThrow('Invalid production timing/reserve')
  expect(()=>simulateSchedule(s,{sampleHours:.03,production:{...production,initialResources:{drone:251}}})).toThrow('Invalid drone state')
 })
 it('crosses coincident roster and fractional manufacturing endpoints in the real 252 fixture',()=>{
  const ws=importMowerJson(readFileSync('src/workbench/compat/fixtures/mower-252-2gold.json','utf8'))
  const r=simulateSchedule(compileRosterSchedule(ws),{sampleHours:12,production:{runOrderMode:'ideal',droneTarget:'none'}})
  expect(r.success).toBe(true)
  expect(r.production!.manufacturing.find(m=>m.roomId==='room_2_2')!.completedItems).toBeGreaterThanOrEqual(17)
 },30000)
 it('produces integer gold while preserving the incomplete next batch',()=>{
  const r=simulateSchedule(emptyBase(),{sampleHours:1.3,production:{droneTarget:'none'}})
  expect(r.success).toBe(true)
  expect(r.production!.manufacturing.every(x=>x.completedItems===1)).toBe(true)
  expect(r.production!.ledger.balances.gold).toBe(0)
  expect(r.production!.manufacturing.every(x=>x.pendingItems===1)).toBe(true)
  expect(r.production!.manufacturing[0]!.remainingBaseMinutes).toBeCloseTo(66,7)
 })
 it('never delivers an order without paying its gold',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>r.type!=='manufacture')
  const r=simulateSchedule(s,{sampleHours:48,production:{droneTarget:'none',inventoryMode:'finite'}})
  expect(r.production!.ledger.balances.lmd??0).toBe(0)
  expect(r.production!.trading.every(x=>x.pendingOrders.length===10)).toBe(true)
  expect(r.production!.trading.every(x=>x.blockedHours>0)).toBe(true)
 })
 it('separates sample ledger changes from warmup without resetting work',()=>{
  const r=simulateSchedule(emptyBase(),{sampleHours:1.2,warmupHours:1.2,production:{droneTarget:'none'}})
  expect(r.production!.sample.inflows.gold??0).toBe(0)
  expect(r.production!.sample.completed.gold).toBe(4)
  expect(r.production!.manufacturing.every(x=>x.completedItems===2)).toBe(true)
 })
 it('retains recipe material costs and refuses unfunded fragment batches',()=>{
  const s=emptyBase();const m=s.rooms.find(r=>r.type==='manufacture')!;m.product='fragment'
  const r=simulateSchedule(s,{sampleHours:3,production:{droneTarget:'none',inventoryMode:'finite'}})
  const f=r.production!.manufacturing.find(x=>x.roomId===m.roomId)!
  expect(f.completedItems).toBe(0);expect(f.blockedMaterialHours).toBe(3)
 })
 it('has repeatable seeded order draws and sample accounting',()=>{
  const s=emptyBase(),o={sampleHours:24,production:{droneTarget:'none' as const,seed:42,initialResources:{gold:100}}}
  const a=simulateSchedule(s,o),b=simulateSchedule(s,o)
  expect(a).toEqual(b)
  for(const [key,v] of Object.entries(a.production!.ledger.balances)){
   const l=a.production!.ledger,k=key as keyof typeof l.balances
   expect(v).toBeCloseTo((l.initial[k]??0)+(l.inflows[k]??0)-(l.outflows[k]??0),8)
  }
 })
 it('uses native periodic drone tasks and retains unspent stock at midnight',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1')
  const r=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'gold'}})
  expect(r.success).toBe(true)
  const p=r.production!,events=p.events.filter(e=>e.type==='native-manufacture-drone'&&e.amount!==undefined)
  expect(events.length).toBeGreaterThan(0)
  assertNativeManufactureReserve(p,100)
  expect(events.slice(1).every((e,i)=>e.time-events[i]!.time>3)).toBe(true)
  expect(p.events.some(e=>e.type==='manufacture-drone')).toBe(false)
  expect(p.drones.generated).toBeCloseTo(240,5)
  expect(p.drones.stock).toBeGreaterThan(0)
  expect(p.drones.consumed+p.drones.stock+p.drones.overflow).toBeCloseTo(240,5)
 })
 it('uses the same native threshold with boosted drone generation',()=>{
  const w=createDefaultWorkspace()
  for(const r of Object.values(w.mainPlan.facilities))if(r.type==='manufacture')r.product='gold'
  w.mainPlan.facilities.room_1_3.slots[0]={occupant:{kind:'operator',operatorId:'char_253_greyy'},groupId:null,replacements:[]}
  w.mainPlan.conf.workaholic=['char_253_greyy']
  const r=simulateSchedule(compileRosterSchedule(w),{sampleHours:24,production:{outputMode:'potential',droneTarget:'gold'}})
  expect(r.success).toBe(true)
  expect(r.production!.drones.generated).toBeCloseTo(300,5)
  expect(r.production!.drones.stock).toBeGreaterThan(0)
  expect(r.production!.drones.consumed+r.production!.drones.stock+r.production!.drones.overflow).toBeCloseTo(300,5)
  assertNativeManufactureReserve(r.production!,100)
 })
 it('accelerates the selected normal trade station once per native todo invocation',()=>{
  const s=emptyBase();s.rooms=s.rooms.filter(r=>r.roomId==='room_3_1')
  const r=simulateSchedule(s,{sampleHours:24,production:{outputMode:'potential',droneTarget:'trading',droneTradingRoomId:'room_3_1'}})
  expect(r.success).toBe(true)
  const p=r.production!,events=p.events.filter(e=>e.type==='native-trade-drone'&&e.amount!==undefined)
  expect(events.length).toBeGreaterThan(1)
  expect(events.slice(1).every((e,i)=>e.time-events[i]!.time>3)).toBe(true)
  expect(events.reduce((sum,e)=>sum+(e.amount??0),0)).toBe(p.drones.consumed)
  expect(p.events.some(e=>e.type==='trade-drone')).toBe(false)
  expect(p.drones.stock).toBeGreaterThan(0)
 })
})
