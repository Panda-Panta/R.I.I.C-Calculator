<script lang="ts">
export interface CalculationConfig {
  productionWeights?: import('../../domain/productionWeights').ProductionWeights
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneTradingRoomId: string
  droneRoomId?: string
  useOperatorInventory?: boolean
  jayeElite0?: boolean
}
</script>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { droneFacilities } from '../../workbench/droneTargets'
import type { RosterWorkspace } from '../../workbench/model'
import ProductionWeightsEditor from './ProductionWeightsEditor.vue'
import { normalizeProductionWeights } from '../../domain/productionWeights'

const props = defineProps<{ open: boolean; workspace: RosterWorkspace; initial: CalculationConfig }>()
const emit = defineEmits<{ close: []; confirm: [config: CalculationConfig] }>()
const room = ref('none')
const useOperatorInventory = ref(true)
const jayeElite0 = ref(false)
const weights = ref(normalizeProductionWeights())
const weightsValid = ref(true)
const facilities = computed(() => droneFacilities(props.workspace))
watch(() => props.open, open => {
  if (!open) return
  const saved = props.initial.droneRoomId || props.initial.droneTradingRoomId
  room.value = props.initial.droneTarget === 'none' ? 'none' :
    facilities.value.find(f => f.roomId === saved)?.roomId ??
    (saved ? 'none' : facilities.value.find(f => f.target === props.initial.droneTarget)?.roomId ?? 'none')
  useOperatorInventory.value = props.initial.useOperatorInventory ?? true
  jayeElite0.value = props.initial.jayeElite0 ?? false
  weights.value = normalizeProductionWeights(props.initial.productionWeights)
}, { immediate: true })
function confirm() {
  if (!weightsValid.value) return
  const selected = facilities.value.find(f => f.roomId === room.value)
  emit('confirm', {
    droneTarget: selected?.target ?? 'none',
    droneRoomId: selected?.roomId ?? '',
    droneTradingRoomId: selected?.target === 'trading' ? selected.roomId : '',
    useOperatorInventory: useOperatorInventory.value,
    jayeElite0: jayeElite0.value,
    productionWeights: normalizeProductionWeights(weights.value),
  })
}
</script>

<template>
  <NModal :show="open" preset="card" title="计算产出" :style="{ width: '520px', maxWidth: '95vw' }" @update:show="!$event && emit('close')">
    <div class="calculation-config" data-test="calculation-config">
      <p>选择本次模拟的无人机加速目标。计算将在后台进行，可随时中止。</p>
      <ProductionWeightsEditor v-model="weights" @validity-change="weightsValid = $event" />
      <label>无人机加速目标
        <select v-model="room" data-test="calculation-drone-target">
          <option value="none">不使用无人机加速</option>
          <option v-for="facility in facilities" :key="facility.roomId" :value="facility.roomId">{{ facility.label }}</option>
        </select>
      </label>
      <label class="inventory-choice">
        <span><input v-model="useOperatorInventory" type="checkbox" data-test="calculation-use-inventory" /> 使用当前干员库配置</span>
        <small>取消勾选则按全部干员满配计算。</small>
      </label>
      <label class="inventory-choice">
        <span><input v-model="jayeElite0" type="checkbox" data-test="calculation-jaye-elite0" /> 孑使用精0状态（跑单满差额加成）</span>
        <small>勾选后，孑将按精0（仅解锁摊贩经济）计算，不受队友效率扣减订单上限，享受全额差额加成。</small>
      </label>
    </div>
    <template #footer>
      <div class="calculation-actions">
        <NButton @click="emit('close')">取消</NButton>
        <NButton type="primary" data-test="confirm-calculation" :disabled="!weightsValid" @click="confirm">开始计算</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.calculation-config { display: flex; flex-direction: column; gap: 18px; }
.calculation-config p { margin: 0; color: #a9b5c8; line-height: 1.7; }
.calculation-config label { display: flex; flex-direction: column; gap: 8px; }
.calculation-config select { width: 100%; padding: 10px 12px; background: #18212f; color: #e2e8f0; border: 1px solid #455367; border-radius: 6px; }
.inventory-choice > span { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.inventory-choice input { width: auto; margin: 0; }
.inventory-choice small { color: #a9b5c8; }
.calculation-actions { display: flex; justify-content: flex-end; gap: 12px; }
</style>
