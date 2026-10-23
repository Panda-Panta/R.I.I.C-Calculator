<template>
  <details class="backup-groups" data-test="backup-group-editor">
    <summary>副表分组 <span>{{ groupState.groups.length }} 组</span></summary>
    <div class="groups-content">
      <p class="group-help">一次只启用一个分组。当前组条件仍成立时保持；否则按下方顺序选择首个成立的自定义组，均不成立时使用默认组。</p>
      <p class="group-help">副表可属于多个组，但仅在当前组内参与调度。「组内叠加」可同时生效；「组内互斥」最多生效一张，优先保留当前有效项，否则按副表顺序选择。</p>
      <p v-if="groupState.error" class="group-error" role="alert">{{ groupState.error }}，原始数据已保留，请检查导入文件。</p>
      <template v-else>
        <div v-for="(group, index) in groupState.groups" :key="group.id" class="group-row" :data-test="`backup-group-${group.id}`">
          <div class="group-heading">
            <span class="group-kind">{{ group.id === 'default' ? '兜底' : `顺序 ${index}` }}</span>
            <n-input
              :value="nameDrafts[group.id] ?? group.name" :aria-label="`分组 ${group.name} 名称`"
              :data-test="`group-name-${group.id}`" placeholder="分组名称" maxlength="80" size="small"
              @update:value="nameDrafts[group.id] = $event" @blur="saveName(group.id)" @keydown.enter="saveName(group.id)"
            />
            <div v-if="group.id !== 'default'" class="group-actions">
              <n-button size="small" :disabled="index <= 1" :aria-label="`上移分组 ${group.name}`" :data-test="`group-up-${group.id}`" @click="move(group.id, -1)">↑</n-button>
              <n-button size="small" :disabled="index === groupState.groups.length - 1" :aria-label="`下移分组 ${group.name}`" :data-test="`group-down-${group.id}`" @click="move(group.id, 1)">↓</n-button>
              <n-popconfirm @positive-click="remove(group.id)">
                <template #trigger><n-button size="small" type="error" quaternary :data-test="`group-delete-${group.id}`">删除</n-button></template>
                删除「{{ group.name }}」？仅属于此组的副表转入默认组，其余副表保留其他归属。
              </n-popconfirm>
            </div>
          </div>
          <p v-if="nameErrors[group.id]" class="group-error" role="alert">{{ nameErrors[group.id] }}</p>
          <p v-if="group.id === 'default'" class="group-help">默认组始终作为兜底，不设条件，也不能删除。</p>
          <template v-else>
            <n-input
              :value="triggerDrafts[group.id] ?? serializeBackupTrigger(group.trigger)" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }"
              :aria-label="`分组 ${group.name} 条件`" :data-test="`group-trigger-${group.id}`"
              placeholder="例如：op_data.operators['令'].is_resting()" @update:value="setTrigger(group.id, $event)"
            />
            <p class="group-validation" :class="{ 'group-error': !validation(group.trigger).valid }" :data-test="`group-validation-${group.id}`">
              {{ validation(group.trigger).valid ? '语法有效' : `语法错误：${validation(group.trigger).error}` }}
            </p>
          </template>
        </div>
        <n-button secondary size="small" data-test="add-backup-group" @click="add">+ 新增分组</n-button>
        <span class="group-help new-group-help">新组条件默认为 False，编辑后才参与选择。</span>
      </template>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { NButton, NInput, NPopconfirm } from 'naive-ui'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { addBackupGroup, backupGroupsForEditor, moveBackupGroup, removeBackupGroup, updateBackupGroup } from '../../workbench/backupGroupHelpers'
import { serializeBackupTrigger, validateBackupTrigger } from '../../workbench/backupPlanHelpers'

const store = useRosterWorkbenchStore()
const nameDrafts = reactive<Record<string, string>>({})
const nameErrors = reactive<Record<string, string>>({})
const triggerDrafts = reactive<Record<string, string>>({})
watch(() => store.workspace, () => {
  for (const values of [nameDrafts, nameErrors, triggerDrafts]) Object.keys(values).forEach(key => { delete values[key] })
})
const groupState = computed(() => {
  try { return { groups: backupGroupsForEditor(store.workspace), error: '' } }
  catch (error) { return { groups: [], error: error instanceof Error ? error.message : String(error) } }
})
const validation = validateBackupTrigger
function saveName(id: string) {
  if (nameDrafts[id] === undefined) return
  try {
    updateBackupGroup(store.workspace, id, { name: nameDrafts[id] })
    delete nameDrafts[id]; delete nameErrors[id]
  } catch (error) { nameErrors[id] = error instanceof Error ? error.message : String(error) }
}
function setTrigger(id: string, trigger: string) {
  triggerDrafts[id] = trigger
  updateBackupGroup(store.workspace, id, { trigger })
}
function add() { addBackupGroup(store.workspace) }
function move(id: string, direction: -1 | 1) { moveBackupGroup(store.workspace, id, direction) }
function remove(id: string) {
  removeBackupGroup(store.workspace, id)
  delete nameDrafts[id]; delete nameErrors[id]; delete triggerDrafts[id]
}
</script>

<style scoped>
.backup-groups { margin-bottom: 16px; border: 1px solid rgba(255, 255, 255, .1); border-radius: 8px; background: rgba(20, 26, 33, .7); }
summary { padding: 12px 16px; cursor: pointer; font-weight: 600; }
summary span { margin-left: 8px; font-size: .8rem; font-weight: 400; color: #94a3b8; }
.groups-content { padding: 0 16px 16px; }
.group-help { color: #94a3b8; font-size: .8rem; line-height: 1.65; margin: 6px 0; }
.group-row { padding: 12px 0; border-top: 1px solid rgba(255, 255, 255, .07); }
.group-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.group-heading > .n-input { max-width: 320px; }
.group-kind { min-width: 48px; color: #2cb5a0; font-size: .8rem; }
.group-actions { display: flex; gap: 6px; margin-left: auto; }
.group-validation { font-size: .75rem; color: #2cb5a0; margin: 5px 0 0; }
.group-error { font-size: .8rem; color: #f87171; }
.new-group-help { margin-left: 10px; }
@media (max-width: 600px) {
  .group-heading { flex-wrap: wrap; }
  .group-heading > .n-input { flex: 1; max-width: none; min-width: 140px; }
  .group-actions { width: 100%; justify-content: flex-end; }
  .new-group-help { display: block; margin-left: 0; }
}
</style>
