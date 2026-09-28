import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from '../scheduler/scheduleAdapter'
import {createRosterRuntime} from '../scheduler/rosterRuntime'
import {projectScheduleState} from './scheduleSimulation'
import {evaluateOperators} from '../engine/operatorRules'
import {createProductionTimeline,type ProductionFrame} from './productionTimeline'
function scenario(native=false,outputMode:'potential'|'settled'='potential'){
 const workspace=createDefaultWorkspace()
 for(const facility of Object.values(workspace.mainPlan.facilities))facility.slots=[]
 workspace.mainPlan.facilities.room_3_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:[]}]
 const schedule=compileRosterSchedule(workspace),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
 const frame=():ProductionFrame=>{
  const config=projectScheduleState(schedule,state),active=new Set(Object.keys(state.morale)),morale=new Map(Object.entries(state.morale))
  return {time:state.time,config,active,morale,evaluations:Object.fromEntries(config.rooms.map(room=>[room.id,evaluateOperators(room,config,active,morale)]))}
 }
 const controller=createProductionTimeline(schedule,state,{outputMode,collectionIntervalHours:1000,droneTarget:'none',initialResources:{drone:native?235:50,gold:10000},seed:42},0,()=>{},()=>{},native)
 controller.settle(frame)
 return {state,frame,controller}
}
describe('native order I/O observes the shared production state',()=>{
 it('reads the live remaining time after production and clock advancement',()=>{
  const {state,frame,controller}=scenario()
  const before=controller.nativeRemainingSeconds('room_3_1',frame())
  controller.advance(.1,frame());state.time=.1
  expect(controller.nativeRemainingSeconds('room_3_1',frame())).toBeCloseTo(before-360,8)
 })
 it('spends real stock once and reads the updated deadline without rerolling the current order',()=>{
  const {frame,controller}=scenario(),before=controller.nativeRemainingSeconds('room_3_1',frame())
  const orders=controller.report().events.filter(e=>e.type==='order-started')
  controller.nativeSpendTradeDrones('room_3_1',3,frame())
  const after=controller.report()
  expect(after.drones.consumed).toBe(3);expect(after.drones.stock).toBe(47)
  expect(controller.nativeRemainingSeconds('room_3_1',frame())).toBeCloseTo(before-9*60/(frame().evaluations.room_3_1!.efficiencyPercent/100),8)
  expect(after.events.filter(e=>e.type==='order-started')).toEqual(orders)
  expect(after.ledger.outflows.drone).toBe(3)
 })
 it.each(['settled','potential'] as const)('retains a completed order until a native receipt action in %s mode',outputMode=>{
  const {frame,controller}=scenario(true,outputMode)
  const required=controller.nativeTradeRequiredDrones('room_3_1')
  controller.nativeSpendTradeDrones('room_3_1',required,frame())
  controller.settle(frame)
  const pending=controller.report()
  expect(pending.trading[0]!.completedOrders).toBe(1)
  expect(pending.trading[0]!.collectedOrders).toBe(0)
  expect(pending.trading[0]!.pendingOrders).toHaveLength(1)
  expect(pending.ledger.balances.lmd??0).toBe(0)
  controller.nativeAcceptOrder('room_3_1',frame())
  const accepted=controller.report()
  expect(accepted.trading[0]!.collectedOrders).toBe(1)
  expect(accepted.trading[0]!.pendingOrders).toHaveLength(0)
  expect(accepted.ledger.balances.lmd).toBeGreaterThan(0)
 })

 it('rejects an unavailable facility and refuses unbacked drone stock',()=>{
  const {frame,controller}=scenario(),before=structuredClone(controller.report())
  expect(()=>controller.nativeRemainingSeconds('unknown',frame())).toThrow('facility')
  expect(()=>controller.nativeSpendTradeDrones('room_3_1',51,frame())).toThrow('spend')
  expect(controller.report()).toEqual(before)
 })
})
