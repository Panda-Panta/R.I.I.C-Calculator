<template>
  <section class="group-tasks" aria-label="绑组任务">
    <h3>绑组任务</h3>
    <p>副表可要求现有绑组整组上下班。整组上班在副表生效时执行一次。下班也可以持续到副表退出。</p>
    <template v-if="state.error">
      <p class="task-error" role="alert">{{ state.error }}</p>
      <n-button type="error" secondary size="small" @click="emit('update:value', [])">清除无效绑组任务</n-button>
    </template>
    <template v-else>
      <p v-if="missingGroups.length" class="task-error" role="alert">找不到绑组 {{ missingGroups.join('、') }}，请重新选择或移除对应任务。</p>
      <div v-for="(task, index) in state.tasks" :key="task.group" class="group-task-row">
        <n-select
          :value="task.group" :options="groupOptions(task.group)" filterable size="small"
          aria-label="任务绑组" :data-test="`backup-group-task-group-${index}`"
          @update:value="updateGroup(index, $event)"
        />
        <n-select
          :value="task.action" :options="actionOptions" size="small"
          aria-label="上下班" :data-test="`backup-group-task-action-${index}`"
          @update:value="updateAction(index, $event)"
        />
        <n-select
          :value="task.mode" :options="modeOptions" :disabled="task.action === 'on'" size="small"
          aria-label="执行方式" :data-test="`backup-group-task-mode-${index}`"
          @update:value="updateMode(index, $event)"
        />
        <n-button
          type="error" quaternary size="small" :aria-label="`移除 ${task.group} 的任务`"
          :data-test="`remove-backup-group-task-${index}`" @click="removeTask(index)"
        >移除</n-button>
      </div>
      <n-select
        class="add-group-task" :value="null" :options="availableOptions" :disabled="!availableOptions.length"
        aria-label="添加绑组任务" placeholder="选择绑组以添加任务" filterable size="small"
        data-test="add-backup-group-task" @update:value="addTask"
      />
      <p v-if="!groups.size">在主表或副表的干员槽位设置绑组后，即可添加任务。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, toRaw } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import { readMowerBackupGroupTasks, type MowerBackupGroupTask } from '../../domain/mowerBackupGroupTasks'

const props = defineProps<{ value?: unknown; groups: ReadonlySet<string> }>()
const emit = defineEmits<{ 'update:value': [value: unknown[]] }>()

const actionOptions = [
  { label: '整组下班', value: 'off' },
  { label: '整组上班', value: 'on' },
]
const modeOptions = [
  { label: '生效时执行一次', value: 'once' },
  { label: '持续休息（允许协调回班）', value: 'while_active' },
  { label: '强制休息（禁止协调回班）', value: 'forced' },
]
const state = computed(() => {
  try { return { tasks: readMowerBackupGroupTasks(props.value), error: '' } }
  catch (error) { return { tasks: [], error: error instanceof Error ? error.message : String(error) } }
})
const missingGroups = computed(() => state.value.tasks.filter(task => !props.groups.has(task.group)).map(task => task.group))
const availableOptions = computed(() => {
  const selected = new Set(state.value.tasks.map(task => task.group))
  return [...props.groups].filter(group => group === group.trim() && !selected.has(group)).map(group => ({ label: group, value: group }))
})
function groupOptions(group: string) {
  return [{ label: group, value: group }, ...availableOptions.value]
}

function documents(): Record<string, unknown>[] {
  return Array.isArray(props.value) ? toRaw(props.value) : []
}
function updateTask(index: number, changes: Partial<MowerBackupGroupTask>) {
  emit('update:value', documents().map((task, i) => i === index ? { ...task, ...changes } : task))
}
function updateGroup(index: number, group: string) {
  if (availableOptions.value.some(option => option.value === group)) updateTask(index, { group })
}
function updateAction(index: number, action: MowerBackupGroupTask['action']) {
  updateTask(index, action === 'on' ? { action, mode: 'once' } : { action })
}
function updateMode(index: number, mode: MowerBackupGroupTask['mode']) {
  if (state.value.tasks[index]?.action === 'off') updateTask(index, { mode })
}
function addTask(group: string) {
  if (availableOptions.value.some(option => option.value === group)) {
    emit('update:value', [...documents(), { group, action: 'off', mode: 'once' }])
  }
}
function removeTask(index: number) {
  emit('update:value', documents().filter((_, i) => i !== index))
}
</script>

<style scoped>
.group-tasks { margin-bottom: 20px; padding: 10px 12px; border: 1px solid rgba(255, 255, 255, .08); border-radius: 6px; }
h3 { font-size: .95rem; margin: 0 0 6px; }
p { margin: 6px 0 10px; color: #94a3b8; font-size: .8rem; }
.task-error { color: #f87171; }
.group-task-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.7fr) auto; gap: 8px; align-items: center; margin: 8px 0; }
.add-group-task { max-width: 280px; }
@media (max-width: 700px) {
  .group-task-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
