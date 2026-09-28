/**
 * @vitest-environment jsdom
 *
 * Derivative work based on arknights-mower (Plan.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PolicyEditor from './PolicyEditor.vue'
import { POLICY_LIST_FIELDS } from './policyFields'
import { useRosterWorkbenchStore } from '../../workbench/store'

function asVueWrapper<T = Record<string, unknown>>(wrapper: unknown): VueWrapper<T> {
  return wrapper as VueWrapper<T>
}

describe('PolicyEditor.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('exposes exactly ling_xi and the seven main-plan operator lists, and no forbidden fields', () => {
    const wrapper = mount(PolicyEditor)

    // Verify ling_xi is exposed
    expect(wrapper.find('[data-field="ling_xi"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('令夕模式')
    expect(wrapper.text()).toContain('感知信息')
    expect(wrapper.text()).toContain('人间烟火')
    expect(wrapper.text()).toContain('均衡模式')

    // Verify the exactly seven operator lists defined in model
    const expectedKeys = [
      'rest_in_full',
      'exhaust_require',
      'workaholic',
      'resting_priority',
      'refresh_trading',
      'refresh_drained',
      'ope_resting_priority',
    ]

    expect(POLICY_LIST_FIELDS.map((f) => f.key)).toEqual(expectedKeys)

    for (const key of expectedKeys) {
      expect(wrapper.find(`[data-field="${key}"]`).exists()).toBe(true)
      expect(wrapper.find(`[data-test="list-editor-${key}"]`).exists()).toBe(true)
      expect(wrapper.find(`[data-test="add-select-${key}"]`).exists()).toBe(true)
    }

    // Verify Mower wording
    expect(wrapper.text()).toContain('需要回满心情的干员')
    expect(wrapper.text()).toContain('需要用尽心情的干员')
    expect(wrapper.text()).toContain('0心情工作的干员')
    expect(wrapper.text()).toContain('宿舍低优先级干员')
    expect(wrapper.text()).toContain('跑单时间刷新干员')
    expect(wrapper.text()).toContain('用尽刷新')
    expect(wrapper.text()).toContain('干员休息优先级')

    // Verify forbidden fields are NOT exposed
    expect(wrapper.find('[data-field="free_blacklist"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="subplans"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="backup_plans"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="triggers"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="tasks"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="list-editor-free_blacklist"]').exists()).toBe(false)
  })

  it('toggles ling_xi mode (1, 2, 3) through Pinia store', async () => {
    const store = useRosterWorkbenchStore()
    const wrapper = mount(PolicyEditor)

    expect(store.workspace.mainPlan.conf.ling_xi).toBe(1)

    // Native select setValue for direct test interaction
    const select = wrapper.find('[data-test="ling-xi-select"]')
    await select.setValue('2')
    expect(store.workspace.mainPlan.conf.ling_xi).toBe(2)

    await select.setValue('3')
    expect(store.workspace.mainPlan.conf.ling_xi).toBe(3)

    // Radio group update
    const radioGroup = asVueWrapper(wrapper.findComponent('[data-test="ling-xi-radio-group"]'))
    radioGroup.vm.$emit('update:value', 1)
    await wrapper.vm.$nextTick()
    expect(store.workspace.mainPlan.conf.ling_xi).toBe(1)
  })

  it('supports adding operators to a list via store updateConf and prevents duplicates', async () => {
    const store = useRosterWorkbenchStore()
    const wrapper = mount(PolicyEditor)

    expect(store.workspace.mainPlan.conf.exhaust_require).toEqual([])

    // Select and add operator via n-select
    const addSelect = asVueWrapper(wrapper.findComponent('[data-test="add-select-exhaust_require"]'))
    addSelect.vm.$emit('update:value', 'char_002_amiya')
    await wrapper.vm.$nextTick()

    expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_002_amiya'])

    // Add another operator
    addSelect.vm.$emit('update:value', 'char_102_texas')
    await wrapper.vm.$nextTick()

    expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_002_amiya', 'char_102_texas'])

    // Adding existing operator again does not duplicate
    addSelect.vm.$emit('update:value', 'char_002_amiya')
    await wrapper.vm.$nextTick()

    expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_002_amiya', 'char_102_texas'])
  })

  it('supports removing operators from a list via remove button', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.mainPlan.conf.rest_in_full = ['char_002_amiya', 'char_102_texas', 'char_103_angel']

    const wrapper = mount(PolicyEditor)
    await wrapper.vm.$nextTick()

    const tags = wrapper.findAll('[data-test^="tag-rest_in_full-"]')
    expect(tags.length).toBe(3)

    // Remove middle operator ('char_102_texas' at index 1)
    const removeBtn = wrapper.find('[data-test="remove-rest_in_full-1"]')
    expect(removeBtn.exists()).toBe(true)
    await removeBtn.trigger('click')

    expect(store.workspace.mainPlan.conf.rest_in_full).toEqual(['char_002_amiya', 'char_103_angel'])
  })

  it('supports reordering operators via move buttons and drag-and-drop', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.mainPlan.conf.workaholic = ['char_002_amiya', 'char_102_texas', 'char_103_angel']

    const wrapper = mount(PolicyEditor)
    await wrapper.vm.$nextTick()

    // 1. Test move-down button: move index 0 ('char_002_amiya') down to index 1
    const moveDownBtn = wrapper.find('[data-test="move-down-workaholic-0"]')
    expect(moveDownBtn.exists()).toBe(true)
    await moveDownBtn.trigger('click')

    expect(store.workspace.mainPlan.conf.workaholic).toEqual([
      'char_102_texas',
      'char_002_amiya',
      'char_103_angel',
    ])

    // 2. Test drag and drop: drag item 2 ('char_103_angel') and drop on item 0
    await wrapper.vm.$nextTick()
    const item0 = wrapper.find('[data-test="tag-workaholic-0"]')
    const item2 = wrapper.find('[data-test="tag-workaholic-2"]')

    let payloadString = ''
    const dataTransfer = {
      setData: (_fmt: string, val: string) => {
        payloadString = val
      },
      getData: () => payloadString,
    }

    await item2.trigger('dragstart', { dataTransfer })
    await item0.trigger('drop', { dataTransfer })

    expect(store.workspace.mainPlan.conf.workaholic).toEqual([
      'char_103_angel',
      'char_102_texas',
      'char_002_amiya',
    ])
  })

  it('preserves unknown conf metadata, envelope, and non-edited lists across edits', async () => {
    const store = useRosterWorkbenchStore()

    // Set custom metadata and fields
    const customMetadata = { customEngineSetting: 'keep-safe', nestedFlag: true }
    store.workspace.mainPlan.conf.customMetadata = customMetadata
    store.workspace.mainPlan.conf.free_blacklist = ['char_hidden_1', 'char_hidden_2']
    store.workspace.mainPlan.conf.refresh_trading = ['char_4087_ines']
    store.workspace.compatibility.unrecognizedFields = { extraEnvelopeKey: 'lossless' }
    store.workspace.compatibility.backupPlans = [{ name: 'sub1', conf: {} }]

    const wrapper = mount(PolicyEditor)

    // Edit exhaust_require
    const addSelect = asVueWrapper(wrapper.findComponent('[data-test="add-select-exhaust_require"]'))
    addSelect.vm.$emit('update:value', 'char_002_amiya')
    await wrapper.vm.$nextTick()

    // Edit ling_xi
    const select = wrapper.find('[data-test="ling-xi-select"]')
    await select.setValue('3')

    // Assert edited fields updated
    expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_002_amiya'])
    expect(store.workspace.mainPlan.conf.ling_xi).toBe(3)

    // Assert non-edited lists and custom metadata are strictly preserved
    expect(store.workspace.mainPlan.conf.customMetadata).toEqual(customMetadata)
    expect(store.workspace.mainPlan.conf.free_blacklist).toEqual(['char_hidden_1', 'char_hidden_2'])
    expect(store.workspace.mainPlan.conf.refresh_trading).toEqual(['char_4087_ines'])
    expect(store.workspace.compatibility.unrecognizedFields).toEqual({ extraEnvelopeKey: 'lossless' })
    expect(store.workspace.compatibility.backupPlans).toEqual([{ name: 'sub1', conf: {} }])
  })
})


it('shows imported native balanced mode 0 without rewriting the stored policy',()=>{
 setActivePinia(createPinia())
 const store=useRosterWorkbenchStore()
 store.workspace.mainPlan.conf.ling_xi=0
 const wrapper=mount(PolicyEditor)
 expect((wrapper.find('[data-test="ling-xi-select"]').element as HTMLSelectElement).value).toBe('3')
 expect(store.workspace.mainPlan.conf.ling_xi).toBe(0)
 wrapper.unmount()
})
