import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {simulateSchedule} from './scheduleSimulation'
function fixture(){
 const workspace=createDefaultWorkspace()
 for(const room of Object.values(workspace.mainPlan.facilities))room.slots=[]
 const trade=workspace.mainPlan.facilities.room_3_1
 trade.level=1;trade.slots=[{occupant:{kind:'operator',operatorId:id('芬')},groupId:null,replacements:[id('但书')]}]
 workspace.mainPlan.conf.workaholic=[id('芬')]
 workspace.mainPlan.facilities.dormitory_1.slots=[
  ...['杜林','闪灵'].map(n=>({occupant:{kind:'operator' as const,operatorId:id(n)},groupId:null,replacements:[]})),
  ...Array.from({length:3},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]})),
 ]
 return compileRosterSchedule(workspace,{idleOperators:['斑点','空爆','梓兰','克洛丝'].map(id)})
}
describe('full simulation supplies concrete order observations to Mower tasks',()=>{
 it('observes order deadlines without physical runner entry',()=>{
  const report=simulateSchedule(fixture(),{sampleHours:8,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42}})
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  expect(report.diagnostics.some(d=>d.code==='mower-run-order-io-unavailable')).toBe(false)
  const runner=report.operators.find(o=>o.operatorId===id('但书'))!
  expect(runner.workHours).toBe(0)
  expect(report.segments.some(segment=>segment.occupants.room_3_1_0===id('但书'))).toBe(false)
  expect(report.segments.filter(segment=>segment.occupants.room_3_1_0===id('芬')).length).toBeGreaterThan(1)
  expect(report.production!.events.some(e=>e.type==='run-order-ideal')).toBe(true)
  expect(report.production!.events.some(e=>e.type==='order-completed'&&e.order?.kind==='proviso')).toBe(true)
  expect(report.production!.events.filter(e=>e.type==='order-completed').length).toBeGreaterThan(1)
  expect(report.operators.filter(o=>o.operatorId!==id('芬')).every(o=>o.exhaustedHours===0)).toBe(true)
 })
 it('leaves unpaid orders pending and exits the receipt page instead of tapping indefinitely',()=>{
  const schedule=fixture();schedule.rooms=schedule.rooms.filter(room=>room.type!=='manufacture')
  const report=simulateSchedule(schedule,{sampleHours:8,maxEvents:5000,production:{outputMode:'settled',runOrderMode:'ideal',droneTarget:'none',seed:42,inventoryMode:'finite',initialResources:{gold:0}}})
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  expect(report.production!.trading[0]!.completedOrders).toBeGreaterThan(0)
  expect(report.production!.trading[0]!.collectedOrders).toBe(0)
  expect(report.production!.trading[0]!.pendingOrders.length).toBeGreaterThan(0)
  expect(report.production!.ledger.outflows.gold??0).toBe(0)
 })

 it('uses unlimited materials by default while native receipt actions still own collection',()=>{
  const schedule=fixture();schedule.rooms=schedule.rooms.filter(room=>room.type!=='manufacture')
  const report=simulateSchedule(schedule,{sampleHours:8,maxEvents:5000,production:{outputMode:'settled',runOrderMode:'ideal',droneTarget:'none',seed:42,initialResources:{gold:0}}})
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  expect(report.production!.trading[0]!.collectedOrders).toBeGreaterThan(0)
  expect(report.production!.ledger.balances.gold??0).toBe(0)
  expect(report.production!.assumptions.inventoryMode).toBe('unlimited')
  expect(report.production!.materialsConsumed.gold).toBeGreaterThan(0)
  expect(report.production!.events.some(e=>e.type==='order-collected')).toBe(true)
 })

 it('executes the native drone branch against actual generated stock and preserves its ledger',()=>{
  const schedule=fixture()
  const report=simulateSchedule(schedule,{sampleHours:5,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'trading',droneRoomId:'room_3_1',seed:42,initialResources:{drone:150}}})
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  const drones=report.production!.drones
  expect(drones.consumed).toBeGreaterThan(0)
  expect(report.production!.events.some(e=>e.type==='native-trade-drone')).toBe(true)
  expect(drones.stock).toBeCloseTo(drones.initial+drones.generated-drones.consumed-drones.overflow,8)
  expect(report.production!.ledger.outflows.drone).toBeCloseTo(drones.consumed,8)
 })
 it('stops retrying trade acceleration after the available drones are spent',()=>{
  const report=simulateSchedule(fixture(),{sampleHours:4,maxEvents:500,recordSegments:true,production:{
   outputMode:'potential',runOrderMode:'ideal',droneTarget:'trading',droneRoomId:'room_3_1',seed:42,initialResources:{drone:0},
  }})
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  expect(report.segments.length).toBeLessThan(500)
  expect(report.production!.drones.consumed).toBeGreaterThan(0)
  expect(report.production!.drones.stock).toBeCloseTo(report.production!.drones.initial+report.production!.drones.generated-report.production!.drones.consumed-report.production!.drones.overflow,8)
 })

})
