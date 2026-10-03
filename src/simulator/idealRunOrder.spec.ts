import { describe, it, expect } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { simulateSchedule } from './scheduleSimulation'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'

function fixture(level = 1, runners = ['但书']) {
 const ws = createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 for (const key of ['room_3_1', 'room_3_2'] as const) {
  const r = ws.mainPlan.facilities[key];r.level = level
  r.slots = Array.from({length:level},(_,i)=>({occupant:{kind:'operator' as const,operatorId:id((key==='room_3_1'?['芬','砾','香草']:['克洛丝','斑点','空爆'])[i]!)},groupId:null,replacements:i<runners.length?[id(runners[i]!)]:[]}))
 }
 ws.mainPlan.facilities.dormitory_1.slots=[
  ...['杜林','闪灵'].map(n=>({occupant:{kind:'operator' as const,operatorId:id(n)},groupId:null,replacements:[]})),
  ...Array.from({length:3},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]})),
 ]
 return compileRosterSchedule(ws,{idleOperators:['米格鲁','安赛尔','芙蓉','巡林者'].map(id)})
}
const options = {sampleHours:8,recordSegments:true,consumptionOverrides:Object.fromEntries(['芬','砾','香草','克洛丝','斑点','空爆'].map(n=>[id(n),0])),production:{outputMode:'potential' as const,droneTarget:'none' as const,seed:42}}
describe('ideal-only run-order scheduling',()=>{
 it('applies ideal conversion without physically entering the runner',()=>{
  const actual=simulateSchedule(fixture(),options)
  expect(actual.success,JSON.stringify(actual.diagnostics)).toBe(true)
  expect(actual.production!.assumptions.runOrderMode).toBe('ideal')
  const done=actual.production!.events.filter(e=>e.type==='order-completed')
  expect(done.length).toBeGreaterThan(1)
  expect(done.every(e=>e.order!.kind==='proviso')).toBe(true)
  expect(actual.production!.events.filter(e=>e.type==='run-order-ideal')).toHaveLength(done.length)
  expect(actual.segments.some(s=>Object.values(s.occupants).includes(id('但书')))).toBe(false)
  expect(actual.operators.find(o=>o.operatorId===id('但书'))!.workHours).toBe(0)
  expect(actual.segments.filter(s=>s.occupants.room_3_1_0===id('芬')).length).toBeGreaterThan(1)
 })
 it('can retain order deadline wakes without staffing the runner for a controlled comparison',()=>{
  const ordinary=simulateSchedule(fixture(),{...options,experimentalDisableIdealWake:true})
  const wakeOnly=simulateSchedule(fixture(),options)
  expect(wakeOnly.success,JSON.stringify(wakeOnly.diagnostics)).toBe(true)
  expect(wakeOnly.inputs.schedule.assumptions.idealRunOrderWakeOnly).toBe(true)
  expect(wakeOnly.segments.length).toBeGreaterThan(ordinary.segments.length)
  expect(wakeOnly.segments.some(segment=>Object.values(segment.occupants).includes(id('但书')))).toBe(false)
  expect(wakeOnly.production!.events.filter(event=>event.type==='run-order-ideal')).toHaveLength(wakeOnly.production!.events.filter(event=>event.type==='order-completed').length)
 })
 it('shares a virtual runner across two trade stations without physical occupancy',()=>{
  const actual=simulateSchedule(fixture(),options)
  expect(actual.success,JSON.stringify(actual.diagnostics)).toBe(true)
  for(const segment of actual.segments){
   expect(Object.values(segment.occupants)).not.toContain(id('但书'))
   const positions=[...Object.values(segment.occupants),...Object.values(segment.bedOccupants)]
   expect(positions.filter(name=>name===id('但书')).length).toBeLessThanOrEqual(1)
  }
  for(const room of ['room_3_1','room_3_2'])expect(actual.production!.events.some(event=>event.roomId===room&&event.type==='order-completed'&&event.order?.kind==='proviso')).toBe(true)
 })
 it('converts base four-gold orders with Tequila and never stacks Proviso on them',()=>{
  const result=simulateSchedule(fixture(3,['但书','龙舌兰']),{...options,sampleHours:24})
  expect(result.success,JSON.stringify(result.diagnostics)).toBe(true)
  const orders=result.production!.events.filter(e=>e.type==='order-completed').map(e=>e.order!)
  expect(orders.some(o=>o.kind==='tequila')).toBe(true)
  expect(orders.every(o=>o.kind==='tequila'?o.goldCost===4&&o.lmdReward===2500:o.kind==='proviso'&&((o.goldCost===4&&o.lmdReward===2000)||(o.goldCost===5&&o.lmdReward===2500)))).toBe(true)
 })
 it('keeps virtual runners out of physical rooms after Mower backup-plan recompilation',()=>{
  const result=runScheduleSimulationBridge(importMowerJson(JSON.stringify(sourceRoster)),{
   sampleHours:2,warmupHours:0,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'exp',seed:42},
  },{restingThreshold:.65,freeRoom:false,fiammettaFool:false})
  const report=result.report!
  expect(report.success,JSON.stringify(report.diagnostics)).toBe(true)
  expect(report.events.some(event=>event.type==='backup-plan')).toBe(true)
  expect(report.segments.some(segment=>Object.entries(segment.occupants).some(([slot,occupant])=>slot.startsWith('room_')&&[id('但书'),id('龙舌兰')].includes(occupant)))).toBe(false)
  expect(report.production!.events.some(event=>event.type==='run-order-ideal')).toBe(true)
 })
})
