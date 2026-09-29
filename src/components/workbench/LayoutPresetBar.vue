<template>
  <section class="layout-presets" aria-label="布局预设">
    <div class="layout-presets-main">
      <label class="layout-preset-label" for="layout-preset-select">布局预设</label>
      <select
        id="layout-preset-select"
        class="layout-preset-select"
        data-test="layout-preset-select"
        :value="activePresetId"
        :disabled="presets.length === 0"
        @change="selectPreset"
      >
        <option value="">{{ presets.length ? '当前布局（未保存）' : '暂无预设' }}</option>
        <option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
      <button type="button" class="layout-preset-button save" data-test="layout-preset-save" @click="startSaving">保存当前布局</button>
      <button v-if="isModified" type="button" class="layout-preset-button" data-test="layout-preset-reapply" @click="applySelectedPreset">重新应用</button>
      <button type="button" class="layout-preset-button delete" data-test="layout-preset-delete" :disabled="!activePresetId" @click="deletePreset">删除预设</button>
      <span v-if="isModified" class="layout-preset-modified" data-test="layout-preset-modified">当前布局已修改</span>
    </div>

    <form v-if="isNaming" class="layout-preset-name-row" data-test="layout-preset-name-row" @submit.prevent="savePreset">
      <label for="layout-preset-name">预设名称</label>
      <input id="layout-preset-name" ref="nameInput" v-model="newName" data-test="layout-preset-name" maxlength="32" placeholder="例如：252 双贸易" required />
      <button type="submit" class="layout-preset-button save" data-test="layout-preset-confirm">确认保存</button>
      <button type="button" class="layout-preset-button" data-test="layout-preset-cancel" @click="isNaming = false">取消</button>
    </form>
    <p v-if="message" class="layout-preset-message" :class="messageType" role="status" data-test="layout-preset-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import {
  applyFacilityLayout,
  captureFacilityLayout,
  isValidFacilityLayout,
  readLayoutPresets,
  sameFacilityLayout,
  writeLayoutPresets,
  type LayoutPreset,
} from '../../workbench/layoutPresets'

const store = useRosterWorkbenchStore()
const emit = defineEmits<{ (e: 'applied'): void }>()
const presets = ref<LayoutPreset[]>([])
const selectedId = ref('')
const isNaming = ref(false)
const newName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const message = ref('')
const messageType = ref<'success' | 'error'>('success')

const activePresetId = computed(() => selectedId.value)
const isModified = computed(() => {
  const selected = presets.value.find(preset => preset.id === selectedId.value)
  return Boolean(selected && !sameFacilityLayout(selected.facilities, captureFacilityLayout(store.workspace)))
})

function matchingPresetId(): string {
  const current = captureFacilityLayout(store.workspace)
  return presets.value.find(preset => sameFacilityLayout(preset.facilities, current))?.id ?? ''
}

onMounted(() => {
  try {
    presets.value = readLayoutPresets(localStorage)
    selectedId.value = matchingPresetId()
  } catch {
    showMessage('error', '无法读取布局预设，请检查浏览器存储权限。')
  }
})

watch(() => store.workspace, () => {
  selectedId.value = matchingPresetId()
}, { flush: 'sync' })

function showMessage(type: 'success' | 'error', text: string): void {
  messageType.value = type
  message.value = text
}

function startSaving(): void {
  newName.value = ''
  isNaming.value = true
  message.value = ''
  nextTick(() => nameInput.value?.focus())
}

function savePreset(): void {
  const name = newName.value.trim()
  if (!name) {
    showMessage('error', '请输入预设名称。')
    return
  }
  if (name.length > 32) {
    showMessage('error', '预设名称不能超过 32 个字。')
    return
  }
  if (presets.value.some(preset => preset.name === name)) {
    showMessage('error', '预设名称已存在，请换一个名称。')
    return
  }
  const facilities = captureFacilityLayout(store.workspace)
  if (!isValidFacilityLayout(facilities)) {
    showMessage('error', '当前布局包含不支持的设施类型或产物，无法保存为预设。')
    return
  }
  const preset: LayoutPreset = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name,
    facilities,
  }
  const next = [...presets.value, preset]
  try {
    writeLayoutPresets(localStorage, next)
    presets.value = next
    selectedId.value = preset.id
    isNaming.value = false
    showMessage('success', `已保存布局预设「${name}」。`)
  } catch {
    showMessage('error', '保存失败，请检查浏览器存储空间。')
  }
}

function selectPreset(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  if (!id) {
    selectedId.value = ''
    return
  }
  const preset = presets.value.find(item => item.id === id)
  if (!preset) return
  applyPreset(preset)
}

function applySelectedPreset(): void {
  const preset = presets.value.find(item => item.id === selectedId.value)
  if (preset) applyPreset(preset)
}

function applyPreset(preset: LayoutPreset): void {
  try {
    const result = applyFacilityLayout(store.workspace, preset.facilities)
    store.loadWorkspace(result.workspace)
    selectedId.value = preset.id
    emit('applied')
    const removed = result.removedAssignments
    showMessage('success', removed
      ? `已应用「${preset.name}」；工位减少，移除了 ${removed} 个超出工位的干员或替补席位。`
      : `已应用布局预设「${preset.name}」。`)
  } catch {
    showMessage('error', '应用预设失败，当前布局未更改。')
  }
}

function deletePreset(): void {
  const preset = presets.value.find(item => item.id === activePresetId.value)
  if (!preset) return
  if (!window.confirm(`确认删除布局预设「${preset.name}」？当前布局不会改变。`)) return
  const next = presets.value.filter(item => item.id !== preset.id)
  try {
    writeLayoutPresets(localStorage, next)
    presets.value = next
    if (selectedId.value === preset.id) selectedId.value = ''
    showMessage('success', `已删除布局预设「${preset.name}」。`)
  } catch {
    showMessage('error', '删除失败，请检查浏览器存储权限。')
  }
}
</script>

<style scoped>
.layout-presets {
  width: min(980px, 100%);
  margin: 0 auto;
  padding: 7px 0;
  color: #dce9eb;
  font-size: 12px;
}
.layout-presets-main,
.layout-preset-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.layout-preset-label,
.layout-preset-name-row label {
  color: #8da5ac;
  font-weight: 600;
  white-space: nowrap;
}
.layout-preset-select,
.layout-preset-name-row input {
  min-width: 210px;
  height: 31px;
  padding: 0 9px;
  color: #e9f2f4;
  background: #202932;
  border: 1px solid #42555c;
  border-radius: 4px;
  font: inherit;
}
.layout-preset-name-row { margin-top: 8px; }
.layout-preset-button {
  min-height: 31px;
  padding: 0 10px;
  color: #dce9eb;
  background: #25333a;
  border: 1px solid #42555c;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.layout-preset-button.save { color: #061514; background: #42d6c7; border-color: #42d6c7; font-weight: 700; }
.layout-preset-button.delete { color: #ffc5c5; }
.layout-preset-button:disabled { opacity: .45; cursor: default; }
.layout-preset-button:focus-visible,
.layout-preset-select:focus-visible,
.layout-preset-name-row input:focus-visible { outline: 2px solid #8cf5e9; outline-offset: 2px; }
.layout-preset-message { margin: 5px 0 0; }
.layout-preset-message.success { color: #89e8d9; }
.layout-preset-message.error { color: #ffaaaa; }
.layout-preset-modified { color: #f3ca80; }
@media (max-width: 1020px) { .layout-presets { padding: 7px 12px; box-sizing: border-box; } }
@media (max-width: 600px) { .layout-preset-select { flex: 1 1 190px; min-width: 0; } }
</style>
