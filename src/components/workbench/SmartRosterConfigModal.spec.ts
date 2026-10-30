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
    const primaryDescription = wrapper.get('[data-test="constraint-description"]').text()
    expect(primaryDescription).toContain('主班')
    expect(primaryDescription).toContain('全局在岗联动')
    expect(primaryDescription).toContain('安全初始表')
    expect(primaryDescription).toContain('完整仿真')
    const verificationDescription = wrapper.get('[data-test="verification-description"]').text()
    expect(verificationDescription).toContain('默认最多两份完整仿真')
    expect(verificationDescription).toContain('高效主班方案与初始表')
    expect(verificationDescription).toContain('先验证初始表')
    expect(verificationDescription).toContain('成功即返回')
    expect(verificationDescription).toContain('未完成再验证后备方案')
    expect(wrapper.get('[data-test="deep-search-description"]').text()).toContain('队伍分配')
    expect(wrapper.get('[data-test="deep-search-description"]').text()).toContain('增加等待时间')
    expect(wrapper.find('[data-test="sample-hours-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="enable-deep-search"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="enable-backup-generation"]').exists()).toBe(true)
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
    expect(wrapper.text()).toContain('主班候选筛选')
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
      enableBackupGeneration: false,
      enableMainOptimization: false,
      allowFreeCombinations: false,
      optimizationMaxSimulations: 3,
      optimizationTimeBudgetMs: 30000,
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

  it('leaves legacy preferences unchanged while defaulting continuous main optimization and free combinations off', () => {
    const saved = JSON.stringify({ simulationSampleHours: 48, seed: 17, enableDeepSearch: true })
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, saved)
    const wrapper = mountModal()
    try {
      expect(wrapper.get<HTMLInputElement>('[data-test="enable-main-optimization"]').element.checked).toBe(false)
      expect(wrapper.get<HTMLInputElement>('[data-test="allow-free-combinations"]').element.checked).toBe(false)
      expect(wrapper.get<HTMLInputElement>('[data-test="optimization-max-simulations"]').element.value).toBe('3')
      expect(wrapper.get<HTMLInputElement>('[data-test="optimization-time-budget-seconds"]').element.value).toBe('30')
      expect(wrapper.get('[data-test="free-combinations-description"]').text()).toContain('内部预设组合')
      expect(wrapper.get('[data-test="free-combinations-description"]').text()).toContain('已配置工位与人员继续锁定')
      expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBe(saved)
    } finally { wrapper.unmount() }
  })

  it('persists explicit main optimization, free combinations and bounded extra simulation budgets, then resets them', async () => {
    const wrapper = mountModal()
    try {
      await wrapper.get('[data-test="enable-main-optimization"]').setValue(true)
      await wrapper.get('[data-test="allow-free-combinations"]').setValue(true)
      await wrapper.get('[data-test="optimization-max-simulations"]').setValue(99)
      await wrapper.get('[data-test="optimization-time-budget-seconds"]').setValue(999)
      await wrapper.get('[data-test="confirm-btn"]').trigger('click')
      const expected = { enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: 8, optimizationTimeBudgetMs: 300000 }
      expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject(expected)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)!)).toMatchObject(expected)
    } finally { wrapper.unmount() }
    const restored = mountModal()
    try {
      expect(restored.get<HTMLInputElement>('[data-test="enable-main-optimization"]').element.checked).toBe(true)
      expect(restored.get<HTMLInputElement>('[data-test="allow-free-combinations"]').element.checked).toBe(true)
      expect(restored.get<HTMLInputElement>('[data-test="optimization-time-budget-seconds"]').element.value).toBe('300')
      await restored.get('[data-test="reset-btn"]').trigger('click')
      expect(restored.get<HTMLInputElement>('[data-test="enable-main-optimization"]').element.checked).toBe(false)
      expect(restored.get<HTMLInputElement>('[data-test="allow-free-combinations"]').element.checked).toBe(false)
      expect(restored.get<HTMLInputElement>('[data-test="optimization-max-simulations"]').element.value).toBe('3')
      expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBeNull()
    } finally { restored.unmount() }
  })

  it.each(['true', 'false', 1, null, {}])('requires explicit true to restore either main optimization option: %j', value => {
    const saved = JSON.stringify({ enableMainOptimization: value, allowFreeCombinations: value })
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, saved)
    const wrapper = mountModal()
    try {
      expect(wrapper.get<HTMLInputElement>('[data-test="enable-main-optimization"]').element.checked).toBe(false)
      expect(wrapper.get<HTMLInputElement>('[data-test="allow-free-combinations"]').element.checked).toBe(false)
      expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBe(saved)
    } finally { wrapper.unmount() }
  })

  it('offers conditional backup comparison as an independent experiment defaulting off', () => {
    const wrapper = mountModal()
    try {
      expect(DEFAULT_CONFIG.enableBackupGeneration).toBe(false)
      expect(wrapper.get<HTMLInputElement>('[data-test="enable-backup-generation"]').element.checked).toBe(false)
      const description = wrapper.get('[data-test="backup-generation-description"]').text()
      expect(wrapper.text()).toContain('联合生成条件副表（实验）')
      expect(description).toContain('主表')
      expect(description).toContain('条件副表')
      expect(description).toContain('增加等待')
      expect(description).toContain('未必更高')
      expect(description).not.toMatch(/ALNS|贝叶斯|GP|查询预算|候选预算/)
    } finally { wrapper.unmount() }
  })

  it.each([
    ['missing', undefined, false], ['true', true, true], ['false', false, false],
    ['string false', 'false', false], ['string true', 'true', false],
    ['number', 1, false], ['null', null, false], ['object', {}, false],
  ])('strictly restores the %s backup-generation preference without rewriting storage', async (_label, value, enabled) => {
    const raw = JSON.stringify({ simulationSampleHours: 48, seed: 17, enableBackupGeneration: value })
    localStorage.setItem(STORAGE_KEY_SMART_ROSTER, raw)
    const wrapper = mountModal()
    try {
      expect(wrapper.get<HTMLInputElement>('[data-test="enable-backup-generation"]').element.checked).toBe(enabled)
      expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBe(raw)
      await wrapper.get('[data-test="confirm-btn"]').trigger('click')
      expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ enableBackupGeneration: enabled })
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)!)).toMatchObject({ enableBackupGeneration: enabled })
    } finally { wrapper.unmount() }
  })

  it('persists both optional comparisons and resets backup generation to off', async () => {
    const wrapper = mountModal()
    try {
      await wrapper.get('[data-test="enable-deep-search"]').setValue(true)
      await wrapper.get('[data-test="enable-backup-generation"]').setValue(true)
      await wrapper.get('[data-test="confirm-btn"]').trigger('click')
      expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ enableDeepSearch: true, enableBackupGeneration: true })
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)!)).toMatchObject({ enableDeepSearch: true, enableBackupGeneration: true })
    } finally { wrapper.unmount() }
    const restored = mountModal()
    try {
      expect(restored.get<HTMLInputElement>('[data-test="enable-backup-generation"]').element.checked).toBe(true)
      expect(restored.get<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(true)
      await restored.get('[data-test="reset-btn"]').trigger('click')
      expect(restored.get<HTMLInputElement>('[data-test="enable-backup-generation"]').element.checked).toBe(false)
      expect(restored.get<HTMLInputElement>('[data-test="enable-deep-search"]').element.checked).toBe(false)
      expect(localStorage.getItem(STORAGE_KEY_SMART_ROSTER)).toBeNull()
    } finally { restored.unmount() }
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
