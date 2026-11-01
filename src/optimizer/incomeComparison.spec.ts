import {describe,it,expect,vi} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {summarizeIncome,compareIncome,type IncomeCase} from './incomeComparison'
import { scoreSimulationProduction } from '../simulator/productionScore'
import { simulateCandidate } from './candidateSimulation'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import * as simulation from '../simulator/scheduleSimulation'
import { createLedger } from '../simulator/resourceLedger'
import { createDroneState } from '../simulator/droneTimeline'
const report=()=>runScheduleSimulationBridge(createDefaultWorkspace(),{sampleHours:1,warmupHours:0,production:{seed:1,droneTarget:'none'}},{idleOperators:[]}).report!
const cases=():IncomeCase[]=>[1,2].flatMap(seed=>[.25,.125].map(step=>{const c=summarizeIncome(report());return {...c,seed,step,key:`${seed}:${step}`}}))
const improved=()=>{const c=cases();c.forEach(x=>{x.daily.lmd+=100;x.closing.lmd+=100});return c}

/** A completed-report shape only; this fixture never executes a calendar/H/F. */
function permanentIncomeReport(policy=true,passive=false):ScheduleSimulationReport {
 const workspace=createDefaultWorkspace(),operatorId='char_285_medic2'
 for(const room of Object.values(workspace.mainPlan.facilities)){room.level=0;room.slots=[]}
 const primary=workspace.mainPlan.facilities[passive?'factory':'room_1_3']
 primary.level=3;primary.slots=[{occupant:{kind:'operator',operatorId},groupId:passive?null:'自动化',replacements:[]}]
 workspace.mainPlan.conf.workaholic=policy?[operatorId]:[]
 const schedule=compileRosterSchedule(workspace,{idleOperators:[]})
 return {schemaVersion:1,engine:'mower-morale-v1',success:true,elapsedHours:96,observedHours:72,
  inputs:{schedule,options:{schedulingModel:'mower-alpha',warmupHours:24,sampleHours:72,production:{seed:42,droneTarget:'none',outputMode:'potential'}}},
  assumptions:{schedulingModel:'mower-alpha',warmupHours:24,sampleHours:72,maxStepHours:.25,warmupModel:'continuous',restingThreshold:.65,
   operationDurationHours:0,dormAtmosphere:'fixture',singleRecoveryTarget:'fixture'},
  operators:[{operatorId,operatorName:'Lancet-2',initialMorale:24,finalMorale:0,mainWorkHours:12,substituteWorkHours:0,workHours:12,
   exhaustedHours:46,restHours:0,idleHours:14,permanentPrimaryOccupancyHours:58,workFraction:1/6,workRestRatio:null}],
  rooms:[],events:[],segments:[],diagnostics:[],shiftDeferrals:[],
  production:{success:true,ledger:createLedger({}),sample:{completed:{exp:0,gold:12,orderLmd:1000},opening:{},closing:{},inflows:{},outflows:{},net:{}},
   materialsConsumed:{},drones:createDroneState(0,200),manufacturing:[],trading:[],events:[],
   assumptions:{outputMode:'potential',inventoryMode:'unlimited',seed:42,runOrderMode:'ideal',droneTarget:'none',droneReserve:0,
    collectionIntervalHours:0,orderSnapshotPolicy:'fixture'}},
 }
}
function addWorkaholicRemoval(value:ScheduleSimulationReport):void {
 value.inputs.schedule.sourceWorkspace.compatibility.backupPlans.push({name:'conditional policy removal',trigger:'True',plan:{},conf:{removed_operators:{workaholic:'Lancet-2'}}})
}

describe('measured permanent primary income policy (0 new H/F)',()=>{
 it.each(['idle','rest'] as const)('accepts explicit workaholic primary duty with measured group %s time outside the physical shift',outside=>{
  const value=permanentIncomeReport(),before=structuredClone(value)
  if(outside==='rest'){value.operators[0]!.restHours=14;value.operators[0]!.idleHours=0}
  const calendar=vi.spyOn(simulation,'simulateSchedule').mockImplementation(()=>{throw new Error('No new calendar/H/F')})
  try{
   expect(summarizeIncome(value)).toMatchObject({eligible:true,issues:[]})
   expect(calendar).not.toHaveBeenCalled()
   expect(value.production).toEqual(before.production)
  }finally{calendar.mockRestore()}
 })
 it.each([undefined,57,72])('retains fatigue with revocable policy when the own-primary coverage counter is %s',counter=>{
  const value=permanentIncomeReport();addWorkaholicRemoval(value);value.operators[0]!.permanentPrimaryOccupancyHours=counter
  expect(summarizeIncome(value).issues).toContain('存在疲劳占岗')
 })
 it('does not exempt one unmeasured substitute hour when policy can be revoked',()=>{
  const value=permanentIncomeReport(),op=value.operators[0]!
  addWorkaholicRemoval(value)
  op.workHours++;op.substituteWorkHours++;op.idleHours--
  expect(summarizeIncome(value).issues).toContain('存在疲劳占岗')
 })
 it('keeps explicit policy and a unique primary mandatory, including passive auxiliary slots',()=>{
  expect(summarizeIncome(permanentIncomeReport(false)).issues).toContain('存在疲劳占岗')
  expect(summarizeIncome(permanentIncomeReport(false,true)).issues).toContain('存在疲劳占岗')
  const duplicate=permanentIncomeReport(),room=duplicate.inputs.schedule.rooms[0]!
  room.slots.push({...room.slots[0]!,slotIndex:1})
  expect(summarizeIncome(duplicate).issues).toContain('存在疲劳占岗')
 })
 it('preserves ordinary forced-exhaustion fatigue without inferring workaholic policy',()=>{
  const value=permanentIncomeReport(false),op=value.operators[0]!,slot=value.inputs.schedule.rooms[0]!.slots[0]!
  op.operatorId='char_446_aroma';op.operatorName='阿罗玛';slot.primaryOperatorId=op.operatorId
  value.inputs.schedule.policies.exhaust_require=[op.operatorId];value.inputs.schedule.policies.rest_in_full=[op.operatorId]
  Object.assign(op,{mainWorkHours:61.188349730641754,workHours:61.188349730641754,exhaustedHours:.771792593382446,
   restHours:10.038468780026548,idleHours:.0013888891666666667,permanentPrimaryOccupancyHours:0})
  expect(summarizeIncome(value).issues).toContain('存在疲劳占岗')
 })
 it('preserves every unrelated diagnostic and ledger gate after correcting fatigue classification',()=>{
  const diagnostic=permanentIncomeReport();diagnostic.diagnostics.push({code:'MOWER_MASTERY_PLAN_ASSUMPTION',message:'unchanged scope'})
  expect(summarizeIncome(diagnostic).issues).toEqual(['MOWER_MASTERY_PLAN_ASSUMPTION：unchanged scope'])
  const ledger=permanentIncomeReport();ledger.production!.ledger.entries.push({reason:'forged',delta:{gold:3}})
  expect(summarizeIncome(ledger).eligible).toBe(false)
  expect(summarizeIncome(ledger).issues).not.toContain('存在疲劳占岗')
 })
})
describe('continuous Mower workaholic income policy (0 new H/F)',()=>{
 it.each([22,11])('accepts a %s-second primary transition gap with invariant original name permission',seconds=>{
  const value=permanentIncomeReport();value.operators[0]!.permanentPrimaryOccupancyHours=58-seconds/3600
  value.inputs.schedule.sourceWorkspace.compatibility.backupPlans=[{name:'primary ownership transition',trigger:'True',plan:{room_1_3:{plans:[{agent:'埃癸斯',replacement:[]}]}},conf:{workaholic:'',removed_operators:{}}}]
  const before=structuredClone(value)
  expect(summarizeIncome(value)).toMatchObject({eligible:true,issues:[]})
  expect(value).toEqual(before)
 })
 it.each(['missing-counter','substitute-duty'] as const)('uses the original global permission for %s rather than an own-primary certificate',kind=>{
  const value=permanentIncomeReport(),op=value.operators[0]!
  if(kind==='missing-counter')op.permanentPrimaryOccupancyHours=undefined
  else{op.workHours++;op.substituteWorkHours++;op.idleHours--}
  expect(summarizeIncome(value)).toMatchObject({eligible:true,issues:[]})
 })
 it('keeps a measured physical certificate sufficient when a possible backup can revoke global permission',()=>{
  const value=permanentIncomeReport();addWorkaholicRemoval(value)
  expect(summarizeIncome(value)).toMatchObject({eligible:true,issues:[]})
 })
 it('permits a globally authorized name without an initial primary while retaining duplicate-primary rejection',()=>{
  const value=permanentIncomeReport(),workspace=createDefaultWorkspace()
  for(const room of Object.values(workspace.mainPlan.facilities)){room.level=0;room.slots=[]}
  workspace.mainPlan.conf.workaholic=['char_285_medic2']
  workspace.compatibility.backupPlans=[{name:'later position',trigger:'True',plan:{room_1_3:{plans:[{agent:'Lancet-2',replacement:[]}]}}}]
  value.inputs.schedule=compileRosterSchedule(workspace);value.operators[0]!.permanentPrimaryOccupancyHours=undefined
  expect(summarizeIncome(value)).toMatchObject({eligible:true,issues:[]})
 })
 it('rejects unknown original policy and does not turn global permission into duplicate-position permission',()=>{
  const unknown=permanentIncomeReport();unknown.operators[0]!.permanentPrimaryOccupancyHours=undefined
  Reflect.deleteProperty(unknown.inputs.schedule,'sourceWorkspace')
  expect(summarizeIncome(unknown).issues).toContain('存在疲劳占岗')
  const duplicate=permanentIncomeReport(),room=duplicate.inputs.schedule.rooms[0]!
  room.slots.push({...room.slots[0]!,slotIndex:1});duplicate.operators[0]!.permanentPrimaryOccupancyHours=undefined
  expect(summarizeIncome(duplicate).issues).toContain('存在疲劳占岗')
 })
})
describe('actual net income comparison',()=>{
 it('keeps native condition runtime failures visible without blocking otherwise complete income cases',()=>{
  const workspace=createDefaultWorkspace()
  workspace.compatibility.backupPlans=[
   {name:'runtime failure',trigger:'1 / 0 > 0',plan:{}},
   {name:'valid condition',trigger:'True',plan:{}},
  ]
  const result=simulateCandidate({workspace,incomeComparison:true,
   options:{sampleHours:1,warmupHours:0,production:{droneTarget:'none',seed:7}},assumptions:{idleOperators:[]},
  })
  expect(result.completed,JSON.stringify(result.diagnostics)).toBe(true)
  expect(result.incomeCase?.assumptions.some(d=>d.code==='MOWER_BACKUP_CONDITION_ERROR')).toBe(true)
  expect(result.incomeCase?.issues).toEqual([])
 })
 it('records the clue-only production assumption without changing income eligibility or allowing unknown mechanics',()=>{
  const r=report()
  const clueAssumption=r.diagnostics.find(d=>d.code==='RECEPTION_CLUE_PRODUCTION_MODEL')!
  expect(clueAssumption).toBeDefined()
  const withoutClues=summarizeIncome({...r,diagnostics:r.diagnostics.filter(d=>d!==clueAssumption)})
  const withClues=summarizeIncome(r)
  expect(withClues.eligible,JSON.stringify(withClues.issues)).toBe(true)
  expect(withClues.assumptions).toContainEqual(clueAssumption)
  expect(withClues.daily).toEqual(withoutClues.daily)
  expect(withClues.opening).toEqual(withoutClues.opening)
  expect(withClues.closing).toEqual(withoutClues.closing)
  expect(withClues.output).toEqual(withoutClues.output)
  r.diagnostics.push({code:'UNKNOWN_NEW_MECHANIC',message:'pending'})
  expect(summarizeIncome(r)).toMatchObject({eligible:false,issues:['UNKNOWN_NEW_MECHANIC：pending']})
 })
 it('accepts finite inventory assumptions for net resource comparisons while composite remains potential-only',()=>{
  const workspace=createDefaultWorkspace()
  workspace.compatibility.backupPlans=[{name:'inventory',trigger:"op_data.inventory_count('赤金') > 999999",plan:{}}]
  const finite=[1,2].flatMap(seed=>[.25,.125].map(maxStepHours=>{
   const r=runScheduleSimulationBridge(workspace,{sampleHours:1,maxStepHours,production:{seed,droneTarget:'none',initialResources:{gold:4,lmd:1600}}},{idleOperators:[]}).report!
   expect(r.success,JSON.stringify(r.diagnostics)).toBe(true)
   expect(r.diagnostics.some(d=>d.code==='FINITE_INVENTORY_MODEL')).toBe(true)
   const summary=summarizeIncome(r)
   expect(summary.eligible,JSON.stringify(summary.issues)).toBe(true)
   expect(summary.assumptions.some(d=>d.code==='FINITE_INVENTORY_MODEL')).toBe(true)
   expect(summary.output?.mode).toBe('settled')
   return summary
  }))
  expect(compareIncome(finite,finite,'lmd').status).toBe('unchanged')
  expect(compareIncome(finite,finite,'exp').status).toBe('unchanged')
  expect(compareIncome(finite,finite,'composite')).toMatchObject({status:'ineligible',reasons:['综合评分要求忽略库存约束的完成产出']})
 })
 it('uses the shared completed-production score with the report weights',()=>{
  const r=runScheduleSimulationBridge(createDefaultWorkspace(),{sampleHours:24,warmupHours:0,production:{seed:1,droneTarget:'none'}},{idleOperators:[]}).report!
  r.inputs.options.productionWeights={exp:3,gold:4,orders:5,fragments:6,orundum:7}
  expect(summarizeIncome(r).output!.daily).toEqual(scoreSimulationProduction(r))
 })
 it('uses collected net change, not opening inventory or manufactured counters',()=>{
  const r=report(),c=summarizeIncome(r)
  expect(c.eligible).toBe(true)
  expect(c.daily.lmd).toBe((r.production!.sample.net.lmd??0)*24)
  r.production!.sample.opening.lmd=100000
  expect(summarizeIncome(r).eligible).toBe(false)
 })
 it('requires four matched cases and preserves the baseline when gains reverse',()=>{
  expect(compareIncome(cases(),improved(),'lmd').status).toBe('improved')
  expect(compareIncome(cases(),improved().slice(1),'lmd').status).toBe('ineligible')
  const c=improved();c[0]!.daily.lmd-=200
  expect(compareIncome(cases(),c,'lmd').status).not.toBe('improved')
 })
 it('rejects resource spending hidden in warmup or sample net',()=>{
  const c=improved();c[0]!.closing.gold-=1
  expect(compareIncome(cases(),c,'lmd').status).toBe('rejected')
  const d=improved();d[1]!.daily.gold-=1
  expect(compareIncome(cases(),d,'lmd').status).toBe('rejected')
 })
 it('keeps unverified conditions conditional and small discretization gains unconfirmed',()=>{
  expect(compareIncome(cases(),improved(),'lmd',true).status).toBe('conditional')
  const c=improved();c[0]!.daily.lmd+=200
  expect(compareIncome(cases(),c,'lmd').status).toBe('unchanged')
 })
 it('blocks incomplete production, unknown diagnostics, fatigue and bad ledgers',()=>{
  for(const mutate of [
   (r:ReturnType<typeof report>)=>{r.production!.success=false},
   (r:ReturnType<typeof report>)=>{r.elapsedHours=.5},
   (r:ReturnType<typeof report>)=>{r.diagnostics.push({code:'UNKNOWN_NEW_MECHANIC',message:'pending'})},
   (r:ReturnType<typeof report>)=>{r.production!.ledger.balances.gold=NaN},
   (r:ReturnType<typeof report>)=>{r.production!.ledger.entries.push({reason:'forged',delta:{gold:3}})},
  ]){const r=report();mutate(r);expect(summarizeIncome(r).eligible).toBe(false)}
 })
 it('does not treat a real storage/material production stop as a scheduler failure',()=>{
  const r=report();r.production!.manufacturing[0]!.blockedHours=1
  expect(summarizeIncome(r).eligible).toBe(true)
 })
 it('does not compare different scenarios or duplicate case keys',()=>{
  const c=improved();c[0]!.context+='different'
  expect(compareIncome(cases(),c,'lmd').status).toBe('ineligible')
  const d=improved();d[0]!.key=d[1]!.key
  expect(compareIncome(cases(),d,'lmd').status).toBe('ineligible')
 })
})

it('rejects cross-version or changed dorm atmosphere default assumptions',()=>{
 const r=report(),b=summarizeIncome(r)
 r.inputs.schedule.assumptions.dataVersion+='changed';expect(summarizeIncome(r).context).not.toBe(b.context)
 const d=report(),before=summarizeIncome(d);d.inputs.schedule.assumptions.defaultsApplied.push('dormAtmosphere')
 expect(summarizeIncome(d).context).not.toBe(before.context)
})
it('records the scheduling model and excludes comparisons across models',()=>{
 const r=report(),b=summarizeIncome(r)
 expect(b.eligible).toBe(true)
 expect(b.assumptions.some(d=>d.code==='MOWER_SCHEDULING_MODEL')).toBe(true)
 expect(b.assumptions.some(d=>d.code==='MOWER_CONTINUOUS_MOOD_MODEL')).toBe(true)
 expect(r.inputs.options.schedulingModel).toBe('mower-alpha')
 r.inputs.options.schedulingModel='mower-default'
 expect(summarizeIncome(r).context).not.toBe(b.context)
 const baseline=cases(),candidate=improved()
 candidate[0]!.context=summarizeIncome(r).context
 expect(compareIncome(baseline,candidate,'lmd').status).toBe('ineligible')
})
it('excludes exhausted staffing and scheduler blockage even if production completes',()=>{
 const r=report();r.operators.push({operatorId:'example',operatorName:'example',mainWorkHours:0,substituteWorkHours:0,workHours:0,exhaustedHours:1,restHours:0,idleHours:0,workFraction:0,workRestRatio:null,initialMorale:0,finalMorale:0})
 expect(summarizeIncome(r).issues).toContain('存在疲劳占岗')
 const d=report();d.diagnostics.push({code:'group-blocked',message:'insufficient beds'})
 expect(summarizeIncome(d).eligible).toBe(false)
})

it('accepts ideal reports and rejects persisted natural reports',()=>{
 const ideal=report(),summary=summarizeIncome(ideal)
 expect(summary.eligible).toBe(true)
 expect(summary.assumptions.some(d=>d.code==='IDEAL_RUN_ORDER_ASSUMPTIONS')).toBe(true)
 const natural=report();Object.assign(natural.inputs.options.production!,{runOrderMode:'natural'})
 expect(summarizeIncome(natural).eligible).toBe(false)
 expect(summarizeIncome(natural).issues.join()).toMatch(/自然跑单.*禁用/)
})
