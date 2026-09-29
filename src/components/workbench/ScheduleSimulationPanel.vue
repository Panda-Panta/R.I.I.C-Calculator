<script setup lang="ts">
import {ref,watch,onBeforeUnmount,computed} from 'vue'
import {scoreProduction} from '../../optimizer/productionObjective'
import OperatorInventoryPanel from './OperatorInventoryPanel.vue'
import ControlImpactPanel from './ControlImpactPanel.vue'
import RosterIncomeSearchPanel from './RosterIncomeSearchPanel.vue'
import type {RosterDraftResult} from '../../optimizer/rosterDraft'
import RosterDraftPanel from './RosterDraftPanel.vue'
import type {OwnedOperatorInput} from '../../domain/operatorInventory'
import {getRoomDisplayName} from '../../workbench/operatorHelpers'
import type {RosterWorkspace} from '../../workbench/model'
import type {ScheduleSimulationReport} from '../../simulator/scheduleSimulation'
import ScheduleTimelineGantt from './ScheduleTimelineGantt.vue'
const props=defineProps<{workspace:RosterWorkspace}>()
const sampleDays=ref(14),warmupDays=ref(7),step=ref(.25),warmupModel=ref<'continuous'|'hourly'>('continuous')
const settingsKey='riic-mower-simulation-settings-v1'
const savedSettings=(()=>{try{const value=JSON.parse(localStorage.getItem(settingsKey)??'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}})()
const restingPercent=ref(typeof savedSettings.restingPercent==='number'&&Number.isFinite(savedSettings.restingPercent)&&savedSettings.restingPercent>=0&&savedSettings.restingPercent<=100?savedSettings.restingPercent:65)
const rescuePercent=ref(typeof savedSettings.rescuePercent==='number'&&Number.isFinite(savedSettings.rescuePercent)&&savedSettings.rescuePercent>=0&&savedSettings.rescuePercent<=100?savedSettings.rescuePercent:75)
const fiammettaPercent=ref(typeof savedSettings.fiammettaPercent==='number'&&Number.isFinite(savedSettings.fiammettaPercent)&&savedSettings.fiammettaPercent>=0&&savedSettings.fiammettaPercent<=100?savedSettings.fiammettaPercent:90)
const fiammettaFool=ref(typeof savedSettings.fiammettaFool==='boolean'?savedSettings.fiammettaFool:true),freeRoom=ref(typeof savedSettings.freeRoom==='boolean'?savedSettings.freeRoom:false)
const runOrderMode=ref<'ideal'|'grandet'>(savedSettings.runOrderMode==='grandet'?'grandet':'ideal'),droneTarget=ref<'gold'|'exp'|'none'>('gold')
const runOrderLeadSeconds=ref(typeof savedSettings.runOrderLeadSeconds==='number'&&Number.isFinite(savedSettings.runOrderLeadSeconds)?savedSettings.runOrderLeadSeconds:180)
const runOrderBufferSeconds=ref(typeof savedSettings.runOrderBufferSeconds==='number'&&Number.isFinite(savedSettings.runOrderBufferSeconds)?savedSettings.runOrderBufferSeconds:15)
const initialGold=ref(0),initialLmd=ref(0),initialOrirock=ref(0),initialDevice=ref(0),initialDrone=ref(0),seed=ref(1),collectionIntervalHours=ref(0)
const inventoryMode=ref<'unlimited'|'finite'>('unlimited')
const outputMode=ref<'potential'|'settled'>('potential')
const productionInputs=[outputMode,inventoryMode,runOrderMode,droneTarget,initialGold,initialLmd,initialOrirock,initialDevice,initialDrone,seed,collectionIntervalHours]
const draftForSearch=ref<RosterDraftResult|null>(null)
const searchOptions=computed(()=>({maxStepHours:step.value,warmupModel:warmupModel.value,production:{inventoryMode:inventoryMode.value,runOrderMode:runOrderMode.value,...(runOrderMode.value==='grandet'?{runOrderLeadSeconds:runOrderLeadSeconds.value,runOrderBufferSeconds:runOrderBufferSeconds.value}:{}),droneTarget:droneTarget.value,initialResources:{gold:initialGold.value,lmd:initialLmd.value,orirock:initialOrirock.value,device:initialDevice.value,drone:initialDrone.value},seed:seed.value,collectionIntervalHours:collectionIntervalHours.value}}))
const searchAssumptions=computed(()=>({restingThreshold:restingPercent.value/100,rescueThreshold:rescuePercent.value/100,fiammettaFool:fiammettaFool.value,fiammettaThreshold:fiammettaPercent.value/100,freeRoom:freeRoom.value,operationDurationHours:0}))
const simulationProduction=computed(()=>({...searchOptions.value.production,outputMode:outputMode.value,...(outputMode.value==='potential'?{initialResources:{drone:initialDrone.value},collectionIntervalHours:0}:{})}))
const reportBasis=ref('当前排班')
const running=ref(false),report=ref<ScheduleSimulationReport|null>(null),error=ref('')
const completedOutput=computed(()=>{const r=report.value,c=r?.production?.sample.completed;return c&&r.observedHours>0?scoreProduction(c,r.observedHours):null})
const rosterDeferred=computed(()=>report.value?.diagnostics.some(d=>d.code==='group-blocked')??false)
const productionComplete=computed(()=>report.value?.success===true&&report.value?.production?.success===true&&!rosterDeferred.value)
const inventory=ref<{enabled:boolean;valid:boolean;entries:OwnedOperatorInput[]}>({enabled:false,valid:true,entries:[]})
function updateInventory(value:typeof inventory.value){inventory.value=value;clear()}
let worker:Worker|undefined
function cancel(){worker?.terminate();worker=undefined;running.value=false}
function clear(){cancel();report.value=null;error.value=''}
watch(()=>props.workspace,clear,{deep:true})
watch([sampleDays,warmupDays,step,warmupModel,...productionInputs],clear)
watch([restingPercent,rescuePercent,fiammettaPercent,fiammettaFool,freeRoom,runOrderMode,runOrderLeadSeconds,runOrderBufferSeconds],()=>{
 try{localStorage.setItem(settingsKey,JSON.stringify({restingPercent:restingPercent.value,rescuePercent:rescuePercent.value,fiammettaPercent:fiammettaPercent.value,fiammettaFool:fiammettaFool.value,freeRoom:freeRoom.value,runOrderMode:runOrderMode.value,runOrderLeadSeconds:runOrderLeadSeconds.value,runOrderBufferSeconds:runOrderBufferSeconds.value}))}catch{}
 clear()
})
onBeforeUnmount(cancel)
function run(targetWorkspace:RosterWorkspace=props.workspace,basis='当前排班'){
 clear()
 reportBasis.value=basis
 if(inventory.value.enabled&&!inventory.value.valid){error.value='请先修正干员库中的输入错误';return}
 if(!Number.isFinite(restingPercent.value)||restingPercent.value<0||restingPercent.value>100){error.value='休息阈值须为 0–100%';return}
 if(!Number.isFinite(rescuePercent.value)||rescuePercent.value<0||rescuePercent.value>100){error.value='急救阈值须为 0–100%';return}
 if(!Number.isFinite(fiammettaPercent.value)||fiammettaPercent.value<0||fiammettaPercent.value>100){error.value='菲亚阈值须为 0–100%';return}
 if(!Number.isFinite(sampleDays.value)||sampleDays.value<=0||!Number.isFinite(warmupDays.value)||warmupDays.value<0){error.value='采样天数应大于 0，预热天数不能为负';return}
 if(runOrderMode.value==='grandet'&&(!Number.isFinite(runOrderLeadSeconds.value)||runOrderLeadSeconds.value<=0||runOrderLeadSeconds.value>3600||!Number.isFinite(runOrderBufferSeconds.value)||runOrderBufferSeconds.value<0||runOrderBufferSeconds.value>3600)){error.value='葛朗台跑单前置须大于 0 且不超过 3600 秒，缓冲须为 0–3600 秒';return}
 if((outputMode.value==='potential'||inventoryMode.value==='unlimited'?[initialDrone]:[initialGold,initialLmd,initialOrirock,initialDevice,initialDrone]).some(n=>!Number.isFinite(n.value)||n.value<0)){error.value='初始库存须为不小于 0 的数值';return}
 if(!Number.isSafeInteger(seed.value)||seed.value<0||seed.value>4294967295||(outputMode.value==='settled'&&(!Number.isFinite(collectionIntervalHours.value)||collectionIntervalHours.value<0))){error.value='随机种子须为 0–4294967295 的整数，收取间隔不能为负';return}
 running.value=true
 try{
  worker=new Worker(new URL('../../simulator/scheduleSimulationWorker.ts',import.meta.url),{type:'module'})
  const currentWorker=worker
  worker.onmessage=event=>{if(worker!==currentWorker)return;report.value=event.data.report??null;error.value=event.data.error??'';cancel()}
  worker.onerror=event=>{if(worker!==currentWorker)return;error.value=event.message||'模拟执行失败';cancel()}
  worker.postMessage({workspace:JSON.parse(JSON.stringify(targetWorkspace)),options:{...(inventory.value.enabled?{operatorInventory:JSON.parse(JSON.stringify(inventory.value.entries))}:{}),sampleHours:sampleDays.value*24,warmupHours:warmupDays.value*24,maxStepHours:step.value,warmupModel:warmupModel.value,recordSegments:true,production:JSON.parse(JSON.stringify(simulationProduction.value))},assumptions:{...searchAssumptions.value}})
 }catch(e){error.value=e instanceof Error?e.message:String(e);cancel()}
}
function download(){if(!report.value)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report.value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='心情与产出模拟.json';a.click();URL.revokeObjectURL(url)}
const resourceLabels=[['gold','赤金（件）'],['lmd','龙门币'],['exp','EXP 点数'],['fragment','源石碎片（件）'],['orundum','合成玉'],['orirock','固源岩（件）'],['device','装置（件）'],['drone','无人机（架）']] as const
const signed=(n:number)=>n>0?'+'+number(n):number(n)
const number=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:2})
</script>
<template>
 <section class="schedule-simulation" aria-labelledby="schedule-simulation-title">
  <h2 id="schedule-simulation-title">心情与产出模拟</h2>
  <p>按实际主替班、休息床位及暖机时间计算效率，默认计算不受库存和缺金限制的直观产出。线索交流固定关闭。休息阈值可调整；宿舍满氛围，常规换班和收取的原版等待计入模拟。</p>
  <OperatorInventoryPanel @change="updateInventory" />
  <RosterDraftPanel :workspace="workspace" :inventory="inventory" @invalidate="clear" @draft-change="draftForSearch=$event" @simulate="draft=>run(draft,'组合草案')" />
  <div class="simulation-controls">
   <label>预热（天）<input v-model.number="warmupDays" type="number" min="0" step="1" /></label>
   <label>采样（天）<input v-model.number="sampleDays" data-test="sample-days" type="number" min="1" step="1" /></label>
   <label>暖机增长<select v-model="warmupModel"><option value="continuous">连续增长（假设）</option><option value="hourly">整小时跳变（假设）</option></select></label>
   <button type="button" data-test="simulate-schedule" :disabled="running" @click="run()">{{running?'正在模拟…':'运行模拟'}}</button>
   <button v-if="running" type="button" @click="cancel">取消模拟</button>
  </div>
  <div class="simulation-controls mower-settings">
   <label>休息阈值（%）<input v-model.number="restingPercent" data-test="resting-threshold" type="number" min="0" max="100" step="0.5" /></label>
   <label>急救阈值（%）<input v-model.number="rescuePercent" data-test="rescue-threshold" type="number" min="0" max="100" step="1" /></label>
   <label><input v-model="fiammettaFool" data-test="fiammetta-fool" type="checkbox" />菲亚梅塔防呆</label>
   <label>菲亚阈值（%）<input v-model.number="fiammettaPercent" data-test="fiammetta-threshold" type="number" min="0" max="100" step="1" :disabled="fiammettaFool" /></label>
   <label><input v-model="freeRoom" data-test="free-room" type="checkbox" />满心情闲人离宿</label>
  </div>
  <p class="simulation-note">菲亚防呆开启时固定充心情不高于 90% 的候选；关闭后优先按菲亚阈值选人，若均高于阈值则充心情最低者。整体心情不高于休息阈值 × 急救阈值时，忽视高优人数限制。</p>
  <div class="simulation-controls production-controls">
   <label>产出口径<select v-model="outputMode" data-test="output-mode"><option value="potential">完成产出</option><option value="settled">收取记录</option></select></label>
   <label>材料库存<select v-model="inventoryMode" data-test="inventory-mode" :disabled="outputMode==='potential'"><option value="unlimited">无限（默认）</option><option value="finite">有限</option></select></label>
   <label>跑单方式<select v-model="runOrderMode" data-test="run-order-mode"><option value="ideal">理想跑单（默认）</option><option value="grandet">葛朗台跑单</option></select></label>
   <label v-if="runOrderMode==='grandet'">跑单前置（秒）<input v-model.number="runOrderLeadSeconds" data-test="run-order-lead" type="number" min="1" max="3600" step="1" /></label>
   <label v-if="runOrderMode==='grandet'">葛朗台缓冲（秒）<input v-model.number="runOrderBufferSeconds" data-test="run-order-buffer" type="number" min="0" max="3600" step="1" /></label>
   <label>待办无人机设施<select v-model="droneTarget" data-test="drone-target"><option value="gold">加速赤金</option><option value="exp">加速作战记录</option><option value="none">不用</option></select></label>
  </div>
  <p class="simulation-note" data-test="simulation-controls-scope">以上设置用于“运行模拟”，不影响旧版快速估算；更改后需要重新运行。</p>
  <p v-if="runOrderMode==='ideal'" class="simulation-note">贸易站替补位中的但书、龙舌兰、佩佩、可露希尔及 U-Official 均识别为跑单干员，不参与普通接班。理想跑单在新单开始时应用佩佩／可露希尔订单模式，在普通订单完成时应用其他跑单效果；保留 Mower 订单任务唤醒，不执行临时换人或跑单等待。</p>
  <p v-else class="simulation-note">葛朗台跑单执行 Mower 临时换人、等待、心情消耗与恢复；前置和缓冲时间按上方设置。</p>
  <details class="simulation-idle production-settings"><summary>随机种子、无人机与可选库存设置</summary>
   <p v-if="outputMode==='potential'">材料默认无限；初始无人机和随机种子参与计算。收取由 Mower 任务决定，设施容量仍有限。</p><p v-else>默认材料库存无限。选择有限库存后，初始材料从预热开始计入；收取时间由 Mower 任务决定。</p>
   <div class="simulation-controls">
    <label>赤金（件）<input v-model.number="initialGold" data-test="initial-gold" :disabled="outputMode==='potential'||inventoryMode==='unlimited'" type="number" min="0" step="1" /></label>
    <label>龙门币<input v-model.number="initialLmd" data-test="initial-lmd" :disabled="outputMode==='potential'||inventoryMode==='unlimited'" type="number" min="0" step="1" /></label>
    <label>固源岩（件）<input v-model.number="initialOrirock" data-test="initial-orirock" :disabled="outputMode==='potential'||inventoryMode==='unlimited'" type="number" min="0" step="1" /></label>
    <label>装置（件）<input v-model.number="initialDevice" data-test="initial-device" :disabled="outputMode==='potential'||inventoryMode==='unlimited'" type="number" min="0" step="1" /></label>
    <label>无人机（架）<input v-model.number="initialDrone" data-test="initial-drone" type="number" min="0" max="235" step="1" /></label>
    <label>随机种子<input v-model.number="seed" data-test="production-seed" type="number" min="0" max="4294967295" step="1" /></label>
    <label>收取间隔（Mower 自动）<input v-model.number="collectionIntervalHours" data-test="collection-interval" disabled type="number" min="0" step="0.25" /></label>
   </div>
   <p>相同种子可复现同一组订单抽样。碎片默认使用固源岩配方；装置库存仅在选择对应配方时消耗。</p>
  </details>
  <details class="simulation-idle" data-test="scheduling-external-conditions"><summary>影响跑单与排班的外部条件</summary>
   <p>线索交流固定关闭，Party Time 为空。材料库存默认无限，设施容量和无人机数量按实际规则计算。</p>
   <p>当前条件：初始心情 24，宿舍按等级满氛围；未导入干员库时从全体干员中选择闲置候选，导入后以库内名单为闲置候选。原排班干员下班后仍可参与 Free 选人。休息、急救和菲亚阈值、菲亚梅塔防呆、满心情闲人离宿，以及无人机目标和数量均按上方设置。</p>
   <p>待办无人机检查间隔 3 小时、使用门槛 100 架；葛朗台跑单使用当前前置与缓冲设置。主副表的候补顺序、绑组、用尽、回满、优先级和黑名单影响换班。</p>
   <p>本次不注入维护停服、加工、专精或其他外部任务。普通换人、收取按原版显式等待；葛朗台模式另计跑单换人等待。稳定页面与识别零耗时为模拟输入。初始在岗状态、预热、暖机规则和订单随机种子会影响长期结果。</p>
  </details>
  <p class="simulation-note">效率包含基本效率 100%。直观产出按采样完成数计分，实际收支口径另计到账；预热长度及步长可调整，用于检查结果是否稳定。</p>
  <ControlImpactPanel :workspace="workspace" :inventory="inventory" />
  <RosterIncomeSearchPanel :workspace="workspace" :inventory="inventory" :options="searchOptions" :assumptions="searchAssumptions" :draft="draftForSearch" />
  <p v-if="error" role="alert" class="simulation-error">{{error}}</p>
  <template v-if="report">
   <p class="simulation-note">正在查看：{{reportBasis}}</p>
   <p role="status">{{report.success?'模拟窗口已完成':'模拟未完成'}} · 实际采样 {{number(report.observedHours/24)}} 天 <button type="button" @click="download">导出明细 JSON</button></p>
   <p v-if="rosterDeferred" data-test="roster-deferred" class="simulation-error">仍有换班延后未恢复，请查看诊断；此结果不能作为稳定日均结论。</p>
   <ScheduleTimelineGantt :report="report" @request-simulate="run()" />
   <details v-if="(report.events??[]).some(e=>e.type==='backup-plan')" data-test="backup-plan-events">
    <summary>副表切换记录（{{(report.events??[]).filter(e=>e.type==='backup-plan').length}} 次）</summary>
    <p>按实际心情和位置判断条件；下表显示采样期间的切换。完整任务记录可导出明细 JSON。</p>
    <table><thead><tr><th>模拟小时</th><th>副表</th><th>状态</th><th>阶段</th></tr></thead><tbody>
     <tr v-for="(event,index) in (report.events??[]).filter(e=>e.type==='backup-plan')" :key="index"><td>{{number(event.time)}}</td><td>{{event.backupName}}</td><td>{{event.active?'启用':'退出'}}</td><td>{{event.timing}}</td></tr>
    </tbody></table>
   </details>
   <section v-if="report.production" aria-label="采样产出与库存" class="production-results">
    <p :class="{'simulation-error':!report.production.success}" data-test="production-status">{{report.production.success?'产出计算窗口已完成':'产出策略未完整执行'}}<span v-if="!report.production.success">，原因见下方假设与待核实项。</span></p>
    <template v-if="report.production.assumptions?.outputMode==='potential'&&completedOutput">
     <p data-test="completed-production-score">{{productionComplete?'每日综合产出':rosterDeferred?'换班延后的折算值（不可作为稳定日均结论）':'未完成采样的折算值（不可作为日均结论）'}}：{{number(completedOutput.total)}} = {{number(completedOutput.exp)}} EXP + 0.8 × {{number(completedOutput.goldValue)}} 赤金价值 + 0.2 × {{number(completedOutput.orderValue)}} 订单面值</p>
     <p class="simulation-note">按采样完成产物折算每日，预热不计入。忽略库存、缺金及存仓/收取阻塞，不扣赤金交易成本。原始完成数量与测算明细可导出。</p>
    </template>
    <template v-else>
    <p class="simulation-note">下表只计实际采样期间的收取到账与支出，期初库存包含预热结余。尚未收取的产品不计入到账；净变动不等于总产量。</p>
    <div class="simulation-table"><table><caption>采样期间产出与库存</caption><thead><tr><th>资源</th><th>期初库存</th><th>到账</th><th>支出</th><th>净变动</th><th>期末库存</th></tr></thead><tbody>
     <tr v-for="[key,label] in resourceLabels" :key="key" :data-test="'production-'+key"><td>{{label}}</td><td>{{number(report.production.sample.opening[key]??0)}}</td><td>{{number(report.production.sample.inflows[key]??0)}}</td><td>{{number(report.production.sample.outflows[key]??0)}}</td><td>{{signed(report.production.sample.net[key]??0)}}</td><td>{{number(report.production.sample.closing[key]??0)}}</td></tr>
    </tbody></table></div>
    </template>
    <p>期末无人机：{{number(report.production.drones.stock)}} / {{number(report.production.drones.capacity)}} 架</p>
   </section>
   <div class="simulation-table"><table><caption>设施平均效率</caption><thead><tr><th>设施</th><th>总效率</th><th>共同在岗组合数</th></tr></thead><tbody><tr v-for="room in report.rooms" :key="room.roomId"><td>{{getRoomDisplayName(room.roomId,room.roomType)}}</td><td>{{number(room.averageEfficiencyPercent)}}%</td><td>{{room.teams.length}}</td></tr></tbody></table></div>
   <div class="simulation-table"><table><caption>干员工休统计（小时）</caption><thead><tr><th>干员</th><th>工作占比</th><th>主班</th><th>替班</th><th>宿舍休息</th><th>闲置</th><th>疲劳占岗</th><th>末心情</th></tr></thead><tbody><tr v-for="op in report.operators" :key="op.operatorId"><td>{{op.operatorName}}</td><td>{{number(op.workFraction*100)}}%</td><td>{{number(op.mainWorkHours)}}</td><td>{{number(op.substituteWorkHours)}}</td><td>{{number(op.restHours)}}</td><td>{{number(op.idleHours)}}</td><td>{{number(op.exhaustedHours)}}</td><td>{{number(op.finalMorale)}}</td></tr></tbody></table></div>
   <details open><summary>假设与待核实项（{{report.diagnostics.length}}）</summary><ul><li v-for="(d,index) in report.diagnostics" :key="index">{{d.message}}</li></ul></details>
  </template>
 </section>
</template>
<style scoped>
.schedule-simulation{margin:1.4rem 0;padding:1.5rem;border:1px solid #41505d;border-radius:12px;scroll-margin-top:90px;background:#17212a;color:#e3ebf2}.schedule-simulation h2{margin:0 0 .6rem}.schedule-simulation p{line-height:1.6}.simulation-controls{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}.production-controls{margin-top:1rem}.simulation-controls label{display:grid;gap:6px;font-size:.85rem}.simulation-controls input{width:100px}.schedule-simulation input,.schedule-simulation select,.schedule-simulation textarea{color:inherit;background:#101922;border:1px solid #63717d;padding:9px;border-radius:5px}.schedule-simulation button{padding:10px 15px;border-radius:5px;border:1px solid #95ab67;background:#c7e49b;color:#16210d;cursor:pointer}.schedule-simulation button:disabled{opacity:.5;cursor:wait}.simulation-table{overflow:auto;max-height:440px;margin:1rem 0}.simulation-table table{width:100%;border-collapse:collapse;white-space:nowrap}.simulation-table th,.simulation-table td{text-align:right;padding:9px;border-bottom:1px solid #3a4651}.simulation-table th:first-child,.simulation-table td:first-child{text-align:left}.simulation-table caption{text-align:left;padding:10px 0;font-weight:600}.simulation-table thead{position:sticky;top:0;background:#17212a}.simulation-error{color:#ffb4ab}.simulation-note,.simulation-idle{color:#b6c6d1;font-size:.9rem}.simulation-idle{margin-top:1rem}.simulation-idle textarea{width:min(100%,600px);box-sizing:border-box}.schedule-simulation input[type=checkbox]{width:auto}.mower-settings label{align-items:center}.schedule-simulation summary{cursor:pointer}.schedule-simulation li{line-height:1.7;margin:.4rem 0}
</style>
