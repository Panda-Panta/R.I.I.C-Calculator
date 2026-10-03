<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { DEFAULT_PRODUCTION_WEIGHTS, normalizeProductionWeights, type ProductionWeights } from '../../domain/productionWeights'

const props = defineProps<{ modelValue: ProductionWeights }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: ProductionWeights): void
  (e: 'validity-change', valid: boolean): void
}>()

const fields: Array<{ key: keyof ProductionWeights; label: string; hint: string }> = [
  { key: 'exp', label: '经验', hint: '每点经验；不是每张作战记录' },
  { key: 'gold', label: '赤金', hint: '每条按 500 龙门币折算，包含虚拟赤金' },
  { key: 'orders', label: '订单龙门币', hint: '每 1 龙门币订单报酬' },
  { key: 'fragments', label: '源石碎片', hint: '每个源石碎片' },
  { key: 'orundum', label: '合成玉', hint: '每个合成玉' },
]
const drafts = reactive({ exp: '', gold: '', orders: '', fragments: '', orundum: '' })
const errors = reactive({ exp: false, gold: false, orders: false, fragments: false, orundum: false })
const weights = computed(() => normalizeProductionWeights(props.modelValue))

function showWeights(value: ProductionWeights): void {
  for (const { key } of fields) {
    drafts[key] = String(value[key])
    errors[key] = false
  }
  emitValidity()
}

function emitValidity(): void {
  emit('validity-change', fields.every(({ key }) => !errors[key]))
}

watch(weights, (value, previous) => {
  if (!previous) {
    showWeights(value)
    return
  }
  for (const { key } of fields) {
    if (value[key] !== previous[key]) {
      drafts[key] = String(value[key])
      errors[key] = false
    }
  }
  emitValidity()
}, { immediate: true })

function updateWeight(key: keyof ProductionWeights, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  drafts[key] = value
  const numeric = Number(value)
  errors[key] = value.trim() === '' || !Number.isFinite(numeric) || numeric < 0
  emitValidity()
  if (!errors[key]) emit('update:modelValue', { ...weights.value, [key]: numeric })
}

function reset(): void {
  const value = { ...DEFAULT_PRODUCTION_WEIGHTS }
  showWeights(value)
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="production-weights-editor" data-test="production-weights-editor">
    <div class="weights-heading">
      <p class="weights-description">这些系数共同用于计算产出和自动排班评分。默认 1 / 0.8 / 0.2 / 0 / 0 保持原有 82 口径。</p>
      <button type="button" class="reset-button" data-test="reset-production-weights" @click="reset">恢复默认</button>
    </div>
    <div class="weights-grid">
      <label v-for="field in fields" :key="field.key" class="weight-field">
        <span class="weight-label">{{ field.label }}系数</span>
        <input
          type="number" min="0" step="any" class="weight-input"
          :data-test="`weight-${field.key}`" :value="drafts[field.key]"
          :aria-invalid="errors[field.key] ? 'true' : 'false'"
          @input="updateWeight(field.key, $event)"
        />
        <span class="weight-hint">{{ field.hint }}</span>
        <span v-if="errors[field.key]" class="weight-error" :data-test="`weight-${field.key}-error`" role="alert">请输入有限的非负数；当前输入尚未保存。</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.weights-heading { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
.weights-description { flex: 1; margin: 0; color: #8da5ac; font-size: 12px; line-height: 1.6; }
.reset-button { flex-shrink: 0; border: 1px solid rgba(66, 214, 199, .35); border-radius: 4px; padding: 5px 10px; background: rgba(66, 214, 199, .08); color: #42d6c7; cursor: pointer; font-size: 12px; }
.reset-button:hover { background: rgba(66, 214, 199, .16); }
.reset-button:focus-visible { outline: 2px solid #42d6c7; outline-offset: 2px; }
.weights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 14px; }
.weight-field { display: flex; flex-direction: column; gap: 6px; }
.weight-label { font-size: 12px; color: rgba(255, 255, 255, .75); }
.weight-input { width: 100%; height: 32px; padding: 0 10px; background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; color: #fff; font-size: 13px; outline: none; box-sizing: border-box; }
.weight-input:focus { border-color: #42d6c7; }
.weight-input[aria-invalid="true"] { border-color: #e29b80; }
.weight-hint, .weight-error { font-size: 11px; line-height: 1.5; }
.weight-hint { color: #8da5ac; }
.weight-error { color: #e29b80; }
@media (max-width: 480px) { .weights-heading { flex-wrap: wrap; } }
</style>
