import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from '../scheduler/scheduleAdapter'
import {createRosterRuntime,advanceRoster,type RuntimeRates} from '../scheduler/rosterRuntime'
import {projectScheduleState} from './scheduleSimulation'
import {evaluateOperators} from '../engine/operatorRules'
import {createProductionTimeline,type ProductionFrame} from './productionTimeline'
import {createMowerProductionIO} from './mowerNativeProductionIO'
describe('native manufacture drone action observations',()=>{
 it('uses the observed initial selection and native minus actions, with one real debit and no receipt at confirmation',()=>{
  const ws=createDefaultWorkspace()
  for(const r of Object.values(ws.mainPlan.facilities))r.slots=[]
  ws.mainPlan.facilities.room_2_1.product='exp'
  ws.mainPlan.facilities.room_2_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:[]}]
  ws.mainPlan.facilities.room_3_1.slots=[{occupant:{kind:'operator',operatorId:'砾'},groupId:null,replacements:['但书']}]
  const schedule=compileRosterSchedule(ws),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  state.config.mowerDeviceObservations={initialManufactureDroneSelection:120}
  const frame=():ProductionFrame=>{
   const config=projectScheduleState(schedule,state),active=new Set(Object.keys(state.morale)),morale=new Map(Object.entries(state.morale))
   return {time:state.time,config,active,morale,evaluations:Object.fromEntries(config.rooms.map(r=>[r.id,evaluateOperators(r,config,active,morale)]))}
  }
  const production=createProductionTimeline(schedule,state,{outputMode:'potential',droneTarget:'none',initialResources:{drone:150}},0,()=>{},()=>{},true)
  production.settle(frame)
  const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,...createMowerProductionIO(state,production,frame)}
  const work=rates.mowerTodoTaskIO!({kind:'drone',room:'room_2_1'},state)
  if(!('next' in work))throw new Error('Expected nested native drone continuation')
  let next=work.next(),steps=0
  while(!next.done){
   if(++steps>100)throw new Error('Native drone did not terminate')
   const dt=next.value.delayMicros/3_600_000_000
   if(dt>0){production.advance(dt,frame());advanceRoster(state,dt,rates);production.settle(frame)}
   next=work.next()
  }
  const report=production.report()
  // The source subtracts 150-100 = 50 from the explicit observed 120 selection.
  expect(report.drones.consumed).toBe(70)
  expect(report.ledger.outflows.drone).toBe(70)
  expect(report.events.filter(e=>e.type==='native-manufacture-drone'&&e.amount!==undefined)).toHaveLength(1)
  expect(report.manufacturing.find(m=>m.roomId==='room_2_1')!.pendingItems).toBe(1)
  expect(state.time).toBeCloseTo(10/3600,10)
 })
})
