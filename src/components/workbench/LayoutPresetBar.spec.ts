/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, onMounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import LayoutPresetBar from './LayoutPresetBar.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { LAYOUT_PRESETS_STORAGE_KEY, captureFacilityLayout, readLayoutPresets } from '../../workbench/layoutPresets'
import { createDefaultWorkspace } from '../../workbench/defaults'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

it('saves a named facility layout, restores it immediately, and keeps current staffing and policy', async () => {
  const store = useRosterWorkbenchStore()
  store.workspace.name = '正在编辑的排班'
  store.workspace.mainPlan.conf.ling_xi = 3
  store.updateFacility('room_1_1', { product: 'exp' })
  const wrapper = mount(LayoutPresetBar)

  await wrapper.find('[data-test="layout-preset-save"]').trigger('click')
  await wrapper.find('[data-test="layout-preset-name"]').setValue('252 作战记录')
  await wrapper.find('[data-test="layout-preset-name-row"]').trigger('submit')
  expect(JSON.parse(localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY) ?? '[]')[0].name).toBe('252 作战记录')
  const presetId = JSON.parse(localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY) ?? '[]')[0].id
  wrapper.unmount()

  store.updateFacility('room_1_1', { product: 'gold' })
  store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
  const reopened = mount(LayoutPresetBar)
  await reopened.vm.$nextTick()
  expect(reopened.findAll('[data-test="layout-preset-select"] option')).toHaveLength(2)
  await reopened.find('[data-test="layout-preset-select"]').setValue(presetId)
  expect(store.workspace.mainPlan.facilities.room_1_1.product).toBe('exp')
  expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]?.occupant).toEqual({ kind: 'operator', operatorId: 'char_002_amiya' })
  expect(store.workspace.name).toBe('正在编辑的排班')
  expect(store.workspace.mainPlan.conf.ling_xi).toBe(3)
  expect(reopened.emitted('applied')).toHaveLength(1)

  expect(readLayoutPresets(localStorage)).toHaveLength(1)
  reopened.unmount()
})

it('removes only the selected preset and leaves the applied layout intact', async () => {
  const store = useRosterWorkbenchStore()
  store.updateFacility('room_1_1', { product: 'exp' })
  const wrapper = mount(LayoutPresetBar)
  await wrapper.find('[data-test="layout-preset-save"]').trigger('click')
  await wrapper.find('[data-test="layout-preset-name"]').setValue('作战记录布局')
  await wrapper.find('[data-test="layout-preset-name-row"]').trigger('submit')
  store.updateFacility('room_1_1', { product: 'gold' })
  await wrapper.vm.$nextTick()
  expect(wrapper.find('[data-test="layout-preset-modified"]').exists()).toBe(true)
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  await wrapper.find('[data-test="layout-preset-delete"]').trigger('click')
  expect(JSON.parse(localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY) ?? '[]')).toEqual([])
  expect(store.workspace.mainPlan.facilities.room_1_1.product).toBe('gold')
  expect(wrapper.find('[data-test="layout-preset-delete"]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('reports and removes assignments beyond the target room capacity', async () => {
  const store = useRosterWorkbenchStore()
  const originalSlots = JSON.parse(JSON.stringify(store.workspace.mainPlan.facilities.room_1_1.slots))
  store.updateFacility('room_1_1', { type: 'power', level: 3, product: undefined, slots: [originalSlots[0]!] })
  const wrapper = mount(LayoutPresetBar)
  await wrapper.find('[data-test="layout-preset-save"]').trigger('click')
  await wrapper.find('[data-test="layout-preset-name"]').setValue('单工位')
  await wrapper.find('[data-test="layout-preset-name-row"]').trigger('submit')

  store.updateFacility('room_1_1', { type: 'manufacture', level: 3, product: 'gold', slots: originalSlots })
  store.updateSlotOccupant('room_1_1', 2, { kind: 'operator', operatorId: 'char_002_amiya' })
  await wrapper.vm.$nextTick()
  await wrapper.find('[data-test="layout-preset-reapply"]').trigger('click')
  expect(store.workspace.mainPlan.facilities.room_1_1.type).toBe('power')
  expect(store.workspace.mainPlan.facilities.room_1_1.slots).toHaveLength(1)
  expect(wrapper.find('[data-test="layout-preset-message"]').text()).toContain('移除了 1 个')
  wrapper.unmount()
})

it('selects the matching preset after the shell restores a persisted workspace', async () => {
  const store = useRosterWorkbenchStore()
  const persisted = createDefaultWorkspace()
  persisted.mainPlan.facilities.room_1_1.product = 'exp'
  localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify([{
    id: 'saved-layout', name: '已保存布局', facilities: captureFacilityLayout(persisted),
  }]))
  const Host = defineComponent({
    setup() {
      onMounted(() => store.loadWorkspace(persisted))
      return () => h(LayoutPresetBar)
    },
  })
  const wrapper = mount(Host)
  await wrapper.vm.$nextTick()
  expect(wrapper.find('[data-test="layout-preset-select"]').element).toHaveProperty('value', 'saved-layout')
  wrapper.unmount()
})
