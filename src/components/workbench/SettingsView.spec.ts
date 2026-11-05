// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { exportMowerJson } from '../../workbench/compat/mowerJson'
beforeEach(() => setActivePinia(createPinia()))
import { mount } from '@vue/test-utils'
import SettingsView, { type SimulationSettings } from './SettingsView.vue'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../../domain/productionWeights'

const settings: SimulationSettings = {
  sampleDays: 7, warmupDays: 3, step: .25, seed: 1,
  droneTarget: 'none', fiammettaFool: true,
  fiammettaThreshold: .9, restingThreshold: .65,
  rescueThreshold: .75,
}

it('points output accounting to the calculation inventory setting', async () => {
  const wrapper = mount(SettingsView, {
    props: { settings },
    global: { stubs: { OperatorInventoryPanel: true } },
  })
  expect(wrapper.text()).toContain('在“计算产出”中设置初始库存；启用后按库存结算')
  expect(wrapper.text()).not.toContain('忽略库存阻塞')
  await wrapper.setProps({ settings: { ...settings, initialInventory: { gold: 0 } } })
  expect(wrapper.text()).toContain('启用后按库存结算')
  wrapper.unmount()
})

it('shows Mower thresholds and keeps Jaye only in calculation options', async () => {
  const wrapper = mount(SettingsView, {
    props: { settings },
    global: { stubs: { OperatorInventoryPanel: true } },
  })
  expect(wrapper.find('[data-test="jaye-elite0-select"]').exists()).toBe(false)
  expect(wrapper.get('[data-test="fiammetta-threshold"]').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ settings: { ...settings, fiammettaFool: false } })
  await wrapper.get('[data-test="fiammetta-threshold"]').setValue('80')
  const firstUpdate = wrapper.emitted('update:settings') ?? []
  expect(firstUpdate[firstUpdate.length - 1]?.[0]).toMatchObject({ fiammettaThreshold: .8 })
  await wrapper.get('[data-test="rescue-threshold"]').setValue('90')
  const secondUpdate = wrapper.emitted('update:settings') ?? []
  expect(secondUpdate[secondUpdate.length - 1]?.[0]).toMatchObject({ rescueThreshold: .9 })
  wrapper.unmount()
})

it('uses default weights for old settings and emits weights through shared simulation settings', async () => {
  const wrapper = mount(SettingsView, {
    props: { settings },
    global: { stubs: { OperatorInventoryPanel: true } },
  })
  expect((wrapper.get('[data-test="weight-gold"]').element as HTMLInputElement).value).toBe('0.8')
  await wrapper.get('[data-test="weight-gold"]').setValue('0')
  const update = (wrapper.emitted('update:settings')?.[0]?.[0]) as SimulationSettings
  expect(update).toMatchObject({
    sampleDays: 7,
    productionWeights: { ...DEFAULT_PRODUCTION_WEIGHTS, gold: 0 },
  })
  await wrapper.setProps({ settings: update })
  expect((wrapper.get('[data-test="weight-gold"]').element as HTMLInputElement).value).toBe('0')
  wrapper.unmount()
})

it('shares imported advanced values and persists edits into the exported plan', async () => {
  const store = useRosterWorkbenchStore()
  store.workspace.compatibility.unrecognizedFields.advanced_settings = { fia_fool: false, rescue_threshold: .25, future: 7 }
  const wrapper = mount(SettingsView, { props: { settings }, global: { stubs: { OperatorInventoryPanel: true } } })
  expect((wrapper.get('[data-test="fiammetta-fool"]').element as HTMLSelectElement).value).toBe('false')
  expect((wrapper.get('[data-test="rescue-threshold"]').element as HTMLInputElement).value).toBe('25')
  await wrapper.get('[data-test="rescue-threshold"]').setValue('50')
  expect(JSON.parse(exportMowerJson(store.workspace)).advanced_settings).toEqual({ fia_fool: false, rescue_threshold: .5, future: 7 })
  wrapper.unmount()
})

it('preserves an older global threshold and only writes valid new Mower values', async () => {
  const store = useRosterWorkbenchStore()
  store.workspace.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: .2, future: 7 }
  const wrapper = mount(SettingsView, { props: { settings }, global: { stubs: { OperatorInventoryPanel: true } } })
  const input = wrapper.get<HTMLInputElement>('[data-test="resting-threshold"]')
  expect(input.element.value).toBe('20')
  expect(input.attributes('min')).toBe('35')
  await input.setValue('34')
  expect(input.element.value).toBe('20')
  expect(wrapper.emitted('update:settings')).toBeUndefined()
  expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toEqual({ resting_threshold: .2, future: 7 })
  await input.setValue('35')
  expect(wrapper.emitted('update:settings')?.[0]?.[0]).toMatchObject({ restingThreshold: .35 })
  expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toEqual({ resting_threshold: .35, future: 7 })
  wrapper.unmount()
})
