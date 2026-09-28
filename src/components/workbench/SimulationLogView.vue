<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ScheduleSimulationReport } from '../../simulator/scheduleSimulation'
import { getRoomDisplayName } from '../../workbench/operatorHelpers'
import { mowerReportMetrics } from '../../workbench/mowerReportMetrics'
import { downloadReportJson, serializeReportJson, type ExportReportMode } from '../../workbench/reportExport'
import ScheduleTimelineGantt from './ScheduleTimelineGantt.vue'

const props = defineProps<{
  report: ScheduleSimulationReport | null
  error?: string | null
}>()

const emit = defineEmits<{
  (e: 'clear'): void
}>()

const searchKeyword = ref('')
const selectedRoom = ref<string>('all')
const copySuccess = ref(false)
const mowerMetrics = computed(() => props.report ? mowerReportMetrics(props.report) : null)

const resourceLabels = [
  ['gold', '赤金（件）'],
  ['lmd', '龙门币'],
  ['exp', 'EXP 点数'],
  ['fragment', '源石碎片（件）'],
  ['orundum', '合成玉'],
  ['orirock', '固源岩（件）'],
  ['device', '装置（件）'],
  ['drone', '无人机（架）'],
] as const

const number = (n: number | undefined | null) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    : '0'

const signed = (n: number | undefined | null) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  return n > 0 ? '+' + number(n) : number(n)
}

const availableRooms = computed(() => {
  if (!props.report?.rooms) return []
  return props.report.rooms.map(r => ({
    id: r.roomId,
    label: getRoomDisplayName(r.roomId, r.roomType),
  }))
})

interface LogEventItem {
  time: number
  type: string
  roomId?: string
  amount?: number
  operators?: string[]
  operatorIds?: string[]
  backupName?: string
  active?: boolean
  timing?: string
}

const filteredEvents = computed<LogEventItem[]>(() => {
  if (!props.report?.events) return []
  const q = searchKeyword.value.trim().toLowerCase()
  return (props.report.events as unknown as LogEventItem[]).filter(e => {
    if (selectedRoom.value !== 'all' && e.roomId && e.roomId !== selectedRoom.value) {
      return false
    }
    if (!q) return true
    if (e.type.toLowerCase().includes(q)) return true
    if (e.backupName?.toLowerCase().includes(q)) return true
    if (e.roomId && e.roomId.toLowerCase().includes(q)) return true
    const ops = e.operatorIds || e.operators || []
    if (ops.some(id => id.toLowerCase().includes(q))) return true
    return false
  })
})

async function copyLogs(): Promise<void> {
  if (!props.report) return
  try {
    const text = serializeReportJson(props.report, 'summary')
    await navigator.clipboard.writeText(text)
    copySuccess.value = true
    setTimeout(() => {
      copySuccess.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy logs to clipboard:', err)
  }
}

function exportJson(mode: ExportReportMode = 'summary'): void {
  if (!props.report) return
  downloadReportJson(props.report, mode)
}
</script>

<template>
  <div class="simulation-log-view plan-container" data-test="simulation-log-view">
    <!-- Header -->
    <div class="log-header">
      <div class="log-title-group">
        <h3 class="log-title">模拟运行过程与计算日志</h3>
        <span class="log-subtitle">动态多周期工休演化、跑单结算、无人机分配及逐日收益明细</span>
      </div>
      <div class="log-actions">
        <button
          type="button"
          class="log-btn copy-btn"
          :disabled="!report"
          title="复制轻量产出报表 JSON（已剔除轨迹切片，可安全存入剪贴板）"
          data-test="copy-logs-btn"
          @click="copyLogs"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
          {{ copySuccess ? '已复制报表 JSON！' : '复制报表 JSON' }}
        </button>
        <button
          type="button"
          class="log-btn export-btn summary-btn"
          :disabled="!report"
          title="导出轻量产出收益报表（包含工效、工时、收支及诊断，~50KB）"
          data-test="export-summary-btn"
          @click="exportJson('summary')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          导出产出报表 (轻量)
        </button>
        <button
          type="button"
          class="log-btn export-btn debug-btn"
          :disabled="!report"
          title="导出包含全量时间切片、干员心情与工位占用原始轨迹的完整日志（文件较大，通常在 20MB~50MB）"
          data-test="export-full-btn"
          @click="exportJson('full')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/>
          </svg>
          导出全量轨迹 (Debug)
        </button>
      </div>
    </div>

    <!-- Error notice -->
    <div v-if="error" class="log-error-box">
      <span class="error-icon">✕</span>
      <span>{{ error }}</span>
    </div>

    <!-- Empty state -->
    <div v-if="!report && !error" class="log-empty-state">
      <div class="empty-icon">📋</div>
      <p class="empty-text">暂无模拟日志数据</p>
      <p class="empty-hint">在「基建排班」界面点击「计算产出」或在设置中运行模拟后，此处将呈现完整计算过程与事件流日志。</p>
    </div>

    <!-- Main log content -->
    <div v-if="report" class="log-body">
      <!-- Status Badge Row -->
      <div class="status-summary-bar">
        <span class="badge" :class="{ success: report.success, warning: !report.success }">
          {{ report.success ? '✓ 模拟计算完成' : '⚠ 模拟提前结束' }}
        </span>
        <span>实际模拟天数: <strong>{{ number(report.observedHours / 24) }}</strong> 天 ({{ number(report.observedHours) }} 小时)</span>
        <span>预热时长: <strong>{{ number(report.assumptions.warmupHours / 24) }}</strong> 天</span>
        <span>最大步长: <strong>{{ number(report.assumptions.maxStepHours * 60) }}</strong> 分钟</span>
        <span>总事件数: <strong>{{ report.events.length }}</strong></span>
      </div>

      <!-- Gantt Chart Timeline Visualization -->
      <ScheduleTimelineGantt :report="report" :initial-window-hours="24" initially-collapsed />

      <!-- Resource inflow/outflow balance table -->
      <section v-if="report.production" class="log-section">
        <h4 class="section-heading">采样期间收支与库存</h4>
        <div class="table-wrapper">
          <table class="log-table">
            <thead>
              <tr>
                <th>资源类别</th>
                <th>期初库存</th>
                <th>产出到账</th>
                <th>消耗支出</th>
                <th>净变动</th>
                <th>期末库存</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="[key, label] in resourceLabels" :key="key">
                <td>{{ label }}</td>
                <td>{{ number(report.production.sample.opening[key]) }}</td>
                <td>{{ number(report.production.sample.inflows[key]) }}</td>
                <td>{{ number(report.production.sample.outflows[key]) }}</td>
                <td :class="{ 'text-pos': (report.production.sample.net[key] ?? 0) > 0, 'text-neg': (report.production.sample.net[key] ?? 0) < 0 }">
                  {{ signed(report.production.sample.net[key]) }}
                </td>
                <td>{{ number(report.production.sample.closing[key]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="mowerMetrics" class="log-section">
        <h4 class="section-heading">Mower 报表口径对照（日均）</h4>
        <p>82 收益 {{ number(mowerMetrics.mower82) }}；经验 {{ number(mowerMetrics.exp) }}；赤金价值 {{ number(mowerMetrics.goldValue) }}；订单 {{ number(mowerMetrics.orderLmd) }}；龙舌兰额外价值 {{ number(mowerMetrics.tequilaGoldValue) }}。</p>
        <p>平均订单金额 {{ number(mowerMetrics.meanOrderValue) }}。龙舌兰额外价值仅用于报表折算，不增加赤金库存。</p>
        <p>Mower 工休图按心情记录变化估算；下方工作占比统计非疲劳工作时间，不能直接视为同一指标。</p>
      </section>

      <!-- Facility average efficiency table -->
      <section v-if="report.rooms && report.rooms.length > 0" class="log-section">
        <h4 class="section-heading">设施平均效率统计</h4>
        <div class="table-wrapper">
          <table class="log-table">
            <thead>
              <tr>
                <th>设施名称</th>
                <th>平均总效率</th>
                <th>在岗驻留时长</th>
                <th>采样完成件数（经验按份）</th>
                <th>经历轮换组合数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="room in report.rooms" :key="room.roomId">
                <td>{{ getRoomDisplayName(room.roomId, room.roomType) }}</td>
                <td><strong>{{ number(room.averageEfficiencyPercent) }}%</strong></td>
                <td>{{ number(room.occupiedHours) }} 小时</td>
                <td>{{ room.roomType==='manufacture' && report.production ? number(report.production.manufacturing.find(item=>item.roomId===room.roomId)?.sampleCompletedItems) : '—' }}</td>
                <td>{{ room.teams.length }} 组</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Operator Duty Statistics -->
      <section v-if="report.operators && report.operators.length > 0" class="log-section">
        <h4 class="section-heading">干员工休明细统计</h4>
        <div class="table-wrapper">
          <table class="log-table">
            <thead>
              <tr>
                <th>干员</th>
                <th>工作占比</th>
                <th>主班工时</th>
                <th>替班工时</th>
                <th>宿舍休息</th>
                <th>闲置待机</th>
                <th>疲劳占岗</th>
                <th>期末心情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="op in report.operators" :key="op.operatorId">
                <td><strong>{{ op.operatorName }}</strong></td>
                <td>{{ number(op.workFraction * 100) }}%</td>
                <td>{{ number(op.mainWorkHours) }} h</td>
                <td>{{ number(op.substituteWorkHours) }} h</td>
                <td>{{ number(op.restHours) }} h</td>
                <td>{{ number(op.idleHours) }} h</td>
                <td :class="{ 'text-danger': op.exhaustedHours > 0 }">{{ number(op.exhaustedHours) }} h</td>
                <td>{{ number(op.finalMorale) }} / 24</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Diagnostics / Unquantified / Alerts -->
      <section v-if="report.diagnostics && report.diagnostics.length > 0" class="log-section">
        <h4 class="section-heading">诊断提示与未量化规则 ({{ report.diagnostics.length }})</h4>
        <ul class="diagnostic-list">
          <li v-for="(d, i) in report.diagnostics" :key="i" class="diagnostic-item">
            <span class="diagnostic-code">[{{ d.code }}]</span>
            <span class="diagnostic-msg">{{ d.message }}</span>
          </li>
        </ul>
      </section>

      <!-- Event Stream Log Filter & View -->
      <section class="log-section">
        <div class="events-header">
          <h4 class="section-heading">事件流明细记录 ({{ filteredEvents.length }} / {{ report.events.length }})</h4>
          <div class="filter-controls">
            <input
              v-model="searchKeyword"
              type="text"
              class="search-input"
              placeholder="搜索事件类型、副表名称或干员..."
            />
            <select v-model="selectedRoom" class="room-select">
              <option value="all">全部设施</option>
              <option v-for="r in availableRooms" :key="r.id" :value="r.id">
                {{ r.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="event-stream-box">
          <div v-for="(e, idx) in filteredEvents.slice(0, 500)" :key="idx" class="event-row">
            <span class="event-time">T+{{ number(e.time) }}h</span>
            <span class="event-badge" :class="e.type">{{ e.type }}</span>
            <span v-if="e.backupName" class="event-room">{{e.backupName}} · {{e.type==='backup-task'?'执行任务':e.active?'启用':'退出'}} · {{e.timing}}</span>
            <span v-if="e.roomId" class="event-room">{{ getRoomDisplayName(e.roomId) }}</span>
            <span v-if="e.amount !== undefined" class="event-amount">数量: {{ e.amount }}</span>
            <span v-if="(e.operatorIds || e.operators)?.length" class="event-ops">
              干员: {{ (e.operatorIds || e.operators)?.join(', ') }}
            </span>
          </div>
          <div v-if="filteredEvents.length > 500" class="more-events-hint">
            仅展示前 500 条事件，完整记录请点击右上角「导出产出报表」或「导出全量轨迹」
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.simulation-log-view {
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  padding: 16px 20px;
  background: #18181c;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-sizing: border-box;
  color: #e9f2f4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.log-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.log-subtitle {
  font-size: 12px;
  color: #8da5ac;
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 3px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: #e9f2f4;
  transition: all 0.2s;
}

.log-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}

.log-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.copy-btn {
  border-color: rgba(66, 214, 199, 0.4);
  color: #42d6c7;
}

.summary-btn {
  border-color: rgba(66, 214, 199, 0.4);
  background: rgba(66, 214, 199, 0.12);
  color: #42d6c7;
}

.summary-btn:hover:not(:disabled) {
  background: rgba(66, 214, 199, 0.22);
}

.debug-btn {
  border-color: rgba(255, 255, 255, 0.15);
  color: #a8bcc2;
}

.debug-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

.log-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  text-align: center;
}

.empty-icon {
  font-size: 42px;
  margin-bottom: 12px;
  opacity: 0.6;
}

.empty-text {
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 6px;
}

.empty-hint {
  font-size: 12px;
  color: #8da5ac;
  max-width: 420px;
  line-height: 1.6;
  margin: 0;
}

.status-summary-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 14px;
  margin: 16px 0;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 4px;
  font-size: 12px;
  color: #b6c6d1;
}

.badge {
  padding: 2px 8px;
  border-radius: 3px;
  font-weight: 600;
  font-size: 11px;
}

.badge.success {
  background: rgba(24, 160, 88, 0.2);
  color: #63e2b7;
  border: 1px solid rgba(24, 160, 88, 0.4);
}

.badge.warning {
  background: rgba(240, 160, 32, 0.2);
  color: #f2c97d;
  border: 1px solid rgba(240, 160, 32, 0.4);
}

.log-section {
  margin-top: 20px;
}

.section-heading {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: #42d6c7;
}

.table-wrapper {
  overflow-x: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.log-table th,
.log-table td {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.log-table th:first-child,
.log-table td:first-child {
  text-align: left;
}

.log-table th {
  background: rgba(255, 255, 255, 0.04);
  color: #8da5ac;
  font-weight: 600;
}

.text-pos {
  color: #63e2b7;
}

.text-neg {
  color: #ff7875;
}

.text-danger {
  color: #ff7875;
  font-weight: 600;
}

.diagnostic-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diagnostic-item {
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 3px solid rgba(66, 214, 199, 0.4);
  border-radius: 2px;
}

.diagnostic-code {
  font-family: Consolas, monospace;
  color: #42d6c7;
  margin-right: 6px;
  font-size: 11px;
}

.events-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.filter-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-input {
  height: 28px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  color: #ffffff;
  font-size: 12px;
  outline: none;
}

.search-input:focus {
  border-color: #42d6c7;
}

.room-select {
  height: 28px;
  padding: 0 8px;
  background: #141920;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  color: #ffffff;
  font-size: 12px;
  outline: none;
}

.event-stream-box {
  max-height: 380px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: Consolas, monospace;
  font-size: 11px;
}

.event-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 2px;
}

.event-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.event-time {
  color: #8da5ac;
  min-width: 60px;
}

.event-badge {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  color: #e9f2f4;
  font-size: 10px;
}

.event-badge.shift-on {
  background: rgba(24, 160, 88, 0.25);
  color: #63e2b7;
}

.event-badge.shift-off {
  background: rgba(240, 160, 32, 0.25);
  color: #f2c97d;
}

.event-badge.order-completed {
  background: rgba(32, 128, 240, 0.25);
  color: #70c0e8;
}

.event-room {
  color: #42d6c7;
}

.event-amount {
  color: #f0bd5b;
}

.more-events-hint {
  text-align: center;
  padding: 8px;
  color: #8da5ac;
  font-size: 11px;
}

.log-error-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(208, 48, 80, 0.15);
  border: 1px solid rgba(208, 48, 80, 0.4);
  border-radius: 4px;
  color: #ff7875;
  font-size: 13px;
  margin-top: 12px;
}
</style>
