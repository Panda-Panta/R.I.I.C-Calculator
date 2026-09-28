<script setup lang="ts">
import {computed,ref,watch,toRaw,onBeforeUnmount} from 'vue'
import type {RosterWorkspace} from '../../workbench/model'
import {getRoomDisplayName} from '../../workbench/operatorHelpers'
import {exportMowerJson} from '../../workbench/compat/mowerJson'
import {OPERATOR_MAP} from '../../domain/operators'
import {compileOperatorInventory,fullCatalogIdleInventory,type OwnedOperatorInput} from '../../domain/operatorInventory'
import {admitCombinationCandidates} from '../../optimizer/inventoryAdmission'
import {generateRosterDraft,type RosterDraftResult} from '../../optimizer/rosterDraft'
import type {AutomaticRosterResult} from '../../optimizer/automaticRoster'
const props=defineProps<{workspace:RosterWorkspace;inventory:{enabled:boolean;valid:boolean;entries:OwnedOperatorInput[]}}>()
const emit=defineEmits<{simulate:[workspace:RosterWorkspace];invalidate:[];draftChange:[result:RosterDraftResult|null]}>()
const generationError=ref('')
const generationMode=ref<'manual'|'automatic'>('manual'),seed=ref(42),trials=ref(3),mainDutyPercent=ref(77.5),running=ref(false)
const automaticResult=ref<AutomaticRosterResult|null>(null),automaticInput=ref<unknown>(null)
let worker:Worker|undefined
function stopGeneration(){worker?.terminate();worker=undefined;running.value=false}
function invalidate(){stopGeneration();if(result.value){emit('invalidate');emit('draftChange',null)};result.value=null;automaticResult.value=null;automaticInput.value=null;generationError.value=''}
onBeforeUnmount(stopGeneration)
const selected=ref<string[]>([]),maxStates=ref(2000),result=ref<RosterDraftResult|null>(null)
const idleEntries=computed(()=>props.inventory.enabled?props.inventory.entries:fullCatalogIdleInventory())
const available=computed(()=>!props.inventory.enabled||props.inventory.valid?admitCombinationCandidates(compileOperatorInventory(idleEntries.value)).filter(c=>c.status==='needs-context').map(c=>c.candidate):[])
const names=computed(()=>new Map(available.value.map(c=>[c.id,c.name])))
const enabled=computed(()=>!props.inventory.enabled||props.inventory.valid)
watch([()=>props.workspace,()=>props.inventory,selected,maxStates,generationMode,seed,trials,mainDutyPercent],invalidate,{deep:true})
const operatorName=(id:string)=>OPERATOR_MAP.get(id)?.name??id
const rosterRows=computed(()=>Object.values(result.value?.workspace?.mainPlan.facilities??{}).flatMap(room=>room.slots.flatMap((slot,index)=>slot.occupant.kind==='operator'?[{
 key:room.roomId+':'+index,roomName:getRoomDisplayName(room.roomId,room.type),operatorName:operatorName(slot.occupant.operatorId),
 replacementNames:slot.replacements.map(operatorName),group:slot.groupId,
 role:room.type==='dormitory'&&operatorName(slot.occupant.operatorId)==='菲亚梅塔'?'心情交换目标':'候补',
}]:[])))
function generateAutomatic(){
 invalidate()
 if(!enabled.value)return
 if(!Number.isFinite(mainDutyPercent.value)||mainDutyPercent.value<75||mainDutyPercent.value>80){generationError.value='普通主班参考占比须为75%–80%';return}
 if(!Number.isInteger(seed.value)||seed.value<0||seed.value>4294967295||!Number.isInteger(trials.value)||trials.value<1||trials.value>8||!Number.isInteger(maxStates.value)||maxStates.value<1||maxStates.value>100000){generationError.value='种子须为0–4294967295整数；生成次数1–8；尝试预算1–100000';return}
 try{
  const input=JSON.parse(JSON.stringify({base:props.workspace,entries:idleEntries.value,options:{seed:seed.value,trials:trials.value,maxStates:maxStates.value,mainDutyRatio:mainDutyPercent.value/100}}))
  automaticInput.value=input
  worker=new Worker(new URL('../../optimizer/automaticRosterWorker.ts',import.meta.url),{type:'module'})
  const current=worker;running.value=true
  worker.onmessage=event=>{
   if(worker!==current)return
   if(event.data.type==='complete'){
    automaticResult.value=event.data.report
    result.value=automaticResult.value?.draft??null
    emit('draftChange',result.value)
   }else generationError.value=event.data.error??'生成失败'
   stopGeneration()
  }
  worker.onerror=()=>{if(worker!==current)return;generationError.value='生成任务发生错误';stopGeneration()}
  worker.postMessage(input)
 }catch(error){generationError.value=error instanceof Error?error.message:String(error);stopGeneration()}
}
function exportGeneration(){
 if(!automaticResult.value)return
 const url=URL.createObjectURL(new Blob([JSON.stringify({input:automaticInput.value,report:automaticResult.value},null,2)],{type:'application/json'}))
 const a=document.createElement('a');a.href=url;a.download='自动主班生成明细.json';a.click();URL.revokeObjectURL(url)
}
function generate(){
 if(!enabled.value)return
 generationError.value=''
 try{result.value=generateRosterDraft(structuredClone(toRaw(props.workspace)),idleEntries.value,selected.value,{maxStates:maxStates.value})}
 catch(error){result.value=null;generationError.value=error instanceof Error?error.message:String(error)}
 emit('draftChange',result.value)
}
function download(){
 if(!result.value?.workspace)return
 const url=URL.createObjectURL(new Blob([exportMowerJson(structuredClone(toRaw(result.value.workspace)))],{type:'application/json'}))
 const a=document.createElement('a');a.href=url;a.download='组合排班草案.mower.json';a.click();URL.revokeObjectURL(url)
}
</script>
<template>
 <details class="roster-draft" data-test="roster-draft-panel">
  <summary>组合排班草案</summary>
  <p data-test="main-plan-only">自动生成只使用主表及普通候补，不带入副表；原始导入排班保持不变。</p>
  <p>选择成员和技能齐备的组合，在当前布局的空位中摆放，并尝试分配普通候补。原主班、原候补、已有分组和 Free 床位会保留。</p>
  <p v-if="!enabled">请先修正干员库中的输入错误。</p><p v-else-if="!inventory.enabled">未导入干员库：按全体干员可用生成草案。</p>
  <label>生成方式<select v-model="generationMode" data-test="draft-mode"><option value="manual">手动选择组合</option><option value="automatic">空布局自动组队</option></select></label>
  <p v-if="generationMode==='automatic'">按当前布局和干员库优先选择高效主班与替班组合。普通岗位按75%–80%主班占比作参考，歌蕾蒂娅及有心情消耗技能的干员工休比待定；本阶段暂不以疲劳筛选。</p>
  <fieldset v-if="generationMode==='manual'" :disabled="!enabled" class="draft-candidates"><legend>选择组合（已选 {{selected.length}} 项）</legend>
   <label v-for="c in available" :key="c.id"><input v-model="selected" type="checkbox" :value="c.id" :data-candidate="c.id" />{{c.name}}</label>
   <p v-if="!available.length">当前没有成员与目录技能均齐备的组合。</p>
  </fieldset>
  <div class="draft-actions"><label>最多尝试次数<input v-model.number="maxStates" type="number" min="1" max="100000" /></label><button v-if="generationMode==='manual'" type="button" data-test="generate-draft" :disabled="!enabled||!selected.length" @click="generate">生成排班草案</button>
   <template v-if="generationMode==='automatic'"><label>生成种子<input v-model.number="seed" data-test="auto-seed" type="number" min="0" max="4294967295" /></label><label>普通主班占比（%）<input v-model.number="mainDutyPercent" data-test="auto-duty" type="number" min="75" max="80" step="0.5" /></label><label>生成次数<input v-model.number="trials" data-test="auto-trials" type="number" min="1" max="8" /></label><button type="button" data-test="generate-automatic" :disabled="!enabled||running" @click="generateAutomatic">自动组队并初筛</button><button v-if="running" type="button" data-test="cancel-automatic" @click="stopGeneration">取消生成</button></template>
  </div>
  <p v-if="running" role="status">正在生成并计算静态初筛值…</p>
  <div v-if="automaticResult" data-test="automatic-summary">
   <p>{{automaticResult.status==='draft'?'已生成完整主班草案，待工休验证':'未找到完整主班草案'}}；按主替班搭配排序分保留一份候选；特殊工休比待定，排序分不是整表日均。</p>
   <ul><li v-for="(d,i) in automaticResult.diagnostics" :key="i">{{d.message}}</li></ul>
   <div class="draft-table"><table data-test="automatic-trials"><thead><tr><th>轮次</th><th>主班82快照</th><th>替班82快照</th><th>搭配排序分（非日均）</th><th>检查</th><th>原因</th></tr></thead><tbody><tr v-for="(trial,i) in automaticResult.trials" :key="i"><td>{{i+1}}{{automaticResult.selectedTrial===i?'（选中）':''}}</td><td>{{trial.staticScore===null?'未量化':trial.staticScore.toFixed(2)}}</td><td>{{trial.duty?.backupScore.toFixed(2)??'未计算'}}</td><td>{{trial.duty?.rankingScore?.toFixed(2)??'未计算'}}</td><td>{{trial.status==='blocked'?'未生成':trial.complete?'静态规则可量化':'存在未量化规则'}}</td><td>{{trial.diagnostics.join('；')}}</td></tr></tbody></table></div>
   <template v-for="(trial,trialIndex) in automaticResult.trials" :key="trial.seed">
    <details v-if="trial.crossRoomSelections?.length" data-test="cross-room-details"><summary>第 {{trialIndex+1}} 轮：原表跨站换班组合{{automaticResult.selectedTrial===trialIndex?'（选中）':''}}</summary>
     <div v-for="group in trial.crossRoomSelections" :key="group.templateId">
      <p>{{group.groupId}}：以下成员共同换班，保留原组关系。</p>
      <ul><li v-for="member in group.members" :key="member.roomId+':'+member.slotIndex">{{getRoomDisplayName(member.roomId)}} / {{member.slotIndex+1}}：{{operatorName(member.operatorId)}} → {{operatorName(member.selectedCandidate)}}；原候补顺序：{{member.orderedCandidates.map(operatorName).join('、')}}</li></ul>
      <p>来源：{{group.sources.map(source=>source.file).join('；')}}。当前选择互不冲突的普通候补，未执行来源表的条件备用计划。</p>
     </div>
    </details>
   </template>
   <details v-if="automaticResult.selectedTrial!==null&&automaticResult.trials[automaticResult.selectedTrial]?.duty" data-test="duty-details"><summary>主替班占比与待定项</summary>
    <template v-for="duty in [automaticResult.trials[automaticResult.selectedTrial]!.duty!]" :key="duty.ratio">
     <p>普通主班占比 {{(duty.ratio*100).toFixed(1)}}%；整表加权参考：{{duty.weightedScore===null?'特殊工休比待定':duty.weightedScore.toFixed(2)}}。</p>
     <p v-if="duty.specialOperators.length">工休比待定：{{duty.specialOperators.join('、')}}。</p>
     <p>无特殊占比影响时使用主替班加权值；有特殊干员时，跨站影响暂按全表待定处理，以各站两套快照较低值作搭配排序，未为特殊干员设置固定工休比。</p>
     <div class="draft-table"><table><thead><tr><th>房间</th><th>主班82</th><th>替班82</th><th>普通占比加权参考</th></tr></thead><tbody><tr v-for="row in duty.rows" :key="row.roomId"><td>{{row.roomId}}</td><td>{{row.mainScore.toFixed(2)}}</td><td>{{row.backupScore.toFixed(2)}}</td><td>{{row.weightedScore===null?'特殊占比待定':row.weightedScore.toFixed(2)}}</td></tr></tbody></table></div>
     <ul><li v-for="(d,i) in duty.diagnostics" :key="i">{{d}}</li></ul>
    </template>
   </details>
   <button type="button" data-test="export-automatic" @click="exportGeneration">导出生成明细 JSON</button>
  </div>
  <p v-if="generationError" role="alert">{{generationError}}</p>
  <template v-if="result">
   <p data-test="draft-status">{{result.status==='draft'?'物理摆放已生成，尚需模拟验证':'未生成草案'}} · 已尝试 {{result.statesVisited}} 次</p>
   <ul class="draft-diagnostics"><li v-for="(d,i) in result.diagnostics" :key="i">{{d.message}}</li></ul>
   <template v-if="result.workspace">
    <div class="draft-table"><table><caption>组合与实际房间（同房支持已合并）</caption><thead><tr><th>组合</th><th>房间</th><th>干员</th></tr></thead><tbody><tr v-for="p in result.placements" :key="p.candidateId+p.roomKey"><td>{{names.get(p.candidateId)}}</td><td>{{getRoomDisplayName(p.roomId,result.workspace.mainPlan.facilities[p.roomId].type)}}</td><td>{{p.operatorIds.map(operatorName).join('、')}}</td></tr></tbody></table></div>
    <details><summary>查看主替班明细</summary><div class="draft-table"><table data-test="draft-roster"><thead><tr><th>房间</th><th>主班</th><th>候补或交换目标</th><th>分组</th></tr></thead><tbody><tr v-for="row in rosterRows" :key="row.key"><td>{{row.roomName}}</td><td>{{row.operatorName}}</td><td>{{row.role}}：{{row.replacementNames.join('、')||'未配置'}}</td><td>{{row.group||'未分组'}}</td></tr></tbody></table></div></details>
    <p>现有 Free 床位 {{result.restResources.freeBeds}} 个；新增最大分组需 {{result.restResources.minimumFreeBedsForNewGroup}} 个。缺少候补：{{result.restResources.missingReplacementIds.map(operatorName).join('、')||'无'}}。</p>
    <div class="draft-actions"><button type="button" data-test="simulate-draft" @click="emit('simulate',result.workspace)">模拟草案</button><button type="button" data-test="export-draft" @click="download">导出草案 Mower JSON</button></div>
    <p>模拟使用下方当前参数，结果标为“组合草案”。{{generationMode==='automatic'?'替班已进行有限组合与单席效率搜索；固定占比仅为阶段性估算。':'候补仅按设施技能匹配，未优化效率。'}}已有排班不会被覆盖。</p>
   </template>
   <details v-if="result.uncheckedConditions.length"><summary>保留待核验条件（{{result.uncheckedConditions.length}} 项）</summary><ul class="draft-conditions"><li v-for="(c,i) in result.uncheckedConditions" :key="i">{{c.text}}</li></ul></details>
  </template>
 </details>
</template>
<style scoped>
.roster-draft{margin:1rem 0;padding:1rem;border:1px solid #526570;border-radius:8px;background:#14202a;color:#dfebf1;overflow-wrap:anywhere}.roster-draft summary{font-weight:600;cursor:pointer}.roster-draft p{line-height:1.6}.draft-candidates{display:grid;gap:.5rem;max-height:240px;overflow:auto;border:1px solid #526570;padding:1rem}.draft-candidates label{display:flex;align-items:center;gap:.6rem}.draft-candidates input{flex-shrink:0}.draft-actions{display:flex;align-items:end;flex-wrap:wrap;gap:.7rem;margin:1rem 0}.draft-actions label{display:grid;gap:.3rem}.draft-actions input{width:120px;color:inherit;background:#101922;border:1px solid #63717d;padding:.5rem;border-radius:5px}.roster-draft select{color:inherit;background:#101922;border:1px solid #63717d;padding:.5rem;border-radius:5px}.draft-actions button{padding:.6rem .9rem;border:1px solid #95ab67;background:#c7e49b;color:#16210d;border-radius:5px;cursor:pointer}.draft-actions button:disabled{opacity:.5;cursor:default}.draft-table{overflow:auto;max-height:350px}.draft-table table{width:100%;border-collapse:collapse;min-width:460px}.draft-table th,.draft-table td{text-align:left;padding:.6rem;border-bottom:1px solid #42515e}.draft-table caption{text-align:left;padding:.7rem 0}.draft-table th{position:sticky;top:0;background:#14202a}.draft-diagnostics,.draft-conditions{line-height:1.7;padding-left:1.4rem}.draft-conditions{max-height:200px;overflow:auto}
</style>
