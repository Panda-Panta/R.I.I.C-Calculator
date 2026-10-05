import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {summarizeIncome,compareIncome,type IncomeCase} from './incomeComparison'
import {scoreSimulationProduction} from './productionObjective'
const report=()=>runScheduleSimulationBridge(createDefaultWorkspace(),{sampleHours:1,warmupHours:0,production:{seed:1,droneTarget:'none'}},{idleOperators:[]}).report!
const cases=():IncomeCase[]=>[1,2].flatMap(seed=>[.25,.125].map(step=>{const c=summarizeIncome(report());return {...c,seed,step,key:`${seed}:${step}`}}))
const improved=()=>{const c=cases();c.forEach(x=>{x.daily.lmd+=100;x.closing.lmd+=100});return c}
describe('actual net income comparison',()=>{
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
 expect(r.inputs.options.schedulingModel).toBe('mower-default')
 r.inputs.options.schedulingModel='mower-alpha'
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
