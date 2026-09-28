import {it,expect,vi,afterEach} from 'vitest'
import {OPERATORS} from '../domain/operators'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {runRosterIncomeSearch} from './rosterIncomeSearch'
import * as control from './controlNeighborhood'
import * as backup from './backupNeighborhood'
import * as primaryBackup from './primaryBackupNeighborhood'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as comparison from './incomeComparison'
// Free selections require a declared owned idle pool, including during holdout runs.
const idleNames=['芬','安赛尔','夜刀','黑角','巡林者','正义骑士号']
const owned=(names:string[])=>[...new Set([...names,...idleNames])].map(operator=>{const o=OPERATORS.find(o=>o.name===operator)!;return {operator,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}})
function workspace(){const w=createDefaultWorkspace();for(const f of Object.values(w.mainPlan.facilities)){if(f.type==='manufacture')f.product='gold'};w.mainPlan.facilities.central.slots=[{occupant:{kind:'operator',operatorId:id('杜宾')},groupId:null,replacements:[id('阿米娅')]}];w.mainPlan.facilities.dormitory_1.slots[0]!.occupant={kind:'free'};return w}
const request=()=>({baseline:workspace(),inventory:owned(['杜宾','阿米娅','凯尔希']),mode:'multi-start' as const,restarts:2,maxDepth:2,searchSeed:42,includeControlMains:true,includeProductionMains:true,objective:'composite' as const,maxCandidates:3,assumptions:{idleOperators:idleNames.map(id)},options:{sampleHours:2,warmupHours:0,production:{seed:7,droneTarget:'none' as const}}})
afterEach(()=>vi.restoreAllMocks())
it('validates independent random search parameters before simulating',()=>{
 for(const change of [{searchSeed:-1},{searchSeed:1.5},{restarts:0},{restarts:21},{maxCandidates:201},{includeControlMains:'yes'}])expect(()=>runRosterIncomeSearch({...request(),...change} as Parameters<typeof runRosterIncomeSearch>[0])).toThrow()
 expect(()=>runRosterIncomeSearch({...request(),mode:'hill-climb',maxCandidates:21})).toThrow()
})
it('finds and independently revalidates a real control improvement without altering the layout or source',()=>{
 vi.spyOn(backup,'generateBackupNeighbors').mockReturnValue([])
 // A 2% factory bonus needs enough completed-item observations to beat the
 // step/seed envelope; a single day can legitimately have zero minimum gain.
 const input=request();input.options.sampleHours=72;const before=structuredClone(input)
 const result=runRosterIncomeSearch(input)
 expect(result.candidates.some(c=>c.move?.kind==='control-main')).toBe(true)
 expect(result.validation?.status).toBe('passed');expect(result.bestCandidateId).not.toBeNull()
 expect(result.validation!.sampleHours).toBe(168);expect(result.validation!.warmupHours).toBe(24)
 expect(result.validation!.seeds.every(s=>!result.settings.seeds.includes(s))).toBe(true)
 expect(result.validation!.steps[0]).toBeLessThanOrEqual(.25)
 expect(result.validation!.candidates.find(c=>c.id===result.bestCandidateId)!.comparison.minGain).toBeGreaterThan(0)
 expect(input).toEqual(before)
 // The winning control operator is determined by complete scheduling and holdout gain.
 const winner=result.bestWorkspace.mainPlan.facilities.central.slots[0]!.occupant
 expect(winner.kind).toBe('operator')
 expect(winner.kind==='operator'&&[id('阿米娅'),id('凯尔希')].includes(winner.operatorId)).toBe(true)
},60000)
it('does not promote a one-day gain when completed-item granularity leaves a zero lower bound',()=>{
 vi.spyOn(backup,'generateBackupNeighbors').mockReturnValue([])
 const input=request();input.options.sampleHours=24
 const result=runRosterIncomeSearch(input)
 expect(result.validation?.status).toBe('no-improvement')
 expect(result.bestCandidateId).toBeNull()
 expect(result.bestWorkspace).toEqual(input.baseline)
 expect(result.candidates.some(c=>c.comparison?.status==='unchanged' && c.comparison.minGain<=0)).toBe(true)
},60000)
it('uses a shared distinct-plan budget and reproduces search candidates with a fixed seed',()=>{
 const input={...request(),inventory:owned(['杜宾','阿米娅','凯尔希','Mon3tr','诗怀雅','调香师','砾']),maxCandidates:5}
 // Keep this traversal test cheap; the real integration above covers production and holdout.
 vi.spyOn(comparison,'compareIncome').mockReturnValue({status:'unchanged',minGain:0,maxGain:0,reasons:[]})
 const a=runRosterIncomeSearch(input),b=runRosterIncomeSearch(input),c=runRosterIncomeSearch({...input,searchSeed:43})
 expect(a.candidates.map(e=>e.workspace)).not.toEqual(c.candidates.map(e=>e.workspace))
 expect(a.candidates.map(c=>c.workspace)).toEqual(b.candidates.map(c=>c.workspace))
 expect(new Set(a.candidates.map(c=>JSON.stringify(c.workspace.mainPlan))).size).toBe(a.candidates.length)
 expect(a.simulatedCandidates).toBe(a.candidates.length);expect(a.evaluatedCandidates).toBeLessThanOrEqual(5)
 expect(a.candidates.flatMap(c=>c.cases.map(x=>x.seed))).toEqual(b.candidates.flatMap(c=>c.cases.map(x=>x.seed)))
 expect(a.bestWorkspace).toEqual(input.baseline)
})
it('does not protect the entire supplied inventory as external support, but does preserve an explicitly referenced operator',()=>{
 vi.spyOn(backup,'generateBackupNeighbors').mockReturnValue([])
 const input=request();input.options={...input.options,sampleHours:1}
 vi.spyOn(comparison,'compareIncome').mockReturnValue({status:'unchanged',minGain:0,maxGain:0,reasons:[]})
 expect(runRosterIncomeSearch(input).candidates.length).toBeGreaterThan(1)
 expect(runRosterIncomeSearch({...input,options:{...input.options,consumptionOverrides:{[id('杜宾')]:0}}}).candidates.length).toBe(1)
})
it('keeps the baseline when new-seed validation rejects the exploratory winner',()=>{
 vi.spyOn(backup,'generateBackupNeighbors').mockReturnValue([])
 const original=comparison.compareIncome
 vi.spyOn(comparison,'compareIncome').mockImplementation((a,b,o,c)=>a[0]!.seed===7?{status:'improved',minGain:10,maxGain:10,reasons:[]}:({...original(a,b,o,c),status:'unchanged',minGain:0,maxGain:0}))
 const result=runRosterIncomeSearch({...request(),maxCandidates:2})
 expect(result.validation?.status).toBe('failed');expect(result.bestCandidateId).toBeNull();expect(result.bestWorkspace).toEqual(result.baseline.workspace)
},30000)
it('does not simulate empty extra restart copies when the budget is exhausted',()=>{
 const spy=vi.spyOn(bridge,'runScheduleSimulationBridge')
 const result=runRosterIncomeSearch({...request(),maxCandidates:1,restarts:20})
 expect(result.candidates).toHaveLength(1);expect(spy).toHaveBeenCalledTimes(4);expect(result.bestCandidateId).toBeNull()
})

it('continues a restart after a losing intermediate state',()=>{
 vi.spyOn(primaryBackup,'generatePrimaryBackupNeighbors').mockReturnValue([])
 vi.spyOn(backup,'generateBackupNeighbors').mockReturnValue([])
 vi.spyOn(control,'generateControlMainNeighbors').mockImplementation(w=>{
  const slot=w.mainPlan.facilities.central.slots[0]!,current=slot.occupant.kind==='operator'?slot.occupant.operatorId:''
  const next=current===id('杜宾')?'凯尔希':current===id('凯尔希')?'Mon3tr':null
  if(!next)return []
  const copy=structuredClone(w);copy.mainPlan.facilities.central.slots[0]!.occupant={kind:'operator',operatorId:id(next)}
  return [{label:next,workspace:copy,move:{kind:'control-main',positions:['central_0']}}]
 })
 vi.spyOn(comparison,'compareIncome').mockReturnValue({status:'rejected',minGain:-100,maxGain:-100,reasons:['controlled losing intermediate']})
 const r=runRosterIncomeSearch({...request(),inventory:owned(['杜宾','阿米娅','凯尔希','Mon3tr']),restarts:1,maxDepth:2,maxCandidates:3})
 expect(r.candidates.map(c=>c.depth)).toEqual([0,1,2]);expect(r.candidates[2]!.parentId).toBe(r.candidates[1]!.id)
 expect(r.bestCandidateId).toBeNull()
})
it('accepts a starting roster whose on-duty operators are absent from the idle-only library',()=>{
 const spy=vi.spyOn(bridge,'runScheduleSimulationBridge')
 const input=request();input.options.sampleHours=1;input.options.warmupHours=0
 const result=runRosterIncomeSearch({...input,inventory:owned(['凯尔希']),maxCandidates:1})
 expect(result.baseline.cases).toHaveLength(4)
 expect(spy).toHaveBeenCalledTimes(4)
})
