<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'
import { OPERATOR_MAP } from '../../domain/operators'
import { getOperatorAvatarUrl } from '../../workbench/operatorHelpers'
import OperatorImportModal from './OperatorImportModal.vue'

const emit = defineEmits<{ change: [value: { enabled: boolean; valid: boolean; entries: OwnedOperatorInput[] }] }>()
const storageKey = 'arcinc-operator-inventory-v1'
const text = ref(''), enabled = ref(false), storageError = ref('')
const importModalOpen = ref(false)
const viewMode = ref<'table' | 'text'>('table')
const searchQuery = ref('')
const clearSuccessMsg = ref('')

try {
  const saved = localStorage.getItem(storageKey)
  if (saved) {
    const data = JSON.parse(saved)
    if (data.schemaVersion !== 1 || typeof data.text !== 'string' || typeof data.enabled !== 'boolean') throw new Error('invalid')
    text.value = data.text
    enabled.value = data.enabled
  }
} catch {
  storageError.value = '无法读取本地干员库；请重新粘贴，原存储不会自动覆盖。'
}

const parsed = computed(() => parseOperatorInventory(text.value))

const filteredOperators = computed(() => {
  const ops = parsed.value.operators
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return ops
  return ops.filter(op => {
    return op.name.toLowerCase().includes(q) || op.charId.toLowerCase().includes(q)
  })
})

function onExternalSync(event: Event): void {
  const detail = (event as CustomEvent).detail
  if (detail && typeof detail.text === 'string') {
    text.value = detail.text
    if (typeof detail.enabled === 'boolean') {
      enabled.value = detail.enabled
    }
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('arcinc-inventory-synced', onExternalSync)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('arcinc-inventory-synced', onExternalSync)
  }
})

watch([text, enabled], () => {
  try {
    if (!text.value.trim() && !enabled.value) {
      localStorage.removeItem(storageKey)
    } else {
      localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, text: text.value, enabled: enabled.value }))
    }
    storageError.value = ''
  } catch {
    storageError.value = '本地保存失败，请检查浏览器存储配额。'
  }
})

watch([parsed, enabled], () => {
  emit('change', { enabled: enabled.value, valid: parsed.value.valid, entries: parsed.value.entries })
}, { immediate: true })

function setInventoryText(newText: string, append = false): void {
  if (append && text.value.trim()) {
    text.value = text.value.trim() + '\n' + newText.trim()
  } else {
    text.value = newText.trim()
  }
  enabled.value = true
}

function onImported(_entries: OwnedOperatorInput[], csvText: string): void {
  text.value = csvText
  enabled.value = true
  viewMode.value = 'table'
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('arcinc-inventory-synced', { detail: { text: csvText, enabled: true } }))
  }
}

function handleClearClick(): void {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const confirmed = window.confirm('确认清空干员库？当前已录入的所有干员将被清除。')
    if (!confirmed) return
  }
  text.value = ''
  enabled.value = false
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // ignore
  }
  clearSuccessMsg.value = '已成功清空干员库'
  setTimeout(() => {
    clearSuccessMsg.value = ''
  }, 3000)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('arcinc-inventory-synced', { detail: { text: '', enabled: false } }))
  }
}

defineExpose({
  text,
  enabled,
  parsed,
  viewMode,
  searchQuery,
  filteredOperators,
  setInventoryText,
  handleClearClick,
  importModalOpen,
})
</script>

<template>
  <div class="operator-inventory" data-test="inventory-panel">
    <!-- Header -->
    <div class="inventory-header">
      <div class="inventory-title-group">
        <h3 class="inventory-title">我的干员库</h3>
        <span class="inventory-subtitle">录入可选的闲置干员与练度；未导入时从全体干员中选</span>
      </div>
      <div class="inventory-header-buttons">
        <button
          type="button"
          class="clear-modal-btn"
          data-test="clear-inventory-btn"
          :disabled="!text"
          @click="handleClearClick"
        >
          🗑️ 清空干员库
        </button>
        <button
          type="button"
          class="import-modal-btn"
          data-test="open-import-modal-btn"
          @click="importModalOpen = true"
        >
          📥 导入干员数据 (MAA / 一图流)
        </button>
      </div>
    </div>

    <!-- Toggle & View Switcher -->
    <div class="inventory-toolbar">
      <label class="inventory-toggle">
        <input v-model="enabled" data-test="inventory-enabled" type="checkbox" />
        <span>启用后以库内干员作为闲置候选</span>
      </label>

      <div class="view-mode-tabs">
        <button
          type="button"
          class="mode-tab-btn"
          :class="{ active: viewMode === 'table' }"
          data-test="view-mode-table-btn"
          @click="viewMode = 'table'"
        >
          📋 表格视图 ({{ parsed.operators.length }})
        </button>
        <button
          type="button"
          class="mode-tab-btn"
          :class="{ active: viewMode === 'text' }"
          data-test="view-mode-text-btn"
          @click="viewMode = 'text'"
        >
          📝 文本代码编辑
        </button>
      </div>
    </div>

    <p v-if="!enabled" class="inventory-note">未导入干员库：全体干员可作为闲置候选；排班内干员仍按当前最高基建技能假设。</p>
    <div v-if="clearSuccessMsg" class="inventory-success-msg">{{ clearSuccessMsg }}</div>

    <!-- Table View Mode -->
    <div v-show="viewMode === 'table'" class="inventory-table-container" data-test="inventory-table-view">
      <div class="table-filter-bar">
        <input
          v-model="searchQuery"
          type="text"
          class="table-search-input"
          data-test="inventory-search-input"
          placeholder="🔍 搜索干员名称或 ID..."
        />
        <span class="table-count-badge">
          已录入 {{ parsed.operators.length }} 名干员
          <template v-if="searchQuery.trim()">
            （匹配 {{ filteredOperators.length }} 名）
          </template>
        </span>
      </div>

      <div v-if="parsed.operators.length === 0" class="table-empty-state">
        <div class="empty-icon">📂</div>
        <div class="empty-title">当前干员库暂无干员</div>
        <p class="empty-desc">
          点击右上角「📥 导入干员数据」选择 MAA 或一图流导表，或切换至「文本代码编辑」直接粘贴。
        </p>
      </div>

      <div v-else class="table-scroll-wrapper">
        <table class="inventory-data-table">
          <thead>
            <tr>
              <th style="width: 44px; text-align: center;">#</th>
              <th style="width: 56px; text-align: center;">图标</th>
              <th style="min-width: 110px;">干员名称</th>
              <th style="width: 70px; text-align: center;">星级</th>
              <th style="width: 80px; text-align: center;">精英化</th>
              <th style="width: 80px; text-align: center;">等级</th>
              <th>已生效基建技能</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(op, idx) in filteredOperators"
              :key="op.charId"
              class="inventory-table-row"
              data-test="inventory-op-row"
            >
              <td class="cell-index">{{ idx + 1 }}</td>
              <td class="cell-avatar">
                <img
                  :src="getOperatorAvatarUrl(op.charId)"
                  class="op-table-avatar"
                  :alt="op.name"
                  loading="lazy"
                  @error="($event.target as HTMLElement).style.visibility = 'hidden'"
                />
              </td>
              <td class="cell-name">
                <span class="op-display-name">{{ op.name }}</span>
              </td>
              <td class="cell-rarity">
                <span
                  v-if="OPERATOR_MAP.get(op.charId)?.rarity"
                  class="star-badge"
                  :class="'star-' + OPERATOR_MAP.get(op.charId)!.rarity"
                >
                  {{ OPERATOR_MAP.get(op.charId)!.rarity }}★
                </span>
              </td>
              <td class="cell-elite">
                <span class="elite-pill" :class="'elite-' + op.elitePhase">
                  精 {{ op.elitePhase }}
                </span>
              </td>
              <td class="cell-level">
                <span class="level-badge">Lv.{{ op.level }}</span>
              </td>
              <td class="cell-skills">
                <div v-if="op.skills.length > 0" class="skills-list">
                  <span
                    v-for="s in op.skills"
                    :key="s.buffId"
                    class="table-skill-tag"
                    :title="s.description"
                  >
                    {{ s.name }}
                  </span>
                </div>
                <span v-else class="skill-empty">无已解锁技能</span>
                <span v-if="!op.matchesMaximumSkills" class="skill-sub-tag">
                  (非满级技能)
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Text View Mode -->
    <div v-show="viewMode === 'text'" class="inventory-text-container">
      <label class="inventory-input">
        <span>持有干员与练度（每行格式：干员代号,精英阶段,等级）</span>
        <textarea
          v-model="text"
          data-test="inventory-text"
          rows="7"
          placeholder="砾,1,1&#10;温蒂,2,1&#10;Lancet-2,0,30"
        />
      </label>
      <div class="inventory-actions">
        <span>已录入 {{ parsed.operators.length }} 名干员</span>
      </div>
    </div>

    <p v-if="storageError" class="inventory-error">{{ storageError }}</p>
    <ul v-if="parsed.diagnostics.length" class="inventory-error">
      <li v-for="(d, i) in parsed.diagnostics" :key="i">{{ d.message }}</li>
    </ul>

    <details v-if="parsed.operators.length" class="inventory-skills-details">
      <summary>查看实际已解锁技能（共 {{ parsed.operators.length }} 人）</summary>
      <ul class="inventory-skills">
        <li v-for="op in parsed.operators" :key="op.charId">
          <strong>{{ op.name }}</strong> · 精英 {{ op.elitePhase }} / {{ op.level }} 级：
          {{ op.skills.map(s => s.name).join('、') || '尚无已解锁基建技能' }}
          <span v-if="!op.matchesMaximumSkills" class="skill-mismatch-tag">（与最高技能模型不同）</span>
        </li>
      </ul>
    </details>

    <OperatorImportModal
      :open="importModalOpen"
      @update:open="importModalOpen = $event"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.operator-inventory {
  margin: 0;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: #141c24;
  color: #dfebf1;
  box-sizing: border-box;
}

.inventory-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.inventory-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.inventory-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.inventory-subtitle {
  font-size: 12px;
  color: #8da5ac;
}

.inventory-header-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.import-modal-btn {
  padding: 6px 14px;
  background: #42d6c7;
  color: #0a151c;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.import-modal-btn:hover {
  background: #5eead4;
  transform: translateY(-1px);
}

.clear-modal-btn {
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.clear-modal-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.3);
  border-color: #ef4444;
  color: #ffffff;
}

.clear-modal-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.inventory-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}

.inventory-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #cad8e0;
  cursor: pointer;
}

.view-mode-tabs {
  display: flex;
  gap: 4px;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.mode-tab-btn {
  padding: 4px 10px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: #8da5ac;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-tab-btn.active {
  background: #223240;
  color: #42d6c7;
  font-weight: 600;
}

.inventory-note {
  font-size: 12px;
  color: #8da5ac;
  margin: 4px 0 10px;
}

.inventory-success-msg {
  padding: 6px 12px;
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #86efac;
  border-radius: 4px;
  font-size: 12px;
  margin-bottom: 10px;
}

/* Table View */
.inventory-table-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.table-filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.table-search-input {
  flex: 1;
  max-width: 280px;
  height: 30px;
  padding: 0 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #ffffff;
  font-size: 12px;
  outline: none;
}

.table-search-input:focus {
  border-color: #42d6c7;
}

.table-count-badge {
  font-size: 12px;
  color: #8da5ac;
}

.table-scroll-wrapper {
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.15);
}

.inventory-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.inventory-data-table th {
  position: sticky;
  top: 0;
  background: #19232d;
  color: #8da5ac;
  font-weight: 600;
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  z-index: 2;
}

.inventory-data-table td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  vertical-align: middle;
}

.inventory-table-row:hover {
  background: rgba(66, 214, 199, 0.04);
}

.cell-index {
  text-align: center;
  color: #64748b;
  font-size: 11px;
}

.cell-avatar {
  text-align: center;
}

.op-table-avatar {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  background: #0f172a;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: inline-block;
  vertical-align: middle;
}

.op-display-name {
  font-weight: 600;
  color: #ffffff;
}

.star-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  text-align: center;
}

.star-6 { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
.star-5 { background: rgba(234, 179, 8, 0.2); color: #eab308; }
.star-4 { background: rgba(192, 132, 252, 0.2); color: #c084fc; }
.star-3 { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
.star-2, .star-1 { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }

.elite-pill {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-align: center;
}

.elite-0 { background: rgba(255, 255, 255, 0.08); color: #94a3b8; }
.elite-1 { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
.elite-2 { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }

.level-badge {
  font-family: monospace;
  font-size: 11px;
  color: #cad8e0;
}

.skills-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.table-skill-tag {
  display: inline-block;
  font-size: 10px;
  padding: 1px 6px;
  background: rgba(66, 214, 199, 0.1);
  color: #5eead4;
  border: 1px solid rgba(66, 214, 199, 0.25);
  border-radius: 3px;
  white-space: nowrap;
}

.skill-sub-tag {
  font-size: 10px;
  color: #fb923c;
  margin-left: 4px;
}

.skill-empty {
  font-size: 11px;
  color: #64748b;
  font-style: italic;
}

/* Empty State */
.table-empty-state {
  padding: 36px 16px;
  text-align: center;
  background: rgba(0, 0, 0, 0.15);
  border: 1px dashed rgba(255, 255, 255, 0.1);
  border-radius: 6px;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 12px;
  color: #8da5ac;
  max-width: 480px;
  margin: 0 auto;
}

/* Text Mode */
.inventory-input {
  display: grid;
  gap: 6px;
  margin: 8px 0;
}

.inventory-input span {
  font-size: 12px;
  color: #8da5ac;
}

.inventory-input textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  background: #0f1922;
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 8px 10px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 12px;
  outline: none;
}

.inventory-input textarea:focus {
  border-color: #42d6c7;
}

.inventory-actions {
  display: flex;
  justify-content: flex-end;
  font-size: 12px;
  color: #8da5ac;
}

.inventory-error {
  color: #ffb4ab;
  font-size: 12px;
  margin: 6px 0;
}

.inventory-skills-details {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.inventory-skills-details summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
  color: #8da5ac;
}

.inventory-skills {
  max-height: 200px;
  overflow-y: auto;
  padding-left: 1.2rem;
  line-height: 1.8;
  font-size: 12px;
  color: #cad8e0;
}

.skill-mismatch-tag {
  color: #fb923c;
  font-size: 11px;
}
</style>
