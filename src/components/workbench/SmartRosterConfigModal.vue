<template>
  <n-modal
    :show="isOpen"
    :to="to"
    preset="card"
    class="mower-smart-roster-modal"
    title="一键智能排班参数配置"
    :style="{ width: '620px', maxWidth: '95vw' }"
    :closable="true"
    :mask-closable="true"
    @update:show="onModalUpdateShow"
    @close="handleCancel"
  >
    <div class="roster-modal-body" data-test="smart-roster-modal-body">
      <div class="modal-intro">
        <p class="intro-title">⚡ 智能排班设置</p>
        <p class="intro-desc">
          按实际练度与全局在岗联动筛选高效主班，保留合法初始排班，再以完整仿真的日均加权产出确认结果。保留当前建筑、锁定人员和用户已有完整组合。
        </p>
      </div>

      <!-- Phase 1: High-output primary candidates -->
      <ProductionWeightsEditor :model-value="normalizeProductionWeights(form.productionWeights)" @update:model-value="form.productionWeights = $event" @validity-change="weightsValid = $event" />
      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-1">阶段 1</span> 主班候选筛选
        </legend>
        <p class="stage-description" data-test="constraint-description">按实际练度、完整组合与全局在岗联动比较主班产出，保留高效方案和安全初始表。主班效率用于筛选，长期收益仍需完整仿真确认。</p>
      </fieldset>

      <!-- Phase 2: Dynamic Simulation Verification -->
      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-2">阶段 2</span> 完整仿真确认
        </legend>
        <p class="stage-description" data-test="verification-description">默认最多两份完整仿真：有更高主班效率候选时，比较高效主班方案与初始表，按日均加权产出保留较优结果；没有改善时先验证初始表，成功即返回，未完成再验证后备方案。</p>
        <div class="field-row single-field">
          <div class="field-item">
            <label for="sample-hours-input">
              <span>仿真采样时长 (小时)</span>
              <small class="field-tip">用于计算日均基建产出的采样时长 (24–168)</small>
            </label>
            <input
              id="sample-hours-input"
              v-model.number="form.simulationSampleHours"
              type="number"
              min="24"
              max="168"
              step="24"
              class="mower-num-input"
              data-test="sample-hours-input"
            />
          </div>
        </div>
      </fieldset>

      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-3">可选</span> 持续主班优化
        </legend>
        <div class="checkbox-row">
          <label class="checkbox-label" for="enable-main-optimization">
            <input id="enable-main-optimization" v-model="form.enableMainOptimization" type="checkbox" class="mower-checkbox" data-test="enable-main-optimization" />
            <span class="checkbox-text">
              <strong>继续比较主班与恢复方案</strong>
              <small class="checkbox-hint">先生成并验证可用排班，再按预算继续比较。可随时结束并保留已确认的较优方案，产出未必更高。</small>
            </span>
          </label>
        </div>
        <div class="checkbox-row">
          <label class="checkbox-label" for="allow-free-combinations">
            <input id="allow-free-combinations" v-model="form.allowFreeCombinations" :disabled="!form.enableMainOptimization" type="checkbox" class="mower-checkbox" data-test="allow-free-combinations" />
            <span class="checkbox-text">
              <strong>允许自由组合</strong>
              <small class="checkbox-hint" data-test="free-combinations-description">允许打散自动构造的内部预设组合，按实际驻员重新评价联动；输入中已配置工位与人员继续锁定。</small>
            </span>
          </label>
        </div>
        <div class="field-row">
          <div class="field-item">
            <label for="optimization-max-simulations">
              <span>额外完整仿真上限</span>
              <small class="field-tip">初始结果确认后最多追加 1–8 次比较</small>
            </label>
            <input id="optimization-max-simulations" v-model.number="form.optimizationMaxSimulations" :disabled="!form.enableMainOptimization" type="number" min="1" max="8" step="1" class="mower-num-input" data-test="optimization-max-simulations" />
          </div>
          <div class="field-item">
            <label for="optimization-time-budget-seconds">
              <span>继续比较的时间预算（秒）</span>
              <small class="field-tip">到时停止启动新候选，已开始的完整仿真会继续完成</small>
            </label>
            <input id="optimization-time-budget-seconds" v-model.number="optimizationTimeBudgetSeconds" :disabled="!form.enableMainOptimization" type="number" min="1" max="300" step="1" class="mower-num-input" data-test="optimization-time-budget-seconds" />
          </div>
        </div>
      </fieldset>

      <!-- Optional additional comparison -->
      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-3">可选</span> 额外深度比较
        </legend>
        <div class="checkbox-row">
          <label class="checkbox-label" for="enable-deep-search">
            <input
              id="enable-deep-search"
              v-model="form.enableDeepSearch"
              type="checkbox"
              class="mower-checkbox"
              data-test="enable-deep-search"
            />
            <span class="checkbox-text">
              <strong>追加队伍优化、局部搜索与仿真</strong>
              <small class="checkbox-hint" data-test="deep-search-description">进一步计算队伍分配并验证局部调整，会增加等待时间。</small>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-3">可选</span> 联合主副表比较
        </legend>
        <div class="checkbox-row">
          <label class="checkbox-label" for="enable-backup-generation">
            <input
              id="enable-backup-generation"
              v-model="form.enableBackupGeneration"
              type="checkbox"
              class="mower-checkbox"
              data-test="enable-backup-generation"
            />
            <span class="checkbox-text">
              <strong>联合生成条件副表（实验）</strong>
              <small class="checkbox-hint" data-test="backup-generation-description">比较主表方案与附带条件副表的方案；可能增加等待时间，产出未必更高。</small>
            </span>
          </label>
        </div>
      </fieldset>

      <!-- Common Settings: Drone & Seed -->
      <fieldset class="config-fieldset">
        <legend class="fieldset-legend">
          <span class="phase-badge phase-common">偏好</span> 辅助控制与种子
        </legend>
        <div class="field-row">
          <div class="field-item">
            <label for="drone-target-select">
              <span>无人机加速目标</span>
              <small class="field-tip">选择本次仿真使用的具体设施</small>
            </label>
            <select
              id="drone-target-select"
              v-model="selectedRoom"
              class="mower-select-input"
              data-test="drone-target-select"
            >
              <option value="none">不使用无人机加速</option>
              <option v-for="facility in facilities" :key="facility.roomId" :value="facility.roomId">{{ facility.label }}</option>
            </select>
          </div>
          <div class="field-item">
            <label for="seed-input">
              <span>随机种子 (Seed)</span>
              <small class="field-tip">-1 代表随机种子，固定数值可复现仿真随机过程</small>
            </label>
            <input
              id="seed-input"
              v-model.number="form.seed"
              type="number"
              min="-1"
              class="mower-num-input"
              data-test="seed-input"
              placeholder="-1"
            />
          </div>
        </div>
      </fieldset>
    </div>

    <!-- Footer Action Buttons -->
    <template #footer>
      <div class="modal-footer">
        <n-button
          class="btn-reset"
          data-test="reset-btn"
          size="small"
          @click="handleReset"
        >
          ↺ 恢复默认
        </n-button>
        <div class="footer-right">
          <n-button
            class="btn-cancel"
            data-test="cancel-btn"
            size="small"
            @click="handleCancel"
          >
            取消
          </n-button>
          <n-button
            class="btn-confirm"
            data-test="confirm-btn"
            :disabled="!weightsValid"
            type="primary"
            size="small"
            @click="handleConfirm"
          >
            🚀 开始智能排班
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<script lang="ts">
import { SMART_ROSTER_OPTIMIZATION_DEFAULTS, type SmartRosterConfig } from '../../workbench/settings'
export type { SmartRosterConfig } from '../../workbench/settings'

export const STORAGE_KEY_SMART_ROSTER = 'arcinc-smart-roster-options-v1'

export const DEFAULT_CONFIG: SmartRosterConfig = {
  trials: 1,
  maxStaticEvals: 3000,
  simulationTopK: 2,
  simulationSampleHours: 72,
  simulationWarmupHours: 24,
  enableDeepSearch: false,
  enableBackupGeneration: false,
  ...SMART_ROSTER_OPTIMIZATION_DEFAULTS,
  droneTarget: 'gold',
  seed: -1,
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { droneFacilities } from '../../workbench/droneTargets'
import type { RosterWorkspace } from '../../domain/roster'
import ProductionWeightsEditor from './ProductionWeightsEditor.vue'
import { normalizeProductionWeights, type ProductionWeights } from '../../domain/productionWeights'
import { normalizeSmartRosterOptimizationOptions } from '../../workbench/settings'

const props = withDefaults(
  defineProps<{
    workspace?: RosterWorkspace
    open?: boolean
    visible?: boolean
    to?: string | HTMLElement | undefined
    initialDroneTarget?: 'gold' | 'exp' | 'trading' | 'none'
    initialSeed?: number
    initialProductionWeights?: ProductionWeights
  }>(),
  {
    open: undefined,
    visible: undefined,
    to: undefined,
    initialDroneTarget: 'gold',
    initialSeed: -1,
  },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', config: SmartRosterConfig): void
}>()

const isOpen = ref(false)
const weightsValid = ref(true)
const selectedRoom = ref('none')
const facilities = computed(() => props.workspace ? droneFacilities(props.workspace) : [])
// Retain legacy saved fields for compatibility; they do not control generation.
function legacyCount(value: unknown, fallback: number): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 ? count : fallback
}
function restoreRoom() {
  selectedRoom.value = form.value.droneTarget === 'none' ? 'none' :
    facilities.value.find(f => f.roomId === form.value.droneRoomId)?.roomId ??
    (form.value.droneRoomId ? 'none' : facilities.value.find(f => f.target === form.value.droneTarget)?.roomId ?? 'none')
}


const loadPersistedConfig = (): SmartRosterConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SMART_ROSTER)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        productionWeights: normalizeProductionWeights(props.initialProductionWeights ?? parsed.productionWeights),
        trials: legacyCount(parsed.trials, DEFAULT_CONFIG.trials),
        maxStaticEvals: Math.max(500, Math.min(10000, Number(parsed.maxStaticEvals) || DEFAULT_CONFIG.maxStaticEvals)),
        simulationTopK: legacyCount(parsed.simulationTopK, DEFAULT_CONFIG.simulationTopK),
        simulationSampleHours: Math.max(24, Math.min(168, Number(parsed.simulationSampleHours) || DEFAULT_CONFIG.simulationSampleHours)),
        simulationWarmupHours: Math.max(6, Math.min(48, Number(parsed.simulationWarmupHours) || DEFAULT_CONFIG.simulationWarmupHours)),
        enableDeepSearch: parsed.enableDeepSearch !== undefined ? Boolean(parsed.enableDeepSearch) : DEFAULT_CONFIG.enableDeepSearch,
        enableBackupGeneration: parsed.enableBackupGeneration === true,
        ...normalizeSmartRosterOptimizationOptions(parsed),
        droneTarget: ['gold', 'exp', 'trading', 'none'].includes(parsed.droneTarget) ? parsed.droneTarget : props.initialDroneTarget,
        droneRoomId: typeof parsed.droneRoomId === 'string' ? parsed.droneRoomId : '',
        seed: Number.isInteger(parsed.seed) ? parsed.seed : props.initialSeed,
      }
    }
  } catch {
    // Ignore storage parse failure
  }
  return {
    ...DEFAULT_CONFIG,
    productionWeights: normalizeProductionWeights(props.initialProductionWeights),
    droneTarget: props.initialDroneTarget,
    seed: props.initialSeed,
  }
}

const form = ref<SmartRosterConfig>(loadPersistedConfig())
const optimizationTimeBudgetSeconds = computed({
  get: () => (form.value.optimizationTimeBudgetMs ?? SMART_ROSTER_OPTIMIZATION_DEFAULTS.optimizationTimeBudgetMs) / 1000,
  set: (seconds: number) => { form.value.optimizationTimeBudgetMs = Number(seconds) * 1000 },
})

watch(
  () => props.open ?? props.visible ?? false,
  (val) => {
    isOpen.value = val
    if (val) {
      form.value = loadPersistedConfig()
      restoreRoom()
    }
  },
  { immediate: true },
)

const onModalUpdateShow = (show: boolean) => {
  isOpen.value = show
  if (!show) {
    emit('close')
  }
}

const handleCancel = () => {
  isOpen.value = false
  emit('close')
}

const handleReset = () => {
  form.value = {
    ...DEFAULT_CONFIG,
    productionWeights: normalizeProductionWeights(),
    droneTarget: props.initialDroneTarget,
    seed: props.initialSeed,
  }
  try {
    restoreRoom()
    localStorage.removeItem(STORAGE_KEY_SMART_ROSTER)
  } catch {
    // ignore
  }
}

const handleConfirm = () => {
  if (!weightsValid.value) return
  // Sanitize numeric ranges
  const config: SmartRosterConfig = {
    productionWeights: normalizeProductionWeights(form.value.productionWeights),
    trials: legacyCount(form.value.trials, DEFAULT_CONFIG.trials),
    maxStaticEvals: Math.max(500, Math.min(10000, Math.floor(form.value.maxStaticEvals) || 500)),
    simulationTopK: legacyCount(form.value.simulationTopK, DEFAULT_CONFIG.simulationTopK),
    simulationSampleHours: Math.max(24, Math.min(168, Math.floor(form.value.simulationSampleHours) || 24)),
    simulationWarmupHours: Math.max(6, Math.min(48, Math.floor(form.value.simulationWarmupHours) || 6)),
    enableDeepSearch: Boolean(form.value.enableDeepSearch),
    enableBackupGeneration: form.value.enableBackupGeneration === true,
    ...normalizeSmartRosterOptimizationOptions(form.value),
    droneTarget: facilities.value.find(f => f.roomId === selectedRoom.value)?.target ?? 'none',
    droneRoomId: selectedRoom.value === 'none' ? '' : selectedRoom.value,
    seed: Number.isInteger(form.value.seed) ? form.value.seed : -1,
  }

  try {
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, JSON.stringify(config))
  } catch {
    // ignore storage quota error
  }

  isOpen.value = false
  emit('confirm', config)
}
</script>

<style scoped>
.mower-smart-roster-modal {
  font-family: inherit;
}

.roster-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: #e2e8f0;
}

.modal-intro {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(66, 214, 199, 0.25);
  border-radius: 8px;
  padding: 10px 14px;
}

.intro-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 700;
  color: #42d6c7;
}

.intro-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #94a3b8;
}

.stage-description {
  margin: 4px 0 10px;
  color: #94a3b8;
  font-size: 12px;
  line-height: 1.5;
}

.config-fieldset {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 12px 14px 14px;
  margin: 0;
  background: rgba(0, 0, 0, 0.22);
}

.fieldset-legend {
  font-size: 12px;
  font-weight: 700;
  color: #f1f5f9;
  padding: 0 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.phase-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-weight: 800;
}

.phase-1 {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.4);
}

.phase-2 {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.4);
}

.phase-3 {
  background: rgba(168, 85, 247, 0.2);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.4);
}

.phase-common {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 4px;
}

.single-field {
  grid-template-columns: 1fr;
}

@media (max-width: 500px) {
  .field-row {
    grid-template-columns: 1fr;
  }
}

.field-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-item label {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
  display: flex;
  flex-direction: column;
}

.field-tip {
  font-size: 11px;
  color: #64748b;
  font-weight: normal;
  margin-top: 1px;
}

.mower-num-input,
.mower-select-input {
  background: #101921;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 6px 10px;
  color: #e9f2f4;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.mower-num-input:focus,
.mower-select-input:focus {
  border-color: #42d6c7;
  box-shadow: 0 0 0 2px rgba(66, 214, 199, 0.2);
}

.mower-num-input:disabled,
.mower-checkbox:disabled {
  opacity: 0.5;
  cursor: default;
}

.checkbox-row {
  display: flex;
  align-items: center;
  margin-top: 4px;
}

.checkbox-label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.mower-checkbox {
  margin-top: 3px;
  accent-color: #a855f7;
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.checkbox-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: #e2e8f0;
}

.checkbox-hint {
  font-size: 11px;
  color: #94a3b8;
}

.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.footer-right {
  display: flex;
  gap: 8px;
}

.btn-confirm {
  background: #18a058 !important;
  border-color: #18a058 !important;
  color: #ffffff !important;
  font-weight: 700;
}
</style>
