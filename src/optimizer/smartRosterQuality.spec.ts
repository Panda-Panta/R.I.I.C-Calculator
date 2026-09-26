import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { runSmartRoster, type SmartRosterOptions } from './smartRoster'
import * as synthesis from './molecularSynthesis'
import * as simulation from './candidateSimulation'
import * as replacement from './globalPerCapitaReplacement'
import * as search from './rosterIncomeSearch'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as income from './incomeComparison'

afterEach(() => vi.restoreAllMocks())
const inventory = [{operator:'砾',elitePhase:1,level:60}]
// The expensive candidate generation/simulation already has integration coverage.
// Here the controlled scores expose lost runners-up and unsafe promotion decisions.
function setup() {
  const candidates = [100, 95, 90].map((score,i) => {
    const workspace = createDefaultWorkspace()
    workspace.name = String(score)
    workspace.mainPlan.facilities.central.slots.length = i + 1
    return {id:`branch-${i}`,name:`branch-${i}`,workspace,diagnostics:[],appliedAtoms:[],confPolicy:{},staticScore:0,simScore:null}
  })
  vi.spyOn(synthesis,'generateMolecularCandidates').mockReturnValue(candidates)
  vi.spyOn(simulation,'simulateCandidate').mockImplementation(job => ({completed:true,simScore:Number(job.workspace.name),diagnostics:[]}))
  vi.spyOn(replacement,'runGlobalPerCapitaReplacement').mockImplementation(workspace => ({workspace,swappedCount:0,logs:[]}))
  const requests: search.IncomeSearchRequest[] = []
  vi.spyOn(search,'runRosterIncomeSearch').mockImplementation(request => {
    requests.push(request)
    return {bestCandidateId:null,bestWorkspace:request.baseline,evaluatedCandidates:request.maxCandidates ?? 1,candidates:[]} as unknown as search.IncomeSearchResult
  })
  return {requests}
}

it('keeps additional exploration opt-in when no budget is requested', () => {
  const {requests} = setup()
  const result = runSmartRoster(createDefaultWorkspace(),inventory)
  expect(requests.map(r=>r.mode)).toEqual(['hill-climb'])
  expect(result.phases.refinements).toBeUndefined()
})

it('spends the added budget across distinct leading rosters while preserving the baseline result', () => {
  const {requests} = setup()
  const result = runSmartRoster(createDefaultWorkspace(),inventory,{searchBudget:12,refinementTopK:3} as SmartRosterOptions)
  const exploratory = requests.filter(r=>r.mode==='multi-start')
  expect(exploratory.map(r=>r.baseline.name)).toEqual(['100','95','90'])
  expect(exploratory.reduce((n,r)=>n+r.maxCandidates!,0)).toBe(12)
  expect(result.score).toBe(100)
})

function cases(value:number): income.IncomeCase[] {
  const amounts = {lmd:0,exp:0,gold:0,fragment:0,orundum:0,drone:0,orirock:0,device:0}
  return [123456,123457].flatMap(seed=>[.25,.125].map(step=>({
    key:`${seed}:${step}`,seed,step,context:'same-inventory-and-layout',eligible:true,issues:[],
    daily:{...amounts,exp:value},opening:{...amounts},closing:{...amounts},assumptions:[],
    output:{mode:'potential' as const,daily:{exp:value,goldValue:0,orderValue:0,weightedExp:value,weightedGold:0,weightedOrders:0,total:value}},
  })))
}

it.each([
  {short:120,holdout:120,want:120},
  {short:120,holdout:99,want:100},
  {short:99,holdout:120,want:100},
])('only promotes the runner-up when both current-window and common holdout scores improve: %j', ({short,holdout,want}) => {
  setup()
  vi.spyOn(bridge,'runScheduleSimulationBridge').mockReturnValue({report:{} as NonNullable<ReturnType<typeof bridge.runScheduleSimulationBridge>['report']>})
  let caseIndex=0
  vi.spyOn(income,'summarizeIncome').mockImplementation(()=>cases(100)[caseIndex++ % 4]!)
  vi.mocked(search.runRosterIncomeSearch).mockImplementation(request=>{
    const winner = request.mode==='multi-start' && request.baseline.name==='95'
    const workspace = structuredClone(request.baseline)
    if (winner) workspace.name=String(short)
    return {
      bestCandidateId:winner?'improved':null,bestWorkspace:workspace,evaluatedCandidates:request.maxCandidates,candidates:[],
      settings:{options:request.options,assumptions:request.assumptions},
      validation:{status:'passed',seeds:[123456,123457],steps:[.25,.125],sampleHours:168,warmupHours:24,
        candidates:[{id:'improved',cases:cases(holdout)}]},
    } as unknown as search.IncomeSearchResult
  })
  const source=createDefaultWorkspace(),before=structuredClone(source)
  const result=runSmartRoster(source,inventory,{searchBudget:12,refinementTopK:3})
  expect(result.score).toBe(want)
  expect(result.workspace?.name).toBe(String(want))
  expect(result.phases.refinements?.filter(r=>r.accepted)).toHaveLength(want===120?1:0)
  expect(source).toEqual(before)
})

it('retains the verified incumbent and continues other starts after a search throws', () => {
  const {requests}=setup()
  const implementation=vi.mocked(search.runRosterIncomeSearch).getMockImplementation()!
  vi.mocked(search.runRosterIncomeSearch).mockImplementation(request=>{
    if(request.mode==='multi-start' && request.baseline.name==='95') throw new Error('controlled simulation failure')
    return implementation(request)
  })
  const result=runSmartRoster(createDefaultWorkspace(),inventory,{searchBudget:12})
  expect(result.score).toBe(100)
  expect(requests.some(r=>r.mode==='multi-start' && r.baseline.name==='90')).toBe(true)
  expect(result.diagnostics.some(d=>d.code==='REFINEMENT_FALLBACK')).toBe(true)
})

it('reports the final same-window gain rather than adding a conservative bound to a point estimate', () => {
  setup()
  vi.spyOn(bridge,'runScheduleSimulationBridge').mockReturnValue({report:{} as NonNullable<ReturnType<typeof bridge.runScheduleSimulationBridge>['report']>})
  let caseIndex=0
  vi.spyOn(income,'summarizeIncome').mockImplementation(()=>cases(110)[caseIndex++ % 4]!)
  vi.mocked(search.runRosterIncomeSearch).mockImplementation(request=>{
    const legacy=request.mode==='hill-climb',winner=legacy || request.baseline.name==='95'
    const workspace=structuredClone(request.baseline)
    if(winner) workspace.name=legacy?'110':'120'
    return {bestCandidateId:winner?'winner':null,bestWorkspace:workspace,evaluatedCandidates:request.maxCandidates,
      candidates:[{id:'winner',comparison:{minGain:2}}],settings:{options:request.options,assumptions:request.assumptions},
      validation:{status:'passed',seeds:[123456,123457],steps:[.25,.125],sampleHours:168,warmupHours:24,candidates:[{id:'winner',cases:cases(120)}]},
    } as unknown as search.IncomeSearchResult
  })
  const result=runSmartRoster(createDefaultWorkspace(),inventory,{searchBudget:12})
  expect(result.score).toBe(120)
  expect(result.phases.search?.gain).toBe(20)
})

it('supports disabling the extra search and does not spend unused slots on duplicate starts', () => {
  const {requests} = setup()
  runSmartRoster(createDefaultWorkspace(),inventory,{searchBudget:0} as SmartRosterOptions)
  expect(requests.filter(r=>r.mode==='multi-start')).toHaveLength(0)
})

it('prioritizes the strongest starts when the budget is smaller than the requested finalist count', () => {
  const {requests}=setup()
  runSmartRoster(createDefaultWorkspace(),inventory,{searchBudget:2,refinementTopK:3})
  expect(requests.filter(r=>r.mode==='multi-start').map(r=>r.baseline.name)).toEqual(['100','95'])
})

it.each([{searchBudget:-1},{searchBudget:201},{searchBudget:1.5},{refinementTopK:0},{refinementTopK:6}])('rejects invalid quality settings %j before generation', options => {
  const generate = vi.spyOn(synthesis,'generateMolecularCandidates')
  const result = runSmartRoster(createDefaultWorkspace(),inventory,options as SmartRosterOptions)
  expect(result.diagnostics.some(d=>d.code==='INVALID_SEARCH_OPTIONS')).toBe(true)
  expect(generate).not.toHaveBeenCalled()
})
