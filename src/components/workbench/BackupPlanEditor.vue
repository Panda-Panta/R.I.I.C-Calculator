<template>
  <div class="backup-plan-editor plan-container" data-test="backup-plan-editor">
    <!-- Top Header & Actions -->
    <header class="editor-header">
      <div class="header-main">
        <div class="title-row">
          <h2 class="editor-title">副表调度管理</h2>
          <span class="mower-badge">Mower Backup Plans</span>
        </div>
        <p class="editor-subtitle">
          按条件收敛应用副表，配置即时进驻任务与策略增减。
        </p>
      </div>

      <div class="header-actions">
        <n-button
          type="primary"
          secondary
          data-test="add-backup-plan-btn"
          @click="handleCreatePlan"
        >
          + 新增副表
        </n-button>
        <n-popconfirm
          v-if="backupPlans.length > 0"
          @positive-click="handleClearPlans"
        >
          <template #trigger>
            <n-button
              type="error"
              secondary
              data-test="clear-backup-plans-btn"
            >
              清空副表
            </n-button>
          </template>
          确定清空当前排班方案下的全部副表吗？此操作不可撤销。
        </n-popconfirm>
      </div>
    </header>

    <!-- Stats Bar -->
    <div class="stats-bar" data-test="stats-bar">
      <div class="stat-pill">
        <span class="stat-label">副表总数</span>
        <span class="stat-value text-accent">{{ backupPlans.length }}</span>
      </div>
    </div>

    <BackupGroupEditor />

    <!-- Main Two-Pane Layout -->
    <div class="editor-body">
      <!-- Left Pane: Plan List -->
      <aside class="plans-list-panel" data-test="plans-list-panel">
        <div class="search-box">
          <n-input
            v-model:value="searchQuery"
            placeholder="搜索副表名称、干员或条件..."
            clearable
            size="small"
            data-test="backup-plan-search"
          />
        </div>

        <div v-if="filteredPlans.length === 0" class="empty-list-notice">
          {{ backupPlans.length === 0 ? '暂无副表配置，点击右上角「+ 新增副表」添加' : '无匹配副表' }}
        </div>

        <div v-else class="plans-scroll-list" data-test="plans-scroll-list">
          <div
            v-for="item in filteredPlans"
            :key="item.index"
            class="plan-card"
            :class="{ active: selectedIndex === item.index }"
            :data-test="`backup-plan-card-${item.index}`"
            @click="selectedIndex = item.index"
          >
            <div class="card-head">
              <span class="plan-index">#{{ item.index + 1 }}</span>
              <span class="plan-title" :title="item.plan.name">{{ item.plan.name || `副表 #${item.index + 1}` }}</span>

            </div>

            <!-- Condition Preview -->
            <p class="condition-preview" :title="humanizeBackupTrigger(item.plan.trigger)">
              {{ humanizeBackupTrigger(item.plan.trigger) }}
            </p>

            <!-- Metadata Pills -->
            <div class="card-meta">
              <span class="meta-tag meta-group">{{ membershipLabel(item.plan) }}</span>
              <span class="meta-tag meta-group">{{ item.plan.type === 'exclusive' ? '组内互斥' : '组内叠加' }}</span>
              <span v-if="hasTasks(item.plan)" class="meta-tag meta-task">
                任务: {{ Object.keys(item.plan.task || {}).length }} 个设施
              </span>
              <span v-if="hasConfOverrides(item.plan)" class="meta-tag meta-conf">
                包含策略覆盖
              </span>
              <span v-if="hasPlanOverrides(item.plan)" class="meta-tag meta-override">
                方案覆盖
              </span>
            </div>

            <!-- Reorder & Actions -->
            <div class="card-actions" @click.stop>
              <button
                type="button"
                class="action-btn"
                :disabled="item.index === 0"
                title="上移"
                :data-test="`move-up-plan-${item.index}`"
                @click="handleMovePlan(item.index, item.index - 1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="action-btn"
                :disabled="item.index === backupPlans.length - 1"
                title="下移"
                :data-test="`move-down-plan-${item.index}`"
                @click="handleMovePlan(item.index, item.index + 1)"
              >
                ↓
              </button>
              <button
                type="button"
                class="action-btn"
                title="复制"
                :data-test="`dup-plan-${item.index}`"
                @click="handleDuplicatePlan(item.index)"
              >
                📋
              </button>
              <button
                type="button"
                class="action-btn action-btn-del"
                title="删除"
                :data-test="`del-plan-${item.index}`"
                @click="handleDeletePlan(item.index)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </aside>

      <!-- Right Pane: Detail Editor -->
      <main class="plan-detail-panel" data-test="plan-detail-panel">
        <div v-if="!activePlan" class="detail-placeholder">
          <div class="placeholder-icon">📋</div>
          <h3>未选择副表</h3>
          <p>请在左侧列表中选择要编辑的副表，或点击下方按钮新建。</p>
          <n-button type="primary" @click="handleCreatePlan">
            新建副表
          </n-button>
        </div>

        <div v-else class="detail-container" data-test="active-plan-detail">
          <!-- Detail Header -->
          <div class="detail-header-card">
            <div class="field-row">
              <div class="field-col flex-2">
                <label class="form-label">副表名称</label>
                <n-input
                  v-model:value="activePlan.name"
                  placeholder="例如：莱茵强制休息 / 感知下班"
                  maxlength="40"
                  data-test="plan-name-input"
                  @update:value="saveCurrentPlan"
                />
              </div>


            </div>
            <div class="field-row membership-fields">
              <div class="field-col flex-2">
                <label class="form-label">所属分组（可多选）</label>
                <n-select :value="backupPlanMembership(activePlan.group_ids)" :options="backupGroupOptions" multiple
                  aria-label="副表所属分组" data-test="plan-group-select" @update:value="setPlanGroups" />
              </div>
              <div class="field-col">
                <label class="form-label">当前组内的生效方式</label>
                <n-select :value="activePlan.type ?? 'global'" :options="backupTypeOptions"
                  aria-label="副表组内生效方式" data-test="plan-type-select" @update:value="setPlanType" />
              </div>
            </div>
            <p class="membership-help">只在选中的当前组内生效。组内叠加允许多张同时生效；组内互斥仅保留一张。取消全部归属时回到默认组。</p>
          </div>

          <!-- Detail Tabs -->
          <n-tabs
            v-model:value="activeDetailTab"
            type="line"
            animated
            class="detail-tabs"
            data-test="detail-tabs"
          >
            <!-- Tab 1: 触发条件 -->
            <n-tab-pane name="condition" tab="触发条件 (Trigger)">
              <div class="tab-content condition-tab-content">
                <div class="condition-mode-switch">
                  <span class="mode-label">编辑模式：</span>
                  <n-radio-group v-model:value="conditionEditMode" size="small">
                    <n-radio value="builder">可视化构建</n-radio>
                    <n-radio value="code">表达式代码</n-radio>
                  </n-radio-group>
                </div>

                <!-- Visual Rule Builder -->
                <div v-if="conditionEditMode === 'builder'" class="visual-builder-box">
                  <div class="builder-helper-text">
                    快速组装条件片段，点击「追加到表达式」即可写入条件中。
                  </div>

                  <div class="builder-form-row">
                    <!-- Operator Select -->
                    <div class="builder-item flex-2">
                      <span class="sub-label">目标干员</span>
                      <n-select
                        v-model:value="builderState.operator"
                        filterable
                        placeholder="选择干员..."
                        :options="operatorSelectOptions"
                        :filter="filterOperator"
                        :render-label="renderOptionLabel"
                      />
                    </div>

                    <!-- Property Select -->
                    <div class="builder-item flex-2">
                      <span class="sub-label">检测属性</span>
                      <n-select
                        v-model:value="builderState.property"
                        :options="propertyOptions"
                      />
                    </div>

                    <!-- Comparator Select -->
                    <div class="builder-item flex-1">
                      <span class="sub-label">比较符</span>
                      <n-select
                        v-model:value="builderState.comparator"
                        :options="comparatorOptions"
                      />
                    </div>

                    <!-- Value Input -->
                    <div class="builder-item flex-1">
                      <span class="sub-label">目标值</span>
                      <n-input
                        v-model:value="builderState.targetValue"
                        placeholder="True / 12"
                      />
                    </div>

                    <div class="builder-actions">
                      <n-button
                        type="primary"
                        secondary
                        size="small"
                        :disabled="!builderState.operator"
                        @click="appendBuiltCondition"
                      >
                        + 追加到表达式
                      </n-button>
                    </div>
                  </div>

                  <!-- Quick Snippet Buttons -->
                  <div class="snippet-buttons-row">
                    <span class="snippet-label">快捷语法插入：</span>
                    <n-button size="tiny" secondary @click="insertSnippet(' and ')">且 (and)</n-button>
                    <n-button size="tiny" secondary @click="insertSnippet(' or ')">或 (or)</n-button>
                    <n-button size="tiny" secondary @click="insertSnippet('not ')">非 (not)</n-button>
                    <n-button size="tiny" secondary @click="insertSnippet('( )')">( 括号 )</n-button>
                    <n-button size="tiny" secondary @click="setExpression('True')">始终触发 (True)</n-button>
                  </div>
                </div>

                <!-- Expression Code View & Real-time Validation -->
                <div class="expression-editor-section">
                  <div class="expression-header">
                    <span class="sub-label">当前条件表达式 (Mower Logic Expression)</span>
                    <span v-if="validationInfo.valid" class="status-indicator status-valid" data-test="trigger-validation-status">
                      ✓ 语法有效
                    </span>
                    <span v-else class="status-indicator status-invalid" data-test="trigger-validation-status">
                      ✕ 语法错误: {{ validationInfo.error }}
                    </span>
                  </div>

                  <n-input
                    v-model:value="currentExpressionText"
                    type="textarea"
                    class="code-textarea"
                    :rows="3"
                    placeholder="输入 Mower 条件表达式，例如：op_data.operators['薇薇安娜'].is_resting() and op_data.operators['阿罗玛'].is_working()"
                    data-test="trigger-expression-input"
                    @update:value="onExpressionTextChange"
                  />

                  <!-- Humanized Interpretation Box -->
                  <div class="humanized-box" data-test="trigger-humanized-preview">
                    <span class="humanized-tag">自然语言解释</span>
                    <span class="humanized-text">{{ humanizeBackupTrigger(activePlan.trigger) }}</span>
                  </div>

                  <!-- Participants Display -->
                  <div v-if="validationInfo.participants.length > 0" class="participants-row">
                    <span class="participants-label">条件中引用的干员：</span>
                    <div
                      v-for="opId in validationInfo.participants"
                      :key="opId"
                      class="operator-mini-chip"
                    >
                      <img :src="getOperatorAvatarUrl(opId)" class="mini-avatar" />
                      <span>{{ getOperatorName(opId) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </n-tab-pane>

            <!-- Tab 2: 即时进驻任务 (Task) -->
            <n-tab-pane name="task" tab="即时任务 (Task)">
              <div class="tab-content task-tab-content">
                <div class="task-info-banner">
                  <p>
                    <strong>Mower 即时进驻任务（Task）：</strong>
                    当副表条件由假变真时，将指定干员立即送入对应房间或宿舍（如强制休息或强制换岗）。
                    每个槽位可设为 <code>保持当前 (Current)</code>、<code>空闲床位 (Free，仅宿舍)</code> 或 <code>指定干员</code>。
                  </p>
                </div>

                <!-- Add Facility Task Controller -->
                <div class="add-task-row">
                  <n-select
                    v-model:value="selectedFacilityToAdd"
                    placeholder="选择要配置任务的设施/房间..."
                    :options="availableFacilityOptions"
                    class="facility-select"
                    data-test="add-task-facility-select"
                  />
                  <n-button
                    type="primary"
                    secondary
                    :disabled="!selectedFacilityToAdd"
                    data-test="add-task-facility-btn"
                    @click="handleAddFacilityTask"
                  >
                    + 添加设施任务
                  </n-button>
                </div>

                <!-- Configured Facility Task Cards -->
                <div v-if="taskRooms.length === 0" class="empty-tasks-placeholder">
                  暂未配置即时进驻任务，可点击上方「+ 添加设施任务」为指定房间添加任务。
                </div>

                <div v-else class="task-facilities-list">
                  <div
                    v-for="roomId in taskRooms"
                    :key="roomId"
                    class="task-facility-card"
                    :data-test="`task-facility-card-${roomId}`"
                  >
                    <div class="task-card-header">
                      <div class="room-title-info">
                        <span class="room-name">{{ getFacilityRoomDisplayName(roomId) }}</span>
                        <code class="room-id">({{ roomId }})</code>
                      </div>
                      <div class="task-card-actions">
                        <n-button
                          size="tiny"
                          secondary
                          @click="resetTaskFacilityToCurrent(roomId)"
                        >
                          全部设为 Current
                        </n-button>
                        <n-button
                          size="tiny"
                          type="error"
                          secondary
                          @click="handleRemoveFacilityTask(roomId)"
                        >
                          移除任务
                        </n-button>
                      </div>
                    </div>

                    <!-- Slots Row -->
                    <div class="task-slots-grid">
                      <div
                        v-for="slotIdx in getSlotCountForRoom(roomId)"
                        :key="slotIdx"
                        class="task-slot-item"
                        :data-test="`task-slot-${roomId}-${slotIdx - 1}`"
                      >
                        <div class="slot-number">槽位 {{ slotIdx }}</div>

                        <!-- Slot Mode Switch -->
                        <div class="slot-operator-box">
                          <n-select
                            :value="getTaskSlotValue(roomId, slotIdx - 1)"
                            filterable
                            :options="getSlotCandidateOptions(roomId)"
                            :filter="filterOperator"
                            :render-label="renderOptionLabel"
                            size="small"
                            :data-test="`task-slot-op-select-${roomId}-${slotIdx - 1}`"
                            @update:value="setTaskSlotValue(roomId, slotIdx - 1, $event)"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </n-tab-pane>

            <!-- Tab 3: 策略覆盖 (Conf) -->
            <n-tab-pane name="conf" tab="策略覆盖 (Conf)">
              <div class="tab-content conf-tab-content">
                <div class="conf-info-banner">
                  <p>
                    <strong>策略配置覆盖（Conf）：</strong>
                    副表按顺序先添加干员，再移除指定干员；停用后从主表与其余活动副表重新计算。
                  </p>
                </div>

                <!-- Conf List Fields -->
                <div
                  v-for="field in confFields"
                  :key="field.key"
                  class="conf-field-group"
                  :data-test="`conf-field-${field.key}`"
                >
                  <div class="field-title-box">
                    <span class="field-name">{{ field.label }}</span>
                    <span class="field-desc">{{ field.placeholder }}</span>
                  </div>

                  <!-- Chips for Operators -->
                  <div class="conf-chips-container">
                    <div
                      v-for="(opName, idx) in getConfOperatorList(field.key)"
                      :key="`${opName}-${idx}`"
                      class="policy-operator-tag"
                      :data-test="`tag-${field.key}-${idx}`"
                    >
                      <img :src="getOperatorAvatarUrl(opName)" class="tag-avatar" />
                      <span class="tag-name">{{ opName }}</span>
                      <button
                        type="button"
                        class="tag-close-btn"
                        @click="removeConfOperator(field.key, idx)"
                      >
                        ×
                      </button>
                    </div>

                    <!-- Add Operator Select -->
                    <div class="add-operator-chip-box">
                      <n-select
                        filterable
                        placeholder="+ 添加干员..."
                        size="small"
                        :options="operatorSelectOptions"
                        :filter="filterOperator"
                        :render-label="renderOptionLabel"
                        @update:value="addConfOperator(field.key, $event)"
                      />
                    </div>
                  </div>
                  <n-input :value="getRemovedOperators(field.key)" placeholder="移除干员（逗号分隔）" :aria-label="`${field.label}移除名单`" :data-test="`conf-remove-${field.key}`" @update:value="setRemovedOperators(field.key, $event)" />
                </div>
              </div>
            </n-tab-pane>

            <!-- Tab 4: 计划排班覆盖 (Plan) -->
            <n-tab-pane name="plan" tab="排班覆盖 (Plan)">
              <div class="tab-content plan-tab-content">
                <div class="plan-info-banner">
                  <p>
                    <strong>房间排班方案覆盖（Plan Overrides）：</strong>
                    高级功能。在副表生效期间，改变指定房间的常驻干员、轮换替补或生产产物。
                  </p>
                </div>

                <div v-if="Object.keys(activePlan.plan || {}).length === 0" class="empty-tasks-placeholder">
                  当前副表未覆盖任何长期轮换方案（绝大多数副表仅需配置「即时任务 Task」即可生效）。
                </div>

                <div v-else class="plan-overrides-list">
                  <div
                    v-for="(roomPlan, roomId) in activePlan.plan"
                    :key="roomId"
                    class="task-facility-card"
                  >
                    <div class="task-card-header">
                      <span class="room-name">{{ getFacilityRoomDisplayName(String(roomId)) }}</span>
                      <span v-if="roomPlan.product" class="meta-tag meta-conf">产物: {{ roomPlan.product }}</span>
                      <n-button
                        size="tiny"
                        type="error"
                        secondary
                        @click="removePlanOverride(String(roomId))"
                      >
                        移除方案覆盖
                      </n-button>
                    </div>

                    <div class="plan-slots-summary">
                      <div
                        v-for="(slot, sIdx) in roomPlan.plans"
                        :key="sIdx"
                        class="plan-slot-pill"
                      >
                        <span class="slot-idx">#{{ sIdx + 1 }}</span>
                        <img :src="getOperatorAvatarUrl(slot.agent)" class="mini-avatar" />
                        <span class="agent-name">{{ slot.agent }}</span>
                        <span v-if="slot.group" class="group-tag">组: {{ slot.group }}</span>
                        <span v-if="slot.replacement?.length" class="rep-tag">替补: {{ slot.replacement.join(',') }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </n-tab-pane>
          </n-tabs>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, toRaw, watch, type VNode } from 'vue'
import {
  NAvatar,
  NButton,
  NInput,
  NPopconfirm,
  NRadio,
  NRadioGroup,
  NSelect,
  NTabs,
  NTabPane,
  type SelectOption,
} from 'naive-ui'
import { match } from 'pinyin-pro'
import { OPERATORS } from '../../domain/operators'
import { useRosterWorkbenchStore } from '../../workbench/store'
import BackupGroupEditor from './BackupGroupEditor.vue'
import { backupGroupsForEditor, backupPlanMembership, normalizeBackupMembership } from '../../workbench/backupGroupHelpers'
import {
  BACKUP_CONF_FIELDS,
  createDefaultBackupPlan,
  getFacilityMaxSlots,
  getFacilityRoomDisplayName,
  humanizeBackupTrigger,
  isDormitoryRoom,
  parseConfStringToOperatorNames,
  serializeBackupTrigger,
  validateBackupTrigger,
  type MowerBackupPlan,
} from '../../workbench/backupPlanHelpers'
import { getOperatorAvatarUrl, getOperatorName } from '../../workbench/operatorHelpers'
import { MOWER_ROOM_IDS } from '../../domain/roster'

const store = useRosterWorkbenchStore()
const backupGroupOptions = computed<SelectOption[]>(() => {
  try { return backupGroupsForEditor(store.workspace).map(group => ({ label: group.name, value: group.id })) }
  catch { return [{ label: '默认分组', value: 'default' }] }
})
const backupTypeOptions = [
  { label: '组内叠加 (global)', value: 'global' },
  { label: '组内互斥 (exclusive)', value: 'exclusive' },
]
function membershipLabel(plan: MowerBackupPlan): string {
  return backupPlanMembership(plan.group_ids).map(id => backupGroupOptions.value.find(option => option.value === id)?.label ?? id).join('、')
}
function setPlanGroups(groupIds: string[]): void {
  if (activePlan.value) store.updateBackupPlan(selectedIndex.value, { ...toRaw(activePlan.value), group_ids: normalizeBackupMembership(groupIds) })
}
function setPlanType(type: 'global' | 'exclusive'): void {
  if (activePlan.value) store.updateBackupPlan(selectedIndex.value, { ...toRaw(activePlan.value), type })
}

// State
const selectedIndex = ref<number>(0)
const searchQuery = ref<string>('')
const activeDetailTab = ref<'condition' | 'task' | 'conf' | 'plan'>('condition')
const conditionEditMode = ref<'builder' | 'code'>('builder')
const currentExpressionText = ref<string>('')
const selectedFacilityToAdd = ref<string | null>(null)

// Visual condition builder state
const builderState = ref({
  operator: '',
  property: 'is_working()',
  comparator: '==',
  targetValue: 'True',
})

// Conf fields definition
const confFields = BACKUP_CONF_FIELDS

// Operators options for dropdowns
const baseOperatorOptions: SelectOption[] = OPERATORS.map((op) => ({
  label: op.name,
  value: op.name,
  name: op.name,
  charId: op.charId,
}))

const operatorSelectOptions = computed<SelectOption[]>(() => {
  return baseOperatorOptions
})

// Property options for visual condition builder
const propertyOptions: SelectOption[] = [
  { label: '工作中 (is_working)', value: 'is_working()' },
  { label: '休息中 (is_resting)', value: 'is_resting()' },
  { label: '心情值 (current_mood)', value: 'current_mood()' },
  { label: '所在房间 (current_room)', value: 'current_room' },
]

// Comparator options
const comparatorOptions: SelectOption[] = [
  { label: '等于 (==)', value: '==' },
  { label: '不等于 (!=)', value: '!=' },
  { label: '小于 (<)', value: '<' },
  { label: '小于等于 (<=)', value: '<=' },
  { label: '大于 (>)', value: '>' },
  { label: '大于等于 (>=)', value: '>=' },
]

// Backup plans from store
const backupPlans = computed<MowerBackupPlan[]>({
  get() {
    return (store.workspace.compatibility.backupPlans ?? []) as MowerBackupPlan[]
  },
  set(val) {
    store.workspace.compatibility.backupPlans = val
    store.workspace.compatibility.importedHasBackupPlans = true
  },
})

// Filtered plans for sidebar
const filteredPlans = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return backupPlans.value
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan, index }) => {
      if (!query) return true
      const name = (plan.name || '').toLowerCase()
      const cond = serializeBackupTrigger(plan.trigger).toLowerCase()
      const human = humanizeBackupTrigger(plan.trigger).toLowerCase()
      return (
        name.includes(query) ||
        cond.includes(query) ||
        human.includes(query) ||
        String(index + 1) === query
      )
    })
})

// Active plan
const activePlan = computed<MowerBackupPlan | null>(() => {
  if (
    selectedIndex.value >= 0 &&
    selectedIndex.value < backupPlans.value.length
  ) {
    return backupPlans.value[selectedIndex.value] ?? null
  }
  return null
})

// Active plan conf
const activePlanConf = computed<Record<string, unknown>>(() => {
  return activePlan.value?.conf ?? {}
})

// Synchronize current expression text when active plan changes
watch(
  () => activePlan.value,
  (plan) => {
    if (plan) {
      currentExpressionText.value = serializeBackupTrigger(plan.trigger)
    } else {
      currentExpressionText.value = ''
    }
  },
  { immediate: true },
)

// Validation info for current condition
const validationInfo = computed(() => {
  if (!currentExpressionText.value.trim()) {
    return { valid: false, error: '条件不能为空', participants: [] }
  }
  return validateBackupTrigger(currentExpressionText.value)
})

function hasTasks(plan: MowerBackupPlan): boolean {
  return !!plan.task && Object.keys(plan.task).length > 0
}

function hasConfOverrides(plan: MowerBackupPlan): boolean {
  if (!plan.conf) return false
  return Object.values(plan.conf).some((v) => {
    if (Array.isArray(v)) return v.length > 0
    if (typeof v === 'string') return v.trim().length > 0
    return false
  })
}

function hasPlanOverrides(plan: MowerBackupPlan): boolean {
  return !!plan.plan && Object.keys(plan.plan).length > 0
}

// Plan CRUD Handlers
function handleCreatePlan(): void {
  const newIndex = store.addBackupPlan(createDefaultBackupPlan(backupPlans.value.length + 1))
  selectedIndex.value = newIndex
}

function handleDuplicatePlan(index: number): void {
  const newIndex = store.duplicateBackupPlan(index)
  if (newIndex >= 0) {
    selectedIndex.value = newIndex
  }
}

function handleDeletePlan(index: number): void {
  store.removeBackupPlan(index)
  if (selectedIndex.value >= backupPlans.value.length) {
    selectedIndex.value = Math.max(0, backupPlans.value.length - 1)
  }
}

function handleMovePlan(fromIndex: number, toIndex: number): void {
  store.moveBackupPlan(fromIndex, toIndex)
  selectedIndex.value = toIndex
}

function handleClearPlans(): void {
  store.clearBackupPlans()
  selectedIndex.value = 0
}

function getRemovedOperators(key: string): string {
  const removed = activePlan.value?.conf?.removed_operators as Record<string, unknown> | undefined
  const value = removed?.[key]
  return Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : ''
}
function setRemovedOperators(key: string, value: string): void {
  if (!activePlan.value) return
  const conf = activePlan.value.conf ??= {}
  conf.removed_operators = { ...(conf.removed_operators as Record<string, unknown> ?? {}), [key]: value }
  saveCurrentPlan()
}
function saveCurrentPlan(): void {
  if (selectedIndex.value >= 0 && activePlan.value) {
    delete activePlan.value.trigger_timing
    store.updateBackupPlan(selectedIndex.value, activePlan.value)
  }
}

// Condition Editing
function onExpressionTextChange(val: string): void {
  currentExpressionText.value = val
  if (activePlan.value) {
    activePlan.value.trigger = val.trim()
    saveCurrentPlan()
  }
}

function setExpression(expr: string): void {
  onExpressionTextChange(expr)
}

function insertSnippet(snippet: string): void {
  const cur = currentExpressionText.value.trim()
  if (!cur || cur === 'True' || cur === 'False') {
    onExpressionTextChange(snippet.trim())
  } else {
    onExpressionTextChange(`${cur} ${snippet.trim()}`)
  }
}

function appendBuiltCondition(): void {
  const op = builderState.value.operator
  if (!op) return

  let clause = ''
  if (builderState.value.property === 'is_working()') {
    clause = `op_data.operators['${op}'].is_working()`
  } else if (builderState.value.property === 'is_resting()') {
    clause = `op_data.operators['${op}'].is_resting()`
  } else if (builderState.value.property === 'current_mood()') {
    clause = `op_data.operators['${op}'].current_mood() ${builderState.value.comparator} ${builderState.value.targetValue || '12'}`
  } else if (builderState.value.property === 'current_room') {
    clause = `op_data.operators['${op}'].current_room ${builderState.value.comparator} '${builderState.value.targetValue || 'dormitory_1'}'`
  }

  insertSnippet(clause)
}

// Task Facilities Handling
const taskRooms = computed<string[]>(() => {
  if (!activePlan.value?.task) return []
  return Object.keys(activePlan.value.task)
})

const availableFacilityOptions = computed<SelectOption[]>(() => {
  const configured = new Set(taskRooms.value)
  return MOWER_ROOM_IDS.filter((id) => !id.startsWith('gaming') && !configured.has(id)).map((id) => ({
    label: `${getFacilityRoomDisplayName(id)} (${id})`,
    value: id,
  }))
})

function handleAddFacilityTask(): void {
  const roomId = selectedFacilityToAdd.value
  if (!roomId || !activePlan.value) return
  activePlan.value.task ??= {}
  const maxSlots = getFacilityMaxSlots(roomId)
  activePlan.value.task[roomId] = Array(maxSlots).fill('Current')
  selectedFacilityToAdd.value = null
  saveCurrentPlan()
}

function handleRemoveFacilityTask(roomId: string): void {
  if (!activePlan.value?.task) return
  delete activePlan.value.task[roomId]
  saveCurrentPlan()
}

function resetTaskFacilityToCurrent(roomId: string): void {
  if (!activePlan.value?.task?.[roomId]) return
  activePlan.value.task[roomId] = activePlan.value.task[roomId]!.map(() => 'Current')
  saveCurrentPlan()
}

function getSlotCountForRoom(roomId: string): number {
  return activePlan.value?.task?.[roomId]?.length || getFacilityMaxSlots(roomId)
}

function getTaskSlotValue(roomId: string, slotIdx: number): string {
  return activePlan.value?.task?.[roomId]?.[slotIdx] || 'Current'
}

function setTaskSlotValue(roomId: string, slotIdx: number, val: string): void {
  if (!activePlan.value?.task?.[roomId]) return
  activePlan.value.task[roomId]![slotIdx] = val
  saveCurrentPlan()
}

function getSlotCandidateOptions(roomId: string): SelectOption[] {
  const isDorm = isDormitoryRoom(roomId)
  const specialOptions: SelectOption[] = [
    { label: '保持当前 (Current)', value: 'Current' },
  ]
  if (isDorm) {
    specialOptions.push({ label: '空置床位 (Free)', value: 'Free' })
  }
  return [...specialOptions, ...baseOperatorOptions]
}

// Conf Overrides Handling
function updateConfValue(key: string, val: unknown): void {
  if (!activePlan.value) return
  activePlan.value.conf ??= {}
  activePlan.value.conf[key] = val
  saveCurrentPlan()
}

function getConfOperatorList(key: string): string[] {
  const val = activePlanConf.value[key]
  if (Array.isArray(val)) {
    return val.map((id) => getOperatorName(String(id)))
  }
  if (typeof val === 'string') {
    return parseConfStringToOperatorNames(val)
  }
  return []
}

function addConfOperator(key: string, opName: string): void {
  if (!opName || !activePlan.value) return
  const curList = getConfOperatorList(key)
  if (!curList.includes(opName)) {
    curList.push(opName)
    updateConfValue(key, curList.join(','))
  }
}

function removeConfOperator(key: string, index: number): void {
  if (!activePlan.value) return
  const curList = getConfOperatorList(key)
  curList.splice(index, 1)
  updateConfValue(key, curList.join(','))
}

function removePlanOverride(roomId: string): void {
  if (!activePlan.value?.plan) return
  delete activePlan.value.plan[roomId]
  saveCurrentPlan()
}

// Custom option rendering with avatar
function filterOperator(pattern: string, option: SelectOption): boolean {
  if (!pattern) return true
  const q = pattern.trim().toLowerCase()
  const label = String(option.label || '').toLowerCase()
  const value = String(option.value || '').toLowerCase()
  if (label.includes(q) || value.includes(q)) return true
  const pMatch = match(String(option.label || ''), q, { v: true }) ?? match(String(option.label || ''), q)
  return pMatch !== null && pMatch.length > 0
}

function renderOptionLabel(option: SelectOption): VNode {
  const val = String(option.value || '')
  if (val === 'Current' || val === 'Free') {
    return h('div', { class: 'option-item-row' }, [
      h('span', { class: 'option-badge-text' }, val === 'Current' ? '⚡' : '🛏️'),
      h('span', null, String(option.label || '')),
    ])
  }
  return h('div', { class: 'option-item-row' }, [
    h(NAvatar, {
      src: getOperatorAvatarUrl(val),
      round: true,
      size: 22,
      fallbackSrc: getOperatorAvatarUrl('Free'),
      style: { flexShrink: 0 },
    }),
    h('span', null, String(option.label || '')),
  ])
}

defineExpose({
  selectedIndex,
  searchQuery,
  backupPlans,
  activePlan,
  activeDetailTab,
  conditionEditMode,
  currentExpressionText,
  validationInfo,
  handleCreatePlan,
  handleDeletePlan,
  handleDuplicatePlan,
  handleMovePlan,
  handleClearPlans,
  handleAddFacilityTask,
  handleRemoveFacilityTask,
  addConfOperator,
  removeConfOperator,
  getConfOperatorList,
})
</script>

<style scoped>
.backup-plan-editor {
  width: 100%;
  padding: 16px 20px;
  background: var(--bg-color, #12161a);
  color: #e0e6ed;
  box-sizing: border-box;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 14px;
  margin-bottom: 14px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.editor-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #f1f5f9;
}

.mower-badge {
  background: rgba(44, 181, 160, 0.15);
  color: #2cb5a0;
  border: 1px solid rgba(44, 181, 160, 0.3);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
}

.editor-subtitle {
  margin: 4px 0 0 0;
  font-size: 0.85rem;
  color: #94a3b8;
}

.header-actions {
  display: flex;
  gap: 10px;
}

/* Stats Bar */
.stats-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.stat-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 0.8rem;
}

.stat-label {
  color: #94a3b8;
}

.stat-value {
  font-weight: 700;
}

.text-accent {
  color: #2cb5a0;
}

/* Editor Body */
.editor-body {
  display: flex;
  gap: 16px;
  min-height: 580px;
}

/* Left Pane: Plans List */
.plans-list-panel {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: rgba(20, 26, 33, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px;
  box-sizing: border-box;
}

.search-box {
  margin-bottom: 10px;
}

.plans-scroll-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 640px;
  padding-right: 4px;
}

.empty-list-notice {
  text-align: center;
  color: #64748b;
  font-size: 0.85rem;
  padding: 30px 10px;
}

.plan-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 6px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.plan-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(44, 181, 160, 0.3);
}

.plan-card.active {
  background: rgba(44, 181, 160, 0.08);
  border-color: #2cb5a0;
  box-shadow: inset 3px 0 0 #2cb5a0;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.plan-index {
  font-family: monospace;
  font-size: 0.75rem;
  color: #64748b;
}

.plan-title {
  font-weight: 600;
  font-size: 0.9rem;
  color: #f1f5f9;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timing-badge {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}

.timing-before_planning {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.timing-after_planning {
  background: rgba(192, 132, 252, 0.15);
  color: #c084fc;
  border: 1px solid rgba(192, 132, 252, 0.3);
}

.timing-beginning {
  background: rgba(52, 211, 153, 0.15);
  color: #34d399;
  border: 1px solid rgba(52, 211, 153, 0.3);
}

.timing-end {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.3);
}

.condition-preview {
  margin: 4px 0 8px 0;
  font-size: 0.78rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.meta-tag {
  font-size: 0.7rem;
  padding: 1px 5px;
  border-radius: 3px;
}

.meta-group { background: rgba(44, 181, 160, .1); color: #7dd3c5; }
.membership-fields { margin-top: 12px; flex-wrap: wrap; }
.membership-fields .field-col { min-width: 180px; }
.membership-help { margin: 10px 0 0; color: #94a3b8; font-size: .78rem; line-height: 1.6; }

.meta-task {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.meta-conf {
  background: rgba(99, 102, 241, 0.12);
  color: #818cf8;
}

.meta-override {
  background: rgba(236, 72, 153, 0.12);
  color: #f472b6;
}

.card-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
}

.action-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #94a3b8;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-btn-del:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
}

/* Right Pane: Detail Editor */
.plan-detail-panel {
  flex: 1;
  background: rgba(20, 26, 33, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 16px;
  box-sizing: border-box;
}

.detail-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  color: #64748b;
  text-align: center;
}

.placeholder-icon {
  font-size: 3rem;
  margin-bottom: 12px;
  opacity: 0.5;
}

.detail-header-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 12px 14px;
  margin-bottom: 16px;
}

.field-row {
  display: flex;
  gap: 16px;
}

.field-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.flex-1 { flex: 1; }
.flex-2 { flex: 2; }

.form-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #cbd5e1;
}

.detail-tabs {
  margin-top: 10px;
}

.tab-content {
  padding-top: 12px;
}

/* Tab 1: Condition */
.condition-mode-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.mode-label {
  font-size: 0.8rem;
  color: #94a3b8;
}

.visual-builder-box {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 14px;
  margin-bottom: 16px;
}

.builder-helper-text {
  font-size: 0.8rem;
  color: #94a3b8;
  margin-bottom: 10px;
}

.builder-form-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.builder-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sub-label {
  font-size: 0.78rem;
  color: #94a3b8;
}

.snippet-buttons-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.snippet-label {
  font-size: 0.75rem;
  color: #64748b;
}

.expression-editor-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.expression-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-indicator {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 4px;
}

.status-valid {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.status-invalid {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.code-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
}

.humanized-box {
  display: flex;
  align-items: baseline;
  gap: 10px;
  background: rgba(44, 181, 160, 0.05);
  border: 1px dashed rgba(44, 181, 160, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
  margin-top: 6px;
}

.humanized-tag {
  font-size: 0.7rem;
  font-weight: 600;
  color: #2cb5a0;
  text-transform: uppercase;
}

.humanized-text {
  font-size: 0.82rem;
  color: #cbd5e1;
}

.participants-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.participants-label {
  font-size: 0.78rem;
  color: #94a3b8;
}

.operator-mini-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.75rem;
  color: #e2e8f0;
}

.mini-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
}

/* Tab 2: Task */
.task-info-banner,
.conf-info-banner,
.plan-info-banner {
  background: rgba(255, 255, 255, 0.02);
  border-left: 3px solid #2cb5a0;
  padding: 8px 12px;
  margin-bottom: 14px;
  font-size: 0.8rem;
  color: #94a3b8;
}

.task-info-banner code {
  color: #2cb5a0;
}

.add-task-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.facility-select {
  width: 280px;
}

.task-facilities-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-facility-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 12px;
}

.task-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.room-name {
  font-weight: 600;
  color: #f1f5f9;
  font-size: 0.9rem;
}

.room-id {
  font-size: 0.75rem;
  color: #64748b;
  margin-left: 6px;
}

.task-card-actions {
  display: flex;
  gap: 8px;
}

.task-slots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.task-slot-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(0, 0, 0, 0.2);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.slot-number {
  font-size: 0.72rem;
  color: #64748b;
}

/* Tab 3: Conf */
.conf-field-group {
  margin-bottom: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.field-title-box {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
}

.field-name {
  font-weight: 600;
  font-size: 0.85rem;
  color: #e2e8f0;
}

.field-desc {
  font-size: 0.75rem;
  color: #64748b;
}

.conf-chips-container {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.policy-operator-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.8rem;
}

.tag-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.tag-name {
  color: #f1f5f9;
}

.tag-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 0 2px;
  font-size: 0.85rem;
}

.tag-close-btn:hover {
  color: #ef4444;
}

.add-operator-chip-box {
  width: 160px;
}

/* Tab 4: Plan */
.plan-overrides-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plan-slots-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.plan-slot-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.78rem;
}

.slot-idx {
  color: #64748b;
  font-family: monospace;
}

.agent-name {
  font-weight: 500;
  color: #f1f5f9;
}

.group-tag,
.rep-tag {
  font-size: 0.7rem;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.05);
  padding: 1px 4px;
  border-radius: 2px;
}

.option-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.option-badge-text {
  font-size: 0.9rem;
}

.empty-tasks-placeholder {
  text-align: center;
  color: #64748b;
  font-size: 0.85rem;
  padding: 30px 10px;
  background: rgba(255, 255, 255, 0.01);
  border: 1px dashed rgba(255, 255, 255, 0.06);
  border-radius: 6px;
}
</style>
