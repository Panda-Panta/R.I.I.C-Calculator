<script setup lang="ts">
/** Mower alpha PlanAdvancedSettings.vue, MIT, Copyright 2021 Nano. */
import { computed } from 'vue'
import { NButton, NCheckbox, NForm, NFormItem, NInputNumber, NSelect, NTooltip } from 'naive-ui'
import { OPERATORS } from '../../domain/operators'
import { useRosterWorkbenchStore } from '../../workbench/store'

interface Field {
  key: string
  label: string
  initial: number | boolean
  nested?: boolean
  min?: number
  max?: number
  step?: number
  integer?: boolean
  percent?: boolean
  unit?: string
  help?: string
  exportOnly?: boolean
  when?: () => boolean
}
const store = useRosterWorkbenchStore()
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const settings = computed(() => record(store.workspace.compatibility.unrecognizedFields.advanced_settings))
const product = computed(() => record(settings.value.product_switching))
const enabled = () => product.value.enable === true
const grandet = () => enabled() && product.value.grandet_mode !== false
const fields: Field[] = [
  { key: 'enable', label: '自动切换产物与订单', initial: false, nested: true, help: '根据副表切换制造产物或贸易站订单类型。推荐提高无人机使用阈值。' },
  { key: 'grandet_mode', label: '葛朗台切产物', initial: true, nested: true, when: enabled, help: '按损耗容限节省无人机，并等待当前一份自然完成。' },
  { key: 'max_drones_per_switch', label: '切产物单次无人机上限', initial: 0, nested: true, when: enabled, min: 0, max: 200, integer: true, unit: '架', help: '0 表示不限制；达到上限后等待当前一份自然完成。' },
  { key: 'use_drones_when_leaving_orirock', label: '切出源石碎片时使用无人机', initial: true, nested: true, when: grandet },
  { key: 'direct_when_drones_insufficient', label: '允许无人机不足时直接切换产物', initial: false, nested: true, when: enabled, help: '开启后可取消制造站当前一份的进度。' },
  { key: 'drone_loss_seconds', label: '葛朗台无人机损耗容限', initial: 30, nested: true, when: grandet, min: 0, max: 180, integer: true, unit: '秒', help: '允许最后一架无人机浪费的加速时间。' },
  { key: 'waiting_seconds', label: '葛朗台切产物缓冲时间', initial: 2, nested: true, when: grandet, min: 0, max: 60, integer: true, unit: '秒' },
  { key: 'drone_count_limit', label: '无人机使用阈值', initial: 100, min: 0, integer: true, unit: '架' },
  { key: 'drone_interval', label: '无人机加速间隔', initial: 3, min: 0, unit: '小时' },
  { key: 'resting_threshold', label: '心情阈值', initial: .65, percent: true, min: 50, max: 80, step: 5, unit: '%', help: '2 电站推荐不低于 65%，3 电站推荐不低于 50%。' },
  { key: 'version_update_resting_threshold', label: '大更新心情阈值', initial: .8, percent: true, min: 50, max: 100, step: 5, unit: '%', exportOnly: true },
  { key: 'version_update_threshold_advance_hours', label: '大更新阈值提前时间', initial: 12, min: 0, max: 168, unit: '小时', exportOnly: true },
  { key: 'free_room', label: '宿舍不养闲人', initial: false, help: '开启后创建满心情清退任务。关闭后仍安排恢复、补床和优先级接管；个人及令夕上限仍生效。' },
  { key: 'merge_interval', label: '任务合并间隔', initial: 10, unit: '分钟', when: () => settings.value.free_room === true },
  { key: 'group_rest_in_full_on_mood_gap', label: '同组心情差过大时整组回满', initial: true },
  { key: 'group_mood_gap_threshold_minutes', label: '同组回满时间差阈值', initial: 60, min: 1, max: 1440, integer: true, step: 5, unit: '分钟', when: () => settings.value.group_rest_in_full_on_mood_gap !== false },
  { key: 'group_mood_gap_max_extra_wait_hours', label: '整组回满最多额外等待', initial: 0, min: 0, max: 24, step: .5, unit: '小时', help: '仅限制恢复时间差触发的额外等待，0 表示不限时；明确设置的需要回满仍须满足，包括多绑组干员。', when: () => settings.value.group_rest_in_full_on_mood_gap !== false },
  { key: 'fia_fool', label: '菲亚防呆', initial: true, help: '当菲亚替换干员心情均超过 90% 时，菲亚等待半小时；不确定替换干员心情消耗时启用。' },
  { key: 'assistant_follows_schedule', label: '训练室协助位总是跟随排班', initial: false, exportOnly: true, help: '专精时协助位不使用单独设置的专精工具人，基建排班按排班表替换训练室协助位。' },
  { key: 'fia_threshold', label: '菲亚阈值', initial: .9, percent: true, min: 50, max: 90, step: 5, unit: '%' },
  { key: 'rescue_threshold', label: '救急阈值', initial: .75, percent: true, min: 0, max: 90, step: 5, unit: '%' },
]
const visibleFields = computed(() => fields.filter(field => !field.when || field.when()))
function value(field: Field): number | boolean {
  const candidate = (field.nested ? product.value : settings.value)[field.key]
  const result = typeof candidate === typeof field.initial ? candidate as number | boolean : field.initial
  return field.percent && typeof result === 'number' ? Math.round(result * 10000) / 100 : result
}
function patch(change: Record<string, unknown>): void {
  store.workspace.compatibility.unrecognizedFields.advanced_settings = { ...settings.value, ...change }
}
function update(field: Field, next: number | boolean | null): void {
  if (next === null || typeof next !== typeof field.initial) return
  if (typeof next === 'number') {
    if (!Number.isFinite(next) || (field.min !== undefined && next < field.min) || (field.max !== undefined && next > field.max) || (field.integer && !Number.isInteger(next))) return
    if (field.percent) next /= 100
  }
  if (field.nested) patch({ product_switching: { ...product.value, [field.key]: next } })
  else patch({ [field.key]: next })
}
const gapExclusions = computed<string[]>(() => Array.isArray(settings.value.group_mood_gap_exclusions) ? settings.value.group_mood_gap_exclusions.filter((group): group is string => typeof group === 'string' && !!group.trim()) : [])
const gapGroupOptions = computed(() => {
  const names = new Set(gapExclusions.value)
  const add = (name: unknown) => { if (typeof name === 'string' && name.trim()) names.add(name) }
  for (const facility of Object.values(store.workspace.mainPlan.facilities)) for (const slot of facility.slots) {
    add(slot.groupId)
    slot.groupBindings?.forEach(binding => add(binding.groupId))
  }
  for (const backup of store.workspace.compatibility.backupPlans) for (const facility of Object.values(record(record(backup).plan))) {
    const slots = record(facility).plans
    if (Array.isArray(slots)) for (const slot of slots) {
      const value = record(slot); add(value.group)
      if (Array.isArray(value.group_bindings)) value.group_bindings.forEach(binding => add(record(binding).group))
    }
  }
  return [...names].map(name => ({ label: name, value: name }))
})
function updateGapExclusions(names: string[]): void { patch({ group_mood_gap_exclusions: [...new Set(names.filter(name => typeof name === 'string' && name.trim()))] }) }
const isolation = computed<string[][]>(() => Array.isArray(settings.value.dorm_isolation) ? settings.value.dorm_isolation as string[][] : [])
const favorite = computed(() => typeof settings.value.favorite === 'string' ? settings.value.favorite.split(',').map(name => name.trim()).filter(Boolean) : [])
const operatorOptions = OPERATORS.map(operator => ({ label: operator.name, value: operator.name }))
function options(names: string[]) {
  return [...operatorOptions, ...names.filter(name => !operatorOptions.some(option => option.value === name)).map(name => ({ label: name, value: name }))]
}
function updateFavorite(names: string[]): void { patch({ favorite: names.join(',') }) }
function updateIsolation(index: number, names: string[]): void {
  patch({ dorm_isolation: isolation.value.map((group, i) => i === index ? [...new Set(names.filter(name => name && name !== 'Free' && name !== 'Current'))] : group) })
}
</script>

<template>
  <div class="advanced-settings">
    <n-form label-placement="left" label-width="210" label-align="left" :show-feedback="false">
      <template v-for="field in visibleFields" :key="field.key">
        <n-form-item :label="field.label" :data-field="field.key">
          <div class="setting-control">
            <n-checkbox v-if="typeof field.initial === 'boolean'" :checked="value(field) as boolean" :aria-label="field.label" @update:checked="update(field, $event)" />
            <n-input-number v-else :value="value(field) as number" :min="field.min" :max="field.max" :step="field.step ?? 1" :precision="field.integer ? 0 : undefined" :aria-label="field.label" @update:value="update(field, $event)">
              <template v-if="field.unit" #suffix>{{ field.unit }}</template>
            </n-input-number>
            <n-tooltip v-if="field.help" trigger="hover">
              <template #trigger><span class="setting-help" tabindex="0" :aria-label="field.label + '说明'">?</span></template>
              <span class="help-text">{{ field.help }}</span>
            </n-tooltip>
            <small v-if="field.exportOnly" class="export-only">仅保存并导出至 Mower，本地模拟暂未使用。</small>
          </div>
        </n-form-item>
        <n-form-item v-if="field.key === 'group_mood_gap_max_extra_wait_hours'" label="延后回班排除组" data-field="group_mood_gap_exclusions">
          <div class="isolation-groups">
            <n-select :value="gapExclusions" :options="gapGroupOptions" multiple filterable tag aria-label="延后回班排除组" placeholder="选择或输入组名" @update:value="updateGapExclusions" />
            <small>所选组不因恢复时间差延后回班，明确设置的需要回满仍生效。</small>
          </div>
        </n-form-item>
        <n-form-item v-if="field.key === 'free_room'" label="宿舍隔离" data-field="dorm_isolation">
          <div class="isolation-groups">
            <div v-for="(group, index) in isolation" :key="index" class="isolation-row" :data-test="`isolation-${index}`">
              <n-select :value="group" :options="options(group)" multiple filterable :aria-label="`宿舍隔离组 ${index + 1}`" placeholder="选择优先分开休息的干员" @update:value="updateIsolation(index, $event)" />
              <n-button quaternary :aria-label="`删除宿舍隔离组 ${index + 1}`" @click="patch({ dorm_isolation: isolation.filter((_, i) => i !== index) })">删除</n-button>
            </div>
            <n-button size="small" data-test="add-isolation" @click="patch({ dorm_isolation: [...isolation, []] })">添加隔离组</n-button>
            <small>入住前优先分开同组干员，可跨宿舍交换普通位住客，必要时让新入住者由单回位改住普通位。满足隔离后按恢复优先级分配单回位；固定驻员、已有单回位住客及预约保持保护。无法分开时允许同宿，入住后不另行纠错。同一干员可加入多个隔离组。</small>
          </div>
        </n-form-item>
      </template>
      <n-form-item label="特别关注干员" data-field="favorite">
        <div class="isolation-groups">
          <n-select :value="favorite" :options="options(favorite)" multiple filterable aria-label="特别关注干员" placeholder="选择干员" @update:value="updateFavorite" />
          <small class="export-only">仅保存并导出至 Mower，本地模拟暂未使用。</small>
        </div>
      </n-form-item>
    </n-form>
  </div>
</template>

<style scoped>
.advanced-settings { width: 100%; }
.setting-control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; }
.setting-control :deep(.n-input-number) { width: 180px; max-width: 100%; }
.setting-help { display: inline-flex; justify-content: center; align-items: center; border: 1px solid currentColor; border-radius: 50%; width: 16px; height: 16px; opacity: .6; cursor: help; }
.help-text { display: block; max-width: 340px; }
.export-only { display: block; flex-basis: 100%; color: var(--text-muted, #888); line-height: 1.5; }
.isolation-groups { display: flex; flex-direction: column; gap: 8px; width: 100%; align-items: flex-start; }
.isolation-row { display: flex; gap: 8px; align-items: center; width: 100%; }
.isolation-row :deep(.n-select) { flex: 1; min-width: 0; }
@media (max-width: 600px) {
  .advanced-settings :deep(.n-form-item) { display: block; }
  .advanced-settings :deep(.n-form-item-label) { width: auto !important; padding-bottom: 5px; }
}
</style>
