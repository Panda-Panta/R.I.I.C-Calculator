/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createDefaultWorkspace } from '../../workbench/defaults'
import SmartRosterConfigModal, {
  DEFAULT_CONFIG,
  STORAGE_KEY_SMART_ROSTER,
  type SmartRosterConfig,
} from './SmartRosterConfigModal.vue'

describe('SmartRosterConfigModal.vue', () => {
  it('uses the current shared weights rather than stale modal preferences', async () => {
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, JSON.stringify({ ...DEFAULT_CONFIG, productionWeights: { exp: 9, gold: 9, orders: 9, fragments: 9, orundum: 9 } }))
    const wrapper = mountModal({ initialProductionWeights: { exp: 2, gold: .5, orders: 1, fragments: 0, orundum: 0 } })
    try {
      expect(wrapper.get<HTMLInputElement>('[data-test="weight-exp"]').element.value).toBe('2')
      await wrapper.get('[data-test="weight-orders"]').setValue('0')
      await wrapper.get('[data-test="confirm-btn"]').trigger('click')
      expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ productionWeights: { exp: 2, gold: .5, orders: 0, fragments: 0, orundum: 0 } })
    } finally { wrapper.unmount() }
  })
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function mountModal(props: Record<string, unknown> = {}) {
    return mount(SmartRosterConfigModal, {
      props: {
        open: true,
        workspace: createDefaultWorkspace(),
        ...props,
      },
      attachTo: document.body,
      global: {
        stubs: {
          teleport: true,
          Teleport: true,
        },
      },
    })
  }

  it('renders modal content when open is true', () => {
    const wrapper = mountModal({ open: true })

    expect(wrapper.find('[data-test="smart-roster-modal-body"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="trials-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="max-evals-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="topk-input"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="constraint-description"]').text()).toContain('一份初始排班')
    expect(wrapper.get('[data-test="verification-description"]').text()).toContain('默认最多两份完整仿真')
    expect(wrapper.find('[data-test="sample-hours-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="enable-deep-search"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="drone-target-select"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="seed-input"]').exists()).toBe(true)
  })

  it('does not render body when open is false', () => {
    const wrapper = mountModal({ open: false })

    expect(wrapper.find('[data-test="smart-roster-modal-body"]').exists()).toBe(false)
  })

  it('initializes with default config and props', () => {
    const wrapper = mountModal({
      open: true,
      initialDroneTarget: 'exp',
      initialSeed: 12345,
    })

    const droneSelect = wrapper.find<HTMLSelectElement>('[data-test="drone-target-select"]')
    expect(droneSelect.element.value).toBe('room_2_1')

    const seedInput = wrapper.find<HTMLInputElement>('[data-test="seed-input"]')
    expect(Number(seedInput.element.value)).toBe(12345)
    expect(wrapper.find<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(false)
    expect(wrapper.text()).toContain('约束计算优化')
    expect(wrapper.text()).toContain('日均加权产出')
    expect(wrapper.text()).toContain('保留较优结果')
    expect(wrapper.text()).not.toContain('入选方案上限')
    expect(wrapper.text()).not.toContain('最多 6 套')
    expect(wrapper.text()).not.toContain('全局最优')
    expect(wrapper.text()).not.toContain('推荐开启')
  })

  it('emits confirm with modified parameters and persists to localStorage', async () => {
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, JSON.stringify({ ...DEFAULT_CONFIG, trials: 9, simulationTopK: 4, maxStaticEvals: 5000, enableDeepSearch: true }))
    const wrapper = mountModal({ open: true })

    expect(wrapper.find('[data-test="trials-input"]').exists()).toBe(false)
    expect(wrapper.find<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(true)
    expect(wrapper.find('[data-test="topk-input"]').exists()).toBe(false)
    await wrapper.find<HTMLInputElement>('[data-test="sample-hours-input"]').setValue(48)
    await wrapper.find<HTMLInputElement>('[data-test="enable-deep-search"]').setValue(false)
    await wrapper.find<HTMLSelectElement>('[data-test="drone-target-select"]').setValue('room_3_2')
    await wrapper.find<HTMLInputElement>('[data-test="seed-input"]').setValue(99999)

    await wrapper.find('[data-test="confirm-btn"]').trigger('click')

    expect(wrapper.emitted('confirm')).toBeTruthy()
    const emittedConfig = wrapper.emitted('confirm')![0]![0] as SmartRosterConfig
    expect(emittedConfig).toEqual({
      productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 },
      trials: 9,
      maxStaticEvals: 5000,
      simulationTopK: 4,
      simulationSampleHours: 48,
      simulationWarmupHours: 24,
      enableDeepSearch: false,
      droneTarget: 'trading',
      droneRoomId: 'room_3_2',
      seed: 99999,
    })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_SMART_ROSTER) || '{}')
    expect(stored.trials).toBe(9)
    expect(stored.simulationTopK).toBe(4)
    expect(stored.simulationSampleHours).toBe(48)
    expect(stored.enableDeepSearch).toBe(false)
  })

  it('defaults missing legacy deep-search preference to two stages without rewriting saved settings', () => {
    const stored = JSON.stringify({ simulationSampleHours: 48, maxStaticEvals: 7000, seed: 17 })
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, stored)
    const wrapper = mountModal()
    expect(wrapper.find<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(false)
    expect(wrapper.find<HTMLInputElement>('[data-test="sample-hours-input"]').element.value).toBe('48')
    expect(wrapper.find<HTMLInputElement>('[data-test="seed-input"]').element.value).toBe('17')
    expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBe(stored)
  })
  it('keeps a saved explicit deep comparison when confirming other unchanged preferences', async () => {
    const saved = { ...DEFAULT_CONFIG, trials: 17, simulationTopK: 11, enableDeepSearch: true, seed: 51 }
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, JSON.stringify(saved))
    const wrapper = mountModal()
    expect(wrapper.get<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(true)
    await wrapper.get('[data-test="confirm-btn"]').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ trials: 17, simulationTopK: 11, enableDeepSearch: true, seed: 51 })
  })

  it('resets form when reset button is clicked', async () => {
    const customConfig: SmartRosterConfig = {
      trials: 2,
      maxStaticEvals: 1000,
      simulationTopK: 2,
      simulationSampleHours: 24,
      simulationWarmupHours: 12,
      enableDeepSearch: false,
      droneTarget: 'exp',
      seed: 888,
    }
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, JSON.stringify(customConfig))

    const wrapper = mountModal({
      open: true,
      initialDroneTarget: 'gold',
      initialSeed: -1,
    })

    expect(wrapper.find<HTMLInputElement>('[data-test="sample-hours-input"]').element.value).toBe('24')

    await wrapper.find('[data-test="reset-btn"]').trigger('click')

    expect(wrapper.find<HTMLInputElement>('[data-test="sample-hours-input"]').element.value).toBe(String(DEFAULT_CONFIG.simulationSampleHours))
    expect(wrapper.find<HTMLInputElement>('[data-test="seed-input"]').element.value).toBe('-1')
    expect(wrapper.find<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBeNull()
  })

  it('emits close when cancel button is clicked', async () => {
    const wrapper = mountModal({ open: true })

    await wrapper.find('[data-test="cancel-btn"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
