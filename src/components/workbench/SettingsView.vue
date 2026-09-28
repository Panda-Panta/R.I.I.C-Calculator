<script setup lang="ts">
import OperatorInventoryPanel from './OperatorInventoryPanel.vue'
import type { OwnedOperatorInput } from '../../domain/operatorInventory'

export interface SimulationSettings {
  sampleDays: number
  warmupDays: number
  step: number
  seed: number
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneTradingRoomId?: string
  droneRoomId?: string
  useOperatorInventory?: boolean
  jayeElite0?: boolean
  fiammettaFool?: boolean
  restingThreshold?: number
  freeRoom?: boolean
}

const props = defineProps<{
  settings: SimulationSettings
}>()

const emit = defineEmits<{
  (e: 'update:settings', val: SimulationSettings): void
  (e: 'inventory-change', val: { enabled: boolean; valid: boolean; entries: OwnedOperatorInput[] }): void
}>()

function updateField<K extends keyof SimulationSettings>(key: K, val: SimulationSettings[K]): void {
  emit('update:settings', {
    ...props.settings,
    [key]: val,
  })
}
</script>

<template>
  <div class="settings-view plan-container" data-test="settings-view">
    <!-- Section 1: 动态模拟运行设置 -->
    <section class="settings-card" data-test="sim-settings-card">
      <div class="card-header">
        <h3 class="card-title">动态模拟运行设置</h3>
        <span class="card-subtitle">控制点击「计算产出」时执行的动态多周期微积分模拟参数</span>
      </div>

      <div class="sim-controls-grid">
        <label class="control-item">
          <span class="control-label">孑状态设置</span>
          <select class="control-select" data-test="jaye-elite0-select" :value="String(settings.jayeElite0 ?? false)" @change="updateField('jayeElite0', ($event.target as HTMLSelectElement).value === 'true')">
            <option value="false">默认（按干员库或精2最高技能）</option>
            <option value="true">精0跑单（仅摊贩经济，满差额加成）</option>
          </select>
          <span class="control-hint">勾选精0跑单时，贸易站内队友效率不会削减订单上限，享受全额差额加成。</span>
        </label>
        <label class="control-item">
          <span class="control-label">菲亚防呆</span>
          <select class="control-select" data-test="fiammetta-fool" :value="String(settings.fiammettaFool ?? true)" @change="updateField('fiammettaFool', ($event.target as HTMLSelectElement).value === 'true')">
            <option value="true">开启（Mower 默认）</option>
            <option value="false">关闭（允许最低心情候选兜底）</option>
          </select>
          <span class="control-hint">按作业要求设置；排班图片不包含这个全局选项。</span>
        </label>
        <label class="control-item">
          <span class="control-label">休息阈值（%）</span>
          <input class="control-input" data-test="resting-threshold" type="number" min="0" max="100" step="1" :value="(settings.restingThreshold ?? .65) * 100" @input="updateField('restingThreshold', Number(($event.target as HTMLInputElement).value) / 100)" />
        </label>
        <label class="control-item">
          <span class="control-label">满心情闲人离宿</span>
          <select class="control-select" data-test="free-room" :value="String(settings.freeRoom ?? false)" @change="updateField('freeRoom', ($event.target as HTMLSelectElement).value === 'true')">
            <option value="false">关闭（Mower 默认）</option>
            <option value="true">开启（恢复后腾出床位）</option>
          </select>
          <span class="control-hint">对应 Mower 全局 free_room；排班图片不包含此选项。</span>
        </label>
        <!-- 采样天数 -->
        <label class="control-item">
          <span class="control-label">采样天数（天）</span>
          <input
            type="number"
            min="1"
            max="60"
            step="1"
            class="control-input"
            :value="settings.sampleDays"
            @input="updateField('sampleDays', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <!-- 预热天数 -->
        <label class="control-item">
          <span class="control-label">预热天数（天）</span>
          <input
            type="number"
            min="0"
            max="30"
            step="1"
            class="control-input"
            :value="settings.warmupDays"
            @input="updateField('warmupDays', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <!-- 随机种子 -->
        <label class="control-item">
          <span class="control-label">随机种子 (Seed)</span>
          <input
            type="number"
            min="-1"
            max="4294967295"
            step="1"
            class="control-input"
            :value="settings.seed"
            placeholder="-1 (随机)"
            @input="updateField('seed', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="control-hint">-1 代表随机种子</span>
        </label>

      </div>

      <div class="locked-rules-bar">
        <span class="locked-tag">锁定规则</span>
        <span>暖机增长: <strong>整小时跳变</strong></span>
        <span class="dot">·</span>
        <span>跑单方式: <strong>理想收益（换人参与排班）</strong></span>
        <span class="dot">·</span>
        <span>产出口径: <strong>直观产出（忽略库存阻塞）</strong></span>
      </div>
    </section>

    <!-- Section 2: 干员库 -->
    <section class="settings-card" data-test="inventory-settings-card">
      <OperatorInventoryPanel @change="emit('inventory-change', $event)" />
    </section>
  </div>
</template>

<style scoped>
.settings-view {
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
}

.settings-card {
  padding: 16px 20px;
  background: #18181c;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-sizing: border-box;
}

.card-header {
  margin-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 8px;
}

.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
}

.card-subtitle {
  font-size: 12px;
  color: #8da5ac;
}

.sim-controls-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.control-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.control-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
}

.control-hint {
  font-size: 11px;
  color: #8da5ac;
}

.control-input,
.control-select {
  height: 32px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #ffffff;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.control-input:focus,
.control-select:focus {
  border-color: #42d6c7;
}

.highlight-select {
  border-color: rgba(66, 214, 199, 0.5);
  background: rgba(66, 214, 199, 0.08);
}

.locked-rules-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  font-size: 12px;
  color: #8da5ac;
}

.locked-tag {
  background: rgba(66, 214, 199, 0.15);
  color: #42d6c7;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
}

.dot {
  opacity: 0.4;
}
</style>
