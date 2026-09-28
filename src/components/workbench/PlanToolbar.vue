<template>
  <div class="mower-plan-toolbar plan-bar w-980 mx-auto mt-12 mw-980">
    <div class="toolbar-actions">
      <!-- Left actions: Reset & Import/Export -->
      <div class="action-cluster left-cluster">
        <!-- New / Reset Main Plan -->
        <button
          type="button"
          class="mower-btn btn-reset"
          data-test="reset-btn"
          :disabled="disabled || isExportingImage"
          @click="onResetClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          新建/重置
        </button>

        <!-- Clear Stationed Operators -->
        <button
          type="button"
          class="mower-btn btn-clear-operators"
          data-test="clear-operators-btn"
          :disabled="disabled || isExportingImage"
          @click="onClearOperatorsClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/>
          </svg>
          清空干员
        </button>

        <!-- Import Operator Inventory (MAA & Yituliu) -->
        <button
          type="button"
          class="mower-btn btn-import-inventory"
          data-test="import-inventory-btn"
          :disabled="disabled || isExportingImage"
          @click="importModalOpen = true"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
          </svg>
          导入干员库
        </button>

        <!-- Import Button (accepts .json, .jpg, .jpeg) -->
        <button
          type="button"
          class="mower-btn btn-import"
          data-test="import-btn"
          :disabled="disabled || isExportingImage"
          @click="onImportClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
          </svg>
          导入排班
        </button>

        <!-- Hidden Native File Input for browser file picker -->
        <input
          ref="fileInputRef"
          type="file"
          class="visually-hidden-file-input"
          data-test="file-input"
          accept=".json,.jpg,.jpeg"
          style="display: none"
          @change="onFileInputChange"
        />

        <!-- Export Button Group (JSON & Image) -->
        <div class="mower-btn-group">
          <button
            type="button"
            class="mower-btn btn-export-json"
            data-test="export-json-btn"
            :disabled="disabled || isExportingImage"
            @click="onExportJsonClick"
          >
            <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
            导出JSON
          </button>
          <button
            type="button"
            class="mower-btn btn-export-image"
            data-test="export-image-btn"
            :disabled="disabled || isExportingImage"
            @click="onExportImageClick"
          >
            <span v-if="isExportingImage" class="mower-spinner" aria-hidden="true"></span>
            <svg v-else class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
            </svg>
            {{ isExportingImage ? '导出中...' : '导出图片' }}
          </button>
          <button
            type="button"
            class="mower-btn btn-export-poster"
            data-test="export-poster-btn"
            :disabled="disabled || isExportingImage"
            title="生成排班高清水印海报与收益长图"
            @click="emit('open-poster')"
          >
            <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5-7l-3 3.72L9 13l-3 4h12l-4-5z"/>
            </svg>
            分享海报
          </button>
        </div>
      </div>

      <!-- Right actions: Auto Roster, Replace & Yield Calculation -->
      <div class="action-cluster right-cluster">
        <!-- Abort Auto Generate (Req 5) -->
        <button
          v-if="isGeneratingRoster"
          type="button"
          class="mower-btn btn-abort-roster"
          data-test="abort-roster-btn"
          @click="onAbortGenerateClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/>
          </svg>
          中止排班
        </button>

        <!-- Auto Generate Roster (Req 10) -->
        <button
          type="button"
          class="mower-btn btn-auto-roster"
          data-test="auto-roster-btn"
          :disabled="disabled || isExportingImage || isGeneratingRoster || isCalculating"
          @click="onAutoGenerateClick"
        >
          <span v-if="isGeneratingRoster" class="mower-spinner" aria-hidden="true"></span>
          <svg v-else class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          {{ isGeneratingRoster ? '正在排班...' : '自动生成排班' }}
        </button>

        <!-- One-Click Global Operator Replace -->
        <button
          type="button"
          class="mower-btn btn-replace"
          data-test="replace-btn"
          :disabled="disabled || isExportingImage"
          @click="onReplaceClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z"/>
          </svg>
          一键替换干员
        </button>

        <!-- Calculate Yield -->
        <button
          type="button"
          class="mower-btn btn-calc"
          data-test="calc-btn"
          :disabled="disabled || !isValid || isExportingImage || isCalculating || isGeneratingRoster"
          @click="onCalculateClick"
        >
          <svg class="mower-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-6 2h5v2h-5V5zm0 3h5v2h-5V8zm-7-3h5v5H6V5zm1 14l1.5-1.5L10 19l1.5-1.5L10 16l1.5-1.5L10 13l-1.5 1.5L7 13l-1.5 1.5L7 16l-1.5 1.5L7 19zm11 0h-5v-2h5v2zm0-3h-5v-2h5v2z"/>
          </svg>
          {{ isCalculating ? '正在计算…' : '计算产出' }}
        </button>
      </div>
    </div>

    <!-- Roster Generation Progress Row (below auto-roster button) -->
    <div
      v-if="isGeneratingRoster || generationProgress"
      class="generation-progress-row"
      data-test="generation-progress-row"
    >
      <div class="progress-info">
        <span class="mower-spinner" aria-hidden="true"></span>
        <span class="progress-label">{{ generationProgress?.label || '正在一键生成排班...' }}</span>
      </div>
      <div v-if="generationProgress" class="progress-bar-track">
        <div
          class="progress-bar-fill"
          :style="{ width: `${Math.round((generationProgress.phaseProgress || 0) * 100)}%` }"
        ></div>
      </div>
    </div>

    <div v-if="isCalculating" class="generation-progress-row" data-test="calculation-progress-row">
      <div class="progress-info">
        <span class="mower-spinner" aria-hidden="true"></span>
        <span class="progress-label" role="status">{{ calculationProgress?.label || '正在准备计算…' }}</span>
        <button class="mower-btn" type="button" data-test="abort-calculation-btn" @click="emit('abort-calculation')">中止计算</button>
      </div>
      <div class="progress-bar-track" role="progressbar" aria-label="产出计算进度" :aria-valuenow="Math.round((calculationProgress?.fraction || 0) * 100)" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar-fill" :style="{ width: `${Math.round((calculationProgress?.fraction || 0) * 100)}%` }"></div>
      </div>
      <span class="calculation-timing">{{ calculationTiming }}</span>
    </div>

    <!-- Visible Success / Error / Info Status Message Banner -->
    <div
      v-if="statusMessage"
      class="toolbar-status-msg"
      :class="statusMessage.type"
      data-test="status-message"
    >
      <span class="status-icon">
        {{ statusMessage.type === 'success' ? '✓' : statusMessage.type === 'error' ? '✕' : 'ℹ' }}
      </span>
      <span class="status-text">{{ statusMessage.text }}</span>
      <button
        type="button"
        class="status-close-btn"
        data-test="close-status-btn"
        aria-label="关闭提示"
        @click="clearStatus"
      >
        ×
      </button>
    </div>

    <!-- Modal for importing operator inventory -->
    <OperatorImportModal
      :open="importModalOpen"
      @update:open="importModalOpen = $event"
      @imported="onInventoryImported"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Compact Mower-style top toolbar for the Main Roster Workbench.
 *
 * Core actions:
 * 1. 新建/重置主表: transactional reset with user confirmation
 * 2. 导入排班: accepts .json, .jpg, .jpeg with atomic store replacement
 * 3. 导出JSON: UTF-8 application/json preserving unknown compatibility fields
 * 4. 导出图片: high-res base-map DOM capture with 16-QR overlay
 * 5. 一键替换干员: emits open-replace
 * 6. 计算产出: emits calculate
 *
 * Derived from arknights-mower (https://github.com/ArkMowers/arknights-mower)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { computed, inject, ref } from 'vue'
import OperatorImportModal from './OperatorImportModal.vue'
import type { OwnedOperatorInput } from '../../domain/operatorInventory'
import type { SmartRosterProgress } from '../../optimizer/smartRoster'
import {
  exportPlanToImage,
  exportPlanToJson,
  importPlanFromFile,
  resolvePlanFileAdapters,
  sanitizeFilename,
  PLAN_FILE_ADAPTERS_KEY,
  type PlanFileAdapters,
} from '../../workbench/fileHelpers'
import type { RosterWorkspace } from '../../workbench/model'
import { useRosterWorkbenchStore } from '../../workbench/store'

export interface PlanToolbarProps {
  baseMapElement?: HTMLElement | null
  isValid?: boolean
  theme?: 'light' | 'dark'
  adapters?: PlanFileAdapters
  disabled?: boolean
  isGeneratingRoster?: boolean
  generationProgress?: SmartRosterProgress | null
  isCalculating?: boolean
  calculationProgress?: { label: string; fraction: number } | null
  calculationTiming?: string
}

const props = withDefaults(defineProps<PlanToolbarProps>(), {
  baseMapElement: null,
  isValid: true,
  theme: 'light',
  adapters: undefined,
  disabled: false,
  isGeneratingRoster: false,
  generationProgress: null,
  isCalculating: false,
  calculationProgress: null,
  calculationTiming: '',
})

const emit = defineEmits<{
  (e: 'open-replace'): void
  (e: 'calculate'): void
  (e: 'abort-calculation'): void
  (e: 'reset'): void
  (e: 'clear-operators'): void
  (e: 'imported', workspace: RosterWorkspace): void
  (e: 'exported-json'): void
  (e: 'exported-image'): void
  (e: 'open-poster'): void
  (e: 'error', message: string): void
  (e: 'auto-generate'): void
  (e: 'abort-generation'): void
  (e: 'inventory-imported', entries: OwnedOperatorInput[], text: string): void
}>()

const store = useRosterWorkbenchStore()

const fileInputRef = ref<HTMLInputElement | null>(null)
const isExportingImage = ref(false)
const importModalOpen = ref(false)

export interface StatusMessage {
  type: 'success' | 'error' | 'info'
  text: string
}

const statusMessage = ref<StatusMessage | null>(null)

// Injection support for WorkbenchShell
const injectedBaseMap = inject<HTMLElement | null | (() => HTMLElement | null)>('baseMapElement', null)
const injectedAdapters = inject<PlanFileAdapters | undefined>(PLAN_FILE_ADAPTERS_KEY, undefined)

const effectiveAdapters = computed<PlanFileAdapters>(() => {
  return props.adapters ?? injectedAdapters ?? {}
})

function setStatus(type: 'success' | 'error' | 'info', text: string): void {
  statusMessage.value = { type, text }
}

function clearStatus(): void {
  statusMessage.value = null
}

function resolveBaseMapElement(): HTMLElement | null {
  if (props.baseMapElement) return props.baseMapElement
  if (typeof injectedBaseMap === 'function') {
    const el = injectedBaseMap()
    if (el) return el
  } else if (injectedBaseMap) {
    return injectedBaseMap
  }

  // Fallback DOM lookup for outer plan container
  if (typeof document !== 'undefined') {
    const found = document.querySelector<HTMLElement>('.mower-base-map .plan-container')
    if (found) return found
  }
  return null
}

function getExportFilename(ext: 'json' | 'jpg'): string {
  const raw = store.workspace.name?.trim() || store.workspace.mainPlan?.name?.trim() || 'mower_plan'
  const base = sanitizeFilename(raw, 'mower_plan')
  return `${base}.${ext}`
}

/**
 * 1. 新建/重置主表
 */
async function onResetClick(): Promise<void> {
  clearStatus()
  const resolved = resolvePlanFileAdapters(effectiveAdapters.value)
  const confirmed = await resolved.dialog.confirm('确认重置主排班表？当前未导出的修改将会丢失。')
  if (!confirmed) {
    return
  }

  store.resetWorkspace()
  setStatus('success', '已重置为主排班初始状态')
  emit('reset')
}

/**
 * 1b. 清空进驻干员（保留建筑与等级布局）
 */
async function onClearOperatorsClick(): Promise<void> {
  clearStatus()
  const resolved = resolvePlanFileAdapters(effectiveAdapters.value)
  const confirmed = await resolved.dialog.confirm(
    '确认清空所有设施内的进驻干员与替补？当前建筑类别与等级布局将被保留。'
  )
  if (!confirmed) {
    return
  }

  store.clearAllOperators()
  setStatus('success', '已清空所有进驻干员与替补（建筑布局已保留）')
  emit('clear-operators')
}

/**
 * 2. 导入排班 (.json, .jpg, .jpeg)
 */
async function onImportClick(): Promise<void> {
  clearStatus()
  const resolved = resolvePlanFileAdapters(effectiveAdapters.value)

  // If a custom dialog adapter provides pickFile, use it directly (ideal for headless tests)
  if (effectiveAdapters.value?.dialog?.pickFile) {
    const file = await resolved.dialog.pickFile('.json,.jpg,.jpeg')
    if (file) {
      await handleFileImport(file)
    }
    return
  }

  // Otherwise trigger hidden native file input
  if (fileInputRef.value) {
    fileInputRef.value.click()
  }
}

async function onFileInputChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  await handleFileImport(file)

  // Clear input value so selecting the same file again triggers change
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}

async function handleFileImport(file: File): Promise<void> {
  try {
    const result = await importPlanFromFile(file, effectiveAdapters.value)
    // Atomically load into store
    store.loadWorkspace(result.workspace)
    setStatus('success', `成功导入排班: ${file.name}`)
    emit('imported', result.workspace)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus('error', `导入排班失败: ${msg}`)
    emit('error', msg)
  }
}

/**
 * 3. 导出JSON
 */
function onExportJsonClick(): void {
  clearStatus()
  try {
    exportPlanToJson(store.workspace, {
      filename: getExportFilename('json'),
      adapters: effectiveAdapters.value,
    })
    setStatus('success', '成功导出 JSON 排班！')
    emit('exported-json')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus('error', `导出 JSON 失败: ${msg}`)
    emit('error', msg)
  }
}

/**
 * 4. 导出图片 (16-QR overlay)
 */
async function onExportImageClick(): Promise<void> {
  clearStatus()
  const baseMapEl = resolveBaseMapElement()
  if (!baseMapEl) {
    const msg = '未找到基建底图元素，无法导出图片'
    setStatus('error', msg)
    emit('error', msg)
    return
  }

  isExportingImage.value = true
  try {
    await exportPlanToImage({
      workspace: store.workspace,
      baseMapElement: baseMapEl,
      theme: props.theme,
      filename: getExportFilename('jpg'),
      adapters: effectiveAdapters.value,
    })
    setStatus('success', '成功导出排班图片！')
    emit('exported-image')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus('error', `导出图片失败: ${msg}`)
    emit('error', msg)
  } finally {
    isExportingImage.value = false
  }
}

/**
 * 5. 导入干员库回调
 */
function onInventoryImported(entries: OwnedOperatorInput[], text: string): void {
  setStatus('success', `成功导入 ${entries.length} 名干员至干员库！`)
  emit('inventory-imported', entries, text)
}

/**
 * 6. 中止排班生成
 */
function onAbortGenerateClick(): void {
  emit('abort-generation')
}

/**
 * 7. 自动生成排班
 */
function onAutoGenerateClick(): void {
  emit('auto-generate')
}

/**
 * 7. 一键替换干员
 */
function onReplaceClick(): void {
  emit('open-replace')
}

/**
 * 8. 计算产出
 */
function onCalculateClick(): void {
  if (!props.isValid) return
  emit('calculate')
}

defineExpose({
  triggerReset: onResetClick,
  triggerImport: onImportClick,
  triggerExportJson: onExportJsonClick,
  triggerExportImage: onExportImageClick,
  handleFileImport,
  statusMessage,
  isExportingImage,
})
</script>

<style scoped>
.mower-plan-toolbar {
  width: 980px;
  min-width: 980px;
  margin: 12px auto;
  padding: 0 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.toolbar-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.action-cluster {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.mower-btn-group {
  display: inline-flex;
  border-radius: 3px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.mower-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background-color: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.88);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mower-btn:hover:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.25);
  color: #ffffff;
}

.mower-btn:active:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.22);
}

.mower-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mower-icon {
  flex-shrink: 0;
}

/* Specific button styles */
.mower-btn.btn-reset {
  border-color: rgba(208, 48, 80, 0.35);
  color: #ff7875;
}

.mower-btn.btn-reset:hover:not(:disabled) {
  background-color: rgba(208, 48, 80, 0.2);
  border-color: #f5222d;
  color: #ff4d4f;
}

.mower-btn.btn-clear-operators {
  border-color: rgba(245, 158, 11, 0.35);
  color: #fbbf24;
}

.mower-btn.btn-clear-operators:hover:not(:disabled) {
  background-color: rgba(245, 158, 11, 0.2);
  border-color: #f59e0b;
  color: #fef3c7;
}

.mower-btn.btn-abort-roster {
  background-color: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
  color: #fca5a5;
  font-weight: 600;
}

.mower-btn.btn-abort-roster:hover {
  background-color: rgba(239, 68, 68, 0.38);
  border-color: #f87171;
  color: #ffffff;
}

.mower-btn.btn-calc {
  background-color: rgba(24, 160, 88, 0.2);
  border-color: #18a058;
  color: #63e2b7;
  font-weight: 600;
}

.mower-btn.btn-calc:hover:not(:disabled) {
  background-color: rgba(24, 160, 88, 0.35);
  color: #ffffff;
}

.mower-btn.btn-calc:disabled {
  opacity: 0.4;
  border-color: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.4);
}

.mower-btn-group .mower-btn {
  border-radius: 0;
}

.mower-btn-group .mower-btn:first-child {
  border-top-left-radius: 3px;
  border-bottom-left-radius: 3px;
}

.mower-btn-group .mower-btn:last-child {
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
}

.mower-btn-group .mower-btn + .mower-btn {
  border-left: none;
}

/* Spinner */
.mower-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: mower-spin 0.8s linear infinite;
  display: inline-block;
}

@keyframes mower-spin {
  to { transform: rotate(360deg); }
}

/* Status message alert */
.toolbar-status-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 3px;
  font-size: 13px;
  animation: fadeIn 0.2s ease-in-out;
}

.toolbar-status-msg.success {
  background-color: rgba(24, 160, 88, 0.15);
  border: 1px solid rgba(24, 160, 88, 0.4);
  color: #63e2b7;
}

.toolbar-status-msg.error {
  background-color: rgba(208, 48, 80, 0.15);
  border: 1px solid rgba(208, 48, 80, 0.4);
  color: #ff7875;
}

.toolbar-status-msg.info {
  background-color: rgba(32, 128, 240, 0.15);
  border: 1px solid rgba(32, 128, 240, 0.4);
  color: #70c0e8;
}

.status-close-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  opacity: 0.7;
}

.status-close-btn:hover {
  opacity: 1;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}

.generation-progress-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 14px;
  background: rgba(66, 214, 199, 0.1);
  border: 1px solid rgba(66, 214, 199, 0.35);
  border-radius: 4px;
  color: #42d6c7;
  font-size: 13px;
  animation: fadeIn 0.2s ease-in-out;
}

.calculation-timing { color: #a9b5c8; font-size: 12px; }
.progress-info .mower-btn { margin-left: auto; flex-shrink: 0; }
.progress-info {
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  gap: 8px;
}

.progress-label {
  font-weight: 500;
}

.progress-bar-track {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: #42d6c7;
  transition: width 0.3s ease;
}
</style>
