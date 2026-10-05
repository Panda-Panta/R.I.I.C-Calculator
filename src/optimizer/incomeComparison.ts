import {assertRunOrderMode} from '../simulator/productionTimeline'
import {scoreSimulationProduction,type ProductionScore,type IncomeObjective} from './productionObjective'
import type {ScheduleSimulationReport} from '../simulator/scheduleSimulation'
import type {ResourceAmounts,ResourceKind} from '../simulator/resourceLedger'
export const INCOME_RESOURCES:ResourceKind[]=['lmd','exp','gold','fragment','orundum','drone','orirock','device']
export interface IncomeCase {
 key:string;eligible:boolean;issues:string[];daily:Record<ResourceKind,number>
 opening:Record<ResourceKind,number>;closing:Record<ResourceKind,number>
 output?:{mode:'potential'|'settled';daily:ProductionScore}
 seed:number;step:number;context:string;assumptions:{code:string;message:string}[]
}
export interface IncomeComparison {status:'improved'|'conditional'|'rejected'|'unchanged'|'ineligible';minGain:number;maxGain:number;reasons:string[]}
const EPS=1e-5
const ALLOWED=new Set(['POTENTIAL_OUTPUT_MODEL','TIME_INTEGRATION_MODEL','MOWER_IO_CLOCK_MODEL','MOWER_SCHEDULING_MODEL','MOWER_CLUE_OBSERVATION_MODEL','MOWER_ORDER_OBSERVATION_MODEL','SINGLE_RECOVERY_TARGET_ASSUMPTION','PRODUCTION_TIMING_ASSUMPTIONS','IDEAL_RUN_ORDER_ASSUMPTIONS','DRONE_ALLOCATION_POLICY','RUN_ORDER_SOURCE_BED_POLICY','PASSIVE_AUXILIARY_OCCUPANCY','SHIFT_DEFERRED_RECOVERED'])
const amounts=(x:ResourceAmounts={}):Record<ResourceKind,number>=>Object.fromEntries(INCOME_RESOURCES.map(k=>[k,x[k]??0])) as Record<ResourceKind,number>
function canonical(x:unknown):string {
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']'
 if(x!==null&&typeof x==='object')return '{'+Object.entries(x).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
 return JSON.stringify(x)??'null'
}
/** Compact evidence only. Preserve the complete request separately for replay. */
export function summarizeIncome(report:ScheduleSimulationReport):IncomeCase {
 const p=report.production,a=report.assumptions,issues:string[]=[]
 const add=(message:string)=>{if(!issues.includes(message))issues.push(message)}
 try{assertRunOrderMode(report.inputs.options.production?.runOrderMode);assertRunOrderMode(p?.assumptions.runOrderMode)}catch(error){add(error instanceof Error?error.message:String(error))}
 if(!report.success||!p?.success)add('模拟或生产策略未完整执行')
 if(!Number.isFinite(report.observedHours)||report.observedHours<=0||Math.abs(report.observedHours-a.sampleHours)>EPS||!Number.isFinite(report.elapsedHours)||Math.abs(report.elapsedHours-a.sampleHours-a.warmupHours)>EPS)add('采样或预热窗口未完成')
 for(const d of report.diagnostics){
  if(!ALLOWED.has(d.code))add(d.code+'：'+d.message)
  if(d.code==='SHIFT_DEFERRED_RECOVERED'){
   const episodes=(report.shiftDeferrals??[]).filter(e=>d.message.startsWith(e.key+': '))
   if(!episodes.length||episodes.some(e=>!e.operatorIds.length||!Number.isFinite(e.blockedAt)||e.blockedAt<0||!Number.isFinite(e.resolvedAt)||e.resolvedAt!<=e.blockedAt||e.resolvedAt!>report.elapsedHours))add('换班延后缺少完整恢复证据')
  }
 }
 for(const op of report.operators){
  const times=[op.workHours,op.exhaustedHours,op.restHours,op.idleHours]
  if(times.some(n=>!Number.isFinite(n)||n<0)||Math.abs(times.reduce((n,v)=>n+v,0)-report.observedHours)>EPS)add('干员工休时间不守恒')
  const primarySlots=report.inputs.schedule.rooms.filter(r=>r.type!=='dormitory').flatMap(r=>r.slots).filter(s=>s.primaryOperatorId===op.operatorId)
  const permanent=report.inputs.schedule.policies.workaholic?.includes(op.operatorId)&&primarySlots.length===1
   &&Number.isFinite(op.permanentPrimaryOccupancyHours)&&Math.abs(op.permanentPrimaryOccupancyHours!-report.observedHours)<=EPS
   &&Math.abs(op.workHours+op.exhaustedHours-report.observedHours)<=EPS&&op.restHours===0&&op.idleHours===0
  if(op.exhaustedHours>1e-7&&!permanent)add('存在疲劳占岗')
 }
 if(p){
  const replay=amounts(p.ledger.initial),ins=amounts(),outs=amounts(),reasons=new Set<string>()
  for(const e of p.ledger.entries){
   if(!e.reason||reasons.has(e.reason))add('账本流水标识重复或缺失')
   reasons.add(e.reason)
   for(const [key,n] of Object.entries(e.delta)){
    const k=key as ResourceKind
    if(!INCOME_RESOURCES.includes(k)||!Number.isFinite(n)){add('账本包含无效资源或数值');continue}
    replay[k]+=n;if(n>=0)ins[k]+=n;else outs[k]-=n
    if(replay[k]<-EPS)add('账本中途透支')
   }
  }
  if(p.ledger.appliedReasons.length!==reasons.size||p.ledger.appliedReasons.some(id=>!reasons.has(id)))add('账本流水索引不一致')
  const tables=[p.ledger.initial,p.ledger.balances,p.ledger.inflows,p.ledger.outflows,p.sample.opening,p.sample.closing,p.sample.inflows,p.sample.outflows]
  if(tables.some(t=>Object.entries(t).some(([k,n])=>!INCOME_RESOURCES.includes(k as ResourceKind)||!Number.isFinite(n)||n<0)))add('库存包含无效数值')
  for(const k of INCOME_RESOURCES){
   const net=p.sample.net[k]??0,close=p.sample.closing[k]??0
   if(!Number.isFinite(net)||Math.abs(close-(p.sample.opening[k]??0)-net)>EPS||Math.abs((p.sample.inflows[k]??0)-(p.sample.outflows[k]??0)-net)>EPS)add('采样账本不守恒')
   if(Math.abs(replay[k]-(p.ledger.balances[k]??0))>EPS||Math.abs(ins[k]-(p.ledger.inflows[k]??0))>EPS||Math.abs(outs[k]-(p.ledger.outflows[k]??0))>EPS||Math.abs(close-(p.ledger.balances[k]??0))>EPS)add('全程账本不守恒')
  }
 }
 const seed=p?.assumptions.seed??report.inputs.options.production?.seed??1,step=a.maxStepHours
 const {seed:ignoredSeed,...production}=report.inputs.options.production??{}
 const {maxStepHours:ignoredStep,...options}=report.inputs.options
 const {levelSource,importSource,...assumptions}=report.inputs.schedule.assumptions
 const context=canonical({options:{...options,production},assumptions,sampleHours:a.sampleHours,warmupHours:a.warmupHours,layout:report.inputs.schedule.rooms.map(r=>({id:r.roomId,type:r.type,level:r.level,product:r.product}))})
 let output:IncomeCase['output']
 if(p?.sample.completed&&report.observedHours>0){try{output={mode:p.assumptions.outputMode??'settled',daily:scoreSimulationProduction(report)}}catch{add('完成产出数值无效')}}
 return {output,key:`${seed}:${step}`,seed,step,context,eligible:issues.length===0,issues,daily:amounts(Object.fromEntries(INCOME_RESOURCES.map(k=>[k,(p?.sample.net[k]??0)*24/report.observedHours]))),opening:amounts(p?.sample.opening),closing:amounts(p?.sample.closing),assumptions:report.diagnostics.filter(d=>ALLOWED.has(d.code))}
}
export function incomeObjectiveValue(c:IncomeCase,objective:IncomeObjective):number{return objective==='composite'?c.output?.daily.total??NaN:c.daily[objective]}
/** Composite uses explicit user weights; legacy net objectives retain resource Pareto guards. */
export function compareIncome(baseline:IncomeCase[],candidate:IncomeCase[],objective:IncomeObjective,conditional=false):IncomeComparison {
 const result:IncomeComparison={status:'ineligible',minGain:0,maxGain:0,reasons:[]}
 const keys=new Set(baseline.map(c=>c.key)),map=new Map(candidate.map(c=>[c.key,c]))
 const seeds=new Set(baseline.map(c=>c.seed)),steps=new Set(baseline.map(c=>c.step))
 if(baseline.length!==4||candidate.length!==4||keys.size!==4||map.size!==4||seeds.size!==2||steps.size!==2||baseline.some(b=>!map.has(b.key))){result.reasons.push('必须完成相同的两个种子、两档步长共四组对照');return result}
 for(const b of baseline){const c=map.get(b.key)!
  if(!b.eligible||!c.eligible)result.reasons.push('模拟未通过完整性检查',...b.issues,...c.issues)
  if(objective==='composite'&&(b.output?.mode!=='potential'||c.output?.mode!=='potential'||!Number.isFinite(incomeObjectiveValue(b,objective))||!Number.isFinite(incomeObjectiveValue(c,objective))))result.reasons.push('综合评分要求忽略库存约束的完成产出')
  if(b.context!==c.context||b.seed!==c.seed||b.step!==c.step)result.reasons.push('对照条件不同')
  if(INCOME_RESOURCES.some(k=>![b.daily[k],c.daily[k],b.closing[k],c.closing[k]].every(Number.isFinite)))result.reasons.push('对照包含无效数值')
 }
 if(result.reasons.length){result.reasons=[...new Set(result.reasons)];return result}
 const gains=baseline.map(b=>incomeObjectiveValue(map.get(b.key)!,objective)-incomeObjectiveValue(b,objective))
 result.minGain=Math.min(...gains);result.maxGain=Math.max(...gains)
 if(objective!=='composite')for(const b of baseline){const c=map.get(b.key)!
  for(const k of INCOME_RESOURCES)if((k!==objective&&c.daily[k]<b.daily[k]-EPS)||c.closing[k]<b.closing[k]-EPS)result.reasons.push(`${k}：采样净收支或期末库存下降`)
 }
 if(result.reasons.length){result.status='rejected';result.reasons=[...new Set(result.reasons)];return result}
 const stepDiscrepancy=Math.max(...[...seeds].map(seed=>{const ds=baseline.filter(b=>b.seed===seed).map(b=>incomeObjectiveValue(map.get(b.key)!,objective)-incomeObjectiveValue(b,objective));return Math.max(...ds)-Math.min(...ds)}))
 if(result.minGain<=Math.max(.01,stepDiscrepancy)){result.status='unchanged';result.reasons.push('各组最小收益增量未超过步长差异及每日 0.01 的比较门槛');return result}
 result.status=conditional?'conditional':'improved'
 if(conditional)result.reasons.push('组合文字条件仍待核实，收益仅作条件参考')
 return result
}
