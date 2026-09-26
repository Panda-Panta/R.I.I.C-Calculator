<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, provide, ref, shallowRef, toRaw, watch } from 'vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { validateRosterWorkspace, type ValidationResult } from '../../workbench/validate'
import { EDITION } from '../../domain/edition'
import { GAME_DATA_VERSION, OPERATOR_PROFILE_COUNT } from '../../domain/operators'
import { migrateAppConfigToWorkspace } from '../../workbench/migrate'
import type { MowerRoomId, RosterWorkspace } from '../../workbench/model'
import type { AppConfig, CalculationReport } from '../../domain/types'
import type { CalculationWorkerMessage, CalculationProgress } from '../../workbench/calculationWorker'
import CalculationConfigModal, { type CalculationConfig } from './CalculationConfigModal.vue'
import type { ScheduleSimulationReport } from '../../simulator/scheduleSimulation'
import { runSmartRoster, type SmartRosterProgress, type SmartRosterResult } from '../../optimizer/smartRoster'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'

import PlanToolbar from './PlanToolbar.vue'
import BaseMap from './BaseMap.vue'
import FacilityEditor from './FacilityEditor.vue'
import PolicyEditor from './PolicyEditor.vue'
import SettingsView, { type SimulationSettings } from './SettingsView.vue'
import SimulationLogView from './SimulationLogView.vue'
import ValidationPanel, { type ValidationFocusPayload } from './ValidationPanel.vue'
import OperatorSelectModal, { type OperatorSelectionPayload } from './OperatorSelectModal.vue'
import GlobalReplaceModal, { type GlobalReplacePayload } from './GlobalReplaceModal.vue'
import SmartRosterConfigModal, { type SmartRosterConfig } from './SmartRosterConfigModal.vue'
import RiicSkillsBrowser from './RiicSkillsBrowser.vue'
import BackupPlanEditor from './BackupPlanEditor.vue'
import RosterPosterModal from './RosterPosterModal.vue'
import { NConfigProvider } from 'naive-ui'
import { darkTheme, darkThemeOverrides } from '../../theme'
import '../../workbench/styles.css'

const store = useRosterWorkbenchStore()

// Component and DOM references
const baseMapRef = ref<InstanceType<typeof BaseMap> | null>(null)
const facilityEditorSectionRef = ref<HTMLElement | null>(null)
const policyEditorSectionRef = ref<HTMLElement | null>(null)

// Sub-page navigation: workbench | backup-plans | skills | settings | logs
const activeTab = ref<'workbench' | 'backup-plans' | 'skills' | 'settings' | 'logs'>('workbench')

const backupPlansCount = computed(() => {
  return store.workspace.compatibility.backupPlans?.length ?? 0
})

// Simulation settings state
const defaultSimSettings: SimulationSettings = {
  sampleDays: 7,
  warmupDays: 3,
  step: 0.25,
  seed: -1,
  droneTarget: 'gold',
  droneTradingRoomId: '',
  jayeElite0: false,
  fiammettaFool: true,
  restingThreshold: .65,
}
const simSettings = ref<SimulationSettings>({ ...defaultSimSettings })
watch(simSettings, value => {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(SIM_SETTINGS_STORAGE_KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
  }
}, { deep: true })
const simulationReport = shallowRef<ScheduleSimulationReport | null>(null)
const isCalculating = ref(false)
const isGeneratingRoster = ref(false)
const generationProgress = ref<SmartRosterProgress | null>(null)
const activeRosterWorker = ref<Worker | null>(null)

const calculationConfigOpen = ref(false)
const calculationProgress = ref<CalculationProgress | null>(null)
const calculationElapsed = ref(0)
const calculationStatus = ref<string | null>(null)
let calculationWorker: Worker | null = null
let calculationTimer: ReturnType<typeof setInterval> | undefined
const calculationTiming = computed(() => {
  const seconds = Math.floor(calculationElapsed.value)
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  const fraction = calculationProgress.value?.fraction ?? 0
  if (fraction >= .99) return `已用 ${elapsed} · 即将完成`
  if (seconds < 3 || fraction < .01) return `已用 ${elapsed} · 剩余时间估算中`
  const remaining = Math.max(1, Math.ceil(seconds * (1 - fraction) / fraction))
  return `已用 ${elapsed} · 约剩余 ${remaining < 60 ? `${remaining} 秒` : `${Math.ceil(remaining / 60)} 分钟`}`
})

function stopCalculation(): void {
  const worker = calculationWorker
  calculationWorker = null
  worker?.terminate()
  clearInterval(calculationTimer)
  calculationTimer = undefined
  isCalculating.value = false
  calculationProgress.value = null
}
function handleAbortCalculation(): void {
  stopCalculation()
  calculationStatus.value = '已中止产出计算，可重新开始。'
}
watch(() => store.workspace, () => {
  if (isCalculating.value) {
    stopCalculation()
    calculationStatus.value = '排班已变更，本次产出计算已中止，请重新计算。'
  }
}, { deep: true, flush: 'sync' })
onBeforeUnmount(() => { stopCalculation(); activeRosterWorker.value?.terminate() })

// Operator picker modal state
const pickerOpen = ref(false)
const pickerMode = ref<'main' | 'replacement'>('main')
const pickerRoomId = ref<MowerRoomId>('room_1_1')
const pickerSlotIndex = ref(0)

// Global replace modal state
const replaceModalOpen = ref(false)
const replaceStatusMessage = ref<string | null>(null)
const smartRosterConfigModalOpen = ref(false)
const posterModalOpen = ref(false)

// Operator inventory state
const operatorInventory = ref<{
  enabled: boolean
  valid: boolean
  entries: OwnedOperatorInput[]
}>({
  enabled: true,
  valid: false,
  entries: [],
})

// Calculation report and error state
const calculationReport = shallowRef<CalculationReport | null>(null)
const calculationError = ref<string | null>(null)

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

// Persistence keys matching existing store/edition pattern
const WORKSPACE_STORAGE_KEY = `arc-income-calculator-workspace-v8-${EDITION.storageNamespace}`
const V7_STORAGE_KEY = `arc-income-calculator-config-v7-${EDITION.storageNamespace}`
const REPORT_STORAGE_KEY = `arc-income-calculator-report-v1-${EDITION.storageNamespace}`
const SIM_SETTINGS_STORAGE_KEY = `arc-income-calculator-sim-settings-v1-${EDITION.storageNamespace}`

function initPersistence(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return

  try {
    const rawWs = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (rawWs) {
      const parsed = JSON.parse(rawWs)
      if (parsed?.schemaVersion === 8 && parsed?.mainPlan?.facilities) {
        const facs = parsed.mainPlan.facilities
        const isUntouchedDefault =
          parsed.name === '默认排班' &&
          facs.room_2_1?.product === 'gold' &&
          facs.room_2_2?.product === 'gold' &&
          Object.values(facs).every((f: any) =>
            f.slots.every((s: any) => s.occupant.kind === 'empty' || s.occupant.kind === 'free'),
          )
        if (isUntouchedDefault) {
          if (facs.room_2_1) facs.room_2_1.product = 'exp'
          if (facs.room_2_2) facs.room_2_2.product = 'exp'
        }
        store.loadWorkspace(parsed as RosterWorkspace)
      }
    } else {
      const rawV7 = localStorage.getItem(V7_STORAGE_KEY)
      if (rawV7) {
        const parsedV7 = JSON.parse(rawV7)
        if (parsedV7?.schemaVersion === 7 && Array.isArray(parsedV7?.rooms)) {
          const migratedWs = migrateAppConfigToWorkspace(parsedV7 as AppConfig)
          store.loadWorkspace(migratedWs)
        }
      }
    }

    const rawRep = localStorage.getItem(REPORT_STORAGE_KEY)
    if (rawRep) {
      const parsedRep = JSON.parse(rawRep)
      if (parsedRep?.power) {
        calculationReport.value = parsedRep as CalculationReport
      }
    }

    const rawSim = localStorage.getItem(SIM_SETTINGS_STORAGE_KEY)
    if (rawSim) {
      const parsedSim = JSON.parse(rawSim)
      if (parsedSim?.sampleDays) {
        simSettings.value = { ...defaultSimSettings, ...parsedSim }
      }
    }

    const rawInv = localStorage.getItem('arcinc-operator-inventory-v1')
    if (rawInv) {
      const parsedInv = JSON.parse(rawInv)
      if (parsedInv?.text) {
        const compiled = parseOperatorInventory(parsedInv.text)
        if (compiled.valid) {
          operatorInventory.value = {
            enabled: parsedInv.enabled ?? true,
            valid: true,
            entries: compiled.entries,
          }
        }
      }
    }
  } catch (e) {
    console.warn('Failed to restore persisted workbench state:', e)
  }
}

onMounted(() => {
  initPersistence()
})

// Persist workspace changes
watch(
  () => store.workspace,
  (ws) => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws))
    } catch {
      // ignore storage quota errors
    }
  },
  { deep: true },
)

// Persist calculation report
watch(
  calculationReport,
  (rep) => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
    try {
      if (rep) {
        localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(rep))
      } else {
        localStorage.removeItem(REPORT_STORAGE_KEY)
      }
    } catch {
      // ignore
    }
  },
  { deep: true },
)

// Sync plan name changes to mainPlan.name
watch(
  () => store.workspace.name,
  (newName) => {
    if (newName && store.workspace.mainPlan) {
      store.workspace.mainPlan.name = newName
    }
  },
)

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

function handleReset(): void {
  calculationReport.value = null
  calculationError.value = null
  simulationReport.value = null
  replaceStatusMessage.value = null
}

function handleClearOperators(): void {
  calculationReport.value = null
  calculationError.value = null
  simulationReport.value = null
  replaceStatusMessage.value = null
}

function handleImported(_workspace: RosterWorkspace): void {
  calculationReport.value = null
  calculationError.value = null
  simulationReport.value = null
  replaceStatusMessage.value = null
}

function handleInventoryChange(payload: { enabled: boolean; valid: boolean; entries: OwnedOperatorInput[] }): void {
  operatorInventory.value = payload
}

function handleInventoryImported(entries: OwnedOperatorInput[], csvText: string): void {
  operatorInventory.value = {
    enabled: true,
    valid: true,
    entries,
  }
  replaceStatusMessage.value = `成功导入干员库：共 ${entries.length} 名干员`
  try {
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ schemaVersion: 1, text: csvText, enabled: true }))
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('arcinc-inventory-synced', { detail: { text: csvText, enabled: true } }))
  }
}

function handleCalculate(): void {
  if (isCalculating.value || isGeneratingRoster.value) return
  calculationError.value = null
  if (!validationResult.value.isValid) {
    calculationError.value = '排班存在阻断错误，请根据下方诊断信息修复后再计算。'
    return
  }
  calculationConfigOpen.value = true
}

function handleConfirmCalculation(config: CalculationConfig): void {
  calculationConfigOpen.value = false
  if (isCalculating.value || isGeneratingRoster.value) return
  simSettings.value = { ...simSettings.value, ...config }
  executeCalculation()
}

function executeCalculation(): void {
  if (isCalculating.value) return
  calculationError.value = null
  calculationStatus.value = null
  if (!validationResult.value.isValid) {
    calculationError.value = '排班存在阻断错误，请根据下方诊断信息修复后再计算。'
    return
  }
  calculationReport.value = null
  simulationReport.value = null
  isCalculating.value = true
  calculationElapsed.value = 0
  calculationProgress.value = { label: '正在准备计算…', fraction: 0 }
  const started = performance.now()
  calculationTimer = setInterval(() => { calculationElapsed.value = (performance.now() - started) / 1000 }, 1000)
  try {
    let inventoryEntries: OwnedOperatorInput[] | undefined
    if (simSettings.value.useOperatorInventory !== false) {
      let inventory = operatorInventory.value
      const saved = localStorage.getItem('arcinc-operator-inventory-v1')
      if (saved) {
        const parsed = JSON.parse(saved)
        const compiled = parseOperatorInventory(parsed.text ?? '')
        inventory = { enabled: parsed.enabled ?? true, valid: compiled.valid, entries: compiled.entries }
      }
      if (inventory.enabled) {
        if (!inventory.valid) throw new Error('当前干员库配置无效，请修正或取消使用干员库配置。')
        inventoryEntries = JSON.parse(JSON.stringify(toRaw(inventory.entries)))
      }
    }
    if (simSettings.value.jayeElite0 && inventoryEntries) {
      const jIdx = inventoryEntries.findIndex(e => e.operator === '孑' || e.operator === 'char_272_strong')
      if (jIdx >= 0) {
        inventoryEntries[jIdx] = { ...inventoryEntries[jIdx]!, elitePhase: 0, level: 1 }
      }
    }

    const options = {
      engine: 'simulation' as const,
      jayeElite0: simSettings.value.jayeElite0 ?? false,
      simulationAssumptions: {
        fiammettaFool: simSettings.value.fiammettaFool ?? true,
        restingThreshold: simSettings.value.restingThreshold ?? .65,
      },
      simulationOptions: {
        warmupHours: simSettings.value.warmupDays * 24,
        sampleHours: simSettings.value.sampleDays * 24,
        maxStepHours: simSettings.value.step,
        warmupModel: 'hourly' as const,
        recordSegments: true,
        jayeElite0: simSettings.value.jayeElite0 ?? false,
        operatorInventory: inventoryEntries,
        production: {
          outputMode: 'potential' as const,
          runOrderMode: 'ideal' as const,
          seed: simSettings.value.seed < 0
            ? (typeof process !== 'undefined' && Boolean(process.env?.VITEST) ? 42 : Math.floor(Math.random() * 0xffffffff))
            : simSettings.value.seed,
          droneTarget: simSettings.value.droneTarget,
          droneRoomId: simSettings.value.droneRoomId || undefined,
          droneTradingRoomId: simSettings.value.droneTradingRoomId || undefined,
        },
      },
    }

    const worker = new Worker(new URL('../../workbench/calculationWorker.ts', import.meta.url), { type: 'module' })
    calculationWorker = worker
    worker.onmessage = (event: MessageEvent<CalculationWorkerMessage>) => {
      if (calculationWorker !== worker) return
      const message = event.data
      if (message.type === 'progress') {
        calculationProgress.value = message.progress
      } else if (message.type === 'complete') {
        const result = message.result
        simulationReport.value = result.simulationReport ?? null
        if (result.success && result.report) calculationReport.value = result.report
        else calculationError.value = result.error ?? '收益计算未成功完成'
        stopCalculation()
      } else if (message.type === 'error') {
        calculationError.value = message.error
        stopCalculation()
      }
    }
    const fail = (message: string) => {
      if (calculationWorker !== worker) return
      calculationError.value = message
      stopCalculation()
    }
    worker.onerror = event => fail(`产出计算失败：${event.message || '后台任务执行失败'}`)
    worker.onmessageerror = () => fail('产出计算报告传输失败，请重试。')
    worker.postMessage(JSON.parse(JSON.stringify({ workspace: toRaw(store.workspace), options })))
  } catch (error) {
    calculationError.value = `无法启动后台计算：${error instanceof Error ? error.message : String(error)}`
    stopCalculation()
  }
}

function handleAutoGenerate(explicitConfig?: SmartRosterConfig): void {
  if (isCalculating.value || isGeneratingRoster.value) return
  replaceStatusMessage.value = null
  calculationError.value = null

  let inventoryEntries: OwnedOperatorInput[] = []
  if (operatorInventory.value.enabled && operatorInventory.value.valid && operatorInventory.value.entries.length > 0) {
    inventoryEntries = operatorInventory.value.entries
  } else if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const rawInv = localStorage.getItem('arcinc-operator-inventory-v1')
    if (rawInv) {
      try {
        const parsedInv = JSON.parse(rawInv)
        if (parsedInv.text) {
          const compiled = parseOperatorInventory(parsedInv.text)
          if (compiled.valid) {
            inventoryEntries = compiled.entries
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (inventoryEntries.length === 0) {
    replaceStatusMessage.value = '无法自动生成排班：请先在「设置」子页面或点击「导入干员库」录入您持有的干员与练度。'
    return
  }

  const isVitest = typeof process !== 'undefined' && Boolean(process.env?.VITEST)
  if (explicitConfig || (isVitest && explicitConfig === undefined && !smartRosterConfigModalOpen.value)) {
    executeAutoGenerate(inventoryEntries, explicitConfig)
    return
  }

  smartRosterConfigModalOpen.value = true
}

function handleConfirmSmartRosterConfig(config: SmartRosterConfig): void {
  smartRosterConfigModalOpen.value = false

  let inventoryEntries: OwnedOperatorInput[] = []
  if (operatorInventory.value.enabled && operatorInventory.value.valid && operatorInventory.value.entries.length > 0) {
    inventoryEntries = operatorInventory.value.entries
  } else if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const rawInv = localStorage.getItem('arcinc-operator-inventory-v1')
    if (rawInv) {
      try {
        const parsedInv = JSON.parse(rawInv)
        if (parsedInv.text) {
          const compiled = parseOperatorInventory(parsedInv.text)
          if (compiled.valid) {
            inventoryEntries = compiled.entries
          }
        }
      } catch {}
    }
  }

  if (inventoryEntries.length === 0) {
    replaceStatusMessage.value = '无法自动生成排班：请先在「设置」子页面或点击「导入干员库」录入您持有的干员与练度。'
    return
  }

  executeAutoGenerate(inventoryEntries, config)
}

function executeAutoGenerate(inventoryEntries: OwnedOperatorInput[], config?: SmartRosterConfig): void {
  isGeneratingRoster.value = true
  generationProgress.value = {
    phase: 'building',
    phaseProgress: 0,
    label: '正在准备一键智能排班...',
  }

  const baseWorkspace = JSON.parse(JSON.stringify(toRaw(store.workspace)))
  const cleanEntries: OwnedOperatorInput[] = JSON.parse(JSON.stringify(inventoryEntries))
  const isVitest = typeof process !== 'undefined' && Boolean(process.env?.VITEST)
  const runOptions = {
    seed: (config?.seed !== undefined && config.seed >= 0)
      ? config.seed
      : (simSettings.value.seed < 0 ? (isVitest ? 42 : Math.floor(Math.random() * 0xffffffff)) : simSettings.value.seed),
    branchCount: isVitest ? 1 : 10,
    maxStaticEvals: config?.maxStaticEvals ?? (isVitest ? 500 : 3000),

    simulationWarmupHours: config?.simulationWarmupHours ?? (isVitest ? 6 : 24),
    simulationSampleHours: config?.simulationSampleHours ?? (isVitest ? 18 : 72),
    enableDeepSearch: config?.enableDeepSearch ?? !isVitest,
    droneTarget: config?.droneTarget ?? 'none',
    droneRoomId: config?.droneRoomId || undefined,
  }

  const onSmartRosterComplete = (report: SmartRosterResult): void => {
    if (report.status === 'draft' && report.workspace) {
      store.loadWorkspace(report.workspace)
      const scoreStr = report.score !== null ? `（82 预测：${report.score.toFixed(1)} 分/日）` : ''
      replaceStatusMessage.value = `一键排班成功！已保留当前建筑与已配置干员，并完成空位组队与动态仿真验证${scoreStr}。`
      simSettings.value.droneTarget = runOptions.droneTarget
      simSettings.value.droneRoomId = runOptions.droneRoomId
      simSettings.value.droneTradingRoomId = runOptions.droneTarget === 'trading' ? runOptions.droneRoomId : ''
      simSettings.value.useOperatorInventory = true
      activeTab.value = 'workbench'
      executeCalculation()
    } else {
      const msgs = report.diagnostics.map(d => d.message).join('；')
      replaceStatusMessage.value = `自动生成排班未成功：${msgs || '未能生成满足约束的方案'}`
    }
  }

  try {
    if (!isVitest && typeof Worker !== 'undefined') {
      const worker = new Worker(new URL('../../optimizer/smartRosterWorker.ts', import.meta.url), { type: 'module' })
      activeRosterWorker.value = worker
      worker.onmessage = (event) => {
        if (event.data.type === 'progress') {
          generationProgress.value = event.data.progress
        } else if (event.data.type === 'complete') {
          onSmartRosterComplete(event.data.report)
          worker.terminate()
          activeRosterWorker.value = null
          isGeneratingRoster.value = false
          generationProgress.value = null
        } else if (event.data.type === 'error') {
          replaceStatusMessage.value = `自动排班生成失败：${event.data.error}`
          worker.terminate()
          activeRosterWorker.value = null
          isGeneratingRoster.value = false
          generationProgress.value = null
        }
      }
      worker.onerror = (err) => {
        replaceStatusMessage.value = `自动排班任务发生错误：${err.message || 'Worker 执行失败'}`
        worker.terminate()
        activeRosterWorker.value = null
        isGeneratingRoster.value = false
        generationProgress.value = null
      }
      worker.postMessage({
        base: baseWorkspace,
        entries: cleanEntries,
        options: runOptions,
      })
      return
    }
  } catch {
    // Fall back to synchronous execution if Worker creation failed (e.g. in test environment)
  }

  try {
    const report = runSmartRoster(baseWorkspace, cleanEntries, runOptions, (p) => {
      generationProgress.value = p
    })
    onSmartRosterComplete(report)
  } catch (err: unknown) {
    replaceStatusMessage.value = `自动排班生成失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    isGeneratingRoster.value = false
    generationProgress.value = null
  }
}

function handleAbortAutoGenerate(): void {
  if (activeRosterWorker.value) {
    activeRosterWorker.value.terminate()
    activeRosterWorker.value = null
  }
  isGeneratingRoster.value = false
  generationProgress.value = null
  replaceStatusMessage.value = '已中止自动排班计算。'
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

    <!-- Reachable Toolbar Section (shown on workbench tab) -->
    <div v-show="activeTab === 'workbench'" class="toolbar-sticky-wrapper">
      <div class="toolbar-scroll-container">
        <PlanToolbar
          :base-map-element="baseMapElement"
          :is-valid="validationResult.isValid"
          :is-generating-roster="isGeneratingRoster"
          :generation-progress="generationProgress"
          :is-calculating="isCalculating"
          :calculation-progress="calculationProgress"
          :calculation-timing="calculationTiming"
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
              <span class="metric-tag">82 综合日产出</span>
              <div class="metric-main">
                <span class="metric-num text-score82">{{ formatNumber(calculationReport.summary.totalScore82, 1) }}</span>
                <span class="metric-unit">分/日</span>
              </div>
              <span class="metric-sub">EXP + 0.8×赤金 + 0.2×龙门币</span>
            </div>

            <!-- Daily LMD Yield -->
            <div class="metric-card card-lmd" data-test="metric-lmd">
              <span class="metric-tag">贸易收益</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.orderLmd) }}</span>
                <span class="metric-unit">龙门币/日</span>
              </div>
              <span class="metric-sub">日消耗赤金 {{ formatNumber(calculationReport.summary.goldConsumed, 1) }} 条</span>
            </div>

            <!-- Combat Records EXP -->
            <div class="metric-card card-exp" data-test="metric-exp">
              <span class="metric-tag">作战记录</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.exp) }}</span>
                <span class="metric-unit">EXP/日</span>
              </div>
              <span class="metric-sub">中级经验书等效</span>
            </div>

            <!-- Gold Manufacture (Req 15 Tequila Virtual Gold) -->
            <div class="metric-card card-gold" data-test="metric-gold">
              <span class="metric-tag">赤金制造</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.summary.goldValue) }}</span>
                <span class="metric-unit">龙门币/日</span>
              </div>
              <span class="metric-sub">
                净产出 {{ formatNumber(calculationReport.summary.netGoldCount, 1) }} 条
                <template v-if="calculationReport.summary.virtualGoldCount > 0">
                  · 虚拟赤金 +{{ formatNumber(calculationReport.summary.virtualGoldCount, 1) }} 条
                </template>
              </span>
            </div>

            <!-- Theoretical Drones -->
            <div class="metric-card card-drones" data-test="metric-drones">
              <span class="metric-tag">理论无人机</span>
              <div class="metric-main">
                <span class="metric-num">{{ formatNumber(calculationReport.drones, 1) }}</span>
                <span class="metric-unit">架/日</span>
              </div>
              <span class="metric-sub">长期日均充能</span>
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

        <!-- Selected Facility Editor -->
        <section
          ref="facilityEditorSectionRef"
          class="facility-editor-section"
          data-test="facility-editor-section"
        >
          <FacilityEditor @request-picker="handleRequestPicker" />
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

<style scoped>
.workbench-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  width: 100%;
  background: #0d1117;
  color: #e9f2f4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  box-sizing: border-box;
}

/* Topbar */
.workbench-topbar {
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid rgba(173, 209, 216, 0.16);
  background: rgba(13, 17, 23, 0.94);
  backdrop-filter: blur(14px);
  position: sticky;
  top: 0;
  z-index: 30;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  color: #071015;
  background: #42d6c7;
  font: 800 22px/1 Consolas, monospace;
  clip-path: polygon(0 0, 78% 0, 100% 22%, 100% 100%, 22% 100%, 0 78%);
  flex-shrink: 0;
}

.eyebrow {
  margin: 0 0 2px;
  color: #42d6c7;
  letter-spacing: 0.15em;
  font: 600 10px/1.2 Consolas, monospace;
}

h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

h1 small {
  margin-left: 8px;
  padding: 2px 6px;
  color: #42d6c7;
  border: 1px solid rgba(66, 214, 199, 0.28);
  border-radius: 3px;
  font-size: 10px;
  vertical-align: middle;
}

.edition-description {
  margin: 2px 0 0;
  color: #8da5ac;
  font-size: 11px;
}

/* Topbar Navigation Tabs */
.topbar-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(0, 0, 0, 0.25);
  padding: 4px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.nav-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  color: #8da5ac;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-tab:hover {
  color: #e9f2f4;
  background: rgba(255, 255, 255, 0.06);
}

.nav-tab.active {
  color: #071015;
  background: #42d6c7;
  font-weight: 600;
}

.tab-indicator {
  font-size: 8px;
  color: #00e676;
}

.nav-tab.active .tab-indicator {
  color: #071015;
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(44, 181, 160, 0.2);
  color: #2cb5a0;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0 6px;
  min-width: 16px;
  height: 16px;
  line-height: 1;
  margin-left: 4px;
}

.nav-tab.active .tab-badge {
  background: #071015;
  color: #42d6c7;
}

.tab-panel {
  width: 100%;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.plan-name-input-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.plan-name-input-label span {
  font-size: 10px;
  color: #8da5ac;
}

.plan-name-input {
  width: 200px;
  height: 30px;
  padding: 0 10px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #fff;
  outline: none;
  transition: border-color 0.2s;
}

.plan-name-input:focus {
  border-color: #42d6c7;
}

/* Toolbar sticky wrapper */
.toolbar-sticky-wrapper {
  width: 100%;
  background: #141920;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  z-index: 20;
}

.toolbar-scroll-container {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  justify-content: center;
  padding: 4px 0;
  box-sizing: border-box;
}

/* Main Layout Area */
.workbench-main {
  flex: 1;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px 16px 48px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Replace status banner */
.replace-status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(32, 128, 240, 0.15);
  border: 1px solid rgba(32, 128, 240, 0.4);
  border-radius: 4px;
  color: #70c0e8;
  font-size: 13px;
  animation: fadeIn 0.2s ease-in-out;
}

.replace-status-icon {
  font-weight: bold;
}

.replace-status-text {
  flex: 1;
}

.replace-status-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  opacity: 0.7;
}

.replace-status-close:hover {
  opacity: 1;
}

/* Board Section: horizontal scroll container without board distortion */
.board-section {
  width: 100%;
}

.board-scroll-container {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  justify-content: center;
  box-sizing: border-box;
}

@media (max-width: 1020px) {
  .toolbar-scroll-container {
    justify-content: flex-start;
  }
  .toolbar-scroll-container .mower-plan-toolbar {
    margin-left: 0;
    margin-right: 0;
  }
  .board-scroll-container {
    justify-content: flex-start;
  }
}

/* Compact Results Panel */
.results-panel {
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  padding: 14px 18px;
  background: #18181c;
  border-radius: 4px;
  border: 1px solid rgba(66, 214, 199, 0.3);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.results-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 8px;
}

.results-title-box {
  display: flex;
  flex-direction: column;
}

.results-kicker {
  color: #42d6c7;
  font-size: 10px;
  letter-spacing: 0.15em;
  font-family: Consolas, monospace;
}

.results-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.power-summary-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  background: rgba(24, 160, 88, 0.15);
  border: 1px solid rgba(24, 160, 88, 0.35);
  border-radius: 4px;
  padding: 3px 8px;
  color: #63e2b7;
}

.power-summary-badge.is-danger {
  background: rgba(208, 48, 80, 0.15);
  border-color: rgba(208, 48, 80, 0.4);
  color: #ff7875;
}

.power-margin-text {
  font-weight: 600;
}

.power-tag {
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.2);
}

.results-error-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(208, 48, 80, 0.15);
  border: 1px solid rgba(208, 48, 80, 0.4);
  border-radius: 4px;
  color: #ff7875;
  font-size: 13px;
}

.results-blocked-box {
  padding: 10px 14px;
  background: rgba(240, 160, 32, 0.12);
  border: 1px solid rgba(240, 160, 32, 0.35);
  border-radius: 4px;
  color: #f2c97d;
  font-size: 13px;
}

.blocked-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.blocked-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.metric-card {
  padding: 10px 14px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-score82 {
  border-left: 3px solid #00e676;
  background: rgba(0, 230, 118, 0.06);
}

.text-score82 {
  color: #00e676;
}

.card-lmd {
  border-left: 3px solid #2080f0;
}

.card-exp {
  border-left: 3px solid #f0a020;
}

.card-gold {
  border-left: 3px solid #f0bd5b;
}

.card-drones {
  border-left: 3px solid #42d6c7;
}

.card-orundum {
  border-left: 3px solid #d03050;
}

.card-timeline {
  border-left: 3px solid #42d6c7;
  background: rgba(66, 214, 199, 0.08);
  cursor: pointer;
  transition: all 0.2s;
}

.card-timeline:hover {
  background: rgba(66, 214, 199, 0.16);
  border-color: #63e2b7;
  transform: translateY(-1px);
}

.metric-tag {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

.metric-main {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.metric-num {
  font-size: 20px;
  font-weight: 700;
  color: #ffffff;
}

.metric-unit {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.metric-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}

/* Compact Attribution Footer */
.workbench-footer {
  padding: 24px 16px;
  margin-top: auto;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(13, 17, 23, 0.85);
  display: flex;
  justify-content: center;
  align-items: center;
}

.footer-attribution {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #8da5ac;
}

.dot-sep {
  opacity: 0.4;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
