// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsView, { type SimulationSettings } from './SettingsView.vue'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../../domain/productionWeights'

const settings: SimulationSettings = {
  sampleDays: 7, warmupDays: 3, step: .25, seed: 1,
  droneTarget: 'none', fiammettaFool: true,
  fiammettaThreshold: .9, restingThreshold: .65,
  rescueThreshold: .75,
}

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
