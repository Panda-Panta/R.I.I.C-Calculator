<template>
  <NModal
    :show="open"
    preset="card"
    title="排班海报分享"
    :style="{ width: '920px', maxWidth: '96vw', maxHeight: '92vh' }"
    @update:show="!$event && emit('close')"
  >
    <div class="poster-modal-content">
      <!-- Toolbar Controls -->
      <div class="poster-actions-bar">
        <div class="status-tip">
          <span v-if="actionStatus" class="status-msg" :class="actionStatus.type">
            {{ actionStatus.message }}
          </span>
          <span v-else class="hint-msg">高清海报已根据当前排班与收益测算自动生成，可直接下载或复制分享。</span>
        </div>
        <div class="btn-group">
          <NButton
            type="primary"
            secondary
            size="small"
            data-test="copy-poster-btn"
            :loading="isProcessing"
            @click="handleCopyPoster"
          >
            📋 复制图片
          </NButton>
          <NButton
            type="primary"
            size="small"
            data-test="download-poster-btn"
            :loading="isProcessing"
            @click="handleDownloadPoster"
          >
            📥 下载高清海报 (PNG)
          </NButton>
        </div>
      </div>

      <!-- Scrollable Preview Area -->
      <div class="poster-preview-viewport">
        <!-- Renderable Poster Canvas -->
        <div class="roster-poster" ref="posterRef" data-test="roster-poster">
          <!-- Poster Header -->
          <div class="poster-header">
            <div class="brand-line">
              <span class="brand-tag">RHODES ISLAND BASE SCHEDULING</span>
              <span class="brand-badge">{{ layoutModeBadge }} 模式</span>
            </div>
            <h2 class="poster-title">{{ workspace.name || '罗德岛基建排班方案' }}</h2>
            <div class="poster-meta">
              <span>生成时间: {{ formattedTime }}</span>
              <span>·</span>
              <span>方案标准: Mower 兼容</span>
              <span>·</span>
              <span>基建版本: 24小时自动化排班</span>
            </div>
          </div>

          <!-- Income & Output Summary Section (if report present) -->
          <div v-if="calculationReport && calculationReport.summary" class="poster-income-card">
            <div class="income-head">
              <span class="income-label">基建产出综合测算（自定义加权评分）</span>
              <div class="power-tag" :class="{ danger: !calculationReport.power.sufficient }">
                ⚡ 发电 {{ calculationReport.power.generation }} / 耗电 {{ calculationReport.power.consumption }} (余量 {{ calculationReport.power.margin >= 0 ? '+' : '' }}{{ calculationReport.power.margin }})
              </div>
            </div>
            <div class="income-grid">
              <div class="income-metric highlight">
                <span class="m-val">{{ formatNumber(calculationReport.summary.totalScore82, 1) }}</span>
                <span class="m-sub">加权综合日产出</span>
              </div>
              <div class="income-metric">
                <span class="m-val text-exp">{{ formatNumber(calculationReport.summary.exp, 0) }}</span>
                <span class="m-sub">作战记录/日</span>
              </div>
              <div class="income-metric">
                <span class="m-val text-lmd">{{ formatNumber(calculationReport.summary.orderLmd, 0) }}</span>
                <span class="m-sub">龙门币收益/日</span>
              </div>
              <div class="income-metric">
                <span class="m-val text-gold">{{ formatNumber(calculationReport.summary.netGoldCount, 1) }}</span>
                <span class="m-sub">赤金净产出/日</span>
              </div>
              <div class="income-metric">
                <span class="m-val text-drone">{{ calculationReport.drones }}</span>
                <span class="m-sub">无人机/日</span>
              </div>
            </div>
          </div>

          <!-- Facilities Overview Matrix -->
          <div class="poster-matrix">
            <!-- 1. Manufacture Column (制造站) -->
            <div class="facility-section-block">
              <div class="block-header manufacture-header">
                <span class="header-icon">⚙️</span>
                <span class="header-title">制造站 ({{ manufactureFacilities.length }} 间)</span>
              </div>
              <div class="room-cards-stack">
                <div
                  v-for="room in manufactureFacilities"
                  :key="room.roomId"
                  class="poster-room-card manufacture-card"
                >
                  <div class="room-card-head">
                    <span class="room-tag">Lv.{{ room.level }} {{ getRoomDisplayName(room.roomId) }}</span>
                    <span class="product-badge" :class="room.product || 'gold'">
                      {{ getProductLabel(room.product) }}
                    </span>
                  </div>
                  <div class="room-occupants">
                    <div
                      v-for="(slot, idx) in room.slots"
                      :key="idx"
                      class="occupant-chip"
                    >
                      <img
                        :src="getAvatarForSlot(slot)"
                        :alt="getSlotName(slot)"
                        class="chip-avatar"
                        @error="handleImgError"
                      />
                      <span class="chip-name">{{ getSlotName(slot) }}</span>
                      <span v-if="slot.groupId" class="chip-group">{{ slot.groupId }}</span>
                    </div>
                  </div>
                  <!-- Substitutes if any -->
                  <div v-if="hasReplacements(room)" class="room-subs-line">
                    <span class="sub-label">候补:</span>
                    <span class="sub-names">{{ getReplacementNames(room) }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 2. Trading & Power Column (贸易站与发电站) -->
            <div class="facility-section-block">
              <!-- Trading Section -->
              <div class="block-header trading-header">
                <span class="header-icon">📈</span>
                <span class="header-title">贸易站 ({{ tradingFacilities.length }} 间)</span>
              </div>
              <div class="room-cards-stack mb-12">
                <div
                  v-for="room in tradingFacilities"
                  :key="room.roomId"
                  class="poster-room-card trading-card"
                >
                  <div class="room-card-head">
                    <span class="room-tag">Lv.{{ room.level }} {{ getRoomDisplayName(room.roomId) }}</span>
                    <span class="product-badge trading-product">
                      {{ room.product === 'orundum' ? '源石订单' : '龙门商贸' }}
                    </span>
                  </div>
                  <div class="room-occupants">
                    <div
                      v-for="(slot, idx) in room.slots"
                      :key="idx"
                      class="occupant-chip"
                    >
                      <img
                        :src="getAvatarForSlot(slot)"
                        :alt="getSlotName(slot)"
                        class="chip-avatar"
                        @error="handleImgError"
                      />
                      <span class="chip-name">{{ getSlotName(slot) }}</span>
                      <span v-if="slot.groupId" class="chip-group">{{ slot.groupId }}</span>
                    </div>
                  </div>
                  <div v-if="hasReplacements(room)" class="room-subs-line">
                    <span class="sub-label">候补:</span>
                    <span class="sub-names">{{ getReplacementNames(room) }}</span>
                  </div>
                </div>
              </div>

              <!-- Power Section -->
              <div class="block-header power-header">
                <span class="header-icon">⚡</span>
                <span class="header-title">发电站 ({{ powerFacilities.length }} 间)</span>
              </div>
              <div class="room-cards-stack">
                <div
                  v-for="room in powerFacilities"
                  :key="room.roomId"
                  class="poster-room-card power-card"
                >
                  <div class="room-card-head">
                    <span class="room-tag">Lv.{{ room.level }} {{ getRoomDisplayName(room.roomId) }}</span>
                  </div>
                  <div class="room-occupants">
                    <div
                      v-for="(slot, idx) in room.slots"
                      :key="idx"
                      class="occupant-chip"
                    >
                      <img
                        :src="getAvatarForSlot(slot)"
                        :alt="getSlotName(slot)"
                        class="chip-avatar"
                        @error="handleImgError"
                      />
                      <span class="chip-name">{{ getSlotName(slot) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 3. Central & Dorms & Support Column (控制中枢、宿舍、辅助设施) -->
            <div class="facility-section-block">
              <!-- Control Center -->
              <div class="block-header central-header">
                <span class="header-icon">🛡️</span>
                <span class="header-title">控制中枢 (5 人席位)</span>
              </div>
              <div class="poster-room-card central-card mb-12">
                <div class="room-occupants central-occupants">
                  <div
                    v-for="(slot, idx) in centralFacility?.slots || []"
                    :key="idx"
                    class="occupant-chip"
                  >
                    <img
                      :src="getAvatarForSlot(slot)"
                      :alt="getSlotName(slot)"
                      class="chip-avatar"
                      @error="handleImgError"
                    />
                    <span class="chip-name">{{ getSlotName(slot) }}</span>
                  </div>
                </div>
              </div>

              <!-- Dormitories -->
              <div class="block-header dorm-header">
                <span class="header-icon">🛏️</span>
                <span class="header-title">宿舍轮休 (4 间)</span>
              </div>
              <div class="room-cards-stack mb-12">
                <div
                  v-for="room in dormitoryFacilities"
                  :key="room.roomId"
                  class="poster-room-card dorm-card"
                >
                  <div class="room-card-head">
                    <span class="room-tag">{{ getRoomDisplayName(room.roomId) }} (Lv.{{ room.level }})</span>
                  </div>
                  <div class="room-occupants">
                    <div
                      v-for="(slot, idx) in room.slots"
                      :key="idx"
                      class="occupant-chip"
                    >
                      <img
                        :src="getAvatarForSlot(slot)"
                        :alt="getSlotName(slot)"
                        class="chip-avatar"
                        @error="handleImgError"
                      />
                      <span class="chip-name">{{ getSlotName(slot) }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Functional Support Facilities -->
              <div class="block-header support-header">
                <span class="header-icon">🏢</span>
                <span class="header-title">功能设施</span>
              </div>
              <div class="room-cards-stack">
                <div
                  v-for="room in supportFacilities"
                  :key="room.roomId"
                  class="poster-room-card support-card"
                >
                  <div class="room-card-head">
                    <span class="room-tag">{{ getRoomDisplayName(room.roomId) }}</span>
                  </div>
                  <div class="room-occupants">
                    <div
                      v-for="(slot, idx) in room.slots"
                      :key="idx"
                      class="occupant-chip"
                    >
                      <img
                        :src="getAvatarForSlot(slot)"
                        :alt="getSlotName(slot)"
                        class="chip-avatar"
                        @error="handleImgError"
                      />
                      <span class="chip-name">{{ getSlotName(slot) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Secondary / Backup Plans Banner if present -->
          <div v-if="backupPlansCount > 0" class="poster-backup-bar">
            <span class="backup-icon">🔄</span>
            <span class="backup-text">已配置 <strong>{{ backupPlansCount }}</strong> 个副表自动化调度方案，支持特定触发条件与动态换班执行。</span>
          </div>

          <!-- Poster Footer Watermark -->
          <div class="poster-footer">
            <div class="footer-left">
              <span class="f-title">明日方舟基建排班计算器 · R.I.I.C-Calculator</span>
              <span class="f-sub">Local Calculation · Compatible with Arknights Mower Roster Standard</span>
            </div>
            <div class="footer-right">
              <span class="f-url">https://panda-panta.github.io/R.I.I.C-Calculator/</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </NModal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { toPng, toBlob } from 'html-to-image'
import type { RosterWorkspace, MowerFacility, MowerSlot } from '../../workbench/model'
import type { CalculationReport } from '../../domain/types'
import { getOperatorAvatarUrl, getOperatorName, getRoomDisplayName } from '../../workbench/operatorHelpers'

const props = defineProps<{
  open: boolean
  workspace: RosterWorkspace
  calculationReport: CalculationReport | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const posterRef = ref<HTMLDivElement | null>(null)
const isProcessing = ref(false)
const actionStatus = ref<{ type: 'success' | 'error'; message: string } | null>(null)

const formattedTime = computed(() => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const backupPlansCount = computed(() => {
  return props.workspace.compatibility?.backupPlans?.length ?? 0
})

const facilities = computed(() => {
  return Object.values(props.workspace.mainPlan.facilities)
})

const manufactureFacilities = computed(() => {
  return facilities.value.filter(f => f.type === 'manufacture')
})

const tradingFacilities = computed(() => {
  return facilities.value.filter(f => f.type === 'trading')
})

const powerFacilities = computed(() => {
  return facilities.value.filter(f => f.type === 'power')
})

const dormitoryFacilities = computed(() => {
  return facilities.value.filter(f => f.type === 'dormitory')
})

const centralFacility = computed(() => {
  return props.workspace.mainPlan.facilities.central
})

const supportFacilities = computed(() => {
  return facilities.value.filter(f => ['meeting', 'contact', 'train', 'factory'].includes(f.roomId))
})

const layoutModeBadge = computed(() => {
  const t = tradingFacilities.value.length
  const m = manufactureFacilities.value.length
  const p = powerFacilities.value.length
  return `${t}${m}${p}`
})

function getProductLabel(product?: string): string {
  if (product === 'gold') return '赤金生产'
  if (product === 'exp') return '作战记录'
  if (product === 'originium') return '源石碎片'
  return '未设定'
}

function getSlotName(slot: MowerSlot): string {
  if (slot.occupant.kind === 'free') return 'Free'
  if (slot.occupant.kind === 'current') return 'Current'
  if (slot.occupant.kind === 'empty') return '空置'
  return getOperatorName(slot.occupant.operatorId)
}

function getAvatarForSlot(slot: MowerSlot): string {
  if (slot.occupant.kind === 'free') return getOperatorAvatarUrl('Free')
  if (slot.occupant.kind === 'current') return getOperatorAvatarUrl('Current')
  if (slot.occupant.kind === 'empty') return getOperatorAvatarUrl('Free')
  return getOperatorAvatarUrl(slot.occupant.operatorId)
}

function handleImgError(e: Event) {
  const target = e.target as HTMLImageElement
  if (target && !target.src.includes('Free.webp')) {
    target.src = getOperatorAvatarUrl('Free')
  }
}

function hasReplacements(facility: MowerFacility): boolean {
  return facility.slots.some(s => s.replacements && s.replacements.length > 0)
}

function getReplacementNames(facility: MowerFacility): string {
  const list = facility.slots.flatMap(s => s.replacements || [])
  const uniqueNames = [...new Set(list.map(id => getOperatorName(id)))]
  return uniqueNames.join('、')
}

function formatNumber(num: number | null | undefined, decimals = 1): string {
  if (num === null || num === undefined || !Number.isFinite(num)) return '0'
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

async function handleDownloadPoster(): Promise<void> {
  if (!posterRef.value || isProcessing.value) return
  isProcessing.value = true
  actionStatus.value = null

  try {
    const dataUrl = await toPng(posterRef.value, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#12161c',
    })
    const link = document.createElement('a')
    const planName = props.workspace.name || '排班方案'
    link.download = `排班海报_${planName}_${Date.now()}.png`
    link.href = dataUrl
    link.click()
    actionStatus.value = { type: 'success', message: '海报导出成功，已开始下载！' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    actionStatus.value = { type: 'error', message: `海报生成失败: ${msg}` }
  } finally {
    isProcessing.value = false
  }
}

async function handleCopyPoster(): Promise<void> {
  if (!posterRef.value || isProcessing.value) return
  isProcessing.value = true
  actionStatus.value = null

  try {
    const blob = await toBlob(posterRef.value, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#12161c',
    })
    if (!blob) throw new Error('无法生成图片数据')
    if (typeof navigator !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      actionStatus.value = { type: 'success', message: '已成功将海报图片复制到剪贴板！' }
    } else {
      throw new Error('当前浏览器不支持直接写入剪贴板图片，请使用下载海报')
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    actionStatus.value = { type: 'error', message: `复制海报失败: ${msg}` }
  } finally {
    isProcessing.value = false
  }
}
</script>

<style scoped>
.poster-modal-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.poster-actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}

.status-tip {
  font-size: 13px;
}

.hint-msg {
  color: #94a3b8;
}

.status-msg.success {
  color: #10b981;
  font-weight: 500;
}

.status-msg.error {
  color: #ef4444;
  font-weight: 500;
}

.btn-group {
  display: flex;
  gap: 8px;
}

.poster-preview-viewport {
  max-height: 72vh;
  overflow-y: auto;
  overflow-x: hidden;
  background: #0d1117;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  justify-content: center;
}

/* ==========================================================================
   Poster Canvas (High Definition Shareable Layout)
   ========================================================================== */
.roster-poster {
  width: 820px;
  background: #12161c;
  color: #e2e8f0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 24px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.poster-header {
  border-bottom: 2px solid rgba(0, 210, 211, 0.3);
  padding-bottom: 12px;
}

.brand-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.brand-tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: #00d2d3;
}

.brand-badge {
  font-size: 11px;
  background: rgba(0, 210, 211, 0.15);
  color: #00d2d3;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
}

.poster-title {
  margin: 2px 0 6px;
  font-size: 22px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.5px;
}

.poster-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #8b9bb4;
}

/* Income Card */
.poster-income-card {
  background: linear-gradient(135deg, rgba(28, 36, 48, 0.95), rgba(18, 22, 28, 0.95));
  border: 1px solid rgba(0, 210, 211, 0.25);
  border-radius: 8px;
  padding: 12px 16px;
}

.income-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.income-label {
  font-size: 13px;
  font-weight: 600;
  color: #94a3b8;
}

.power-tag {
  font-size: 12px;
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.power-tag.danger {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
}

.income-grid {
  display: grid;
  grid-template-columns: 1.2fr repeat(4, 1fr);
  gap: 8px;
}

.income-metric {
  background: rgba(255, 255, 255, 0.03);
  padding: 8px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.income-metric.highlight {
  background: rgba(0, 210, 211, 0.08);
  border-color: rgba(0, 210, 211, 0.3);
}

.m-val {
  font-size: 18px;
  font-weight: 700;
  color: #ffffff;
}

.text-exp { color: #f59e0b; }
.text-lmd { color: #3b82f6; }
.text-gold { color: #eab308; }
.text-drone { color: #06b6d4; }

.m-sub {
  font-size: 11px;
  color: #8b9bb4;
  margin-top: 2px;
}

/* Facility Matrix */
.poster-matrix {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.facility-section-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.manufacture-header { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.trading-header { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
.power-header { background: rgba(6, 182, 212, 0.15); color: #22d3ee; }
.central-header { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
.dorm-header { background: rgba(16, 185, 129, 0.15); color: #34d399; }
.support-header { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; }

.room-cards-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mb-12 {
  margin-bottom: 12px;
}

.poster-room-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.room-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.room-tag {
  font-size: 11px;
  font-weight: 600;
  color: #cbd5e1;
}

.product-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}

.product-badge.gold { background: rgba(234, 179, 8, 0.2); color: #facc15; }
.product-badge.exp { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
.product-badge.originium { background: rgba(239, 68, 68, 0.2); color: #f87171; }
.product-badge.trading-product { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }

.room-occupants {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.central-occupants {
  gap: 8px;
}

.occupant-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(0, 0, 0, 0.35);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.chip-avatar {
  width: 20px;
  height: 20px;
  border-radius: 3px;
  object-fit: cover;
  background: #1e293b;
}

.chip-name {
  font-size: 11px;
  color: #e2e8f0;
}

.chip-group {
  font-size: 9px;
  background: rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  padding: 1px 3px;
  border-radius: 2px;
}

.room-subs-line {
  font-size: 10px;
  color: #94a3b8;
  display: flex;
  gap: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  padding-top: 2px;
  margin-top: 2px;
}

.sub-label {
  color: #64748b;
}

.sub-names {
  color: #cbd5e1;
}

/* Backup Bar */
.poster-backup-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(139, 92, 246, 0.1);
  border: 1px solid rgba(139, 92, 246, 0.25);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  color: #c4b5fd;
}

/* Footer */
.poster-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 10px;
  font-size: 11px;
  color: #64748b;
}

.f-title {
  font-weight: 600;
  color: #94a3b8;
  display: block;
}

.f-sub {
  font-size: 10px;
  color: #475569;
}

.f-url {
  font-family: monospace;
  color: #00d2d3;
  opacity: 0.8;
}
</style>
