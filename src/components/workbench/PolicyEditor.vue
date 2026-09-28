<template>
  <div class="mower-policy-editor plan-container">
    <div class="policy-header">
      <h3 class="policy-title">策略配置</h3>
      <span class="policy-subtitle">Mower 主排班常用运行策略</span>
    </div>

    <n-form
      class="policy-form"
      :show-feedback="false"
      label-placement="left"
      label-width="170"
      label-align="left"
    >
      <!-- 令夕模式 (ling_xi) -->
      <n-form-item class="policy-form-item" data-field="ling_xi">
        <template #label>
          <div class="field-label-wrapper">
            <span class="field-label">令夕模式</span>
            <n-tooltip trigger="hover">
              <template #trigger>
                <span class="help-icon" title="帮助">?</span>
              </template>
              <div class="help-content">
                <div>令夕上班时起作用</div>
                <div>启动Mower前需要手动对齐心情</div>
                <div>感知：夕心情-令心情=12</div>
                <div>烟火：令心情-夕心情=12</div>
                <div>均衡：夕令心情一样</div>
              </div>
            </n-tooltip>
          </div>
        </template>
        <div class="ling-xi-control">
          <n-radio-group
            :value="conf.ling_xi === 0 ? 3 : conf.ling_xi"
            class="ling-xi-radios"
            data-test="ling-xi-radio-group"
            @update:value="onLingXiChange"
          >
            <n-space>
              <n-radio :value="1" data-test="ling-xi-radio-1">感知信息</n-radio>
              <n-radio :value="2" data-test="ling-xi-radio-2">人间烟火</n-radio>
              <n-radio :value="3" data-test="ling-xi-radio-3">均衡模式</n-radio>
            </n-space>
          </n-radio-group>
          <!-- Native select for test accessibility and direct setValue -->
          <select
            class="ling-xi-select visually-hidden-select"
            data-test="ling-xi-select"
            :value="conf.ling_xi === 0 ? 3 : conf.ling_xi"
            aria-label="令夕模式"
            @change="onNativeLingXiChange"
          >
            <option :value="1">感知信息</option>
            <option :value="2">人间烟火</option>
            <option :value="3">均衡模式</option>
          </select>
        </div>
      </n-form-item>

      <!-- Seven Main-Plan Operator Lists -->
      <n-form-item
        v-for="field in POLICY_LIST_FIELDS"
        :key="field.key"
        class="policy-form-item"
        :data-field="field.key"
      >
        <template #label>
          <div class="field-label-wrapper">
            <span class="field-label">{{ field.label }}</span>
            <n-tooltip v-if="field.help" trigger="hover">
              <template #trigger>
                <span class="help-icon" title="帮助">?</span>
              </template>
              <div class="help-content" style="white-space: pre-line;">{{ field.help }}</div>
            </n-tooltip>
          </div>
        </template>

        <div class="policy-list-editor" :data-test="`list-editor-${field.key}`">
          <!-- Tag Chips -->
          <div class="policy-tags-row">
            <div
              v-for="(opId, idx) in getList(field.key)"
              :key="`${opId}-${idx}`"
              class="policy-operator-tag"
              :data-test="`tag-${field.key}-${idx}`"
              :data-op-id="opId"
              draggable="true"
              @dragstart="onDragStart($event, field.key, idx)"
              @dragover.prevent
              @drop="onDrop($event, field.key, idx)"
            >
              <img
                v-if="!imageErrors[`${field.key}-${opId}-${idx}`]"
                :src="getOperatorAvatarUrl(opId)"
                :alt="getOperatorName(opId)"
                class="tag-avatar"
                draggable="false"
                @error="imageErrors[`${field.key}-${opId}-${idx}`] = true"
              />
              <div v-else class="tag-avatar-fallback">
                {{ getOperatorName(opId).slice(0, 1) }}
              </div>
              <span class="tag-name" :title="getOperatorName(opId)">{{ getOperatorName(opId) }}</span>
              <div class="tag-actions">
                <button
                  type="button"
                  class="reorder-btn move-up-btn"
                  :data-test="`move-up-${field.key}-${idx}`"
                  :disabled="idx === 0"
                  title="前移"
                  @click="moveOperator(field.key, idx, idx - 1)"
                >
                  ▲
                </button>
                <button
                  type="button"
                  class="reorder-btn move-down-btn"
                  :data-test="`move-down-${field.key}-${idx}`"
                  :disabled="idx === getList(field.key).length - 1"
                  title="后移"
                  @click="moveOperator(field.key, idx, idx + 1)"
                >
                  ▼
                </button>
                <button
                  type="button"
                  class="remove-btn"
                  :data-test="`remove-${field.key}-${idx}`"
                  title="删除"
                  @click="removeOperator(field.key, idx)"
                >
                  ×
                </button>
              </div>
            </div>

            <span v-if="getList(field.key).length === 0" class="empty-list-hint">
              未配置干员
            </span>
          </div>

          <!-- Real Search & Operator Selection -->
          <div class="policy-add-row">
            <n-select
              :value="null"
              :options="getSelectOptions(field.key)"
              :filter="filterOperator"
              filterable
              clear-filter-after-select
              size="small"
              class="operator-search-select"
              :data-test="`add-select-${field.key}`"
              :placeholder="field.placeholder"
              :render-label="renderOptionLabel"
              @update:value="onAddSelectValue(field.key, $event)"
            />
          </div>
        </div>
      </n-form-item>
    </n-form>

    <!-- Preservation note -->
    <div class="policy-footer-note">
      <span class="note-text">
        * 注：free_blacklist 属于副排班专有策略，已在兼容信封中无损保存，不作为主排班配置展示。
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Derivative work based on arknights-mower (Plan.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { computed, h, ref, type VNode } from 'vue'
import { NAvatar, NForm, NFormItem, NRadio, NRadioGroup, NSelect, NSpace, NTooltip, type SelectOption } from 'naive-ui'
import { match } from 'pinyin-pro'
import { OPERATOR_MAP, OPERATORS } from '../../domain/operators'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { getOperatorAvatarUrl } from '../../workbench/operatorHelpers'
import type { MowerMainConf } from '../../workbench/model'
import {
  POLICY_LIST_FIELDS,
  type PolicyOperatorListKey,
} from './policyFields'


const store = useRosterWorkbenchStore()
const conf = computed(() => store.workspace.mainPlan.conf)
const imageErrors = ref<Record<string, boolean>>({})

function getOperatorName(identifier: string): string {
  if (!identifier) return ''
  const op = OPERATOR_MAP.get(identifier) || OPERATORS.find((o) => o.name === identifier)
  return op ? op.name : identifier
}

function getList(key: PolicyOperatorListKey): string[] {
  const raw = conf.value[key]
  return Array.isArray(raw) ? raw : []
}

function onLingXiChange(val: number): void {
  const num = (val === 1 || val === 2 || val === 3) ? val : 1
  store.updateConf({ ling_xi: num as 1 | 2 | 3 })
}

function onNativeLingXiChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const val = parseInt(target.value, 10)
  onLingXiChange(val)
}

function addOperator(key: PolicyOperatorListKey, opId: string): void {
  if (!opId) return
  const current = getList(key)
  if (current.includes(opId)) return
  const next = [...current, opId]
  store.updateConf({ [key]: next } as Partial<MowerMainConf>)
}

function removeOperator(key: PolicyOperatorListKey, index: number): void {
  const current = getList(key)
  if (index < 0 || index >= current.length) return
  const next = [...current]
  next.splice(index, 1)
  store.updateConf({ [key]: next } as Partial<MowerMainConf>)
}

function moveOperator(key: PolicyOperatorListKey, fromIndex: number, toIndex: number): void {
  const current = getList(key)
  if (fromIndex < 0 || fromIndex >= current.length || toIndex < 0 || toIndex >= current.length || fromIndex === toIndex) {
    return
  }
  const next = [...current]
  const [item] = next.splice(fromIndex, 1)
  if (item !== undefined) {
    next.splice(toIndex, 0, item)
    store.updateConf({ [key]: next } as Partial<MowerMainConf>)
  }
}

function onDragStart(event: DragEvent, key: PolicyOperatorListKey, index: number): void {
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', JSON.stringify({ key, index }))
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onDrop(event: DragEvent, targetKey: PolicyOperatorListKey, toIndex: number): void {
  event.preventDefault()
  if (!event.dataTransfer) return
  try {
    const raw = event.dataTransfer.getData('text/plain')
    const data = JSON.parse(raw)
    if (data && data.key === targetKey && typeof data.index === 'number') {
      moveOperator(targetKey, data.index, toIndex)
      return
    }
  } catch {
    const fromIndex = parseInt(event.dataTransfer.getData('text/plain'), 10)
    if (!Number.isNaN(fromIndex)) {
      moveOperator(targetKey, fromIndex, toIndex)
    }
  }
}

function onAddSelectValue(key: PolicyOperatorListKey, value: string | null): void {
  if (value) {
    addOperator(key, value)
  }
}

const baseOperatorOptions = OPERATORS.map((op) => ({
  label: op.name,
  value: op.charId,
  name: op.name,
}))

function getSelectOptions(key: PolicyOperatorListKey): SelectOption[] {
  const list = getList(key)
  const missing = list.filter((id) => !OPERATOR_MAP.has(id))
  if (missing.length === 0) {
    return baseOperatorOptions
  }
  const extraOptions = missing.map((id) => ({
    label: getOperatorName(id),
    value: id,
    name: getOperatorName(id),
  }))
  return [...baseOperatorOptions, ...extraOptions]
}

function filterOperator(pattern: string, option: SelectOption): boolean {
  if (!pattern) return true
  const q = pattern.trim().toLowerCase()
  const label = String(option.label || '').toLowerCase()
  const value = String(option.value || '').toLowerCase()
  if (label.includes(q) || value.includes(q)) return true
  const pMatch = match(String(option.label || ''), q, { v: true }) ?? match(String(option.label || ''), q)
  return pMatch !== null && pMatch.length > 0
}

function renderOptionLabel(option: SelectOption): VNode {
  const val = String(option.value || '')
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
    },
    [
      h(NAvatar, {
        src: getOperatorAvatarUrl(val),
        round: true,
        size: 22,
        fallbackSrc: getOperatorAvatarUrl('Free'),
        style: { flexShrink: 0 },
      }),
      h('span', null, String(option.label || '')),
    ],
  )
}

defineExpose({
  addOperator,
  removeOperator,
  moveOperator,
  onLingXiChange,
  getList,
  getOperatorName,
  POLICY_LIST_FIELDS,
})
</script>

<style scoped>
.mower-policy-editor {
  width: 100%;
  max-width: 980px;
  margin: 16px auto;
  padding: 16px;
  background: #18181c;
  border-radius: 4px;
  box-sizing: border-box;
  color: rgba(255, 255, 255, 0.88);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.policy-header {
  margin-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 8px;
}

.policy-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.policy-subtitle {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.field-label-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
}

.help-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  cursor: help;
}

.help-content {
  font-size: 12px;
  line-height: 1.5;
}

.ling-xi-control {
  display: flex;
  align-items: center;
}

.visually-hidden-select {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
  opacity: 0;
  pointer-events: none;
}

.policy-list-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.policy-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}

.policy-operator-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  cursor: grab;
  user-select: none;
  transition: all 0.15s;
}

.policy-operator-tag:hover {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(32, 128, 240, 0.5);
}

.tag-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.tag-avatar-fallback {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #333;
  color: #ccc;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}

.tag-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
}

.reorder-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  padding: 0 1px;
  font-size: 9px;
  line-height: 1;
}

.reorder-btn:hover:not(:disabled) {
  color: #2080f0;
}

.reorder-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.remove-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  font-weight: bold;
}

.remove-btn:hover {
  color: #d03050;
}

.empty-list-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
  font-style: italic;
}

.policy-add-row {
  width: 100%;
  max-width: 280px;
}

.policy-footer-note {
  margin-top: 14px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

.note-text {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}
</style>
