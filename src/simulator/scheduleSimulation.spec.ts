import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {simulateSchedule, projectScheduleState} from './scheduleSimulation'
import {createRosterRuntime} from '../scheduler/rosterRuntime'
import {compiledScheduleToRuntimeConfig} from '../scheduler/scheduleAdapter'

function scenario(primary='砾',candidate?:string){
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:primary},groupId:null,replacements:candidate?[candidate]:[]}]
 ws.mainPlan.facilities.room_1_1.level=1
 ws.mainPlan.facilities.dormitory_1.level=1
 ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'free'},groupId:null,replacements:[]}]
 if(!candidate)ws.mainPlan.conf.workaholic=[primary]
 return compileRosterSchedule(ws)
}

describe('time-dependent Mower schedule simulation',()=>{
 it.each(['mower-default','mower-alpha'] as const)('records an explicitly selected %s model without changing caller options',schedulingModel=>{
  const options={sampleHours:.01,schedulingModel},before={...options}
  const report=simulateSchedule(scenario(),options)
  expect(report.success).toBe(true)
  expect(report.assumptions.schedulingModel).toBe(schedulingModel)
  expect(report.inputs.options.schedulingModel).toBe(schedulingModel)
  expect(options).toEqual(before)
 })
 it('rejects an unknown scheduling model instead of silently choosing an algorithm',()=>{
  // @ts-expect-error Imported report options can contain an invalid model.
  expect(()=>simulateSchedule(scenario(),{schedulingModel:'unknown'})).toThrow('Invalid scheduling model')
 })
 it('default single recovery selects a recipient who can receive outside healing',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.dormitory_1.level=1
  ws.mainPlan.facilities.dormitory_1.slots=['闪灵','菲亚梅塔','芬'].map(name=>({occupant:{kind:'operator' as const,operatorId:name},groupId:null,replacements:[]}))
  const s=compileRosterSchedule(ws,{operatorMorale:{[id('菲亚梅塔')]:0,[id('芬')]:10}})
  const r=simulateSchedule(s,{sampleHours:1})
  expect(r.success).toBe(true)
  expect(r.operators.find(o=>o.operatorId===id('菲亚梅塔'))!.finalMorale).toBeCloseTo(2)
  expect(r.operators.find(o=>o.operatorId===id('芬'))!.finalMorale).toBeCloseTo(12.75)
  // A caller's explicit target remains an explicit modelling assumption.
  const explicit=simulateSchedule(s,{sampleHours:1,recoveryTargetByProvider:{[id('闪灵')]:id('菲亚梅塔')}})
  expect(explicit.operators.find(o=>o.operatorId===id('芬'))!.finalMorale).toBeCloseTo(12)
 })
 it('integrates actual warmup instead of the stationary peak',()=>{
  const s=scenario('阿罗玛')
  const r=simulateSchedule(s,{sampleHours:10,maxStepHours:1,warmupModel:'continuous',consumptionOverrides:{[id('阿罗玛')]:0.5}})
  expect(r.success).toBe(true)
  expect(r.rooms.find(x=>x.roomId==='room_1_1')!.averageEfficiencyPercent).toBeCloseTo(136,7)
  expect(r.operators.find(x=>x.operatorId===id('阿罗玛'))!.workHours).toBe(10)
 })
 it('also evaluates the explicitly selected hourly warmup model',()=>{
  const r=simulateSchedule(scenario('阿罗玛'),{sampleHours:10,maxStepHours:1,warmupModel:'hourly',consumptionOverrides:{[id('阿罗玛')]:0.5}})
  expect(r.rooms.find(x=>x.roomId==='room_1_1')!.averageEfficiencyPercent).toBeCloseTo(135,7)
 })
 it('measures main and substitute duty from repeated bed-constrained cycles',()=>{
  const s=scenario('砾','斑点')
  const r=simulateSchedule(s,{sampleHours:27,consumptionOverrides:{[id('砾')]:1,[id('斑点')]:1},recoveryOverrides:{[id('砾')]:2,[id('斑点')]:2}})
  expect(r.success).toBe(true)
  const a=r.operators.find(x=>x.operatorId===id('砾'))!
  // Full-catalog Free selection can change recovery and shift timing.
  expect(a.mainWorkHours).toBeGreaterThan(0)
  expect(a.restHours).toBeGreaterThan(0)
  expect(a.workFraction).toBeCloseTo(a.workHours/27,6)
  expect(r.operators.find(x=>x.operatorId===id('斑点'))!.substituteWorkHours).toBeGreaterThan(0)
  for(const op of r.operators)expect(op.workHours+op.exhaustedHours+op.restHours+op.idleHours).toBeCloseTo(27,7)
 })
 it('never restores an unassigned substitute without a dormitory slot',()=>{
  const s=scenario('砾','斑点');s.restPools=[];s.assumptions.operatorMorale[id('斑点')]=2
  const r=simulateSchedule(s,{sampleHours:30,consumptionOverrides:{[id('砾')]:1}})
  const op=r.operators.find(x=>x.operatorId===id('斑点'))!
  expect(op.finalMorale).toBe(2)
  expect(op.idleHours).toBe(30)
  expect(r.operators.find(x=>x.operatorId===id('斑点'))!.restHours).toBe(0)
 })
 it('separates the observation window from preconditioning',()=>{
  const r=simulateSchedule(scenario('阿罗玛'),{warmupHours:10,sampleHours:5,warmupModel:'continuous',consumptionOverrides:{[id('阿罗玛')]:0}})
  expect(r.rooms.find(x=>x.roomId==='room_1_1')!.averageEfficiencyPercent).toBeCloseTo(146,7)
  expect(r.operators.find(x=>x.operatorId===id('阿罗玛'))!.workHours).toBeCloseTo(5,8)
  expect(r.elapsedHours).toBe(15)
 })
 it('preserves zero morale physical presence without granting worker efficiency',()=>{
  const s=scenario('砾');s.assumptions.operatorMorale[id('砾')]=0;s.operators[id('砾')]!.morale=0
  const r=simulateSchedule(s,{sampleHours:2})
  expect(r.rooms.find(x=>x.roomId==='room_1_1')!.averageEfficiencyPercent).toBeCloseTo(100,8)
  expect(r.operators.find(x=>x.operatorId===id('砾'))!.exhaustedHours).toBe(2)
 })
 it('projects real bed occupancy and never uses empty Free placeholders as residents',()=>{
  const s=scenario('砾','斑点'), state=createRosterRuntime(compiledScheduleToRuntimeConfig(s))
  expect(projectScheduleState(s,state).dormitoryOccupantCount).toBe(0)
  state.occupants.room_1_1_0=id('斑点');state.bedOccupants.dormitory_1_0=id('砾')
  const c=projectScheduleState(s,state)
  expect(c.dormitoryOccupantCount).toBe(1)
  expect(c.rooms.find(x=>x.id==='room_1_1')!.operatorIds).toEqual([id('斑点')])
  expect(c.facilityOperatorIds.dormitories[0]).toEqual([id('砾')])
 })
 it('does not mutate the compiled schedule and produces deterministic output',()=>{
  const s=scenario('砾','斑点'),copy=structuredClone(s),options={sampleHours:40,recordSegments:true}
  const a=simulateSchedule(s,options), b=simulateSchedule(s,options)
  expect(s).toEqual(copy);expect(a).toEqual(b)
  const saved=JSON.parse(JSON.stringify(a.inputs));expect(simulateSchedule(saved.schedule,saved.options)).toEqual(a)
  expect(a.segments.every(x=>x.end>x.start)).toBe(true)
 })

 it('resets imported warmup when Fiammetta exchanges at time zero',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'阿罗玛'},groupId:null,replacements:[]}];ws.mainPlan.conf.workaholic=['阿罗玛']
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'菲亚梅塔'},groupId:null,replacements:['阿罗玛']}]
  const s=compileRosterSchedule(ws,{operatorMorale:{[id('阿罗玛')]:20}})
  const r=simulateSchedule(s,{sampleHours:1,initialWorkHours:{[id('阿罗玛')]:10}})
  expect(r.events[0]?.type).toBe('fiammetta');expect(r.rooms.find(x=>x.roomId==='room_1_1')!.averageEfficiencyPercent).toBeCloseTo(127,2)
 })

 it('does not spend the event budget on a full-to-full Fiammetta exchange with a stable idle target',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'菲亚梅塔'},groupId:null,replacements:['重岳']}]
  ws.mainPlan.facilities.dormitory_2.slots=[{occupant:{kind:'operator',operatorId:'重岳'},groupId:null,replacements:[]}]
  const s=compileRosterSchedule(ws,{fiammettaFool:false})
  const r=simulateSchedule(s,{sampleHours:.05,maxEvents:1000,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none'}})
  expect(r.success,JSON.stringify(r.diagnostics.slice(-5))).toBe(true)
  expect(r.diagnostics.some(d=>d.code==='mower-fia-full-noop-skipped')).toBe(true)
  expect(r.events.filter(e=>e.type==='fiammetta'&&e.moraleBefore?.[0]===24&&e.moraleBefore?.[1]===24)).toHaveLength(0)
  expect(r.operators.find(o=>o.operatorId===id('菲亚梅塔'))?.finalMorale).toBe(24)
  expect(r.operators.find(o=>o.operatorId===id('重岳'))?.finalMorale).toBe(24)
 })

 it('does not replace a full working Fiammetta target with a full Free card',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'阿罗玛'},groupId:null,replacements:[]}]
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'菲亚梅塔'},groupId:null,replacements:['阿罗玛']}]
  const s=compileRosterSchedule(ws,{fiammettaFool:false,idleOperators:[id('重岳')]})
  const r=simulateSchedule(s,{sampleHours:.1,maxEvents:1000,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none'}})
  expect(r.success,JSON.stringify(r.diagnostics.slice(-5))).toBe(true)
  expect(r.diagnostics.some(d=>d.code==='mower-fia-full-noop-skipped')).toBe(true)
  expect(r.events.filter(e=>e.type==='fiammetta'&&e.moraleBefore?.[0]===24&&e.moraleBefore?.[1]===24)).toHaveLength(0)
  expect(r.operators.find(o=>o.operatorId===id('重岳'))?.finalMorale).toBe(24)
  expect(r.operators.find(o=>o.operatorId===id('阿罗玛'))!.finalMorale).toBeLessThan(24)
 })

 it('rechecks a full target when Fiammetta recovers instead of reserving an empty charge',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'菲亚梅塔'},groupId:null,replacements:['重岳']}]
  ws.mainPlan.facilities.dormitory_2.slots=[{occupant:{kind:'operator',operatorId:'重岳'},groupId:null,replacements:[]}]
  const s=compileRosterSchedule(ws,{fiammettaFool:false,operatorMorale:{[id('菲亚梅塔')]:23}})
  const r=simulateSchedule(s,{sampleHours:.6,maxEvents:1000,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none'}})
  expect(r.success,JSON.stringify(r.diagnostics.slice(-5))).toBe(true)
  expect(r.events.filter(e=>e.type==='fiammetta')).toHaveLength(0)
  expect(r.operators.find(o=>o.operatorId===id('菲亚梅塔'))?.finalMorale).toBe(24)
 })

 it('honors explicitly compiled atmosphere before the max-atmosphere default',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.dormitory_1.level=5;ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:[]}]
  const s=compileRosterSchedule(ws,{operatorMorale:{[id('芬')]:10},dormAtmosphere:0})
  const r=simulateSchedule(s,{sampleHours:1})
  expect(r.operators.find(x=>x.operatorId===id('芬'))!.finalMorale).toBe(12)
 })

 it('does not change roster decisions when only the numerical step is refined',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'砾'},groupId:'g',replacements:['芬']},{occupant:{kind:'operator',operatorId:'斑点'},groupId:'g',replacements:['香草']}]
  ws.mainPlan.facilities.dormitory_1.slots=[{occupant:{kind:'operator',operatorId:'菲亚梅塔'},groupId:null,replacements:['砾']},{occupant:{kind:'free'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]}]
  const s=compileRosterSchedule(ws,{operatorMorale:{[id('砾')]:15,[id('斑点')]:0,[id('菲亚梅塔')]:0}})
  const options={sampleHours:4,consumptionOverrides:{[id('砾')]:1,[id('斑点')]:1,[id('芬')]:1,[id('香草')]:1},recoveryOverrides:{[id('砾')]:10,[id('斑点')]:1,[id('芬')]:1,[id('香草')]:1}}
  const a=simulateSchedule(s,{...options,maxStepHours:.25}),b=simulateSchedule(s,{...options,maxStepHours:1})
  expect(a.success).toBe(true);expect(a.events.map(e=>[e.type,e.time])).toEqual(b.events.map(e=>[e.type,e.time]))
  expect(a.operators.find(o=>o.operatorId===id('斑点'))!.workHours).toBeCloseTo(b.operators.find(o=>o.operatorId===id('斑点'))!.workHours,8)
 },20000)

 it('does not select a numerically full resident as the default single-recovery target',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.dormitory_1.level=5
  ws.mainPlan.facilities.dormitory_1.slots=['深靛','砾','斑点'].map(name=>({occupant:{kind:'operator' as const,operatorId:name},groupId:null,replacements:[]}))
  const s=compileRosterSchedule(ws,{operatorMorale:{[id('砾')]:24-1e-11,[id('斑点')]:10}})
  const r=simulateSchedule(s,{sampleHours:1})
  expect(r.operators.find(o=>o.operatorId===id('斑点'))!.finalMorale).toBeCloseTo(14.55,8)
  expect(r.diagnostics.some(d=>d.message.includes('指定单体目标不满足条件'))).toBe(false)
 })
 it('rejects invalid simulation windows and never labels partial output as complete',()=>{
  expect(()=>simulateSchedule(scenario(),{sampleHours:0})).toThrow()
  expect(()=>simulateSchedule(scenario(),{sampleHours:24,maxStepHours:NaN})).toThrow()
  const result=simulateSchedule(scenario(),{sampleHours:100,maxEvents:2})
  expect(result.success).toBe(false)
  expect(result.diagnostics.some(x=>x.code==='SIMULATION_EVENT_LIMIT')).toBe(true)
 })
})


function idleCatalogScenario(bedCount=2) {
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator' as const,operatorId:'砾'},groupId:null,replacements:['斑点']}]
 ws.mainPlan.facilities.dormitory_1.slots=[
  {occupant:{kind:'free' as const},groupId:null,replacements:[]},
  {occupant:{kind:'free' as const},groupId:null,replacements:[]},
 ].slice(0,bedCount)
 return compileRosterSchedule(ws,{operatorMorale:{[id('砾')]:1}})
}

it('uses catalog idle cards when no operator library is imported',()=>{
 const result=simulateSchedule(idleCatalogScenario(),{sampleHours:.05,maxEvents:500,recordSegments:true})
 expect(result.success,JSON.stringify(result.diagnostics.slice(-8))).toBe(true)
 expect(result.segments.some(segment=>Object.values(segment.bedOccupants).some(name=>![id('砾'),id('斑点')].includes(name)))).toBe(true)
})

it('uses an imported idle-only library without rejecting on-duty roster operators absent from it',()=>{
 const idleNames=['芬','杜林','安赛尔','史都华德','芙蓉','夜刀']
 const result=simulateSchedule(idleCatalogScenario(),{sampleHours:.05,maxEvents:500,recordSegments:true,operatorInventory:idleNames.map(operator=>({operator,elitePhase:0,level:1}))})
 expect(result.success,JSON.stringify(result.diagnostics.slice(-8))).toBe(true)
 expect(result.diagnostics.some(entry=>entry.code==='INVENTORY_OPERATOR_NOT_OWNED'||entry.code==='BACKUP_INVENTORY_MISSING')).toBe(false)
 expect(result.segments.some(segment=>Object.values(segment.bedOccupants).includes(id('芬'))),JSON.stringify(result.segments.slice(0,3).map(x=>x.bedOccupants))).toBe(true)
 expect(result.segments.every(segment=>Object.values(segment.bedOccupants).every(name=>[id('砾'),id('斑点'),...idleNames.map(id)].includes(name)))).toBe(true)
})
