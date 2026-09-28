import type {IncomeSearchRequest,IncomeSearchSettings,IncomeSearchResult,IncomeSearchEvaluation,IncomeSearchProgress,IncomeSearchMove} from './rosterIncomeSearch'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {generateBackupNeighbors} from './backupNeighborhood'
import {generateControlMainNeighbors} from './controlNeighborhood'
import {generateProductionMainNeighbors} from './primaryNeighborhood'
import {generatePrimaryBackupNeighbors} from './primaryBackupNeighborhood'
import {seededSearchOrder} from './dailyTarget'
import {summarizeIncome,compareIncome,type IncomeCase,type IncomeComparison} from './incomeComparison'
import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {validatePhysicalRoster} from './rosterDraft'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import type {RosterWorkspace} from '../workbench/model'

export interface MultiStartValidation {
 status:'passed'|'no-improvement'|'failed';selectedId:string|null;reasons:string[]
 seeds:[number,number];steps:[number,number];sampleHours:number;warmupHours:number
 baseline:IncomeCase[];candidates:{id:string;cases:IncomeCase[];comparison:IncomeComparison}[]
}
type Neighbor={workspace:RosterWorkspace;label:string;move:IncomeSearchMove}
function fingerprint(ws:RosterWorkspace):string {
 return JSON.stringify({rooms:Object.values(ws.mainPlan.facilities).map(r=>({...r,slots:r.slots.map(s=>({...s,occupant:s.occupant.kind==='operator'?{kind:'operator',operatorId:resolveId(s.occupant.operatorId)}:s.occupant,replacements:s.replacements.map(resolveId)}))})),conf:ws.mainPlan.conf,backup:ws.compatibility.backupPlans})
}
const layout=(w:RosterWorkspace)=>JSON.stringify(Object.values(w.mainPlan.facilities).map(r=>[r.roomId,r.type,r.level,r.product]))
/** Random walks explore intermediate losses; only independently revalidated gains replace the source. */
export function runMultiStartSearch(request:IncomeSearchRequest,settings:IncomeSearchSettings,onProgress?:(p:IncomeSearchProgress)=>void):IncomeSearchResult {
 const original=structuredClone(request.baseline),errors=validatePhysicalRoster(original)
 if(errors.length)throw new Error(errors.map(e=>e.message).join('；'))
 // The imported library supplies idle candidates; current roster workers may be absent from it.
 const compiled=compileRosterSchedule(original,settings.assumptions)
 const invalid=compiled.diagnostics.filter(d=>d.severity==='error'||d.code==='UNKNOWN_OPERATOR')
 if(invalid.length)throw new Error('起点排班无效：'+invalid.map(d=>d.message).join('；'))
 if(request.draft){const errors=validatePhysicalRoster(request.draft);if(errors.length||layout(request.draft)!==layout(original))throw new Error('草案须与原排班保持相同合法布局、等级与配方')}
 const baseline:IncomeSearchEvaluation={id:'baseline',label:'原排班',workspace:original,cases:[],comparison:null,cached:false,parentId:null,parentComparison:null,depth:0,origin:'baseline',conditional:false,move:null}
 const result:IncomeSearchResult={baseline,candidates:[],bestCandidateId:null,bestWorkspace:structuredClone(original),evaluatedCandidates:0,simulatedCandidates:0,budgetExhausted:false,issues:[],settings,request:structuredClone(request),bestPath:['baseline'],exploredDepth:0,depthLimitReached:false,stopReason:'neighborhood-exhausted'}
 const visited=new Set<string>(),cache=new Map<string,IncomeCase[]>()
 let completed=0,total=settings.maxCandidates*4,state=settings.searchSeed>>>0
 const nextSeed=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state}
 const notify=(label:string,evaluation?:IncomeSearchEvaluation)=>onProgress?.({completedCandidates:result.evaluatedCandidates,totalCandidates:settings.maxCandidates,completedScenarios:completed,totalScenarios:total,label,completed:evaluation?structuredClone(evaluation):undefined,bestCandidateId:null})
 const runCases=(ws:RosterWorkspace,seeds:[number,number],steps:[number,number],sampleHours:number,warmupHours:number,label:string):IncomeCase[]=>{
  const output:IncomeCase[]=[]
  for(const seed of seeds)for(const step of steps){
   notify(label)
   const response=runScheduleSimulationBridge(ws,{...structuredClone(settings.options),sampleHours,warmupHours,maxStepHours:step,production:{...structuredClone(settings.options.production),seed}},structuredClone(settings.assumptions))
   if(!response.report)throw new Error(response.error??'模拟未返回报告')
   output.push(summarizeIncome(response.report));completed++;notify(label)
  }
  return output
 }
 const evaluate=(e:IncomeSearchEvaluation)=>{
  const key=fingerprint(e.workspace),cached=cache.get(key)
  e.cases=cached?structuredClone(cached):runCases(e.workspace,settings.seeds,settings.steps,settings.options.sampleHours!,settings.options.warmupHours!,e.label)
  e.cached=Boolean(cached);if(!cached){result.simulatedCandidates++;cache.set(key,structuredClone(e.cases))}
  visited.add(key+':'+e.conditional)
  if(e.parentId){const parent=result.candidates.find(p=>p.id===e.parentId)!;e.comparison=compareIncome(baseline.cases,e.cases,settings.objective,e.conditional);e.parentComparison=compareIncome(parent.cases,e.cases,settings.objective,e.conditional)}
  result.candidates.push(e);result.evaluatedCandidates++;result.exploredDepth=Math.max(result.exploredDepth,e.depth);notify(e.label,e)
 }
 evaluate(baseline)
 let draft:IncomeSearchEvaluation|undefined
 if(request.draft&&fingerprint(request.draft)!==fingerprint(original)&&result.evaluatedCandidates<settings.maxCandidates){
  draft={...baseline,id:'candidate-'+result.evaluatedCandidates,label:'组合草案起点',workspace:structuredClone(request.draft),parentId:'baseline',origin:'draft',conditional:request.conditional??false,cases:[]};evaluate(draft)
 }
 // Explicit context participants and policy metadata must not become borrowed workers.
 const protectedIds=new Set<string>()
 const protect=(value:unknown):void=>{if(typeof value==='string')protectedIds.add(resolveId(value));else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){protectedIds.add(resolveId(key));protect(child)}}
 protect(settings.assumptions)
 const contextOptions=structuredClone(settings.options);delete contextOptions.operatorInventory;protect(contextOptions)
 const neighbors=(parent:IncomeSearchEvaluation):Neighbor[]=>{
  const inventory=seededSearchOrder(request.inventory,nextSeed())
  // Change enumeration order only; restore original facility order in each returned candidate.
  const copy=structuredClone(parent.workspace),keys=Object.keys(copy.mainPlan.facilities)
  copy.mainPlan.facilities=Object.fromEntries(seededSearchOrder(Object.entries(copy.mainPlan.facilities),nextSeed())) as typeof copy.mainPlan.facilities
  const available:Neighbor[]=[...generateBackupNeighbors(copy,inventory,21,{protectedIds:[...protectedIds],lockedPositions:settings.lockedPositions})]
  if(settings.includeControlMains)available.push(...generateControlMainNeighbors(copy,inventory,21,[...protectedIds],settings.lockedPositions))
  if(settings.includeProductionMains)available.push(...generateProductionMainNeighbors(copy,inventory,21,[...protectedIds],settings.lockedPositions))
  if(settings.includeProductionMains||settings.includeControlMains)available.push(...generatePrimaryBackupNeighbors(copy,inventory,21,{protectedIds:[...protectedIds],includeControl:settings.includeControlMains,includeProduction:settings.includeProductionMains,lockedPositions:settings.lockedPositions}))
  for(const n of available)n.workspace.mainPlan.facilities=Object.fromEntries(keys.map(key=>[key,n.workspace.mainPlan.facilities[key as keyof typeof copy.mainPlan.facilities]])) as typeof copy.mainPlan.facilities
  const locked=new Set((settings.lockedPositions??[]).map(key=>key.replace(/:(\d+)$/,'_$1')))
  return seededSearchOrder(available.filter(n=>!n.move.positions.some(key=>locked.has(key))),nextSeed())
 }
 const starts=Array.from({length:settings.restarts},(_,index)=>({index,parent:index%2&&draft?draft:baseline,depth:0,done:false}))
 while(result.evaluatedCandidates<settings.maxCandidates&&starts.some(s=>!s.done)){
  for(const start of starts){
   if(start.done||result.evaluatedCandidates>=settings.maxCandidates)continue
   let next:Neighbor|undefined
   for(let retry=0;retry<3&&!next;retry++)next=neighbors(start.parent).find(n=>!visited.has(fingerprint(n.workspace)+':'+start.parent.conditional))
   if(!next){start.done=true;continue}
   const e:IncomeSearchEvaluation={...baseline,id:'candidate-'+result.evaluatedCandidates,label:`起点 ${start.index+1} · ${next.label}`,workspace:next.workspace,cases:[],comparison:null,parentComparison:null,parentId:start.parent.id,origin:start.parent.origin,conditional:start.parent.conditional,depth:++start.depth,move:next.move,restart:start.index+1}
   evaluate(e);start.parent=e
   if(start.depth>=settings.maxDepth){start.done=true;result.depthLimitReached=true}
  }
 }
 result.budgetExhausted=result.evaluatedCandidates>=settings.maxCandidates&&starts.some(s=>!s.done)
 result.stopReason=result.budgetExhausted?'budget':result.depthLimitReached?'depth-limit':'neighborhood-exhausted'
 if(result.budgetExhausted)result.issues.push('候选预算用尽；已检查结果不代表全局最优')
 result.issues.push('多起点使用有限随机邻域；一次未抽到新方案不证明邻域已穷尽。探索路径可能经过减产方案，不能作为游戏操作顺序。')
 const finalists=result.candidates.filter(c=>c.comparison?.status==='improved'&&!c.conditional).sort((a,b)=>b.comparison!.minGain-a.comparison!.minGain).slice(0,3)
 const used=new Set(settings.seeds),validationSeeds:number[]=[]
 let next=(settings.seeds[0]+0x9e3779b9)>>>0
 while(validationSeeds.length<2){if(!used.has(next)){validationSeeds.push(next);used.add(next)}next=(next+1)>>>0}
 const validation:MultiStartValidation={status:'no-improvement',selectedId:null,reasons:[],seeds:validationSeeds as [number,number],steps:[Math.min(.25,...settings.steps),Math.min(.25,...settings.steps)/2],sampleHours:Math.max(168,settings.options.sampleHours!),warmupHours:Math.max(24,settings.options.warmupHours!),baseline:[],candidates:[]}
 result.validation=validation
 if(baseline.cases.some(c=>!c.eligible)){validation.status='failed';validation.reasons.push('原排班未通过完整性检查，无法确认相对改进');return result}
 if(!finalists.length){validation.reasons.push('搜索阶段没有找到通过共同条件检查的82或所选目标改进，保留原排班');return result}
 total=completed+(finalists.length+1)*4
 validation.baseline=runCases(original,validation.seeds,validation.steps,validation.sampleHours,validation.warmupHours,'最终复核：原排班')
 for(const finalist of finalists){
  const cases=runCases(finalist.workspace,validation.seeds,validation.steps,validation.sampleHours,validation.warmupHours,`最终复核：${finalist.label}`)
  validation.candidates.push({id:finalist.id,cases,comparison:compareIncome(validation.baseline,cases,settings.objective)})
 }
 const winner=validation.candidates.filter(c=>c.comparison.status==='improved').sort((a,b)=>b.comparison.minGain-a.comparison.minGain)[0]
 if(winner){
  validation.status='passed';validation.selectedId=winner.id
  result.bestCandidateId=winner.id;result.bestWorkspace=structuredClone(result.candidates.find(c=>c.id===winner.id)!.workspace)
  const path:string[]=[];let node:IncomeSearchEvaluation|undefined=result.candidates.find(c=>c.id===winner.id)
  while(node){path.unshift(node.id);node=result.candidates.find(c=>c.id===node!.parentId)}result.bestPath=path
 }else{validation.status='failed';validation.reasons.push('领先候选未通过新抽单种子与长窗口复核，保留原排班')}
 return result
}
