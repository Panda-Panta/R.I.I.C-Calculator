<script setup lang="ts">
import {ref,watch,onBeforeUnmount,computed} from 'vue'
import type {RosterWorkspace} from '../../workbench/model'
import type {OwnedOperatorInput} from '../../domain/operatorInventory'
import {fullCatalogIdleInventory} from '../../domain/operatorInventory'
import type {ScheduleSimulationOptions} from '../../simulator/scheduleSimulation'
import type {SimulationAssumptions} from '../../scheduler/types'
import type {RosterDraftResult} from '../../optimizer/rosterDraft'
import type {IncomeSearchEvaluation,IncomeSearchResult,IncomeSearchRequest,IncomeSearchMode} from '../../optimizer/rosterIncomeSearch'
import type {IncomeCase} from '../../optimizer/incomeComparison'
import type {IncomeObjective} from '../../optimizer/productionObjective'
import {exportMowerJson} from '../../workbench/compat/mowerJson'
const props=defineProps<{workspace:RosterWorkspace;inventory:{enabled:boolean;valid:boolean;entries:OwnedOperatorInput[]};options:ScheduleSimulationOptions;assumptions:Partial<SimulationAssumptions>;draft?:RosterDraftResult|null}>()
const mode=ref<IncomeSearchMode>('hill-climb'),maxDepth=ref(3)
const searchSeed=ref(42),restarts=ref(4),includeControlMains=ref(true),includeProductionMains=ref(true)
const multiStart=computed(()=>mode.value==='multi-start')
const baselineLabel='原排班'
const displayReason=(message:string)=>message
const evaluationLabel=(e:IncomeSearchEvaluation)=>e.id==='baseline'?baselineLabel:e.label

const budgetLimit=computed(()=>multiStart.value?200:20)
const objective=ref<IncomeObjective>('composite'),maxCandidates=ref(4),warmupDays=ref(1),sampleDays=ref(2)
const running=ref(false),error=ref(''),state=ref('尚未运行'),progress=ref('')
const evaluations=ref<IncomeSearchEvaluation[]>([]),result=ref<IncomeSearchResult|null>(null),request=ref<IncomeSearchRequest|null>(null)
let worker:Worker|undefined
const enabled=computed(()=>!props.inventory.enabled||props.inventory.valid)
const statusLabels={improved:'模型内改进',conditional:'条件参考',rejected:'资源结余下降',unchanged:'未确认改进',ineligible:'不可用于排名'}
const partialBest=ref<string|null>(null)
const bestId=computed(()=>result.value?.bestCandidateId??partialBest.value??'baseline')
function stop(){worker?.terminate();worker=undefined;running.value=false}
function cancel(){stop();state.value='已取消；保留已完成的整组结果'}
function clear(){stop();evaluations.value=[];result.value=null;request.value=null;partialBest.value=null;error.value='';progress.value='';state.value='尚未运行'}
watch([()=>props.workspace,()=>props.inventory,()=>props.options,()=>props.assumptions,()=>props.draft,objective,maxCandidates,warmupDays,sampleDays,mode,maxDepth,searchSeed,restarts,includeControlMains,includeProductionMains],clear,{deep:true})
onBeforeUnmount(stop)
function run(){
 clear()
 if(!enabled.value){error.value='请先修正干员库中的输入错误';return}
 if(!Number.isInteger(maxCandidates.value)||maxCandidates.value<1||maxCandidates.value>budgetLimit.value||!Number.isFinite(warmupDays.value)||warmupDays.value<0||!Number.isFinite(sampleDays.value)||sampleDays.value<=0){error.value=`候选预算为 1–${budgetLimit.value} 整数；预热不能为负，采样须大于零`;return}
 if(multiStart.value&&(!Number.isInteger(searchSeed.value)||searchSeed.value<0||searchSeed.value>4294967295||!Number.isInteger(restarts.value)||restarts.value<1||restarts.value>20)){error.value='搜索种子须为 0–4294967295 整数，起点数须为 1–20 整数';return}
 const baseline=props.workspace
 const production=objective.value==='composite'?{...props.options.production,outputMode:'potential' as const,collectionIntervalHours:0,initialResources:{drone:props.options.production?.initialResources?.drone??0}}:props.options.production
 const input:IncomeSearchRequest={mode:mode.value,maxDepth:maxDepth.value,baseline,inventory:props.inventory.enabled?props.inventory.entries:fullCatalogIdleInventory(),options:{...props.options,production,warmupHours:warmupDays.value*24,sampleHours:sampleDays.value*24},assumptions:{...props.assumptions,idleOperators:props.assumptions.idleOperators??[]},objective:objective.value,maxCandidates:maxCandidates.value,...(props.draft?.workspace?{draft:props.draft.workspace,conditional:props.draft.uncheckedConditions.length>0}:{})}
 if(multiStart.value)Object.assign(input,{searchSeed:searchSeed.value,restarts:restarts.value,includeControlMains:includeControlMains.value,includeProductionMains:includeProductionMains.value})
 try{
  const finite=(value:unknown):void=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('比较设置须为有限数值');if(value&&typeof value==='object')Object.values(value).forEach(finite)}
  finite(input)
  request.value=JSON.parse(JSON.stringify(input))
  worker=new Worker(new URL('../../optimizer/rosterIncomeSearchWorker.ts',import.meta.url),{type:'module'})
  const current=worker;running.value=true;state.value='正在比较'
  worker.onmessage=event=>{
   if(worker!==current)return
   if(event.data.type==='progress'){
   const p=event.data.progress;partialBest.value=p.bestCandidateId??null;progress.value=`已完成 ${p.completedScenarios} 组模拟 · ${p.completedCandidates} / ${p.totalCandidates} 个候选 · ${p.label}`
    if(p.completed&&!evaluations.value.some(e=>e.id===p.completed.id))evaluations.value.push(p.completed)
   }else if(event.data.type==='complete'){
    result.value=event.data.report;evaluations.value=result.value!.candidates;state.value=result.value!.budgetExhausted?'预算已用尽，未证明全局最优':result.value!.stopReason==='depth-limit'?'已到搜索深度上限':multiStart.value?'本轮多起点搜索完成':'本轮候补搜索完成';partialBest.value=null;stop()
   }else{error.value=event.data.error??'搜索失败';state.value='执行失败';stop()}
  }
  worker.onerror=e=>{if(worker!==current)return;error.value=e.message||'搜索失败';state.value='执行失败';stop()}
  worker.postMessage(JSON.parse(JSON.stringify(request.value)))
 }catch(e){error.value=e instanceof Error?e.message:String(e);stop()}
}
const validationLabels={passed:'最终复核通过','no-improvement':'最终复核未确认改进',failed:'最终复核失败'}
const parentLabel=(e:IncomeSearchEvaluation)=>{const parent=evaluations.value.find(p=>p.id===e.parentId);return parent?evaluationLabel(parent):baselineLabel}
const candidateStatus=(e:IncomeSearchEvaluation)=>!multiStart.value&&e.comparison?.status==='improved'&&e.parentComparison&&e.parentComparison.status!=='improved'?'上一步检查未通过':e.comparison?(multiStart.value&&e.comparison.status==='improved'?'搜索阶段改进':statusLabels[e.comparison.status]):(e.cases.some(c=>!c.eligible)?baselineLabel+'基线（不可排名）':baselineLabel+'基线')
const pathLabels=computed(()=>{const labels:string[]=[];let node=evaluations.value.find(e=>e.id===bestId.value);const visited=new Set<string>();while(node&&!visited.has(node.id)){visited.add(node.id);labels.unshift(evaluationLabel(node));node=evaluations.value.find(e=>e.id===node!.parentId)}return labels})
const number=(n:number)=>Number.isFinite(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:2}):'不可用'
const caseMean=(cases:IncomeCase[]|undefined,key:'lmd'|'exp'|'gold'|'score')=>cases?.length===4?number(cases.reduce((n,c)=>n+(objective.value==='composite'?(key==='score'?c.output?.daily.total:key==='lmd'?c.output?.daily.orderValue:key==='gold'?c.output?.daily.goldValue:c.output?.daily.exp)??NaN:key==='score'?NaN:c.daily[key]),0)/4):'未完成'
const mean=(e:IncomeSearchEvaluation,key:'lmd'|'exp'|'gold'|'score')=>caseMean(e.cases,key)
const finalCandidate=computed(()=>result.value?.validation?.candidates?.find(c=>c.id===result.value?.validation?.selectedId))
const finalCases=computed(()=>finalCandidate.value?.cases??(!result.value?.validation?.selectedId?result.value?.validation?.baseline:undefined))
const finalMean=computed(()=>caseMean(finalCases.value,objective.value==='composite'?'score':objective.value))
const recordedNumber=(value:number|undefined)=>value===undefined?'未记录':number(value)
const download=(value:string,name:string)=>{const url=URL.createObjectURL(new Blob([value],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}
function exportReport(){download(JSON.stringify({state:state.value,request:request.value,result:result.value,completedCandidates:evaluations.value,draftConditions:request.value?.draft?props.draft?.uncheckedConditions??[]:[]},null,2),'收益比较与候补搜索.json')}
function exportCandidate(e:IncomeSearchEvaluation){download(exportMowerJson(JSON.parse(JSON.stringify(e.workspace))),'候补搜索-'+e.id+'.mower.json')}
</script>
<template>
 <details class="income-search" data-test="income-search-panel">
  <summary>收益比较与排班搜索</summary>
  <p>保留当前排班，以两个抽单种子和两档步长比较所选产出目标。可选择候补搜索或多起点主班搜索，原排班不会被覆盖。</p>
  <p>可调整普通候补的人员、顺序及同类设施间分配。逐步改进模式会继续探索通过验证的候选，每一步同时对照原排班与上一步。路径预算包含复用模拟的重评；最大步数单独限制路径长度。</p>
  <p v-if="multiStart">多起点模式随机探索中枢、生产设施的单席主班及普通候补变更；布局和工休约束保持不变，尚不支持从空表生成完整排班。搜索种子决定候选，抽单种子决定订单，两者独立。最终复核使用新的抽单种子、至少 24 小时预热与 168 小时采样；候选预算不含最终复核。</p>
  <p v-if="objective==='composite'">综合产出 = EXP + 0.8 × 赤金数量 × 500 + 0.2 × 订单面值。按完成产出计算，忽略库存、原料、缺金与收取约束；无人机与暖机增长沿用上方设置，比较窗口在下方单独指定。</p>
  <p v-else>净收支目标沿用上方库存、收取、无人机及暖机设置，并保持其他资源结余不下降。</p>
  <p>下方单独设置比较窗口。已导入干员库时，库内干员作为闲置候选；未导入时，使用全体干员。</p>
  <p v-if="draft?.workspace">将组合草案一并比较；草案文字条件未核实前，收益仅作条件参考。</p>
  <div class="search-controls">
   <label>搜索方式<select v-model="mode" data-test="search-mode"><option value="hill-climb">逐步改进</option><option value="single-pass">只比较一轮</option><option value="multi-start">多起点随机搜索</option></select></label>
   <label>最大步数<input v-model.number="maxDepth" data-test="search-depth" type="number" min="1" max="8" :disabled="mode==='single-pass'" /></label>
   <label>优先产出<select v-model="objective" data-test="search-objective"><option value="composite">综合产出（1 / 0.8 / 0.2）</option><option value="lmd">龙门币净收支</option><option value="exp">EXP 净收支</option></select></label>
   <label>路径候选预算（含{{baselineLabel}}）<input v-model.number="maxCandidates" data-test="search-budget" type="number" min="1" :max="budgetLimit" /></label>
   <template v-if="multiStart">
    <label>搜索种子<input v-model.number="searchSeed" data-test="search-seed" type="number" min="0" max="4294967295" /></label>
    <label>起点数<input v-model.number="restarts" data-test="search-restarts" type="number" min="1" max="20" /></label>
    <label><input v-model="includeControlMains" data-test="search-control-mains" type="checkbox" />允许替换中枢主班</label>
    <label><input v-model="includeProductionMains" data-test="search-production-mains" type="checkbox" />允许替换生产主班</label>
   </template>
   <label>预热（天）<input v-model.number="warmupDays" data-test="search-warmup" type="number" min="0" /></label>
   <label>采样（天）<input v-model.number="sampleDays" data-test="search-days" type="number" min="0.01" step="1" /></label>
   <button data-test="search-income" :disabled="running||!enabled" type="button" @click="run">{{multiStart?'多起点生成并比较':'比较并搜索候补'}}</button>
   <button v-if="running" data-test="cancel-income-search" type="button" @click="cancel">取消搜索</button>
  </div>
  <p v-if="!enabled">请先修正干员库中的输入错误。</p>
  <p v-else-if="!inventory.enabled">未导入干员库：搜索时按全体干员可用计算。</p>
  <p role="status" data-test="income-search-status">{{state}}<span v-if="progress"> · {{progress}}</span></p>
  <p v-if="error" role="alert">{{error}}</p>
  <div v-if="multiStart&&result?.validation" data-test="income-final-validation" role="status">
   <p>{{validationLabels[result.validation.status]}}<span v-if="result.validation.selectedId"> · 保留：{{result.validation.selectedId==='baseline'?baselineLabel:evaluations.find(e=>e.id===result!.validation!.selectedId)?.label??result.validation.selectedId}}</span></p>
   <p data-test="income-final-window">复核窗口：预热 {{recordedNumber(result.validation.warmupHours)}} 小时，采样 {{recordedNumber(result.validation.sampleHours)}} 小时；抽单种子：{{result.validation.seeds?.join(' / ')??'未记录'}}；步长：{{result.validation.steps?.join(' / ')??'未记录'}} 小时。</p>
   <p data-test="income-final-value">{{result.validation.selectedId?'选中候选':baselineLabel}}复核日均{{objective==='composite'?'综合产出（82）':objective==='exp'?'EXP 净收支':'龙门币净收支'}}：{{finalMean}}。<span v-if="finalCandidate" data-test="income-final-gain">相对{{baselineLabel}}增量：{{number(finalCandidate.comparison.minGain)}} ~ {{number(finalCandidate.comparison.maxGain)}} / 日。</span></p>
   <ul v-if="result.validation.reasons.length"><li v-for="(reason,i) in result.validation.reasons" :key="i">{{displayReason(reason)}}</li></ul>
  </div>
  <template v-if="evaluations.length">
   <p v-if="multiStart" data-test="income-search-stage"><strong>搜索阶段结果</strong>（下表使用搜索窗口；最终收益以复核区为准）</p>
   <p v-if="objective==='composite'">下表为四组模拟的每日完成产出均值。比较综合值，允许三项产出之间权衡；每组均须通过工休、规则覆盖和步长差异检查。</p>
   <p v-else>下表为四组模拟的平均每日净变动；其他资源净收支和全部期末库存不下降，赤金不折算为到账龙门币。</p>
   <p v-if="pathLabels.length>1" data-test="income-best-path">{{multiStart&&!result?'搜索候选路径':'当前保留路径'}}：{{pathLabels.join(' → ')}}</p>
   <p v-if="result">实际模拟 {{result.simulatedCandidates}} 张不同排班；评估 {{result.evaluatedCandidates}} 条路径候选，最深 {{result.exploredDepth}} 步。</p>
   <div class="search-table"><table><thead><tr><th>候选</th><th v-if="objective==='composite'">综合产出 / 日</th><th>{{objective==='composite'?'订单面值':'龙门币'}} / 日</th><th>EXP / 日</th><th>{{objective==='composite'?'赤金价值':'赤金'}} / 日</th><th>目标增量区间 / 日</th><th>判定</th><th>导出</th></tr></thead><tbody>
    <tr v-for="e in evaluations" :key="e.id"><td>{{evaluationLabel(e)}}<span v-if="e.id===bestId">{{multiStart&&!result?'（搜索候选）':'（当前保留）'}}</span><small v-if="e.parentId" class="route-info">第 {{e.depth}} 步 · 来自 {{parentLabel(e)}}<span v-if="e.cached"> · 复用模拟</span></small></td><td v-if="objective==='composite'">{{mean(e,'score')}}</td><td>{{mean(e,'lmd')}}</td><td>{{mean(e,'exp')}}</td><td>{{mean(e,'gold')}}</td><td>{{e.comparison?number(e.comparison.minGain)+' ~ '+number(e.comparison.maxGain):'—'}}</td><td>{{candidateStatus(e)}}</td><td><button type="button" @click="exportCandidate(e)">Mower JSON</button></td></tr>
   </tbody></table></div>
   <details v-for="e in evaluations" :key="'details-'+e.id"><summary>{{evaluationLabel(e)}} · 比较原因与模型假设</summary><p v-if="e.parentComparison&&e.depth>1">相对上一步：{{statusLabels[e.parentComparison.status]}}，目标增量 {{number(e.parentComparison.minGain)}} ~ {{number(e.parentComparison.maxGain)}} / 日。</p><ul><li v-for="(reason,i) in e.parentComparison?.reasons??[]" :key="'parent-reason'+i">上一步检查：{{displayReason(reason)}}</li><li v-for="(reason,i) in e.comparison?.reasons??[]" :key="'reason'+i">{{displayReason(reason)}}</li><li v-for="(issue,i) in [...new Set(e.cases.flatMap(c=>c.issues))]" :key="'issue'+i">{{displayReason(issue)}}</li><li v-for="(assumption,i) in [...new Set(e.cases.flatMap(c=>c.assumptions.map(a=>a.message)))]" :key="'assumption'+i">{{assumption}}</li></ul></details>
   <button type="button" data-test="export-income-search" @click="exportReport">导出比较明细 JSON</button>
  </template>
  <ul v-if="result?.issues.length"><li v-for="(issue,i) in result.issues" :key="i">{{displayReason(issue)}}</li></ul>
  <p>这是有限窗口、有限候选的模型比较，尚不能证明长期最优；种子与步长对照也不等同于游戏实测。</p>
 </details>
</template>
<style scoped>
.income-search{margin:1rem 0;padding:1rem;border:1px solid #526570;border-radius:8px;background:#14202a;overflow-wrap:anywhere}.income-search summary{cursor:pointer;font-weight:600}.income-search p,.income-search li{line-height:1.6}.search-controls{display:flex;align-items:end;gap:.75rem;flex-wrap:wrap}.search-controls label{display:grid;gap:.4rem}.search-controls input{width:90px}.income-search input,.income-search select{background:#101922;color:inherit;padding:.5rem;border:1px solid #63717d;border-radius:5px}.income-search button{background:#c7e49b;color:#16210d;padding:.6rem .8rem;border:1px solid #95ab67;border-radius:5px;cursor:pointer}.income-search button:disabled{opacity:.5}.search-table{overflow:auto;margin:1rem 0;max-height:380px}.search-table table{border-collapse:collapse;min-width:760px;width:100%}.search-table td,.search-table th{text-align:right;padding:.6rem;border-bottom:1px solid #42515e}.search-table th{position:sticky;top:0;z-index:1;background:#14202a}.search-table th,.search-table td:not(:first-child){white-space:nowrap}.search-table td:first-child,.search-table th:first-child{text-align:left;min-width:230px}.route-info{display:block;margin-top:.4rem;color:#b6c6d1;font-size:.8rem}.income-search details{margin:.7rem 0}.income-search [role=alert]{color:#ffb4ab}
</style>
