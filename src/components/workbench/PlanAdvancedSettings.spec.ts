/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NInputNumber, NCheckbox, NSelect } from 'naive-ui'
import PlanAdvancedSettings from './PlanAdvancedSettings.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { exportMowerJson, importMowerJson } from '../../workbench/compat/mowerJson'

beforeEach(() => setActivePinia(createPinia()))
describe('Mower alpha advanced settings', () => {
  it('displays upstream defaults without adding settings on mount', () => {
    const store = useRosterWorkbenchStore()
    const before = exportMowerJson(store.workspace)
    const wrapper = mount(PlanAdvancedSettings)
    expect(wrapper.find('[data-field="resting_threshold"]').findComponent(NInputNumber).props('value')).toBe(65)
    expect(wrapper.find('[data-field="drone_count_limit"]').findComponent(NInputNumber).props('value')).toBe(100)
    expect(exportMowerJson(store.workspace)).toBe(before)
    expect(wrapper.find('[data-field="fia_fool"]').text()).toContain('菲亚防呆')
    expect(wrapper.find('[data-field="assistant_follows_schedule"]').text()).toContain('训练室协助位总是跟随排班')
  })
  it('edits fractions and nested switches losslessly', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.unrecognizedFields.advanced_settings = { future: { a: 1 }, product_switching: { enable: true, future_flag: 9 } }
    const wrapper = mount(PlanAdvancedSettings)
    wrapper.find('[data-field="resting_threshold"]').findComponent(NInputNumber).vm.$emit('update:value', 70)
    wrapper.find('[data-field="max_drones_per_switch"]').findComponent(NInputNumber).vm.$emit('update:value', 90)
    await wrapper.vm.$nextTick()
    const advanced = JSON.parse(exportMowerJson(store.workspace)).advanced_settings
    expect(advanced).toEqual({ future: { a: 1 }, resting_threshold: .7, product_switching: { enable: true, future_flag: 9, max_drones_per_switch: 90 } })
  })
  it('uses native operator names and marks unsupported local simulation fields', async () => {
    const store = useRosterWorkbenchStore()
    const wrapper = mount(PlanAdvancedSettings)
    wrapper.find('[data-field="favorite"]').findComponent(NSelect).vm.$emit('update:value', ['阿米娅', '能天使'])
    wrapper.find('[data-field="group_rest_in_full_on_mood_gap"]').findComponent(NCheckbox).vm.$emit('update:checked', false)
    await wrapper.vm.$nextTick()
    expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toMatchObject({ favorite: '阿米娅,能天使', group_rest_in_full_on_mood_gap: false })
    expect(wrapper.find('[data-field="group_mood_gap_threshold_minutes"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="version_update_resting_threshold"]').text()).toContain('本地模拟暂未使用')
  })
  it('edits the wait cap and exact group exclusions from main, backup, shared and saved groups', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: 'char_123_fang' }, groupId: 'main', replacements: [], groupBindings: [{ groupId: 'shared', replacements: [] }] }]
    store.workspace.compatibility.backupPlans = [{ plan: { room_1_1: { plans: [{ agent: '芬', group: 'backup', group_bindings: [{ group: 'backup-shared', replacement: [] }] }] } } }]
    store.workspace.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_exclusions: ['saved'], future: 9 }
    const wrapper = mount(PlanAdvancedSettings)
    const selector = wrapper.find('[data-field="group_mood_gap_exclusions"]').findComponent(NSelect)
    expect(selector.props('options')?.map(option => option.value)).toEqual(['saved', 'main', 'shared', 'backup', 'backup-shared'])
    selector.vm.$emit('update:value', ['main', 'typed group', 'main'])
    wrapper.find('[data-field="group_mood_gap_max_extra_wait_hours"]').findComponent(NInputNumber).vm.$emit('update:value', 1.5)
    await wrapper.vm.$nextTick()
    const imported = importMowerJson(exportMowerJson(store.workspace))
    expect(imported.compatibility.unrecognizedFields.advanced_settings).toMatchObject({ group_mood_gap_exclusions: ['main', 'typed group'], group_mood_gap_max_extra_wait_hours: 1.5, future: 9 })
  })
  it('rejects invalid numeric writes and supports isolation groups without altering unrelated settings', async () => {
    const store = useRosterWorkbenchStore()
    const wrapper = mount(PlanAdvancedSettings)
    wrapper.find('[data-field="drone_count_limit"]').findComponent(NInputNumber).vm.$emit('update:value', -1)
    expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toBeUndefined()
    await wrapper.find('[data-test="add-isolation"]').trigger('click')
    wrapper.find('[data-test="isolation-0"]').findComponent(NSelect).vm.$emit('update:value', ['阿米娅', 'Free', '阿米娅', '能天使'])
    expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toEqual({ dorm_isolation: [['阿米娅', '能天使']] })
  })
})
