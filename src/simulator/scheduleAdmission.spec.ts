import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {fullCatalogIdleInventory} from '../domain/operatorInventory'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {simulateSchedule} from './scheduleSimulation'
import {summarizeIncome} from '../optimizer/incomeComparison'

const slot=(name:string,candidates:string[]=[])=>({occupant:{kind:'operator' as const,operatorId:name},groupId:null,replacements:candidates})
function simulatePermanent(permanent=true){
 const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_3.slots=[slot('Lancet-2')]
 if(permanent)w.mainPlan.conf.workaholic=['Lancet-2']
 return simulateSchedule(compileRosterSchedule(w,{idleOperators:[],operatorMorale:{[id('Lancet-2')]:0}}),{sampleHours:2,production:{droneTarget:'none',outputMode:'potential'}})
}
function deferred(hours:number,recovery=2){
 const w=createDefaultWorkspace()
 w.mainPlan.facilities.room_1_1.slots=[slot('砾',['芬'])]
 w.mainPlan.facilities.room_1_2.slots=[slot('斑点',['芬'])]
 w.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'free'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]}]
 const idleNames=new Set(['艾丽妮','白铁','百炼嘉维尔','仇白','嵯峨','归溟幽灵鲨'].map(id))
 const idleLibrary=fullCatalogIdleInventory().filter(entry=>idleNames.has(entry.operator))
 return simulateSchedule(compileRosterSchedule(w,{idleOperators:[]}),{sampleHours:hours,operatorInventory:idleLibrary,consumptionOverrides:{[id('砾')]:1,[id('斑点')]:1,[id('芬')]:1},recoveryOverrides:{[id('砾')]:recovery,[id('斑点')]:recovery,[id('芬')]:recovery},production:{droneTarget:'none',outputMode:'potential'}})
}
describe('explicit scheduling admission evidence',()=>{
 it('admits intentionally permanent zero-morale occupancy without granting work skills',()=>{
  const r=simulatePermanent();expect(r.operators.find(o=>o.operatorId===id('Lancet-2'))!.exhaustedHours).toBe(2)
  expect(r.rooms.find(room=>room.roomId==='room_1_3')!.averageEfficiencyPercent).toBe(100)
  expect(summarizeIncome(r).eligible).toBe(true)
  const ordinary=simulatePermanent(false);expect(summarizeIncome(ordinary).issues).toContain('存在疲劳占岗')
  const missingEvidence=simulatePermanent();delete missingEvidence.operators.find(o=>o.operatorId===id('Lancet-2'))!.permanentPrimaryOccupancyHours
  expect(summarizeIncome(missingEvidence).issues).toContain('存在疲劳占岗')
 })
 it.each(['factory','train'] as const)('declares idle auxiliary occupancy for %s',room=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities[room].slots=[slot('特克诺')]
  const r=simulateSchedule(compileRosterSchedule(w,{idleOperators:[]}),{sampleHours:1,production:{droneTarget:'none',outputMode:'potential'}})
  expect(r.diagnostics.some(d=>d.code==='PASSIVE_AUXILIARY_OCCUPANCY')).toBe(true)
  expect(r.diagnostics.some(d=>d.code==='UNQUANTIFIED_WORK_RATE')).toBe(false)
  expect(summarizeIncome(r).eligible).toBe(true)
 })
 it('accepts proven recovered deferral but rejects an unresolved shared-candidate conflict',()=>{
  const blocked=deferred(12);expect(blocked.diagnostics.some(d=>d.code==='group-blocked')).toBe(true)
  expect(summarizeIncome(blocked).eligible).toBe(false)
  const recovered=deferred(22)
  expect(recovered.diagnostics.some(d=>d.code==='SHIFT_DEFERRED_RECOVERED')).toBe(true)
  expect(recovered.diagnostics.some(d=>d.code==='group-blocked')).toBe(false)
  expect(summarizeIncome(recovered).eligible).toBe(true)
  const missing=structuredClone(recovered);delete missing.shiftDeferrals
  expect(summarizeIncome(missing).issues).toContain('换班延后缺少完整恢复证据')
  const unfinished=structuredClone(recovered);delete unfinished.shiftDeferrals![0]!.resolvedAt
  expect(summarizeIncome(unfinished).issues).toContain('换班延后缺少完整恢复证据')
  const fatigued=recovered.operators.find(o=>o.operatorId===id('斑点'))!
  fatigued.workHours-=.5;fatigued.exhaustedHours+=.5
  expect(summarizeIncome(recovered).issues).toContain('存在疲劳占岗')
 })
})

it('retains a later unresolved episode after the same group previously recovered',()=>{
 const r=deferred(35,1)
 const episodes=r.shiftDeferrals!
 expect(episodes.some(e=>e.resolvedAt!==undefined)).toBe(true)
 expect(episodes.some(e=>e.resolvedAt===undefined)).toBe(true)
 expect(r.diagnostics.some(d=>d.code==='group-blocked')).toBe(true)
 expect(summarizeIncome(r).eligible).toBe(false)
})
