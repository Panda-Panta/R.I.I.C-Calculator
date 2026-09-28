<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NModal,
  NRadio,
  NRadioGroup,
} from 'naive-ui'
import {
  detectAndParseOperatorData,
  inventoryToCsvText,
  deduplicateOperatorEntries,
  type OperatorImportSummary,
} from '../../domain/operatorImport'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'
import { getOperatorAvatarUrl } from '../../workbench/operatorHelpers'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void
  (e: 'imported', entries: OwnedOperatorInput[], text: string): void
}>()

const uploadedFile = ref<{ name: string; summary: OperatorImportSummary } | null>(null)
const pastedText = ref('')
const errorMessage = ref('')
const isDragOver = ref(false)
const importMode = ref<'replace' | 'merge'>('replace')
const fileInputRef = ref<HTMLInputElement | null>(null)
let inputVersion = 0

const storageKey = 'arcinc-operator-inventory-v1'

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    inputVersion++
    errorMessage.value = ''
    uploadedFile.value = null
    pastedText.value = ''
    isDragOver.value = false
  }
})

const parsedText = computed(() => pastedText.value.trim()
  ? detectAndParseOperatorData(pastedText.value)
  : null)
const detectedSummary = computed(() => uploadedFile.value?.summary ?? parsedText.value)
const currentSummary = computed(() => {
  const summary = detectedSummary.value
  return summary?.source === 'maa' || summary?.source === 'yituliu' ? summary : null
})
const displayError = computed(() => {
  if (errorMessage.value) return errorMessage.value
  if (!detectedSummary.value) return ''
  if (!currentSummary.value) return '未识别为 MAA 或一图流导出结果，请检查文件或粘贴内容。'
  if (currentSummary.value.entries.length === 0) {
    return currentSummary.value.error ?? '未识别到持有干员，请检查导出结果。'
  }
  return ''
})

function handleTextInput(): void {
  inputVersion++
  uploadedFile.value = null
  errorMessage.value = ''
}

function triggerFileInput(): void {
  fileInputRef.value?.click()
}

async function processFile(file: File): Promise<void> {
  const version = ++inputVersion
  errorMessage.value = ''
  uploadedFile.value = null
  pastedText.value = ''
  try {
    const input = file.name.toLowerCase().endsWith('.xlsx')
      ? await file.arrayBuffer()
      : await file.text()
    if (version !== inputVersion) return
    uploadedFile.value = { name: file.name, summary: detectAndParseOperatorData(input, file.name) }
  } catch (err: unknown) {
    if (version === inputVersion) {
      errorMessage.value = `读取文件失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

function handleFileSelect(event: Event): void {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    processFile(file)
  }
  target.value = ''
}

function handleFileDrop(event: DragEvent): void {
  isDragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) {
    processFile(file)
  }
}

function handleImport(): void {
  errorMessage.value = ''
  const summary = currentSummary.value
  if (!summary || summary.entries.length === 0) {
    errorMessage.value = '未能解析到有效的干员数据，请检查文件或输入内容。'
    return
  }

  let finalEntries = summary.entries

  if (importMode.value === 'merge') {
    const existingRaw = localStorage.getItem(storageKey)
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw)
        if (parsed.text) {
          const existingEntries = parseOperatorInventory(parsed.text).entries
          finalEntries = deduplicateOperatorEntries([...existingEntries, ...finalEntries])
        }
      } catch {
        // ignore
      }
    }
  }

  const csvText = inventoryToCsvText(finalEntries)
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      text: csvText,
      enabled: true,
    }))
  } catch {
    // ignore quota
  }

  emit('imported', finalEntries, csvText)
  emit('update:open', false)
}
</script>

<template>
  <n-modal
    :show="open"
    preset="card"
    title="导入干员库：MAA / 一图流导出结果"
    class="operator-import-modal"
    style="width: 720px; max-width: 95vw;"
    :mask-closable="true"
    @update:show="emit('update:open', $event)"
  >
    <div class="import-content">
      <!-- Universal File Dropzone -->
      <div
        class="file-dropzone"
        :class="{ 'is-dragover': isDragOver }"
        role="button"
        tabindex="0"
        aria-label="选择 MAA 或一图流导出文件"
        @dragover.prevent="isDragOver = true"
        @dragleave.prevent="isDragOver = false"
        @drop.prevent="handleFileDrop"
        @click="triggerFileInput"
        @keydown.enter.prevent="triggerFileInput"
        @keydown.space.prevent="triggerFileInput"
      >
        <input
          ref="fileInputRef"
          type="file"
          accept=".xlsx,.json,.csv,.md,.txt"
          style="display: none"
          @change="handleFileSelect"
        />
        <div class="dropzone-icon">📥</div>
        <div class="dropzone-text">
          <strong>点击选择文件</strong> 或直接将文件拖拽至此处
        </div>
        <div class="dropzone-hint">
          支持 MAA 导出文件 (<code>.json</code>, <code>.csv</code>, <code>.md</code>) 与 一图流练度导表 (<code>.xlsx</code>)
        </div>
      </div>

      <div class="guide-banner">
        MAA：上传 JSON、CSV 或 Markdown 导出文件；一图流：上传干员练度表 XLSX。
        也可在下方粘贴 MAA 导出文本或一图流表格文本，自动识别格式并排除未持有干员。
      </div>
      <div v-if="uploadedFile" class="file-loaded-banner">
        <span class="file-badge">📄 {{ uploadedFile.name }}</span>
        <span class="file-status">识别格式：<strong>{{ uploadedFile.summary.format }}</strong></span>
      </div>
      <textarea
        v-model="pastedText"
        class="import-textarea"
        rows="6"
        aria-label="粘贴 MAA 或一图流导出结果"
        placeholder="粘贴 MAA 的 JSON、CSV、Markdown 或一图流复制的表格文本…"
        @input="handleTextInput"
      />

      <!-- Recognition Statistics & Preview -->
      <div v-if="currentSummary && currentSummary.entries.length > 0" class="recognition-panel">
        <div class="recognition-header">
          <div class="rec-tag">
            ✓ {{ currentSummary.format }}
          </div>
          <div class="rec-stat">
            已成功识别 <strong>{{ currentSummary.entries.length }}</strong> 名持有干员
            <span v-if="currentSummary.unownedCount > 0" class="unowned-stat">
              （已排除 {{ currentSummary.unownedCount }} 名未持有干员）
            </span>
          </div>
        </div>

        <!-- Sample preview chips -->
        <div class="preview-chips-container">
          <span class="preview-label">识别样本预览：</span>
          <div class="preview-chips">
            <div
              v-for="op in currentSummary.entries.slice(0, 10)"
              :key="op.operator"
              class="operator-preview-chip"
            >
              <img
                class="chip-avatar"
                :src="getOperatorAvatarUrl(op.operator)"
                :alt="op.operator"
                @error="($event.target as HTMLElement).style.display = 'none'"
              />
              <span class="chip-name">{{ op.operator }}</span>
              <span class="chip-elite">精{{ op.elitePhase }}</span>
              <span class="chip-level">{{ op.level }}级</span>
            </div>
            <div v-if="currentSummary.entries.length > 10" class="preview-more-tag">
              + 另外 {{ currentSummary.entries.length - 10 }} 名干员
            </div>
          </div>
        </div>

        <!-- Import Mode Selection -->
        <div class="import-mode-row">
          <span class="mode-label">导入模式：</span>
          <n-radio-group v-model:value="importMode" name="import-mode">
            <n-radio value="replace">
              覆盖当前干员库
            </n-radio>
            <n-radio value="merge">
              合并/追加更新（保留未在此文件出现的干员）
            </n-radio>
          </n-radio-group>
        </div>
      </div>

      <div v-if="displayError" class="error-banner">
        ✕ {{ displayError }}
      </div>

      <div class="modal-actions">
        <n-button @click="emit('update:open', false)">取消</n-button>
        <n-button
          type="primary"
          :disabled="!currentSummary || currentSummary.entries.length === 0"
          @click="handleImport"
        >
          确认导入至干员库（{{ currentSummary?.entries.length ?? 0 }} 人）
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.import-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* File Dropzone */
.file-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 16px;
  background: rgba(66, 214, 199, 0.04);
  border: 2px dashed rgba(66, 214, 199, 0.35);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
}

.file-dropzone:hover,
.file-dropzone:focus-visible,
.file-dropzone.is-dragover {
  background: rgba(66, 214, 199, 0.1);
  border-color: #42d6c7;
  transform: translateY(-1px);
}

.dropzone-icon {
  font-size: 28px;
  margin-bottom: 6px;
}

.dropzone-text {
  font-size: 14px;
  color: #e0f2f1;
  margin-bottom: 4px;
}

.dropzone-text strong {
  color: #42d6c7;
}

.dropzone-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.dropzone-hint code {
  color: #42d6c7;
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}

.file-loaded-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(66, 214, 199, 0.12);
  border: 1px solid rgba(66, 214, 199, 0.35);
  border-radius: 6px;
}

.file-badge {
  font-weight: bold;
  color: #42d6c7;
  font-size: 13px;
}

.file-status {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
}

.guide-banner {
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.6;
}

.import-textarea {
  width: 100%;
  box-sizing: border-box;
  background: #0d161d;
  color: #e0f2f1;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  padding: 10px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.import-textarea:focus {
  outline: none;
  border-color: #42d6c7;
}

/* Recognition Panel */
.recognition-panel {
  padding: 12px 14px;
  background: #14202a;
  border: 1px solid rgba(66, 214, 199, 0.3);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.recognition-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.rec-tag {
  font-size: 12px;
  font-weight: bold;
  color: #10b981;
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.35);
  padding: 2px 8px;
  border-radius: 4px;
}

.rec-stat {
  font-size: 13px;
  color: #e0f2f1;
}

.unowned-stat {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.preview-chips-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.preview-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 110px;
  overflow-y: auto;
}

.operator-preview-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px 2px 4px;
  background: #0a1118;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  font-size: 11px;
}

.chip-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
}

.chip-name {
  color: #fff;
  font-weight: 500;
}

.chip-elite {
  color: #42d6c7;
  font-size: 10px;
}

.chip-level {
  color: #f59e0b;
  font-size: 10px;
}

.preview-more-tag {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  padding: 2px 6px;
}

.import-mode-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  font-size: 12px;
}

.mode-label {
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
}

.error-banner {
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
  font-size: 12px;
  border-radius: 4px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}
</style>
