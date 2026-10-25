<template>
  <n-modal
    :show="isOpen"
    :to="to"
    preset="card"
    class="mower-global-replace-modal"
    title="一键替换干员"
    :style="{ width: '600px', maxWidth: '95vw' }"
    :closable="true"
    :mask-closable="true"
    @update:show="onModalUpdateShow"
    @close="handleCancel"
  >
    <div class="replace-modal-body">
      <!-- Section 1: Source Operator Selection -->
      <div class="form-section source-section">
        <label class="section-label" for="source-operator-select">
          <span>原干员（仅限当前在岗主力干员）</span>
          <span class="count-hint">在岗主力 {{ sourceOperators.length }} 位</span>
        </label>
        <div class="select-container">
          <select
            id="source-operator-select"
            v-model="sourceId"
            class="mower-select"
            data-test="source-select"
          >
            <option value="" disabled>-- 请选择需要替换的在岗主力干员 --</option>
            <option
              v-for="op in sourceOperators"
              :key="op.operatorId"
              :value="op.operatorId"
            >
              {{ op.name }} ({{ op.rooms.join(', ') }})
            </option>
            <!-- Fallback if sourceId was set dynamically -->
            <option
              v-if="sourceId && !sourceOperators.some((op) => op.operatorId === sourceId)"
              :value="sourceId"
            >
              {{ selectedSourceOp?.name || sourceId }}
            </option>
          </select>
        </div>
        <div v-if="sourceOperators.length === 0" class="empty-hint" data-test="no-source-operators">
          当前排班中没有配置任何主力干员
        </div>
      </div>

      <!-- Section 2: Visual Source ➔ Target comparison -->
      <div class="source-target-display" data-test="source-target-display">
        <div class="op-card-wrapper source-wrapper" data-test="source-display">
          <div class="card-header-tag">原干员</div>
          <div v-if="selectedSourceOp" class="op-card">
            <img
              v-if="!imageErrors[selectedSourceOp.operatorId]"
              :src="getOperatorAvatarUrl(selectedSourceOp.operatorId)"
              :alt="selectedSourceOp.name"
              width="45"
              height="45"
              class="card-avatar"
              @error="onImageError(selectedSourceOp.operatorId)"
            />
            <div v-else class="card-avatar-fallback">{{ selectedSourceOp.name }}</div>
            <div class="card-info">
              <div class="card-name">{{ selectedSourceOp.name }}</div>
              <div class="card-extra">
                {{ selectedSourceOp.rooms.length > 0 ? selectedSourceOp.rooms.join(', ') : selectedSourceOp.operatorId }}
              </div>
            </div>
          </div>
          <div v-else class="op-card-placeholder">请选择原干员</div>
        </div>

        <div class="arrow-container" data-test="replacement-arrow">
          <span class="arrow-icon">➔</span>
        </div>

        <div class="op-card-wrapper target-wrapper" data-test="target-display">
          <div class="card-header-tag">目标干员</div>
          <div v-if="selectedTargetOp" class="op-card">
            <img
              v-if="!imageErrors[selectedTargetOp.charId]"
              :src="getOperatorAvatarUrl(selectedTargetOp.charId)"
              :alt="selectedTargetOp.name"
              width="45"
              height="45"
              class="card-avatar"
              @error="onImageError(selectedTargetOp.charId)"
            />
            <div v-else class="card-avatar-fallback">{{ selectedTargetOp.name }}</div>
            <div class="card-info">
              <div class="card-name">{{ selectedTargetOp.name }}</div>
              <div class="card-extra">{{ selectedTargetOp.appellation || selectedTargetOp.charId }}</div>
            </div>
          </div>
          <div v-else class="op-card-placeholder">请选择目标干员</div>
        </div>
      </div>

      <!-- Section 3: Target Operator Search & Selection -->
      <div class="form-section target-section">
        <label class="section-label" for="target-operator-select">
          <span>替换为目标干员</span>
          <span class="count-hint">全干员库</span>
        </label>

        <!-- Standard select for test and form binding -->
        <div class="select-container">
          <select
            id="target-operator-select"
            v-model="targetId"
            class="mower-select"
            data-test="target-select"
          >
            <option value="" disabled>-- 请选择或在下方搜索目标干员 --</option>
            <option
              v-for="op in allOperators"
              :key="op.charId"
              :value="op.charId"
            >
              {{ op.name }} ({{ op.appellation || op.charId }})
            </option>
          </select>
        </div>

        <!-- Searchable input with pinyin helper -->
        <div class="target-search-bar">
          <input
            v-model="targetSearchQuery"
            type="text"
            class="search-input"
            data-test="target-search-input"
            placeholder="搜索目标干员（支持 中文 / 全拼 / 首字母 / 英文代号 如: 德克萨斯 / dks / texas）"
          />
        </div>

        <!-- Compact avatar grid of search results -->
        <div class="target-grid-container" data-test="target-operator-grid">
          <div class="target-grid">
            <div
              v-for="op in filteredTargetOperators"
              :key="op.charId"
              class="target-item"
              :class="{ 'is-selected': op.charId === targetId }"
              :data-op-id="op.charId"
              :data-op-name="op.name"
              @click="selectTarget(op.charId)"
            >
              <div class="avatar-wrap">
                <img
                  v-if="!imageErrors[op.charId]"
                  :src="getOperatorAvatarUrl(op.charId)"
                  :alt="op.name"
                  width="40"
                  height="40"
                  class="target-avatar"
                  loading="lazy"
                  @error="onImageError(op.charId)"
                />
                <div v-else class="target-avatar-fallback">{{ op.name }}</div>
                <span v-if="op.charId === targetId" class="selected-badge">✓</span>
              </div>
              <div class="target-name" :title="op.name">{{ op.name }}</div>
            </div>
          </div>
          <div v-if="filteredTargetOperators.length === 0" class="empty-search-hint">
            未找到匹配干员
          </div>
        </div>
      </div>

      <!-- Section 4: Validation Warning if same operator -->
      <div
        v-if="isSameOperator"
        class="validation-warning error-same"
        data-test="error-same-operator"
      >
        原干员与目标干员相同，无法进行替换！
      </div>

      <!-- Section 5: Impact Summary -->
      <div v-if="sourceId" class="impact-summary-wrapper" data-test="impact-summary">
        <div class="impact-summary-header">
          <span class="impact-summary-title">替换影响范围预估</span>
          <span class="impact-summary-total" data-test="impact-total-count">
            共计 {{ impact.totalCount }} 处
          </span>
        </div>

        <div class="impact-grid">
          <!-- Main Slots -->
          <div class="impact-card">
            <div class="impact-card-title">
              <span>主力在岗槽位</span>
              <span class="badge" data-test="impact-main-count">{{ impact.mainLocations.length }} 处</span>
            </div>
            <ul v-if="impact.mainLocations.length > 0" class="impact-list" data-test="impact-main-list">
              <li
                v-for="(loc, idx) in impact.mainLocations"
                :key="`main-${idx}`"
                class="impact-list-item"
              >
                {{ loc.roomName }}（第 {{ loc.slotIndex + 1 }} 位）
              </li>
            </ul>
            <div v-else class="impact-card-empty">无主力在岗槽位</div>
          </div>

          <!-- Replacement Entries -->
          <div class="impact-card">
            <div class="impact-card-title">
              <span>替补轮换列表</span>
              <span class="badge" data-test="impact-replacement-count">{{ impact.replacementLocations.length }} 处</span>
            </div>
            <ul v-if="impact.replacementLocations.length > 0" class="impact-list" data-test="impact-replacement-list">
              <li
                v-for="(loc, idx) in impact.replacementLocations"
                :key="`rep-${idx}`"
                class="impact-list-item"
              >
                {{ loc.roomName }}（第 {{ loc.slotIndex + 1 }} 位替补）
              </li>
            </ul>
            <div v-else class="impact-card-empty">无替补列表配置</div>
          </div>

          <!-- Conf/Policy Lists -->
          <div class="impact-card">
            <div class="impact-card-title">
              <span>策略与偏好名单</span>
              <span class="badge" data-test="impact-conf-count">{{ impact.confLocations.length }} 项</span>
            </div>
            <ul v-if="impact.confLocations.length > 0" class="impact-list" data-test="impact-conf-list">
              <li
                v-for="(confKey, idx) in impact.confLocations"
                :key="`conf-${idx}`"
                class="impact-list-item"
              >
                {{ policyName(confKey) }}
              </li>
            </ul>
            <div v-else class="impact-card-empty">无策略名单包含该干员</div>
          </div>
          <div v-if="impact.additionalLocations?.length" class="impact-card">
            <div class="impact-card-title">
              <span>关联组、副表与其他配置</span>
              <span class="badge">{{ impact.additionalLocations.length }} 处</span>
            </div>
            <ul class="impact-list" data-test="impact-extra-list">
              <li v-for="(location, idx) in impact.additionalLocations" :key="`additional-${idx}`" class="impact-list-item">{{ location }}</li>
            </ul>
          </div>
        </div>
      </div>
      <div v-else class="impact-prompt" data-test="prompt-missing-choice">
        请选择原干员以查看全局替换影响范围
      </div>
    </div>

    <!-- Footer buttons -->
    <template #footer>
      <div class="modal-footer">
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
          type="primary"
          size="small"
          :disabled="!isValid"
          @click="handleConfirm"
        >
          确认替换
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
/**
 * Derivative work based on arknights-mower (Plan.vue / PlanEditor.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { computed, ref, watch } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { OPERATOR_MAP, OPERATORS, type OperatorRecord } from '../../domain/operators'
import { useRosterWorkbenchStore } from '../../workbench/store'
import {
  buildOperatorSearchIndex,
  computeReplacementScope,
  getOperatorAvatarUrl,
  getRoomDisplayName,
  searchOperators,
  type OperatorSearchItem,
  type ReplacementScopeResult,
} from '../../workbench/operatorHelpers'
import type { MowerRoomId } from '../../domain/roster'

export interface GlobalReplacePayload {
  sourceId: string
  targetId: string
  sourceOperatorId: string
  targetOperatorId: string
  sourceName: string
  targetName: string
  impact: ReplacementScopeResult
}

export interface SourceOperatorOption {
  operatorId: string
  name: string
  appellation?: string
  rarity?: number
  rooms: string[]
}

interface Props {
  open?: boolean
  visible?: boolean
  to?: string | HTMLElement | undefined
}

const props = withDefaults(defineProps<Props>(), {
  open: undefined,
  visible: undefined,
  to: undefined,
})

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void
  (e: 'update:visible', val: boolean): void
  (e: 'close'): void
  (e: 'replaced', payload: GlobalReplacePayload): void
}>()

const store = useRosterWorkbenchStore()

const isOpen = computed<boolean>(() => {
  if (props.open !== undefined) return props.open
  if (props.visible !== undefined) return props.visible
  return false
})

const sourceId = ref('')
const targetId = ref('')
const targetSearchQuery = ref('')
const imageErrors = ref<Record<string, boolean>>({})

function onImageError(charId: string) {
  if (!charId) return
  imageErrors.value = {
    ...imageErrors.value,
    [charId]: true,
  }
}

const allOperators = OPERATORS
const searchIndex = buildOperatorSearchIndex(OPERATORS)

watch(
  () => isOpen.value,
  (newVal) => {
    if (newVal) {
      sourceId.value = ''
      targetId.value = ''
      targetSearchQuery.value = ''
    }
  },
)

const sourceOperators = computed<SourceOperatorOption[]>(() => {
  const map = new Map<string, { name: string; appellation?: string; rarity?: number; rooms: string[] }>()
  const facilities = store.workspace?.mainPlan?.facilities
  if (!facilities) return []

  for (const roomId of Object.keys(facilities) as MowerRoomId[]) {
    const facility = facilities[roomId]
    if (!facility?.slots) continue
    const roomName = getRoomDisplayName(facility.roomId, facility.type)

    for (const slot of facility.slots) {
      if (slot.occupant && slot.occupant.kind === 'operator') {
        const opId = slot.occupant.operatorId?.trim()
        if (!opId) continue
        const lower = opId.toLowerCase()
        if (lower === 'free' || lower === 'current' || lower === 'empty') {
          continue
        }

        const existing = map.get(opId)
        if (existing) {
          if (!existing.rooms.includes(roomName)) {
            existing.rooms.push(roomName)
          }
        } else {
          const opRecord = OPERATOR_MAP.get(opId)
          map.set(opId, {
            name: opRecord?.name ?? opId,
            appellation: opRecord?.appellation,
            rarity: opRecord?.rarity,
            rooms: [roomName],
          })
        }
      }
    }
  }

  return Array.from(map.entries())
    .map(([operatorId, info]) => ({
      operatorId,
      name: info.name,
      appellation: info.appellation,
      rarity: info.rarity,
      rooms: info.rooms,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
})

const selectedSourceOp = computed<SourceOperatorOption | null>(() => {
  if (!sourceId.value) return null
  const fromSourceList = sourceOperators.value.find((op) => op.operatorId === sourceId.value)
  if (fromSourceList) return fromSourceList
  const opRecord = OPERATOR_MAP.get(sourceId.value)
  return {
    operatorId: sourceId.value,
    name: opRecord?.name ?? sourceId.value,
    appellation: opRecord?.appellation,
    rarity: opRecord?.rarity,
    rooms: [],
  }
})

const filteredTargetOperators = computed<OperatorSearchItem[]>(() => {
  return searchOperators(targetSearchQuery.value, searchIndex, 60)
})

const selectedTargetOp = computed<OperatorRecord | { charId: string; name: string; appellation?: string } | null>(() => {
  if (!targetId.value) return null
  return OPERATOR_MAP.get(targetId.value) || { charId: targetId.value, name: targetId.value }
})

function selectTarget(charId: string) {
  targetId.value = charId
}

const impact = computed<ReplacementScopeResult>(() => {
  if (!sourceId.value) {
    return {
      totalCount: 0,
      mainLocations: [],
      replacementLocations: [],
      confLocations: [],
    }
  }
  return computeReplacementScope(store.workspace.mainPlan, sourceId.value, store.workspace.compatibility)
})

const isSameOperator = computed<boolean>(() => {
  return Boolean(sourceId.value && targetId.value && sourceId.value === targetId.value)
})

const isValid = computed<boolean>(() => {
  if (!sourceId.value || !targetId.value) return false
  if (isSameOperator.value) return false
  return true
})

const POLICY_LABELS: Record<string, string> = {
  exhaust_require: '强制耗尽 (exhaust_require)',
  rest_in_full: '满心情休息 (rest_in_full)',
  resting_priority: '休息优先级 (resting_priority)',
  workaholic: '工作狂 (workaholic)',
  refresh_trading: '跑单干员 (refresh_trading)',
  refresh_drained: '跑单补充 (refresh_drained)',
  ope_resting_priority: '特定休息优先 (ope_resting_priority)',
}

function policyName(key: string): string {
  return POLICY_LABELS[key] || key
}

function closeModal(): void {
  emit('update:open', false)
  emit('update:visible', false)
  emit('close')
}

function handleCancel(): void {
  closeModal()
}

function onModalUpdateShow(val: boolean): void {
  if (!val) {
    handleCancel()
  }
}

function handleConfirm(): void {
  if (!isValid.value) return

  const sId = sourceId.value
  const tId = targetId.value
  const currentImpact: ReplacementScopeResult = {
    totalCount: impact.value.totalCount,
    mainLocations: [...impact.value.mainLocations],
    replacementLocations: [...impact.value.replacementLocations],
    confLocations: [...impact.value.confLocations],
    additionalLocations: [...(impact.value.additionalLocations ?? [])],
  }

  // Exactly one call to store.replaceOperatorGlobally
  store.replaceOperatorGlobally(sId, tId)

  const sOp = OPERATOR_MAP.get(sId)
  const tOp = OPERATOR_MAP.get(tId)

  emit('replaced', {
    sourceId: sId,
    targetId: tId,
    sourceOperatorId: sId,
    targetOperatorId: tId,
    sourceName: sOp?.name ?? sId,
    targetName: tOp?.name ?? tId,
    impact: currentImpact,
  })

  closeModal()
}
</script>

<style scoped>
.mower-global-replace-modal {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: rgba(255, 255, 255, 0.85);
}

.replace-modal-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.count-hint {
  font-size: 11px;
  font-weight: normal;
  color: rgba(255, 255, 255, 0.45);
}

.select-container {
  width: 100%;
}

.mower-select {
  width: 100%;
  padding: 6px 10px;
  background: #101921;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #e9f2f4;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, background 0.2s;
}

.mower-select:focus {
  border-color: #42d6c7;
  background: #14202a;
}

.mower-select option {
  background: #18181c;
  color: #e9f2f4;
}

.empty-hint {
  font-size: 12px;
  color: #d03050;
  margin-top: 2px;
}

/* Explicit source ➔ target visual comparison row */
.source-target-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 10px 14px;
  gap: 10px;
}

.op-card-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-header-tag {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

.op-card {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-avatar {
  width: 45px;
  height: 45px;
  border-radius: 3px;
  background: #333639;
  object-fit: cover;
  flex-shrink: 0;
}

.card-avatar-fallback {
  width: 45px;
  height: 45px;
  border-radius: 3px;
  background: #333639;
  color: #e0e0e0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  text-align: center;
  line-height: 1.1;
  flex-shrink: 0;
}

.card-info {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-name {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-extra {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.op-card-placeholder {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  line-height: 45px;
}

.arrow-container {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.arrow-icon {
  font-size: 18px;
  color: #42d6c7;
  font-weight: bold;
}

/* Target Search Box & Grid */
.target-search-bar {
  margin-top: 4px;
}

.search-input {
  width: 100%;
  padding: 6px 10px;
  background: #101921;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #e9f2f4;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: #42d6c7;
}

.target-grid-container {
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 6px;
  background: rgba(0, 0, 0, 0.25);
}

.target-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
  gap: 6px 4px;
  justify-items: center;
}

.target-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  width: 48px;
  user-select: none;
  transition: background 0.15s, transform 0.15s;
}

.target-item:hover {
  background: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
}

.target-item.is-selected {
  background: rgba(66, 214, 199, 0.2);
  outline: 1px solid #42d6c7;
}

.avatar-wrap {
  position: relative;
  width: 40px;
  height: 40px;
}

.target-avatar {
  width: 40px;
  height: 40px;
  border-radius: 2px;
  object-fit: cover;
  background: grey;
  display: block;
}

.target-avatar-fallback {
  width: 40px;
  height: 40px;
  border-radius: 2px;
  background: #333639;
  color: #e0e0e0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  text-align: center;
  line-height: 1.1;
  word-break: break-all;
  overflow: hidden;
}

.selected-badge {
  position: absolute;
  top: 0;
  right: 0;
  background: #42d6c7;
  color: #071015;
  font-size: 10px;
  font-weight: bold;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.target-name {
  margin-top: 2px;
  font-size: 10px;
  line-height: 12px;
  color: rgba(255, 255, 255, 0.8);
  width: 46px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-search-hint {
  text-align: center;
  padding: 18px 0;
  color: rgba(255, 255, 255, 0.35);
  font-size: 12px;
}

/* Warnings and Prompts */
.validation-warning {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
}

.error-same {
  background: rgba(208, 48, 80, 0.15);
  border: 1px solid rgba(208, 48, 80, 0.4);
  color: #ff6b81;
}

/* Impact summary */
.impact-summary-wrapper {
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.impact-summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.impact-summary-title {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.75);
}

.impact-summary-total {
  font-size: 12px;
  font-weight: 600;
  color: #f0a020;
}

.impact-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.impact-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.impact-card-title {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.65);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.badge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 2px;
  background: rgba(66, 214, 199, 0.2);
  color: #42d6c7;
}

.impact-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 80px;
  overflow-y: auto;
}

.impact-list-item {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  line-height: 14px;
}

.impact-card-empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
  font-style: italic;
}

.impact-prompt {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  text-align: center;
  padding: 8px 0;
}

/* Modal footer */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
