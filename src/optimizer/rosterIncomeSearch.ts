import {assertRunOrderMode} from '../simulator/productionTimeline'
import {runMultiStartSearch,type MultiStartValidation} from './multiStartSearch'
import {generateControlMainNeighbors,type ControlMainNeighbor} from './controlNeighborhood'
import {generateProductionMainNeighbors,type ProductionMainNeighbor} from './primaryNeighborhood'
import {generatePrimaryBackupNeighbors,type PrimaryBackupNeighbor} from './primaryBackupNeighborhood'
import type {IncomeObjective} from './productionObjective'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import type {SimulationAssumptions} from '../scheduler/types'
import type {ScheduleSimulationOptions} from '../simulator/scheduleSimulation'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import type {RosterWorkspace} from '../workbench/model'
import {simulateCandidate,type CandidateSimulationBatch,type CandidateSimulationResult,type CandidateBatchExecutor} from './candidateSimulation'
import {validatePhysicalRoster} from './rosterDraft'
import {generateBackupNeighbors,type BackupNeighbor} from './backupNeighborhood'
import {compareIncome,type IncomeCase,type IncomeComparison} from './incomeComparison'

export type IncomeSearchMode='single-pass'|'hill-climb'|'multi-start'
export type IncomeSearchMove=BackupNeighbor['move']|ControlMainNeighbor['move']|ProductionMainNeighbor['move']|PrimaryBackupNeighbor['move']
type SearchNeighbor={workspace:RosterWorkspace;label:string;move:IncomeSearchMove}
export interface IncomeSearchRequest {
 baseline:RosterWorkspace;draft?:RosterWorkspace;inventory:OwnedOperatorInput[]
 options?:ScheduleSimulationOptions;assumptions?:Partial<SimulationAssumptions>
 mode?:IncomeSearchMode;maxDepth?:number;searchSeed?:number;restarts?:number;includeControlMains?:boolean;includeProductionMains?:boolean
 lockedPositions?:string[]
 objective?:IncomeObjective;maxCandidates?:number;seeds?:[number,number];steps?:[number,number];conditional?:boolean
}
export interface IncomeSearchEvaluation {
 id:string;label:string;workspace:RosterWorkspace;cases:IncomeCase[];comparison:IncomeComparison|null
 cached:boolean;parentId:string|null;parentComparison:IncomeComparison|null;depth:number;origin:'baseline'|'draft';conditional:boolean;move:IncomeSearchMove|null;restart?:number
}
export interface IncomeSearchProgress {completedCandidates:number;totalCandidates:number;completedScenarios:number;totalScenarios:number;label:string;completed?:IncomeSearchEvaluation;bestCandidateId?:string|null}
export interface IncomeSearchSettings {
 options:ScheduleSimulationOptions;assumptions:Partial<SimulationAssumptions>
 seeds:[number,number];steps:[number,number];objective:IncomeObjective;maxCandidates:number;mode:IncomeSearchMode;maxDepth:number
 searchSeed:number;restarts:number;includeControlMains:boolean;includeProductionMains:boolean
 lockedPositions?:string[]
}
export interface IncomeSearchResult {
 validation?:MultiStartValidation
 baseline:IncomeSearchEvaluation;candidates:IncomeSearchEvaluation[];bestCandidateId:string|null;bestWorkspace:RosterWorkspace
 evaluatedCandidates:number;simulatedCandidates:number;budgetExhausted:boolean;issues:string[];settings:IncomeSearchSettings;request:IncomeSearchRequest
 bestPath:string[];exploredDepth:number;depthLimitReached:boolean;stopReason:'budget'|'depth-limit'|'neighborhood-exhausted'
}

function normalize(request:IncomeSearchRequest):IncomeSearchSettings {
 assertRunOrderMode(request.options?.production?.runOrderMode)
 const mode=request.mode??'single-pass',maxDepth=request.maxDepth??3
 if(!['single-pass','hill-climb','multi-start'].includes(mode)||!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>8)throw new Error('搜索模式无效或深度不在 1–8 整数范围')
 const seed=request.options?.production?.seed??1,step=request.options?.maxStepHours??.25
 const maxCandidates=request.maxCandidates??4,seeds=request.seeds??[seed,(seed+1)>>>0],steps=request.steps??[step,step/2],objective=request.objective??'lmd'
 const budgetLimit=mode==='multi-start'?200:20
 if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>budgetLimit)throw new Error(`候选预算须为 1–${budgetLimit} 的整数`)
 const searchSeed=request.searchSeed??42,restarts=request.restarts??4,includeControlMains=request.includeControlMains??false,includeProductionMains=request.includeProductionMains??false
 if(!Number.isSafeInteger(searchSeed)||searchSeed<0||searchSeed>0xffffffff||!Number.isSafeInteger(restarts)||restarts<1||restarts>20)throw new Error('搜索种子须为uint32，起点数须为1–20的整数')
 if(typeof includeControlMains!=='boolean'||typeof includeProductionMains!=='boolean')throw new Error('主班搜索开关须为布尔值')
 if(!['lmd','exp','composite'].includes(objective))throw new Error('不支持的收益目标')
 if(!Array.isArray(seeds)||seeds.length!==2||new Set(seeds).size!==2||seeds.some(n=>!Number.isSafeInteger(n)||n<0||n>0xffffffff))throw new Error('须提供两个不同的 uint32 种子')
 if(!Array.isArray(steps)||steps.length!==2||new Set(steps).size!==2||steps.some(n=>!Number.isFinite(n)||n<.001||n>1))throw new Error('须提供两个不同的 0.001–1 小时步长')
 const inventory=compileOperatorInventory(request.inventory)
 if(!inventory.valid)throw new Error(inventory.diagnostics.map(d=>d.message).join('；'))
 const options:ScheduleSimulationOptions={sampleHours:48,warmupHours:24,maxEvents:200000,...structuredClone(request.options),operatorInventory:structuredClone(request.inventory),recordSegments:false}
 // Every case uses the same explicit extra idle roster; registered backups remain part of its schedule.
 const assumptions:Partial<SimulationAssumptions>={...structuredClone(request.assumptions)}
 assumptions.idleOperators=assumptions.idleOperators===undefined?[]:[...assumptions.idleOperators].map(resolveId)
 const owned=new Set(inventory.operators.map(o=>o.charId))
 if(assumptions.idleOperators.some(id=>!owned.has(id)))throw new Error('闲置干员须在导入的干员库中')
 assumptions.idleOperators=[...new Set(assumptions.idleOperators)]
 for(const [key,min,max] of [['sampleHours',1,2160],['warmupHours',0,2160],['maxEvents',1,200000]] as const){const n=options[key]!;if(!Number.isFinite(n)||n<min||n>max||(key==='maxEvents'&&!Number.isSafeInteger(n)))throw new Error(`无效的比较设置 ${key}`)}
 options.production={runOrderMode:'ideal',...options.production}
 if(objective==='composite'){options.production={...options.production,outputMode:'potential',collectionIntervalHours:0,initialResources:{drone:options.production.initialResources?.drone??0}};assumptions.initialGold=0;assumptions.initialFragments=0}
 // Validate every supplied numeric setting before any expensive simulation.
 const finite=(value:unknown):void=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('比较设置必须包含有限数值');if(value&&typeof value==='object')Object.values(value).forEach(finite)}
 finite(options);finite(assumptions)
 const lockedPositions=request.lockedPositions??[]
 if(!Array.isArray(lockedPositions)||lockedPositions.some(key=>typeof key!=='string'))throw new Error('锁定工位列表无效')
 return {options,assumptions,seeds:[...seeds],steps:[...steps],objective,maxCandidates,mode,maxDepth,searchSeed,restarts,includeControlMains,includeProductionMains,lockedPositions:[...lockedPositions]}
}

/** Compatibility entry point: replacement-only neighborhood used by existing callers. */
export function ordinaryBackupNeighbors(workspace:RosterWorkspace,entries:OwnedOperatorInput[],limit=20):BackupNeighbor[]{
 return generateBackupNeighbors(workspace,entries,limit,{reorder:false,exchange:false})
}
function fingerprint(ws:RosterWorkspace):string {
 const facilities=Object.values(ws.mainPlan.facilities).map(room=>({...room,slots:room.slots.map(slot=>({...slot,
  occupant:slot.occupant.kind==='operator'?{kind:'operator',operatorId:resolveId(slot.occupant.operatorId)}:slot.occupant,
  replacements:slot.replacements.map(resolveId),
 }))}))
 return JSON.stringify({facilities,conf:ws.mainPlan.conf,backupPlans:ws.compatibility.backupPlans})
}
interface Frontier {parent:IncomeSearchEvaluation;neighbors:SearchNeighbor[];index:number}

/** Whole-candidate budget; every accepted step must improve both the original and its parent. */
export function runRosterIncomeSearch(request:IncomeSearchRequest,onProgress?:(progress:IncomeSearchProgress)=>void):IncomeSearchResult {
 const run=rosterIncomeSearchSteps(request,onProgress)
 let step=run.next()
 while(!step.done){
  const batch=step.value
  const results=batch.jobs.map((job,index)=>{const result=simulateCandidate(job);batch.onComplete(result,index);return result})
  step=run.next(results)
 }
 return step.value
}

/** Only independent scenarios run concurrently; frontier admission stays in serial order. */
export async function runRosterIncomeSearchParallel(request:IncomeSearchRequest,execute:CandidateBatchExecutor,onProgress?:(progress:IncomeSearchProgress)=>void):Promise<IncomeSearchResult> {
 const run=rosterIncomeSearchSteps(request,onProgress)
 let step=run.next()
 while(!step.done){
  const batch=step.value,results=await execute(batch.jobs,batch.onComplete)
  if(results.length!==batch.jobs.length)throw new Error('邻域场景返回数量不完整')
  step=run.next(results)
 }
 return step.value
}

export function* rosterIncomeSearchSteps(request:IncomeSearchRequest,onProgress?:(progress:IncomeSearchProgress)=>void):Generator<CandidateSimulationBatch,IncomeSearchResult,CandidateSimulationResult[]> {
 const settings=normalize(request)
 if(settings.mode==='multi-start')return runMultiStartSearch(request,settings,onProgress)
 const baseline=structuredClone(request.baseline),baseErrors=validatePhysicalRoster(baseline)
 if(baseErrors.length)throw new Error(baseErrors.map(d=>d.message).join('；'))
 const initial:IncomeSearchEvaluation={id:'baseline',label:'原排班',workspace:baseline,cases:[],comparison:null,cached:false,parentId:null,parentComparison:null,depth:0,origin:'baseline',conditional:false,move:null}
 const result:IncomeSearchResult={baseline:initial,candidates:[],bestCandidateId:null,bestWorkspace:structuredClone(baseline),evaluatedCandidates:0,simulatedCandidates:0,budgetExhausted:false,issues:[],settings,request:structuredClone(request),bestPath:['baseline'],exploredDepth:0,depthLimitReached:false,stopReason:'neighborhood-exhausted'}
 const source=request.draft?structuredClone(request.draft):baseline
 const draftErrors=validatePhysicalRoster(source)
 if(draftErrors.length)throw new Error(draftErrors.map(d=>d.message).join('；'))
 const sameLayout=(ws:RosterWorkspace)=>Object.values(ws.mainPlan.facilities).map(r=>[r.roomId,r.type,r.level,r.product])
 if(JSON.stringify(sameLayout(source))!==JSON.stringify(sameLayout(baseline)))throw new Error('收益比较须保持设施顺序、类型、等级与配方一致')
 const cache=new Map<string,IncomeCase[]>(),comparedEdges=new Set<string>(),frontiers:Frontier[]=[],depthBoundaries:IncomeSearchEvaluation[]=[]
 const accepted=(e:IncomeSearchEvaluation)=>e.comparison?.status==='improved'&&e.parentComparison?.status==='improved'
 const canTry=(parent:IncomeSearchEvaluation,neighbor:SearchNeighbor)=>{
  const key=fingerprint(neighbor.workspace)
  if(comparedEdges.has(parent.id+':'+parent.origin+':'+parent.conditional+':'+key))return false
  let ancestor:IncomeSearchEvaluation|undefined=parent
  while(ancestor){if(fingerprint(ancestor.workspace)===key)return false;ancestor=result.candidates.find(c=>c.id===ancestor!.parentId)}
  return !result.candidates.some(c=>c.origin===parent.origin&&c.conditional===parent.conditional&&accepted(c)&&c.depth<=parent.depth+1&&fingerprint(c.workspace)===key)
 }
 const scenarios=settings.seeds.flatMap(seed=>settings.steps.map(step=>({seed,step})))
 let completedScenarios=0
 const notify=(label:string,completed?:IncomeSearchEvaluation)=>onProgress?.({completedCandidates:result.evaluatedCandidates,totalCandidates:settings.maxCandidates,completedScenarios,totalScenarios:settings.maxCandidates*4,label,completed:completed?structuredClone(completed):undefined,bestCandidateId:result.bestCandidateId})
 const evaluate=function*(evaluation:IncomeSearchEvaluation,parent?:IncomeSearchEvaluation):Generator<CandidateSimulationBatch,boolean,CandidateSimulationResult[]>{
  const key=fingerprint(evaluation.workspace)
  if(parent)comparedEdges.add(parent.id+':'+evaluation.origin+':'+evaluation.conditional+':'+key)
  const cached=cache.get(key)
  if(cached){evaluation.cases=structuredClone(cached);evaluation.cached=true}
  else{
  notify(evaluation.label)
  const jobs=scenarios.map(({seed,step})=>({workspace:evaluation.workspace,incomeComparison:true,
   options:{...structuredClone(settings.options),maxStepHours:step,production:{...structuredClone(settings.options.production),seed}},assumptions:structuredClone(settings.assumptions)}))
  const results=yield {jobs,onComplete:()=>{completedScenarios++;notify(evaluation.label)}}
  if(results.length!==scenarios.length)throw new Error('邻域场景返回数量不完整')
  for(const [index,summary] of results.entries()){
   const scenario=scenarios[index]!,incomeCase=summary.incomeCase
   if(!incomeCase||incomeCase.seed!==scenario.seed||incomeCase.step!==scenario.step)throw new Error(`${evaluation.label}：邻域场景证据缺失或顺序错误`)
   evaluation.cases.push(incomeCase)
  }
  cache.set(key,structuredClone(evaluation.cases));result.simulatedCandidates++
  }
  if(parent){
   evaluation.comparison=compareIncome(initial.cases,evaluation.cases,settings.objective,evaluation.conditional)
   evaluation.parentComparison=parent.id==='baseline'?evaluation.comparison:compareIncome(parent.cases,evaluation.cases,settings.objective,evaluation.conditional)
  }
  result.candidates.push(evaluation);result.evaluatedCandidates++;result.exploredDepth=Math.max(result.exploredDepth,evaluation.depth)
  const isAccepted=accepted(evaluation)
  if(isAccepted){
   const incumbent=result.candidates.find(c=>c.id===result.bestCandidateId)
   if(!incumbent||evaluation.comparison!.minGain>incumbent.comparison!.minGain){
    result.bestCandidateId=evaluation.id;result.bestWorkspace=structuredClone(evaluation.workspace)
    const path:string[]=[];let node:IncomeSearchEvaluation|undefined=evaluation
    while(node){path.unshift(node.id);node=result.candidates.find(c=>c.id===node!.parentId)}
    result.bestPath=path
   }
  }
  notify(evaluation.label,evaluation)
  return isAccepted
 }
 const protectedIds=new Set<string>()
 const protect=(value:unknown):void=>{if(typeof value==='string')protectedIds.add(resolveId(value));else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){protectedIds.add(resolveId(key));protect(child)}}
 protect(settings.assumptions)
 const contextOptions=structuredClone(settings.options);delete contextOptions.operatorInventory;protect(contextOptions)
 const neighbors=(parent:IncomeSearchEvaluation):SearchNeighbor[]=>{
  const limit=settings.maxCandidates+1
  const streams:SearchNeighbor[][]=[generateBackupNeighbors(parent.workspace,request.inventory,limit,{protectedIds:[...protectedIds],lockedPositions:settings.lockedPositions})]
  if(settings.includeProductionMains||settings.includeControlMains)streams.unshift(generatePrimaryBackupNeighbors(parent.workspace,request.inventory,limit,{protectedIds:[...protectedIds],includeControl:settings.includeControlMains,includeProduction:settings.includeProductionMains,lockedPositions:settings.lockedPositions}))
  if(settings.includeControlMains)streams.push(generateControlMainNeighbors(parent.workspace,request.inventory,limit,[...protectedIds],settings.lockedPositions))
  if(settings.includeProductionMains)streams.push(generateProductionMainNeighbors(parent.workspace,request.inventory,limit,[...protectedIds],settings.lockedPositions))
  const locked=new Set((settings.lockedPositions??[]).map(key=>key.replace(/:(\d+)$/,'_$1')))
  const available:SearchNeighbor[]=[]
  for(let index=0;streams.some(stream=>index<stream.length);index++)for(const stream of streams){
   const neighbor=stream[index]
   if(neighbor&&!neighbor.move.positions.some(key=>locked.has(key)))available.push(neighbor)
  }
  return available
 }
 const addFrontier=(parent:IncomeSearchEvaluation,priority=false)=>{
  const available=neighbors(parent)
  const frontier={parent,neighbors:available,index:0}
  if(priority)frontiers.unshift(frontier);else frontiers.push(frontier)
 }
 const takeNext=():{parent:IncomeSearchEvaluation;neighbor:SearchNeighbor}|undefined=>{
  while(frontiers.length){
   const frontier=frontiers.shift()!
   while(frontier.index<frontier.neighbors.length){
    const neighbor=frontier.neighbors[frontier.index++]!
    if(!canTry(frontier.parent,neighbor))continue
    if(frontier.index<frontier.neighbors.length)frontiers.push(frontier)
    return {parent:frontier.parent,neighbor}
   }
  }
  return undefined
 }
 yield* evaluate(initial);addFrontier(initial)
 const draftDifferent=fingerprint(source)!==fingerprint(baseline)
 if(draftDifferent&&result.evaluatedCandidates<settings.maxCandidates){
  const draft:IncomeSearchEvaluation={id:`candidate-${result.evaluatedCandidates}`,label:'组合草案',workspace:source,cases:[],comparison:null,cached:false,parentId:'baseline',parentComparison:null,depth:0,origin:'draft',conditional:request.conditional??false,move:null}
  yield* evaluate(draft,initial);addFrontier(draft)
 }
 while(result.evaluatedCandidates<settings.maxCandidates){
  const next=takeNext();if(!next)break
  const {parent,neighbor}=next
  const evaluation:IncomeSearchEvaluation={id:`candidate-${result.evaluatedCandidates}`,label:(parent.origin==='draft'?'草案：':'')+neighbor.label,workspace:neighbor.workspace,cases:[],comparison:null,cached:false,parentId:parent.id,parentComparison:null,depth:parent.depth+1,origin:parent.origin,conditional:parent.conditional,move:neighbor.move}
  const accepted=yield* evaluate(evaluation,parent)
  if(accepted&&settings.mode==='hill-climb'){
   if(evaluation.depth<settings.maxDepth)addFrontier(evaluation,true)
   else depthBoundaries.push(evaluation)
  }
 }
 result.depthLimitReached=depthBoundaries.some(parent=>neighbors(parent).some(n=>canTry(parent,n)))
 const unexplored=Boolean(takeNext())||(draftDifferent&&!result.candidates.some(c=>c.origin==='draft'))
 result.budgetExhausted=result.evaluatedCandidates>=settings.maxCandidates&&unexplored
 result.stopReason=result.budgetExhausted?'budget':result.depthLimitReached?'depth-limit':'neighborhood-exhausted'
 if(result.candidates.length===1&&!unexplored)result.issues.push('当前候选范围没有可用的普通候补变更')
 if(result.budgetExhausted)result.issues.push('候选预算用尽；仅比较已完整评估的候选，不代表全局或完整邻域最优')
 if(result.depthLimitReached)result.issues.push('已到搜索深度上限；仍可能存在更长的改进路径')
 return result
}
