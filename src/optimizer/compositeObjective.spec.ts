import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {compareIncome,summarizeIncome} from './incomeComparison'
import {scoreProduction} from './productionObjective'
const cases=()=>[1,2].flatMap(seed=>[.25,.125].map(maxStepHours=>summarizeIncome(runScheduleSimulationBridge(createDefaultWorkspace(),{sampleHours:1,warmupHours:0,maxStepHours,production:{outputMode:'potential',droneTarget:'none',seed}},{idleOperators:[]}).report!)))
describe('user-defined conventional composite output',()=>{
 it('applies EXP + .8 * gold value + .2 * order face value without double-counting inventory',()=>{
  expect(scoreProduction({exp:1000,gold:2,orderLmd:1500},24)).toEqual({exp:1000,goldValue:1000,orderValue:1500,weightedExp:1000,weightedGold:800,weightedOrders:300,weightedFragments:0,weightedOrundum:0,total:2100})
 })
 it('can accept a better weighted mix while some component and stock values fall',()=>{
  const b=cases(),c=structuredClone(b)
  for(const x of c){x.output!.daily=scoreProduction({exp:1000,gold:0,orderLmd:0},24);x.daily.gold-=5;x.closing.gold-=5}
  expect(compareIncome(b,c,'composite').status).toBe('improved')
  expect(compareIncome(b,c,'exp').status).toBe('rejected')
 })
 it('does not call finite-inventory completed output unconstrained output',()=>{
  const b=cases(),c=structuredClone(b);c[0]!.output!.mode='settled'
  expect(compareIncome(b,c,'composite').status).toBe('ineligible')
 })
})
