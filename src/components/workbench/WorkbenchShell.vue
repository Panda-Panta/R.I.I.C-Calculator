<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { createWorkbenchSession } from '../../workbench/session'
import { formatClueCount } from '../../workbench/mowerReportMetrics'
import { useWorkbenchCalculation } from '../../workbench/composables/useWorkbenchCalculation'
import { useSmartRosterGeneration } from '../../workbench/composables/useSmartRosterGeneration'
import { useWorkbenchPersistence } from '../../workbench/composables/useWorkbenchPersistence'
import { validateRosterWorkspace, type ValidationResult } from '../../workbench/validate'
import { EDITION } from '../../domain/edition'
import { GAME_DATA_VERSION, OPERATOR_PROFILE_COUNT } from '../../domain/operators'
import type { MowerRoomId, RosterWorkspace } from '../../domain/roster'
import { compileOperatorInventory } from '../../domain/operatorInventory'
import { inventoryOperatorRecords } from '../../domain/operatorContext'
import CalculationConfigModal from './CalculationConfigModal.vue'
import CalculationBottleneckSummary from './CalculationBottleneckSummary.vue'

import PlanToolbar from './PlanToolbar.vue'
import LayoutPresetBar from './LayoutPresetBar.vue'
import BaseMap from './BaseMap.vue'
import FacilityEditor from './FacilityEditor.vue'
import PolicyEditor from './PolicyEditor.vue'
import SettingsView from './SettingsView.vue'
import SimulationLogView from './SimulationLogView.vue'
import ValidationPanel, { type ValidationFocusPayload } from './ValidationPanel.vue'
import OperatorSelectModal, { type OperatorSelectionPayload } from './OperatorSelectModal.vue'
import GlobalReplaceModal, { type GlobalReplacePayload } from './GlobalReplaceModal.vue'
import SmartRosterConfigModal from './SmartRosterConfigModal.vue'
import RiicSkillsBrowser from './RiicSkillsBrowser.vue'
import BackupPlanEditor from './BackupPlanEditor.vue'
import RosterPosterModal from './RosterPosterModal.vue'
import MobileFacilityNav from './MobileFacilityNav.vue'
import { NConfigProvider } from 'naive-ui'
import { darkTheme, darkThemeOverrides } from '../../theme'
import '../../workbench/styles.css'

const store = useRosterWorkbenchStore()
const session = createWorkbenchSession()
const { activeTab, simSettings, calculationReport, calculationError, calculationStatus, simulationReport, timelineData, isCalculating, isGeneratingRoster, replaceStatusMessage } = session
const previewOperatorRecords = computed(() => {
  const inventory = session.operatorInventory.value
  return simSettings.value.useOperatorInventory !== false && inventory.enabled && inventory.valid
    ? inventoryOperatorRecords(compileOperatorInventory(inventory.entries)) : undefined
})

// Component and DOM references
const baseMapRef = ref<InstanceType<typeof BaseMap> | null>(null)
const facilityEditorSectionRef = ref<HTMLElement | null>(null)
const policyEditorSectionRef = ref<HTMLElement | null>(null)

const backupPlansCount = computed(() => {
  return store.workspace.compatibility.backupPlans?.length ?? 0
})

// Operator picker modal state
const pickerOpen = ref(false)
const pickerMode = ref<'main' | 'replacement'>('main')
const pickerRoomId = ref<MowerRoomId>('room_1_1')
const pickerSlotIndex = ref(0)

// Global replace modal state
const replaceModalOpen = ref(false)
const posterModalOpen = ref(false)

// Computed base map export DOM element for PlanToolbar JPG capture
const baseMapElement = computed<HTMLElement | null>(() => {
  if (baseMapRef.value?.outer) return baseMapRef.value.outer
  const el = (baseMapRef.value as unknown as { $el?: HTMLElement })?.$el
  if (el) {
    return el.querySelector<HTMLElement>('.plan-container') ?? el
  }
  return null
})

provide('baseMapElement', () => baseMapElement.value)

// Reactive validation result
const validationResult = computed<ValidationResult>(() => {
  return validateRosterWorkspace(store.workspace)
})

const { smartRosterConfigModalOpen, generationProgress, hasVerifiedIncumbent, handleAutoGenerate, handleConfirmSmartRosterConfig, handleAbortAutoGenerate } = useSmartRosterGeneration(store, session)
const { calculationBottleneckSummary, calculationConfigOpen, calculationProgress, calculationTiming, calculationSilence, handleCalculate, handleConfirmCalculation, handleAbortCalculation } = useWorkbenchCalculation(store, session, validationResult)
const { handleInventoryChange, handleInventoryImported } = useWorkbenchPersistence(store, session)

// Focus FacilityEditor when room selection changes
watch(
  () => store.selectedRoomId,
  (newRoomId, oldRoomId) => {
    if (newRoomId && newRoomId !== oldRoomId) {
      nextTick(() => {
        if (facilityEditorSectionRef.value?.scrollIntoView) {
          facilityEditorSectionRef.value.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      })
    }
  },
)

function handleRequestPicker(payload: {
  roomId: MowerRoomId
  slotIndex: number
  mode: 'main' | 'replacement'
}): void {
  pickerRoomId.value = payload.roomId
  pickerSlotIndex.value = payload.slotIndex
  pickerMode.value = payload.mode
  pickerOpen.value = true
}

function handlePickerSelected(_payload: OperatorSelectionPayload): void {
  pickerOpen.value = false
}

function handleOpenReplace(): void {
  replaceModalOpen.value = true
}

function handleGlobalReplaced(payload: GlobalReplacePayload): void {
  replaceModalOpen.value = false
  replaceStatusMessage.value = `已将干员「${payload.sourceName}」替换为「${payload.targetName}」，涉及 ${payload.impact.totalCount} 处位置。`
}

function handleValidationFocus(payload: ValidationFocusPayload): void {
  if (payload.roomId) {
    store.selectRoom(payload.roomId as MowerRoomId)
    nextTick(() => {
      if (facilityEditorSectionRef.value?.scrollIntoView) {
        facilityEditorSectionRef.value.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    })
  } else if (payload.policyKey) {
    nextTick(() => {
      if (policyEditorSectionRef.value?.scrollIntoView) {
        policyEditorSectionRef.value.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
      if (typeof document !== 'undefined') {
        const fieldEl = document.querySelector(`[data-field="${payload.policyKey}"]`)
        if (fieldEl && typeof (fieldEl as HTMLElement).scrollIntoView === 'function') {
          (fieldEl as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }
    })
  }
}

function handleFocusRoom(roomId: string): void {
  store.selectRoom(roomId as MowerRoomId)
  nextTick(() => {
    if (facilityEditorSectionRef.value?.scrollIntoView) {
      facilityEditorSectionRef.value.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

function handleSelectRoomFromNav(roomId: MowerRoomId): void {
  store.selectRoom(roomId)
  nextTick(() => {
    if (facilityEditorSectionRef.value?.scrollIntoView) {
      facilityEditorSectionRef.value.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

function handleReset(): void {
  calculationReport.value = null
  calculationError.value = null
  simulationReport.value = null
  timelineData.value = null
  replaceStatusMessage.value = null
}

function handleClearOperators(): void {
  handleReset()
}

function handleImported(_workspace: RosterWorkspace): void {
  calculationReport.value = null
  calculationError.value = null
  simulationReport.value = null
  timelineData.value = null
  replaceStatusMessage.value = null
}

function formatNumber(value: number | undefined | null, digits = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value)
}

defineExpose({
  store,
  validationResult,
  calculationReport,
  calculationError,
  simulationReport,
  simSettings,
  activeTab,
  backupPlansCount,
  isCalculating,
  isGeneratingRoster,
  generationProgress,
  replaceStatusMessage,
  pickerOpen,
  pickerMode,
  pickerRoomId,
  pickerSlotIndex,
  replaceModalOpen,
  smartRosterConfigModalOpen,
  handleCalculate,
  calculationConfigOpen,
  handleConfirmCalculation,
  handleAbortCalculation,
  handleAutoGenerate,
  handleAbortAutoGenerate,
  handleConfirmSmartRosterConfig,
  handleInventoryChange,
  handleInventoryImported,
  handleReset,
  handleClearOperators,
  handleImported,
  handleRequestPicker,
  handlePickerSelected,
  handleGlobalReplaced,
  handleValidationFocus,
  handleFocusRoom,
  baseMapElement,
  baseMapRef,
})
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="darkThemeOverrides">
    <div class="workbench-shell" data-test="workbench-shell">
    <!-- Top Header & Brand -->
    <header class="workbench-topbar">
      <div class="brand">
        <div class="brand-mark">R</div>
        <div class="brand-text">
          <p class="eyebrow">RHODES ISLAND · INFRASTRUCTURE</p>
          <h1>基建收益预测终端 <small>{{ EDITION.label }}</small></h1>
          <p class="edition-description">{{ EDITION.description }}</p>
        </div>
      </div>

      <!-- Topbar Navigation Tabs (Req 3, 11) -->
      <nav class="topbar-nav" data-test="topbar-nav">
        <button
          type="button"
          class="nav-tab"
          :class="{ active: activeTab === 'workbench' }"
          data-test="tab-workbench"
          @click="activeTab = 'workbench'"
        >
          基建排班
        </button>
        <button
          type="button"
          class="nav-tab"
          :class="{ active: activeTab === 'backup-plans' }"
          data-test="tab-backup-plans"
          @click="activeTab = 'backup-plans'"
        >
          副表调度
          <span v-if="backupPlansCount > 0" class="tab-badge" data-test="backup-plans-tab-badge">{{ backupPlansCount }}</span>
        </button>
        <button
          type="button"
          class="nav-tab"
          :class="{ active: activeTab === 'skills' }"
          data-test="tab-skills"
          @click="activeTab = 'skills'"
        >
          基建技能
        </button>
        <button
          type="button"
          class="nav-tab"
          :class="{ active: activeTab === 'settings' }"
          data-test="tab-settings"
          @click="activeTab = 'settings'"
        >
          设置
        </button>
        <button
          type="button"
          class="nav-tab"
          :class="{ active: activeTab === 'logs' }"
          data-test="tab-logs"
          @click="activeTab = 'logs'"
        >
          时间轴与日志
          <span v-if="simulationReport" class="tab-indicator">●</span>
        </button>
      </nav>

      <div class="topbar-actions">
        <label class="plan-name-input-label">
          <span>方案名称</span>
          <input
            v-model="store.workspace.name"
            maxlength="32"
            class="plan-name-input"
            data-test="plan-name-input"
            placeholder="排班方案名称"
          />
        </label>
      </div>
    </header>

    <CalculationBottleneckSummary v-if="calculationBottleneckSummary" :summary="calculationBottleneckSummary" />

    <!-- Reachable Toolbar Section (shown on workbench tab) -->
    <div v-show="activeTab === 'workbench'" class="toolbar-sticky-wrapper">
      <LayoutPresetBar @applied="handleReset" />
      <div class="toolbar-scroll-container">
        <PlanToolbar
          :base-map-element="baseMapElement"
          :is-valid="validationResult.isValid"
          :is-generating-roster="isGeneratingRoster"
          :generation-progress="generationProgress"
          :has-verified-incumbent="hasVerifiedIncumbent"
          :is-calculating="isCalculating"
          :calculation-progress="calculationProgress"
          :calculation-timing="calculationTiming"
          :calculation-silence="calculationSilence"
          @abort-calculation="handleAbortCalculation"
          theme="dark"
          @open-replace="handleOpenReplace"
          @calculate="handleCalculate"
          @reset="handleReset"
          @clear-operators="handleClearOperators"
          @imported="handleImported"
          @auto-generate="handleAutoGenerate"
          @abort-generation="handleAbortAutoGenerate"
          @inventory-imported="handleInventoryImported"
          @open-poster="posterModalOpen = true"
        />
      </div>
    </div>

    <div v-if="calculationStatus" class="replace-status-banner" role="status">{{ calculationStatus }}</div>

    <!-- Main Content Flow -->
    <main class="workbench-main">
      <!-- Global Replace Success/Status Banner -->
      <div
        v-if="replaceStatusMessage"
        class="replace-status-banner"
        data-test="replace-status-banner"
      >
        <span class="replace-status-icon">✓</span>
        <span class="replace-status-text">{{ replaceStatusMessage }}</span>
        <button
          type="button"
          class="replace-status-close"
          aria-label="关闭提示"
          @click="replaceStatusMessage = null"
        >
          ×
        </button>
      </div>

      <!-- Tab 1: 基建排班 -->
      <div v-show="activeTab === 'workbench'" class="tab-panel workbench-tab-panel">
        <!-- Validation Summary & Diagnostics -->
        <section class="validation-section" data-test="validation-section">
          <ValidationPanel
            :result="validationResult"
            @focus="handleValidationFocus"
            @focus-room="handleFocusRoom"
          />
        </section>

        <!-- Compact Calculation Results Panel -->
        <section
          v-if="calculationReport || calculationError"
          class="results-panel plan-container"
          data-test="results-panel"
        >
          <div class="results-panel-header">
            <div class="results-title-box">
              <span class="results-kicker">SIMULATION REPORT</span>
              <h3 class="results-title">基建收益测算结果</h3>
            </div>
            <div
              v-if="calculationReport"
              class="power-summary-badge"
              :class="{ 'is-danger': !calculationReport.power.sufficient }"
              data-test="results-power-badge"
            >
              <span>发电: {{ calculationReport.power.generation }}</span>
              <span>耗电: {{ calculationReport.power.consumption }}</span>
              <span class="power-margin-text">
                余量: {{ calculationReport.power.margin >= 0 ? '+' : '' }}{{ calculationReport.power.margin }}
              </span>
              <span class="power-tag">
                {{ calculationReport.power.sufficient ? '供电充足' : '供电不足' }}
              </span>
            </div>
          </div>

          <div v-if="calculationError" class="results-error-box" data-test="calculation-error">
            <span class="error-icon">✕</span>
            <span>{{ calculationError }}</span>
          </div>

          <div
            v-else-if="calculationReport && !calculationReport.summary"
            class="results-blocked-box"
            data-test="results-blocked"
          >
            <div class="blocked-head">
              <span class="blocked-icon">⚠</span>
              <strong>当前排班未通过校验，无法生成产出数值</strong>
            </div>
            <ul
              v-if="calculationReport.validationMessages && calculationReport.validationMessages.length > 0"
              class="blocked-list"
            >
              <li v-for="msg in calculationReport.validationMessages" :key="msg">{{ msg }}</li>
            </ul>
          </div>

          <div
            v-else-if="calculationReport && calculationReport.summary"
            class="results-grid"
            data-test="results-metrics"
          >
            <!-- Total 82 Output Score (Req 14) -->
            <div class="metric-card card-score82" data-test="metric-score82">
              <span class="metric-tag">加权总分</span>
              <div class="metric-main">
                <span class="metric-num text-score82">{{ formatNumber(calculationReport.summary.totalScore82, 1) }}</span>
                <span class="metric-unit">分/日</span>
              </div>
            </div>

            <!-- Daily LMD Yield -->
            <div class="metric-card card-lmd" data-test="metric-lmd">
              <span class="metric-tag">贸易收益</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.orderLmd) }}</span>
                <span class="metric-unit">龙门币/日</span>
              </div>
            </div>

            <!-- Combat Records EXP -->
            <div class="metric-card card-exp" data-test="metric-exp">
              <span class="metric-tag">作战记录</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.exp) }}</span>
                <span class="metric-unit">EXP/日</span>
              </div>
            </div>

            <!-- Gold manufacture value with net physical and virtual gold details -->
            <div class="metric-card card-gold" data-test="metric-gold">
              <span class="metric-tag">赤金制造</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.goldValue) }}</span>
                <span class="metric-unit">龙门币/日</span>
              </div>
              <span class="metric-sub">净产出 {{ formatNumber(calculationReport.summary.netGoldCount, 1) }} 条 · 虚拟赤金 +{{ formatNumber(calculationReport.summary.virtualGoldCount, 1) }} 条</span>
            </div>

            <!-- Actual simulated drone charging and spending -->
            <div class="metric-card card-drones" data-test="metric-drones">
              <span class="metric-tag">无人机充能</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.drones, 1) }}</span>
                <span class="metric-unit">架/日</span>
              </div>
            </div>

            <div v-if="calculationReport.summary.clueCount !== undefined" class="metric-card" data-test="metric-clues">
              <span class="metric-tag">线索产出</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatClueCount(calculationReport.summary.clueCount) }}</span>
                <span class="metric-unit">条/日</span>
              </div>
              <span v-if="calculationReport.summary.clueTotal !== undefined" class="metric-sub">采样完成 {{ formatNumber(calculationReport.summary.clueTotal) }} 条</span>
              <span class="metric-sub">全程开启交流 · 不计信用和加权收入</span>
            </div>

            <!-- Orundum & Fragments (if present) -->
            <div
              v-if="calculationReport.summary.orundum > 0 || calculationReport.summary.fragments > 0"
              class="metric-card card-orundum"
              data-test="metric-orundum"
            >
              <span class="metric-tag">合成玉产出</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.orundum) }}</span>
                <span class="metric-unit">玉/日</span>
              </div>
              <span class="metric-sub">源石碎片 {{ formatNumber(calculationReport.summary.fragments, 1) }} 个</span>
            </div>

            <!-- Timeline / Gantt Quick Link -->
            <div
              v-if="simulationReport"
              class="metric-card card-timeline"
              data-test="metric-timeline-link"
              title="点击查看排班甘特图与动态工休时间轴"
              @click="activeTab = 'logs'"
            >
              <span class="metric-tag">排班时间轴</span>
              <div class="metric-main">
                <span class="metric-num">📊</span>
                <span class="metric-unit">查看甘特图 →</span>
              </div>
              <span class="metric-sub">全周期工休轨迹与动态演化</span>
            </div>
          </div>
        </section>

        <!-- Exact Base Map Board (Horizontally scrollable without distortion) -->
        <section class="board-section" data-test="base-map-section">
          <div class="board-scroll-container">
            <BaseMap ref="baseMapRef" />
          </div>
        </section>

        <!-- Mobile & Responsive Facility Quick Navigation -->
        <section class="mobile-facility-nav-section" data-test="mobile-facility-nav-section">
          <MobileFacilityNav @select-room="handleSelectRoomFromNav" />
        </section>

        <!-- Selected Facility Editor -->
        <section
          ref="facilityEditorSectionRef"
          class="facility-editor-section"
          data-test="facility-editor-section"
        >
          <FacilityEditor :operator-records="previewOperatorRecords" @request-picker="handleRequestPicker" />
        </section>

        <!-- Strategy Policy Editor (moved from Settings) -->
        <section
          ref="policyEditorSectionRef"
          class="policy-editor-section"
          data-test="policy-editor-section"
        >
          <PolicyEditor />
        </section>
      </div>

      <!-- Tab: 副表调度 (Backup Plans) -->
      <div v-show="activeTab === 'backup-plans'" class="tab-panel backup-plans-tab-panel" data-test="backup-plans-tab-panel">
        <BackupPlanEditor />
      </div>

      <!-- Tab: 基建技能 (Riic Skills Browser) -->
      <div v-show="activeTab === 'skills'" class="tab-panel skills-tab-panel" data-test="skills-tab-panel">
        <RiicSkillsBrowser />
      </div>

      <!-- Tab 2: 设置 (Settings) (Req 3, 4, 5, 6, 7, 9, 12) -->
      <div v-show="activeTab === 'settings'" class="tab-panel settings-tab-panel" data-test="settings-tab-panel">
        <SettingsView
          v-model:settings="simSettings"
          @inventory-change="handleInventoryChange"
        />
      </div>

      <!-- Tab 3: 日志 (Logs) (Req 11, 13) -->
      <div v-show="activeTab === 'logs'" class="tab-panel logs-tab-panel" data-test="logs-tab-panel">
        <SimulationLogView
          :report="simulationReport"
          :timeline-data="timelineData"
          :error="calculationError"
          @clear="simulationReport = null"
        />
      </div>
    </main>

    <!-- Compact Attribution Footer -->
    <footer class="workbench-footer" data-test="workbench-footer">
      <div class="footer-attribution">
        <span>{{ EDITION.label }} · 组合规则引擎 v0.3.0</span>
        <span class="dot-sep">·</span>
        <span>Arknights Mower 排班兼容 (MIT License | Copyright (c) 2021 Nano)</span>
        <span class="dot-sep">·</span>
        <span>本地保存 · 不上传配置</span>
        <span class="dot-sep">·</span>
        <span>GameData {{ GAME_DATA_VERSION }} · {{ OPERATOR_PROFILE_COUNT }} 份基建档案</span>
      </div>
    </footer>

    <!-- Modals -->
    <OperatorSelectModal
      :open="pickerOpen"
      :mode="pickerMode"
      :room-id="pickerRoomId"
      :slot-index="pickerSlotIndex"
      @update:open="pickerOpen = $event"
      @close="pickerOpen = false"
      @selected="handlePickerSelected"
    />

    <GlobalReplaceModal
      :open="replaceModalOpen"
      @update:open="replaceModalOpen = $event"
      @close="replaceModalOpen = false"
      @replaced="handleGlobalReplaced"
    />

    <CalculationConfigModal
      :open="calculationConfigOpen"
      :workspace="store.workspace"
      :initial="{ ...simSettings, droneTradingRoomId: simSettings.droneTradingRoomId || '' }"
      @close="calculationConfigOpen = false"
      @confirm="handleConfirmCalculation"
    />

    <SmartRosterConfigModal
      :open="smartRosterConfigModalOpen"
      :workspace="store.workspace"
      :initial-drone-target="simSettings.droneTarget"
      :initial-seed="simSettings.seed"
      :initial-production-weights="simSettings.productionWeights"
      @close="smartRosterConfigModalOpen = false"
      @confirm="handleConfirmSmartRosterConfig"
    />

    <RosterPosterModal
      :open="posterModalOpen"
      :workspace="store.workspace"
      :calculation-report="calculationReport"
      @close="posterModalOpen = false"
    />
    </div>
  </n-config-provider>
</template>

<style scoped src="./WorkbenchShell.css"></style>
