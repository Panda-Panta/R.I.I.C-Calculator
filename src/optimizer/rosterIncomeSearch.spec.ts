import {describe,it,expect,vi} from 'vitest'
import * as incomeComparison from './incomeComparison'
import {OPERATORS} from '../domain/operators'
import {fullCatalogIdleInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {createDefaultWorkspace} from '../workbench/defaults'
import {importMowerJson,resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import fixture from '../workbench/compat/fixtures/mower-252-2gold.json'
import {ordinaryBackupNeighbors,runRosterIncomeSearch,rosterIncomeSearchSteps,type IncomeSearchProgress} from './rosterIncomeSearch'
import {simulateCandidate} from './candidateSimulation'
// The library is the idle-card pool, so controlled Free-bed cases need enough cards.
const idleNames=['艾丽妮','白铁','百炼嘉维尔','仇白','嵯峨','归溟幽灵鲨']
const owned=(names:string[]):OwnedOperatorInput[]=>[...new Set([...names,...idleNames])].map(operator=>{const o=OPERATORS.find(o=>o.name===operator)!;return {operator,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}})
const allOwned=owned(OPERATORS.map(o=>o.name))
function simple(){
 const w=createDefaultWorkspace(),slot=w.mainPlan.facilities.room_1_1.slots[0]!
 slot.occupant={kind:'operator',operatorId:id('砾')};slot.replacements=[id('芬')];slot.groupId='keep-group'
 w.mainPlan.facilities.dormitory_1.slots[0]!.occupant={kind:'free'}
 return w
}
describe('bounded ordinary backup income search',()=>{
 it('filters automatic tuning candidates before simulation while independent income search stays unrestricted',()=>{
  const request={baseline:simple(),inventory:owned(['砾','芬','调香师','雪猎']),maxCandidates:2,options:{sampleHours:1,warmupHours:0,maxStepHours:.5,production:{seed:9,droneTarget:'none' as const}}}
  const run=rosterIncomeSearchSteps(request,undefined,ws=>ws.mainPlan.facilities.room_1_1.slots[0]!.replacements[0]===id('芬'))
  let step=run.next()
  while(!step.done){const batch=step.value;step=run.next(batch.jobs.map((job,index)=>{const result=simulateCandidate(job);batch.onComplete(result,index);return result}))}
  expect(step.value.evaluatedCandidates).toBe(1)
  expect(step.value.baseline.cases).toHaveLength(4)
  expect(step.value.budgetExhausted).toBe(false)
  expect(runRosterIncomeSearch(request).evaluatedCandidates).toBe(2)
 })

 it('changes only one ordinary replacement and preserves main groups and the source',()=>{
  const w=simple(),before=structuredClone(w),result=ordinaryBackupNeighbors(w,owned(['砾','芬','调香师','雪猎']),2)
  expect(result).toHaveLength(2);expect(w).toEqual(before)
  for(const neighbor of result){
   const rebuilt=structuredClone(neighbor.workspace)
   const slot=rebuilt.mainPlan.facilities.room_1_1.slots[0]!
   expect(slot.occupant).toEqual(before.mainPlan.facilities.room_1_1.slots[0]!.occupant)
   expect(slot.groupId).toBe('keep-group');expect(slot.replacements[0]).not.toBe(id('芬'))
   slot.replacements=[id('芬')];expect(rebuilt).toEqual(before)
  }
 })
 it('protects mixed run-order lists, metadata and Fiammetta targets',()=>{
  const w=simple();w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['芬','但书']
  expect(ordinaryBackupNeighbors(w,allOwned,2)).toEqual([])
  w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['芬'];w.mainPlan.facilities.room_1_1.slots[0]!.metadata={custom:true}
  expect(ordinaryBackupNeighbors(w,allOwned,2)).toEqual([])
  delete w.mainPlan.facilities.room_1_1.slots[0]!.metadata
  w.mainPlan.facilities.dormitory_1.slots[1]!.occupant={kind:'operator',operatorId:id('菲亚梅塔')}
  w.mainPlan.facilities.dormitory_1.slots[1]!.replacements=['调香师']
  const neighbors=ordinaryBackupNeighbors(w,owned(['砾','芬','调香师','雪猎','菲亚梅塔']),2)
  expect(neighbors).toHaveLength(1)
  expect(neighbors[0]!.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual([id('雪猎')])
 })
 it('adds candidates only when owned at maximum skill stage and with the room skill',()=>{
  const w=simple();w.mainPlan.facilities.room_1_1.slots[0]!.replacements=[]
  const entries=[...owned(['砾','Lancet-2']),{operator:'调香师',elitePhase:0,level:1}]
  expect(ordinaryBackupNeighbors(w,entries,2)).toEqual([])
  expect(ordinaryBackupNeighbors(w,owned(['砾','调香师']),2)[0]!.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual([id('调香师')])
 })
 it.each([{maxCandidates:0},{maxCandidates:21},{seeds:[1,1]},{seeds:[NaN,2]},{steps:[.25,.25]},{steps:[0,.1]},{options:{sampleHours:Infinity}},{options:{warmupHours:-1}},{options:{maxEvents:1.5}},{options:{production:{seed:NaN}}}])('rejects invalid finite-budget settings before evaluation: %j',extra=>{
  expect(()=>runRosterIncomeSearch({baseline:simple(),inventory:allOwned,...extra} as Parameters<typeof runRosterIncomeSearch>[0])).toThrow()
 })
 it('completes four cases per budgeted candidate, inherits UI seeds/steps and retains the original',()=>{
  const baseline=simple(),before=structuredClone(baseline),progress:IncomeSearchProgress[]=[]
  const result=runRosterIncomeSearch({baseline,inventory:owned(['砾','芬','调香师','雪猎']),maxCandidates:2,options:{sampleHours:1,warmupHours:0,maxStepHours:.5,production:{seed:9,droneTarget:'none'}}},p=>progress.push(p))
  expect(result.evaluatedCandidates).toBe(2);expect(result.budgetExhausted).toBe(true)
  expect(result.settings.seeds).toEqual([9,10]);expect(result.settings.steps).toEqual([.5,.25]);expect(result.settings.assumptions.idleOperators).toEqual([])
  expect(result.baseline.cases).toHaveLength(4);expect(result.candidates[1]!.cases).toHaveLength(4)
  expect(progress.filter(p=>p.completed).map(p=>p.completed!.cases.length)).toEqual([4,4])
  expect(progress[progress.length-1]).toMatchObject({completedCandidates:2,completedScenarios:8,totalScenarios:8})
  expect(result.bestCandidateId).toBeNull();expect(result.bestWorkspace).toEqual(before);expect(baseline).toEqual(before)
  expect(result.request.baseline).toEqual(before)
 },20000)
 it('evaluates the real 252 fixture under four common production scenarios without changing it',()=>{
  const baseline=importMowerJson(JSON.stringify(fixture)),before=structuredClone(baseline)
  const result=runRosterIncomeSearch({baseline,inventory:allOwned,maxCandidates:2,options:{sampleHours:1,warmupHours:0,maxStepHours:.5,production:{droneTarget:'none'}}})
  expect(result.baseline.cases).toHaveLength(4);expect(result.candidates).toHaveLength(2)
  expect(result.candidates[1]!.cases.map(c=>c.key)).toEqual(result.baseline.cases.map(c=>c.key))
  for(const c of [...result.baseline.cases,...result.candidates[1]!.cases])expect(Object.values(c.daily).every(Number.isFinite)).toBe(true)
  expect(baseline).toEqual(before)
 },30000)
 it('preserves existing replacement lists that are referenced by named policies',()=>{
  const w=simple();w.mainPlan.conf.rest_in_full=['芬']
  expect(ordinaryBackupNeighbors(w,allOwned,2)).toEqual([])
 })
 it('does not publish an ineligible incomplete simulation as an improvement',()=>{
  const result=runRosterIncomeSearch({baseline:simple(),inventory:owned(['砾','芬','调香师']),maxCandidates:2,options:{sampleHours:1,warmupHours:0,maxEvents:1}})
  expect(result.baseline.cases.every(c=>!c.eligible)).toBe(true)
  expect(result.candidates[1]!.comparison!.status).toBe('ineligible')
  expect(result.bestCandidateId).toBeNull()
 })
 it('counts the baseline inside a one-plan budget and marks remaining neighbors unevaluated',()=>{
  const result=runRosterIncomeSearch({baseline:simple(),inventory:owned(['砾','芬','调香师']),maxCandidates:1,options:{sampleHours:1,warmupHours:0}})
  expect(result.candidates.map(c=>c.id)).toEqual(['baseline']);expect(result.evaluatedCandidates).toBe(1)
  expect(result.budgetExhausted).toBe(true);expect(result.baseline.cases).toHaveLength(4)
 })
 it('alternates baseline and draft neighborhoods without leaking draft conditional status',()=>{
  const baseline=simple(),draft=structuredClone(baseline)
  draft.mainPlan.facilities.room_1_1.slots[0]!.occupant={kind:'operator',operatorId:id('调香师')}
  const spy=vi.spyOn(incomeComparison,'compareIncome')
  try{
   const r=runRosterIncomeSearch({baseline,draft,conditional:true,inventory:owned(['砾','芬','调香师','雪猎']),maxCandidates:4,options:{sampleHours:1,warmupHours:0,maxStepHours:.01}})
   expect(r.candidates.map(c=>c.label)).toEqual(['原排班','组合草案',expect.not.stringContaining('草案'),expect.stringContaining('草案：')])
   expect(spy.mock.calls.map(args=>args[3])).toEqual([true,false,true,true])
   expect(new Set(r.candidates.map(c=>JSON.stringify(c.workspace.mainPlan))).size).toBe(4)
   expect(r.settings.steps).toEqual([.01,.005])
  }finally{spy.mockRestore()}
 },20000)
 it('preserves workaholic primary slots and main slots named as Fiammetta targets',()=>{
  const w=simple();w.mainPlan.conf.workaholic=['砾']
  expect(ordinaryBackupNeighbors(w,allOwned,2)).toEqual([])
  w.mainPlan.conf.workaholic=[]
  w.mainPlan.facilities.dormitory_1.slots[1]!.occupant={kind:'operator',operatorId:id('菲亚梅塔')}
  w.mainPlan.facilities.dormitory_1.slots[1]!.replacements=['砾']
  expect(ordinaryBackupNeighbors(w,allOwned,2)).toEqual([])
 })
 it('selects an actual EXP improvement over a full week of morale shifts without spending other resources',()=>{
  const baseline=createDefaultWorkspace()
  for(const f of Object.values(baseline.mainPlan.facilities)){if(f.type==='manufacture')f.product='gold'}
  const room=baseline.mainPlan.facilities.room_1_1
  room.product='exp';room.slots[0]!.occupant={kind:'operator',operatorId:id('断罪者')};room.slots[0]!.replacements=[id('砾')];room.slots[0]!.groupId='exp-main'
  baseline.mainPlan.facilities.dormitory_1.slots[0]!.occupant={kind:'free'}
  const before=structuredClone(baseline)
  const r=runRosterIncomeSearch({baseline,inventory:owned(['断罪者','砾','Castle-3']),objective:'exp',maxCandidates:2,
   options:{sampleHours:168,warmupHours:24,maxStepHours:.25,production:{seed:42,runOrderMode:'ideal',droneTarget:'none'}},
   assumptions:{idleOperators:[],restingThreshold:.65,operationDurationHours:0}})
  expect(r.bestCandidateId).toBe('candidate-1');expect(r.candidates[1]!.comparison!.status).toBe('improved')
  for(const base of r.baseline.cases){
   const candidate=r.candidates[1]!.cases.find(c=>c.key===base.key)!
   expect(base.eligible).toBe(true);expect(candidate.eligible).toBe(true)
   expect(candidate.daily.exp).toBeGreaterThan(base.daily.exp)
   for(const resource of incomeComparison.INCOME_RESOURCES){
    expect(candidate.closing[resource]).toBeGreaterThanOrEqual(base.closing[resource]-1e-5)
    if(resource!=='exp')expect(candidate.daily[resource]).toBeGreaterThanOrEqual(base.daily[resource]-1e-5)
   }
  }
  expect(r.bestWorkspace.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual([id('Castle-3')])
  expect(baseline).toEqual(before);expect(r.baseline.workspace).toEqual(before)
 },90000)
 it('rejects layout changes and unavailable explicit idle operators',()=>{
  const baseline=simple(),draft=structuredClone(baseline);draft.mainPlan.facilities.room_1_1.product='exp'
  expect(()=>runRosterIncomeSearch({baseline,draft,inventory:allOwned})).toThrow('设施顺序')
  expect(()=>runRosterIncomeSearch({baseline,inventory:owned(['砾','芬']),assumptions:{idleOperators:['调香师']}})).toThrow('闲置干员')
 })
})
it('does not spend a candidate budget on a renamed copy of the same effective plan',()=>{
 const baseline=createDefaultWorkspace(),draft=structuredClone(baseline);draft.name='renamed';draft.mainPlan.name='renamed plan'
 const result=runRosterIncomeSearch({baseline,draft,inventory:fullCatalogIdleInventory(),maxCandidates:2,options:{sampleHours:1,warmupHours:0}})
 expect(result.candidates).toHaveLength(1);expect(result.evaluatedCandidates).toBe(1);expect(result.budgetExhausted).toBe(false)
})
