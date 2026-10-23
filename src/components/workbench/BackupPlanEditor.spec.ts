/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NSelect } from 'naive-ui'
import BackupPlanEditor from './BackupPlanEditor.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'

describe('BackupPlanEditor.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders empty list placeholder when no backup plans exist', () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = []
    const wrapper = mount(BackupPlanEditor)

    expect(wrapper.text()).toContain('副表调度管理')
    expect(wrapper.text()).toContain('暂无副表配置')
    expect(wrapper.find('[data-test="add-backup-plan-btn"]').exists()).toBe(true)
  })

  it('renders existing backup plans list and displays badges and humanized condition', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      {
        name: '莱茵强制休息',
        trigger_timing: 'BEFORE_PLANNING',
        trigger: {
          left: "op_data.operators['薇薇安娜'].is_resting()",
          operator: 'and',
          right: "op_data.operators['阿罗玛'].is_working()",
        },
        task: {
          dormitory_2: ['Current', 'Current', 'Current', 'Current', '夕'],
        },
        conf: { ling_xi: 1 },
      },
      {
        name: '远牙动态低优',
        trigger_timing: 'END',
        trigger: "op_data.operators['远牙'].current_mood() > 12",
        task: {},
        conf: { ling_xi: 1 },
      },
    ]

    const wrapper = mount(BackupPlanEditor)

    expect(wrapper.find('[data-test="backup-plan-card-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="backup-plan-card-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('莱茵强制休息')
    expect(wrapper.text()).toContain('远牙动态低优')
    expect(wrapper.text()).toContain('薇薇安娜休息中')
    expect(wrapper.find('[data-test="plan-timing-select"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('按条件收敛应用副表')
  })

  it('supports adding a new backup plan', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = []
    const wrapper = mount(BackupPlanEditor)

    await wrapper.find('[data-test="add-backup-plan-btn"]').trigger('click')

    expect(store.workspace.compatibility.backupPlans).toHaveLength(1)
    expect(wrapper.find('[data-test="backup-plan-card-0"]').exists()).toBe(true)
  })

  it('supports moving a backup plan up and down', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      { name: 'Plan A', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
      { name: 'Plan B', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
    ]
    const wrapper = mount(BackupPlanEditor)

    // Move down Plan A (index 0)
    await wrapper.find('[data-test="move-down-plan-0"]').trigger('click')

    const plans = store.workspace.compatibility.backupPlans as Array<{ name: string }>
    expect(plans[0]?.name).toBe('Plan B')
    expect(plans[1]?.name).toBe('Plan A')

    // Move up Plan A (now index 1)
    await wrapper.find('[data-test="move-up-plan-1"]').trigger('click')
    expect(plans[0]?.name).toBe('Plan A')
  })

  it('supports duplicating a backup plan', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      { name: 'Plan A', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
    ]
    const wrapper = mount(BackupPlanEditor)

    await wrapper.find('[data-test="dup-plan-0"]').trigger('click')

    const plans = store.workspace.compatibility.backupPlans as Array<{ name: string }>
    expect(plans).toHaveLength(2)
    expect(plans[1]?.name).toBe('Plan A (副本)')
  })

  it('supports deleting a backup plan', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      { name: 'Plan A', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
      { name: 'Plan B', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
    ]
    const wrapper = mount(BackupPlanEditor)

    await wrapper.find('[data-test="del-plan-0"]').trigger('click')

    const plans = store.workspace.compatibility.backupPlans as Array<{ name: string }>
    expect(plans).toHaveLength(1)
    expect(plans[0]?.name).toBe('Plan B')
  })

  it('filters backup plans by search query', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      { name: '莱茵强制休息', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
      { name: '感知下班', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
    ]
    const wrapper = mount(BackupPlanEditor)

    const searchInput = wrapper.find('[data-test="backup-plan-search"] input')
    await searchInput.setValue('感知')

    expect(wrapper.text()).toContain('感知下班')
    expect(wrapper.text()).not.toContain('莱茵强制休息')
  })

  it('shows live condition syntax validation and humanized preview', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      {
        name: '测试副表',
        trigger_timing: 'BEFORE_PLANNING',
        trigger: "op_data.operators['令'].is_resting() == True",
      },
    ]
    const wrapper = mount(BackupPlanEditor)

    // Check valid status
    const status = wrapper.find('[data-test="trigger-validation-status"]')
    expect(status.text()).toContain('语法有效')

    const preview = wrapper.find('[data-test="trigger-humanized-preview"]')
    expect(preview.text()).toContain('令')

    // Change to invalid expression
    const input = wrapper.find('[data-test="trigger-expression-input"] textarea')
    await input.setValue("op_data.operators['令'].is_resting( == True")

    expect(wrapper.find('[data-test="trigger-validation-status"]').text()).toContain('语法错误')
  })

  it('allows adding and configuring facility task', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      {
        name: '测试副表',
        trigger_timing: 'BEFORE_PLANNING',
        trigger: 'True',
        task: {},
      },
    ]
    const wrapper = mount(BackupPlanEditor)

    // Switch to task tab
    const exposed = wrapper.vm as unknown as { activeDetailTab: string; handleAddFacilityTask: () => void; selectedFacilityToAdd: string }
    exposed.activeDetailTab = 'task'
    exposed.selectedFacilityToAdd = 'dormitory_3'
    exposed.handleAddFacilityTask()
    await wrapper.vm.$nextTick()

    const plan = store.workspace.compatibility.backupPlans[0] as { task: Record<string, string[]> }
    expect(plan.task.dormitory_3).toBeDefined()
    expect(plan.task.dormitory_3).toHaveLength(5)
    expect(plan.task.dormitory_3?.[0]).toBe('Current')
  })

  it('supports conf policy overrides management', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.backupPlans = [
      {
        name: '测试副表',
        trigger_timing: 'BEFORE_PLANNING',
        trigger: 'True',
        conf: {
          ling_xi: 1,
          exhaust_require: '令,夕',
        },
      },
    ]
    const wrapper = mount(BackupPlanEditor)

    const exposed = wrapper.vm as unknown as {
      activeDetailTab: string
      addConfOperator: (key: string, op: string) => void
      removeConfOperator: (key: string, idx: number) => void
      getConfOperatorList: (key: string) => string[]
    }
    exposed.activeDetailTab = 'conf'

    expect(exposed.getConfOperatorList('exhaust_require')).toContain('令')
    expect(exposed.getConfOperatorList('exhaust_require')).toContain('夕')

    exposed.addConfOperator('exhaust_require', '薇薇安娜')
    expect(exposed.getConfOperatorList('exhaust_require')).toContain('薇薇安娜')

    exposed.removeConfOperator('exhaust_require', 0)
    expect(exposed.getConfOperatorList('exhaust_require')).not.toContain('令')
  })

  it('edits multiple group memberships and exclusive type without rewriting AST or extensions', async () => {
    const store = useRosterWorkbenchStore()
    const ast = { left: 'True', operator: 'and', right: 'False' }
    store.workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'rest', name: '恢复组', trigger: ast, extra: 3 }]
    store.workspace.compatibility.backupPlans = [{ name: '旧副表', trigger: ast, extension: { keep: [1] } }]
    const before = JSON.stringify(store.workspace)
    const wrapper = mount(BackupPlanEditor)
    expect(JSON.stringify(store.workspace)).toBe(before)
    const groupSelect = wrapper.findAllComponents(NSelect).find(select => select.attributes('data-test') === 'plan-group-select')!
    const typeSelect = wrapper.findAllComponents(NSelect).find(select => select.attributes('data-test') === 'plan-type-select')!
    groupSelect.vm.$emit('update:value', ['default', 'rest'])
    await wrapper.vm.$nextTick()
    typeSelect.vm.$emit('update:value', 'exclusive')
    await wrapper.vm.$nextTick()
    expect(store.workspace.compatibility.backupPlans[0]).toEqual({ name: '旧副表', trigger: ast, extension: { keep: [1] }, group_ids: ['default', 'rest'], type: 'exclusive' })
    expect(store.workspace.compatibility.unrecognizedFields.backup_groups).toEqual([{ id: 'rest', name: '恢复组', trigger: ast, extra: 3 }])
    groupSelect.vm.$emit('update:value', [])
    await wrapper.vm.$nextTick()
    expect((store.workspace.compatibility.backupPlans[0] as { group_ids: string[] }).group_ids).toEqual(['default'])
    wrapper.unmount()
  })
})
