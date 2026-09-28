import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {simulateSchedule,type ScheduleSimulationOptions} from './scheduleSimulation'
import type {ResourceAmounts} from './resourceLedger'

/** Sparse, empty rooms isolate facility base production from operator-specific rules. */
function onlyRoom(product:'gold'|'exp'|'fragment'='gold',level:1|3=3){
 const s=compileRosterSchedule(createDefaultWorkspace())
 s.rooms=s.rooms.filter(r=>r.roomId==='room_1_1')
 Object.assign(s.rooms[0]!,{product,level})
 return s
}
const noDrones={droneTarget:'none' as const}
function conserved(r:ReturnType<typeof simulateSchedule>){
 expect(r.success).toBe(true);expect(r.production?.success).toBe(true)
 const p=r.production!,l=p.ledger
 for(const key of new Set([...Object.keys(l.initial),...Object.keys(l.balances),...Object.keys(l.inflows),...Object.keys(l.outflows)])){
  const k=key as keyof ResourceAmounts
  expect(l.balances[k]??0).toBeGreaterThanOrEqual(0)
  expect(l.balances[k]??0).toBeCloseTo((l.initial[k]??0)+(l.inflows[k]??0)-(l.outflows[k]??0),7)
  expect((p.sample.closing[k]??0)-(p.sample.opening[k]??0)).toBeCloseTo((p.sample.inflows[k]??0)-(p.sample.outflows[k]??0),7)
 }
 expect(l.balances.drone??0).toBeCloseTo(p.drones.stock,7)
 expect(p.drones.initial+p.drones.generated-p.drones.overflow-p.drones.consumed).toBeCloseTo(p.drones.stock,7)
}

describe('production resource contracts on the native Mower event clock',()=>{
 it('collects a level-1 warehouse through native Mower tasks without accumulating beyond capacity',()=>{
  const r=simulateSchedule(onlyRoom('gold',1),{sampleHours:21.3,production:noDrones})
  conserved(r)
  const m=r.production!.manufacturing[0]!
  expect(m.completedItems).toBe(17);expect(m.pendingItems).toBe(1)
  expect(m.blockedHours).toBe(0);expect(m.blockedMaterialHours).toBe(0)
  expect(r.production!.ledger.balances.gold).toBe(16)
  expect(r.production!.events.filter(e=>e.type==='collect-manufacture:room_1_1')).toHaveLength(8)
  expect(m.remainingBaseMinutes).toBeCloseTo(18,6)
 })
 it('settles one medium EXP record as 1000 EXP and keeps the next record incomplete',()=>{
  const r=simulateSchedule(onlyRoom('exp'),{sampleHours:3.5,production:noDrones})
  conserved(r)
  expect(r.production!.manufacturing[0]!.completedItems).toBe(1)
  expect(r.production!.manufacturing[0]!.remainingBaseMinutes).toBeCloseTo(150,7)
  expect(r.production!.manufacturing[0]!.pendingItems).toBe(1)
  expect(r.production!.sample.completed.exp).toBe(1000)
  expect(r.production!.ledger.balances.exp??0).toBe(0)
 })
 it('pays orirock batch inputs once at start, including the next funded work in progress',()=>{
  const r=simulateSchedule(onlyRoom('fragment'),{sampleHours:1.5,production:{...noDrones,inventoryMode:'finite',initialResources:{orirock:4,lmd:3200}}})
  conserved(r)
  const p=r.production!
  expect(p.manufacturing[0]!.pendingItems).toBe(1);expect(p.ledger.balances.fragment).toBe(0)
  expect(p.ledger.outflows.orirock).toBe(4);expect(p.ledger.outflows.lmd).toBe(3200)
  expect(p.ledger.entries.filter(e=>e.reason.includes('manufacture-start:'))).toHaveLength(2)
  expect(p.manufacturing[0]!.remainingBaseMinutes).toBeCloseTo(30,7)
  expect(p.manufacturing[0]!.blockedMaterialHours).toBe(0)
 })
 it('does not charge partial recipe costs when one input is missing',()=>{
  const r=simulateSchedule(onlyRoom('fragment'),{sampleHours:2.5,production:{...noDrones,inventoryMode:'finite',initialResources:{orirock:4,lmd:1600}}})
  conserved(r)
  const p=r.production!
  expect(p.manufacturing[0]!.pendingItems).toBe(1);expect(p.ledger.balances.fragment).toBe(0);expect(p.ledger.balances.orirock).toBe(2)
  expect(p.ledger.outflows.lmd).toBe(1600);expect(p.ledger.outflows.orirock).toBe(2)
  expect(p.manufacturing[0]!.blockedMaterialHours).toBeCloseTo(1.5,7)
 })
 it('honors the alternative device recipe without consuming orirock',()=>{
  const r=simulateSchedule(onlyRoom('fragment'),{sampleHours:1.5,production:{...noDrones,inventoryMode:'finite',fragmentFormulaByRoom:{room_1_1:'fragment-device'},initialResources:{device:1,lmd:1000,orirock:9}}})
  conserved(r)
  const p=r.production!
  expect(p.manufacturing[0]!.pendingItems).toBe(1);expect(p.ledger.balances.fragment).toBe(0);expect(p.ledger.balances.device).toBe(0)
  expect(p.ledger.balances.orirock).toBe(9);expect(p.ledger.outflows.orirock??0).toBe(0)
  expect(p.manufacturing[0]!.blockedMaterialHours).toBeCloseTo(.5,7)
 })
 it('carries an unfinished warmup batch across the sampling boundary without charging again',()=>{
  const r=simulateSchedule(onlyRoom('fragment'),{warmupHours:.5,sampleHours:.75,production:{...noDrones,inventoryMode:'finite',initialResources:{orirock:2,lmd:1600}}})
  conserved(r)
  const s=r.production!.sample
  expect(s.opening.orirock).toBe(0);expect(s.opening.lmd).toBe(0)
  expect(s.outflows.orirock).toBe(0);expect(s.outflows.lmd).toBe(0)
  expect(s.inflows.fragment??0).toBe(0);expect(s.net.fragment??0).toBe(0)
  expect(r.production!.manufacturing[0]!.pendingItems).toBe(1)
  expect(r.production!.manufacturing[0]!.blockedMaterialHours).toBeCloseTo(.25,7)
 })
 it('counts post-warmup completions while pending output stays outside the ledger',()=>{
  const r=simulateSchedule(onlyRoom(),{warmupHours:1.2,sampleHours:1.2,production:noDrones})
  conserved(r)
  expect(r.production!.sample.opening.gold).toBe(0)
  expect(r.production!.sample.closing.gold).toBe(0)
  expect(r.production!.sample.inflows.gold??0).toBe(0)
  expect(r.production!.sample.completed.gold).toBe(1)
  expect(r.production!.manufacturing[0]!.pendingItems).toBe(2)
 })
 it('has one shared drone recharge baseline for three empty power stations and records overflow',()=>{
  const s=compileRosterSchedule(createDefaultWorkspace());s.rooms=s.rooms.filter(r=>r.type==='power')
  const r=simulateSchedule(s,{sampleHours:2,production:{...noDrones,initialResources:{drone:230}}})
  conserved(r)
  expect(r.production!.drones.generated).toBeCloseTo(20,8)
  expect(r.production!.drones.stock).toBe(235)
  expect(r.production!.drones.overflow).toBeCloseTo(15,8)
  expect(r.production!.drones.consumed).toBe(0)
 })
 it('collects completed trade orders through native Mower tasks after they finish',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_3_1.level=1
  ws.mainPlan.facilities.room_3_1.slots=[{occupant:{kind:'operator',operatorId:'砾'},groupId:null,replacements:['但书']}]
  ws.mainPlan.facilities.room_3_2.level=1
  ws.mainPlan.facilities.room_3_2.slots=[{occupant:{kind:'operator',operatorId:'能天使'},groupId:null,replacements:[]}]
  ws.mainPlan.conf.workaholic=['砾','能天使']
  const s=compileRosterSchedule(ws);s.rooms=s.rooms.filter(r=>['room_1_1','room_3_1','room_3_2'].includes(r.roomId))
  expect(s.runOrderPolicies).toEqual([{roomId:'room_3_1',orderedOperatorIds:[id('但书')]}])
  const r=simulateSchedule(s,{sampleHours:2.5,production:{...noDrones,runOrderMode:'grandet',initialResources:{gold:20,drone:20}}})
  conserved(r)
  const p=r.production!
  const completed=p.events.filter(e=>e.type==='order-completed')
  const collected=p.events.filter(e=>e.type==='order-collected')
  expect(completed).toHaveLength(2);expect(collected).toHaveLength(2)
  for(const event of collected)expect(event.time).toBeGreaterThan(completed.find(e=>e.orderId===event.orderId)!.time)
  expect(p.manufacturing[0]!.completedItems).toBe(2)
  expect(p.manufacturing[0]!.pendingItems).toBe(1)
  expect(p.trading.find(t=>t.roomId==='room_3_1')!.collectedOrders).toBe(1)
  expect(p.trading.find(t=>t.roomId==='room_3_2')!.collectedOrders).toBe(1)
  expect(p.ledger.balances.gold).toBe(21)
  expect(p.ledger.balances.lmd).toBe(3000)
 })
 it('preserves ordinary Mower duty decisions while production actions advance the shared clock',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'砾'},groupId:null,replacements:['斑点']}]
  ws.mainPlan.facilities.room_1_1.level=1
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'free'},groupId:null,replacements:[]}]
  const s=compileRosterSchedule(ws),o:ScheduleSimulationOptions={sampleHours:54,consumptionOverrides:{[id('砾')]:1,[id('斑点')]:1},recoveryOverrides:{[id('砾')]:2,[id('斑点')]:2}}
  const a=simulateSchedule(s,o),b=simulateSchedule(s,{...o,production:noDrones})
  conserved(b);expect(a.success).toBe(true)
  expect(b.events.map(e=>[e.type,e.operators])).toEqual(a.events.map(e=>[e.type,e.operators]))
  // Native notification and collection clicks take real clock time between duty events.
  a.events.forEach((e,i)=>{
   expect(b.events[i]!.time).toBeGreaterThanOrEqual(e.time)
   expect(b.events[i]!.time-e.time).toBeLessThan(1/60)
  })
  for(const op of a.operators){const other=b.operators.find(x=>x.operatorId===op.operatorId)!
   for(const k of ['mainWorkHours','substituteWorkHours','restHours','idleHours','exhaustedHours','finalMorale'] as const)expect(Math.abs(other[k]-op[k])).toBeLessThan(.02)
  }
 })
})
