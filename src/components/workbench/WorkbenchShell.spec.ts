/**
 * @vitest-environment jsdom
 *
 * Test suite for WorkbenchShell.vue and primary application entry wiring.
 *
 * Covers:
 * 1. App.vue contains only WorkbenchShell as primary entry; no legacy dashboard shown.
 * 2. Full-page shell rendering: PlanToolbar, ValidationPanel, BaseMap, FacilityEditor, PolicyEditor, Modals, Footer.
 * 3. BaseMap DOM element handoff to PlanToolbar for high-res JPG export.
 * 4. BaseMap selection focuses FacilityEditor.
 * 5. FacilityEditor request-picker opens OperatorSelectModal in main & replacement modes with correct store writeback.
 * 6. ValidationPanel focus selects room/slot or scrolls policy section.
 * 7. GlobalReplace modal open, close, and replaced status banner.
 * 8. Invalid calculation guard: blocks calculation when validation fails.
 * 9. Real adapter + calculate smoke equivalence against deterministic engine baseline.
 * 10. Results panel displays actual report fields and repeat calculation refreshes.
 * 11. File imports immediately update all views, and reset clears stale calculation state.
 * 12. Preservation of store/local persistence patterns and imported unknown fields.
 * 13. Responsive outer shell structure with non-distorting scrollable Mower board.
 */

vi.hoisted(() => {
  class ResizeObserverStub {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
  if (typeof window !== 'undefined') {
    window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  }
  if (typeof global !== 'undefined') {
    if (typeof (global as any).removeEventListener !== 'function') {
      (global as any).removeEventListener = () => {}
    }
    if (typeof (global as any).addEventListener !== 'function') {
      (global as any).addEventListener = () => {}
    }
  }
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import App from '../../App.vue'
import WorkbenchShell from './WorkbenchShell.vue'
import { runCalculationBridge, type CalculationBridgeOptions } from '../../workbench/calculationBridge'
import PlanToolbar from './PlanToolbar.vue'
import BaseMap from './BaseMap.vue'
import FacilityEditor from './FacilityEditor.vue'
import PolicyEditor from './PolicyEditor.vue'
import ValidationPanel from './ValidationPanel.vue'
import OperatorSelectModal from './OperatorSelectModal.vue'
import GlobalReplaceModal from './GlobalReplaceModal.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import { createDefaultWorkspace } from '../../workbench/defaults'
import type { RosterWorkspace } from '../../workbench/model'
import { compileMainPlanToAppConfig } from '../../workbench/adapter'
import { createDefaultConfig } from '../../domain/defaults'
import { calculate } from '../../engine/calculate'
import { EDITION } from '../../domain/edition'
import { OPERATORS } from '../../domain/operators'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../../domain/productionWeights'
import sourceRoster from '../../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson } from '../../workbench/compat/mowerJson'

describe('WorkbenchShell.vue and App primary entry integration', () => {
  let pinia: Pinia
  const activeWrappers: Array<ReturnType<typeof mount>> = []

  function mountWithPinia<T extends Parameters<typeof mount>[0]>(
    component: T,
    options?: Parameters<typeof mount<T>>[1],
  ) {
    const wrapper = mount(component, {
      ...options,
      global: {
        ...options?.global,
        plugins: [pinia, ...(options?.global?.plugins ?? [])],
      },
    })
    activeWrappers.push(wrapper as unknown as ReturnType<typeof mount>)
    return wrapper
  }

  beforeEach(() => {
    class ResizeObserverStub {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

    pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()
    localStorage.setItem(`arc-income-calculator-sim-settings-v1-${EDITION.storageNamespace}`, JSON.stringify({
      warmupDays: .25, sampleDays: .75, step: .25, seed: 42, droneTarget: 'gold', droneTradingRoomId: '',
    }))
    // jsdom has no browser workers. Execute the real bridge through its asynchronous message boundary.
    vi.stubGlobal('Worker', class {
      onmessage: ((event: MessageEvent) => void) | null = null
      stopped = false
      postMessage(request: { workspace: RosterWorkspace; options: CalculationBridgeOptions }) {
        queueMicrotask(() => {
          if (!this.stopped) this.onmessage?.({ data: { type: 'complete', result: runCalculationBridge(request.workspace, request.options) } } as MessageEvent)
        })
      }
      terminate() { this.stopped = true }
    })

    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn()
    }
  })

  afterEach(() => {
    while (activeWrappers.length > 0) {
      const wrapper = activeWrappers.pop()
      wrapper?.unmount()
    }
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    document.body.innerHTML = ''
  })

  it('saves changed weights before starting a worker and cancels only when those weights change again', async () => {
    const pending: Array<{ postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('Worker', class {
      onmessage: ((event: MessageEvent) => void) | null = null
      postMessage = vi.fn()
      terminate = vi.fn()
      constructor() { pending.push(this) }
    })
    const wrapper = mountWithPinia(WorkbenchShell)
    await flushPromises()
    const original = JSON.stringify(wrapper.vm.store.workspace)
    wrapper.vm.simSettings.sampleDays = 1
    await flushPromises()
    expect(JSON.stringify(wrapper.vm.store.workspace)).toBe(original)
    const productionWeights = { ...DEFAULT_PRODUCTION_WEIGHTS, exp: 2 }
    wrapper.vm.handleConfirmCalculation({
      droneTarget: 'none', droneTradingRoomId: '',
      useOperatorInventory: false, productionWeights,
    })
    await flushPromises()
    expect(wrapper.vm.isCalculating).toBe(true)
    expect(pending[0]!.terminate).not.toHaveBeenCalled()
    const request = pending[0]!.postMessage.mock.calls[0]![0]
    expect(request.workspace.productionWeights).toEqual(productionWeights)
    expect(request.options.simulationOptions.productionWeights).toEqual(productionWeights)
    wrapper.vm.simSettings.productionWeights!.gold = 0
    await flushPromises()
    expect(wrapper.vm.isCalculating).toBe(false)
    expect(pending[0]!.terminate).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(`arc-income-calculator-sim-settings-v1-${EDITION.storageNamespace}`)!).productionWeights).toEqual({ ...productionWeights, gold: 0 })
  })

  // 1. App contains only WorkbenchShell primary entry
  it('mounts App with only WorkbenchShell primary entry and no legacy dashboard/editor', () => {
    const wrapper = mountWithPinia(App)
    const shell = wrapper.findComponent(WorkbenchShell)
    expect(shell.exists()).toBe(true)

    // Legacy elements from previous App.vue must NOT exist
    expect(wrapper.find('.power-console').exists()).toBe(false)
    expect(wrapper.find('.drone-panel').exists()).toBe(false)
    expect(wrapper.find('.income-panel').exists()).toBe(false)
    expect(wrapper.find('.base-output-grid').exists()).toBe(false)
    expect(wrapper.find('.roster-table').exists()).toBe(false)
    expect(wrapper.find('.command-strip').exists()).toBe(false)
  })

  // 2. Primary full-page layout
  it('renders complete Mower main roster UI as primary full page with all required components', () => {
    const wrapper = mountWithPinia(WorkbenchShell)

    expect(wrapper.findComponent(PlanToolbar).exists()).toBe(true)
    expect(wrapper.findComponent(ValidationPanel).exists()).toBe(true)
    expect(wrapper.findComponent(BaseMap).exists()).toBe(true)
    expect(wrapper.findComponent(FacilityEditor).exists()).toBe(true)
    expect(wrapper.findComponent(PolicyEditor).exists()).toBe(true)
    expect(wrapper.findComponent(OperatorSelectModal).exists()).toBe(true)
    expect(wrapper.findComponent(GlobalReplaceModal).exists()).toBe(true)

    const footer = wrapper.find('[data-test="workbench-footer"]')
    expect(footer.exists()).toBe(true)
    expect(footer.text()).toContain(EDITION.label)
    expect(footer.text()).toContain('Arknights Mower')
    expect(footer.text()).toContain('本地保存')
  })

  // 3. Export element handoff
  it('holds and hands off the real BaseMap export DOM element to PlanToolbar', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    await flushPromises()

    const toolbar = wrapper.findComponent(PlanToolbar)
    expect(toolbar.exists()).toBe(true)

    const passedElement = toolbar.props('baseMapElement') as HTMLElement | null
    expect(passedElement).not.toBeNull()
    expect(passedElement).toBeInstanceOf(HTMLElement)

    const baseMap = wrapper.findComponent(BaseMap)
    const baseMapContainer = baseMap.find('.plan-container').element
    expect(passedElement).toBe(baseMapContainer)
  })

  // 4. BaseMap selection focuses FacilityEditor
  it('focuses and updates FacilityEditor when a room is selected in BaseMap or store', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    expect(store.selectedRoomId).toBe('room_1_1')

    store.selectRoom('room_2_2')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoomId).toBe('room_2_2')
    expect(store.selectedRoom?.roomId).toBe('room_2_2')

    const editor = wrapper.findComponent(FacilityEditor)
    expect(editor.exists()).toBe(true)
  })

  // 5. FacilityEditor request-picker opens OperatorSelectModal in main & replacement modes with writeback
  it('opens OperatorSelectModal in main mode and writes back selected operator to slot', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    const editor = wrapper.findComponent(FacilityEditor)
    editor.vm.$emit('request-picker', {
      roomId: 'room_1_1',
      slotIndex: 0,
      mode: 'main',
    })
    await wrapper.vm.$nextTick()

    const modal = wrapper.findComponent(OperatorSelectModal)
    expect(modal.props('open')).toBe(true)
    expect(modal.props('mode')).toBe('main')
    expect(modal.props('roomId')).toBe('room_1_1')
    expect(modal.props('slotIndex')).toBe(0)

    // Select operator and verify store writeback
    store.updateSlotOccupant('room_1_1', 0, {
      kind: 'operator',
      operatorId: 'char_002_amiya',
    })
    modal.vm.$emit('selected', {
      mode: 'main',
      roomId: 'room_1_1',
      slotIndex: 0,
      selectionKind: 'operator',
      operatorId: 'char_002_amiya',
      operatorName: '阿米娅',
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.pickerOpen).toBe(false)
    expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]?.occupant).toEqual({
      kind: 'operator',
      operatorId: 'char_002_amiya',
    })
  })

  it('opens OperatorSelectModal in replacement mode and writes back added replacement', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    const editor = wrapper.findComponent(FacilityEditor)
    editor.vm.$emit('request-picker', {
      roomId: 'room_1_1',
      slotIndex: 0,
      mode: 'replacement',
    })
    await wrapper.vm.$nextTick()

    const modal = wrapper.findComponent(OperatorSelectModal)
    expect(modal.props('open')).toBe(true)
    expect(modal.props('mode')).toBe('replacement')

    // Add replacement and verify store writeback
    store.addReplacement('room_1_1', 0, 'char_102_texas')
    modal.vm.$emit('selected', {
      mode: 'replacement',
      roomId: 'room_1_1',
      slotIndex: 0,
      selectionKind: 'operator',
      operatorId: 'char_102_texas',
      operatorName: '德克萨斯',
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.pickerOpen).toBe(false)
    expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]?.replacements).toContain('char_102_texas')
  })

  // 6. ValidationPanel focus selects room/slot or scrolls policy section
  it('handles validation focus event to select room and slot', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()
    const validationPanel = wrapper.findComponent(ValidationPanel)

    validationPanel.vm.$emit('focus', {
      roomId: 'room_3_1',
      slotIndex: 2,
      message: '测试校验错误',
    })
    await wrapper.vm.$nextTick()

    expect(store.selectedRoomId).toBe('room_3_1')

    validationPanel.vm.$emit('focus-room', 'central')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoomId).toBe('central')
  })

  it('handles validation focus event for policy keys without throwing', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const validationPanel = wrapper.findComponent(ValidationPanel)

    expect(() => {
      validationPanel.vm.$emit('focus', {
        policyKey: 'exhaust_require',
        message: '策略配置测试',
      })
    }).not.toThrow()
  })

  // 7. GlobalReplace modal open, close, and replaced status banner
  it('opens and closes GlobalReplaceModal and displays replaced status banner', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const toolbar = wrapper.findComponent(PlanToolbar)

    toolbar.vm.$emit('open-replace')
    await wrapper.vm.$nextTick()

    const replaceModal = wrapper.findComponent(GlobalReplaceModal)
    expect(replaceModal.props('open')).toBe(true)

    replaceModal.vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.replaceModalOpen).toBe(false)

    // Simulate replacement emit
    replaceModal.vm.$emit('replaced', {
      sourceId: 'char_102_texas',
      targetId: 'char_103_angel',
      sourceOperatorId: 'char_102_texas',
      targetOperatorId: 'char_103_angel',
      sourceName: '德克萨斯',
      targetName: '能天使',
      impact: {
        totalCount: 3,
        mainLocations: [],
        replacementLocations: [],
        confLocations: [],
      },
    })
    await wrapper.vm.$nextTick()

    const banner = wrapper.find('[data-test="replace-status-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('德克萨斯')
    expect(banner.text()).toContain('能天使')
    expect(banner.text()).toContain('3')

    // Close banner
    await banner.find('.replace-status-close').trigger('click')
    expect(wrapper.find('[data-test="replace-status-banner"]').exists()).toBe(false)
  })

  // 8. Invalid calculation guard
  it('guards against invalid calculation when validation has critical errors', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    // Induce critical error: duplicate primary operator across rooms
    store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
    store.updateSlotOccupant('room_1_2', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.validationResult.isValid).toBe(false)

    // Attempt calculate
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()

    expect(wrapper.vm.calculationReport).toBeNull()
    const errorBox = wrapper.find('[data-test="calculation-error"]')
    expect(errorBox.exists()).toBe(true)
    expect(errorBox.text()).toContain('阻断错误')

    // Pure helper guard equivalence
    const bridgeResult = runCalculationBridge(store.workspace)
    expect(bridgeResult.success).toBe(false)
    expect(bridgeResult.report).toBeNull()
  })

  // 9. Real adapter + calculate smoke equivalence against baseline
  it('demonstrates calculation bridge smoke equivalence with untouched calculate engine', () => {
    const store = useRosterWorkbenchStore()
    const defaultWorkspace = store.workspace

    // 1. Direct adapter + calculate
    const compiledConfig = compileMainPlanToAppConfig(
      defaultWorkspace.mainPlan,
      defaultWorkspace,
      createDefaultConfig(),
    )
    const directReport = calculate(compiledConfig)

    // 2. Pure calculation bridge helper
    const bridgeResult = runCalculationBridge(defaultWorkspace)

    expect(bridgeResult.success).toBe(true)
    expect(bridgeResult.report).toEqual(directReport)

    // Deterministic baselines from engine-protection.spec.ts
    expect(directReport.power).toEqual({
      generation: 810,
      consumption: 810,
      margin: 0,
      sufficient: true,
    })
    expect(directReport.layoutValid).toBe(true)
    expect(directReport.drones).toBe(240)
    expect(directReport.summary?.goldValue).toBe(20000)
    expect(directReport.summary?.goldCount).toBe(40)
  })

  // 10. Results panel displays actual report fields and repeat calculation refreshes
  it.each(['可露希尔', '佩佩'])('hides %s special order details and consumed gold in the main result', async runner => {
    localStorage.setItem(`arc-income-calculator-sim-settings-v1-${EDITION.storageNamespace}`, JSON.stringify({
      warmupDays: 0, sampleDays: 1 / 3, step: .25, seed: 42, droneTarget: 'none', droneTradingRoomId: '',
    }))
    const roster = structuredClone(sourceRoster)
    roster.plan1.room_1_1.plans[1]!.agent = '绮良'
    roster.plan1.room_1_1.plans[1]!.replacement = ['能天使', runner]
    roster.plan1.room_1_1.plans[2]!.replacement = ['蕾缪安']
    useRosterWorkbenchStore().loadWorkspace(importMowerJson(JSON.stringify(roster)))
    const wrapper = mountWithPinia(WorkbenchShell)
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
    await flushPromises()
    expect(wrapper.vm.calculationReport?.summary?.virtualGoldCount).toBeGreaterThan(0)
    const gold = wrapper.get('[data-test="metric-gold"]')
    const expectedGoldValue = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0, minimumFractionDigits: 0 })
      .format(wrapper.vm.calculationReport!.summary!.goldValue)
    expect(gold.get('.metric-num').text()).toBe(expectedGoldValue)
    expect(gold.get('.metric-unit').text()).toBe('龙门币/日')
    expect(gold.get('.metric-sub').text()).toContain('净产出')
    expect(gold.get('.metric-sub').text()).toContain('虚拟赤金')
    expect(gold.findAll('.metric-sub')).toHaveLength(1)
    expect(gold.find('[data-test="metric-special-orders"]').exists()).toBe(false)
    const trade = wrapper.get('[data-test="metric-lmd"]')
    expect(trade.get('.metric-num').text()).toBeTruthy()
    expect(trade.text()).not.toContain('日消耗赤金')
    expect(trade.text()).not.toContain('采样期特殊订单')
    expect(trade.find('[data-test="metric-special-orders"]').exists()).toBe(false)
  }, 30000)

  it('displays compact results panel with actual report fields and refreshes on repeat calculation', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)

    // Ensure valid default configuration and trigger calculate
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()

    const resultsPanel = wrapper.find('[data-test="results-panel"]')
    expect(resultsPanel.exists()).toBe(true)

    // Check power summary badge
    const powerBadge = wrapper.find('[data-test="results-power-badge"]')
    expect(powerBadge.exists()).toBe(true)
    expect(powerBadge.text()).toContain('发电: 810')
    expect(powerBadge.text()).toContain('耗电: 810')
    expect(powerBadge.text()).toContain('供电充足')

    // Check metrics cards
    expect(wrapper.find('[data-test="metric-lmd"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="metric-exp"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="metric-gold"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="metric-drones"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="metric-exp"] .metric-sub').exists()).toBe(false)
    expect(wrapper.find('[data-test="metric-drones"] .metric-sub').exists()).toBe(false)

    const initialLmd = wrapper.find('[data-test="metric-lmd"]').text()

    // Repeat calculation refreshes
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()

    expect(wrapper.find('[data-test="results-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="metric-lmd"]').text()).toBe(initialLmd)
  }, 15000)

  it('calculates with the imported library as idle candidates while retaining assigned workers', async () => {
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ schemaVersion: 1, enabled: true, text: '夜烟,0,1' }))
    const store = useRosterWorkbenchStore()
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: 'char_141_nights' }
    store.loadWorkspace(ws)
    const wrapper = mountWithPinia(WorkbenchShell)
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()
    expect(wrapper.vm.calculationReport).not.toBeNull()
    expect(wrapper.vm.simulationReport?.success).toBe(true)
    expect(wrapper.find('[data-test="metric-gold"]').exists()).toBe(true)
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ schemaVersion: 1, enabled: true, text: '芬,0,1' }))
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()
    expect(wrapper.vm.calculationReport).not.toBeNull()
    expect(wrapper.vm.simulationReport?.success).toBe(true)
    expect(wrapper.find('[data-test="metric-gold"]').exists()).toBe(true)
    expect(wrapper.vm.simulationReport?.diagnostics.some(d => d.code === 'INVENTORY_OPERATOR_NOT_OWNED')).toBe(false)
  }, 15000)

  // 11. File imports immediately update all views, and reset clears stale calculation state
  it('updates all views immediately on file import and clears stale calculation state on reset', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    // Run a calculation first
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()
    expect(wrapper.vm.calculationReport).not.toBeNull()

    // Reset clears calculation report
    const toolbar = wrapper.findComponent(PlanToolbar)
    toolbar.vm.$emit('reset')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.calculationReport).toBeNull()
    expect(wrapper.find('[data-test="results-panel"]').exists()).toBe(false)

    // Clear operators also clears calculation report
    wrapper.vm.handleCalculate()
    if (wrapper.vm.calculationConfigOpen) wrapper.vm.handleConfirmCalculation({ droneTarget: 'gold', droneTradingRoomId: '' })
    await flushPromises()
    expect(wrapper.vm.calculationReport).not.toBeNull()

    toolbar.vm.$emit('clear-operators')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.calculationReport).toBeNull()

    // Import updates store and clears stale reports
    const customWs = createDefaultWorkspace()
    customWs.name = '导入的专属排班'
    customWs.mainPlan.facilities.room_1_1.type = 'trading'
    customWs.mainPlan.facilities.room_1_1.product = 'money'

    store.loadWorkspace(customWs)
    toolbar.vm.$emit('imported', customWs)
    await wrapper.vm.$nextTick()

    expect(store.workspace.name).toBe('导入的专属排班')
    expect(store.workspace.mainPlan.facilities.room_1_1.type).toBe('trading')
    expect(wrapper.vm.calculationReport).toBeNull()
  })

  // 12. Preserves store/local persistence patterns and imported unknown fields
  it('preserves imported unknown fields and syncs workspace to localStorage', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()

    // Inject unknown field into compatibility envelope
    store.workspace.compatibility.unrecognizedFields.custom_flag_x = 9999
    await wrapper.vm.$nextTick()

    // Compiling to AppConfig must not delete or alter compatibility fields
    const compiled = compileMainPlanToAppConfig(
      store.workspace.mainPlan,
      store.workspace,
      createDefaultConfig(),
    )
    expect(compiled).toBeDefined()
    expect(store.workspace.compatibility.unrecognizedFields.custom_flag_x).toBe(9999)

    // Verify localStorage key format
    const expectedKey = `arc-income-calculator-workspace-v8-${EDITION.storageNamespace}`
    const stored = localStorage.getItem(expectedKey)
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed.compatibility.unrecognizedFields.custom_flag_x).toBe(9999)
  })

  it('restores saved default-named recipes without guessing that they are obsolete defaults', async () => {
    localStorage.clear()
    const expectedKey = `arc-income-calculator-workspace-v8-${EDITION.storageNamespace}`
    const legacyWs = createDefaultWorkspace()
    legacyWs.mainPlan.facilities.room_2_1.product = 'gold'
    legacyWs.mainPlan.facilities.room_2_2.product = 'gold'
    localStorage.setItem(expectedKey, JSON.stringify(legacyWs))

    const wrapper = mountWithPinia(WorkbenchShell)
    const store = useRosterWorkbenchStore()
    await wrapper.vm.$nextTick()

    expect(store.workspace.mainPlan.facilities.room_1_1.product).toBe('gold')
    expect(store.workspace.mainPlan.facilities.room_1_2.product).toBe('gold')
    expect(store.workspace.mainPlan.facilities.room_2_1.product).toBe('gold')
    expect(store.workspace.mainPlan.facilities.room_2_2.product).toBe('gold')
  })

  it('restores an empty 252 two-gold 21-trade preset without changing its two gold recipes', async () => {
    const workspace = createDefaultWorkspace()
    const layout = [
      ['room_1_1', 'manufacture', 3, 'exp'], ['room_1_2', 'trading', 2, 'money'], ['room_1_3', 'power', 3],
      ['room_2_1', 'manufacture', 3, 'gold'], ['room_2_2', 'manufacture', 2, 'gold'], ['room_2_3', 'manufacture', 3, 'exp'],
      ['room_3_1', 'manufacture', 3, 'exp'], ['room_3_2', 'trading', 1, 'money'], ['room_3_3', 'power', 3],
    ] as const
    for (const [id, type, level, product] of layout) {
      const room = workspace.mainPlan.facilities[id]
      room.type = type; room.level = level
      if (product) room.product = product
      else delete room.product
      room.slots = Array.from({ length: type === 'power' ? 1 : level }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
    }
    localStorage.setItem(`arc-income-calculator-workspace-v8-${EDITION.storageNamespace}`, JSON.stringify(workspace))
    const wrapper = mountWithPinia(WorkbenchShell)
    await wrapper.vm.$nextTick()
    const restored = useRosterWorkbenchStore().workspace
    for (const [id, type, level, product] of layout) {
      expect(restored.mainPlan.facilities[id]).toMatchObject({ type, level, ...(product ? { product } : {}) })
    }
  })

  it('uses the completed generation report without starting another income worker', async () => {
    const workers: { onmessage: ((event: MessageEvent) => void) | null; terminate: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('Worker', class {
      onmessage: ((event: MessageEvent) => void) | null = null
      terminate = vi.fn()
      postMessage = vi.fn()
      constructor() { workers.push(this) }
    })
    vi.stubEnv('VITEST', '')
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ enabled: true, text: '砾,1,60\n芬,1,55' }))
    const wrapper = mountWithPinia(WorkbenchShell)
    wrapper.vm.simSettings.sampleDays = 7
    wrapper.vm.simSettings.warmupDays = 3
    const workspace = JSON.parse(JSON.stringify(wrapper.vm.store.workspace)) as RosterWorkspace
    const calculationReport = calculate(compileMainPlanToAppConfig(workspace.mainPlan, workspace, createDefaultConfig()))
    if (!calculationReport.summary) throw new Error('Fixture calculation must have a complete summary')
    calculationReport.summary.totalScore82 = 12345
    calculationReport.summary.goldValue = 6789
    wrapper.vm.handleConfirmSmartRosterConfig({ seed: 42, trials: 10, maxStaticEvals: 3000, simulationTopK: 10,
      simulationWarmupHours: 24, simulationSampleHours: 72, enableDeepSearch: false, droneTarget: 'gold' })
    workers[0]!.onmessage!({ data: { type: 'complete', report: {
      status: 'draft', workspace, score: 12345, calculationReport, diagnostics: [], specialOperators: [], phases: {},
    } } } as MessageEvent)
    await flushPromises()
    expect(workers).toHaveLength(1)
    expect(wrapper.vm.calculationReport).toEqual(calculationReport)
    expect(wrapper.vm.isCalculating).toBe(false)
    expect(wrapper.vm.simSettings.sampleDays).toBe(7)
    expect(wrapper.vm.simSettings.warmupDays).toBe(3)
    expect(wrapper.get('[data-test="metric-gold"]').text()).toContain('6,789')
  })

  // 13. Responsive outer shell structure with non-distorting scrollable Mower board
  it('wraps the fixed Mower board in a horizontal scroll container while keeping toolbar reachable', () => {
    const wrapper = mountWithPinia(WorkbenchShell)

    const boardScroll = wrapper.find('.board-scroll-container')
    expect(boardScroll.exists()).toBe(true)

    const toolbarScroll = wrapper.find('.toolbar-scroll-container')
    expect(toolbarScroll.exists()).toBe(true)

    // BaseMap plan-container retains 980px fixed width layout
    const baseMapContainer = wrapper.find('.mower-base-map .plan-container')
    expect(baseMapContainer.exists()).toBe(true)
  })

  // 14. Responsive viewport fit regression guard (body min-width <= 320, no obsolete 1180px min-width)
  it('enforces removal of legacy body 1180px min-width and verifies local overflow containment', () => {
    const globalCssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../styles.css')
    const globalCss = readFileSync(globalCssPath, 'utf-8')

    // Must NOT contain obsolete 1180px min-width
    expect(globalCss).not.toMatch(/min-width:\s*1180px/)
    expect(globalCss).not.toContain('1180px')

    // Body and #app fit narrow viewports down to <= 320px
    expect(globalCss).toMatch(/body[^{]*\{[^}]*min-width:\s*(?:[12]?[0-9]{1,2}|3[01][0-9]|320)px/)
    expect(globalCss).toMatch(/body[^{]*\{[^}]*overflow-x:\s*hidden/)

    // Local horizontal scroll containers exist in mounted shell
    const wrapper = mountWithPinia(WorkbenchShell)
    expect(wrapper.find('.toolbar-scroll-container').exists()).toBe(true)
    expect(wrapper.find('.board-scroll-container').exists()).toBe(true)
  })

  // 15. One-click smart roster generation with preserved user-locked operators
  const LIMITED_TEST_OPS = [
    '但书,2,80', '能天使,2,90', '德克萨斯,2,80', '拉普兰德,2,80', '巫恋,2,80', '龙舌兰,2,80', '柏喙,2,80',
    '砾,2,70', '芬,1,55', '克洛丝,1,55', '伊芙利特,2,90', '白面鸮,2,80', '红豆,1,55',
    '斑点,1,55', '卡达,2,70', '远山,1,60', '梅,2,70', '流星,1,60', '杰克,1,60',
    '夜烟,1,60', '深海色,1,60', '古米,1,60', '蛇屠箱,1,60', '调香师,1,60', '清流,2,70',
    '温蒂,2,90', '森蚺,2,90', '迷迭香,2,90', '琴柳,2,90', '令,2,90', '夕,2,90',
    '槐琥,2,80', '陈,2,90', '阿米娅,2,80', '凯尔希,2,90', '银灰,2,90', '崖心,2,80',
    '暗索,1,60', '雪雉,2,80', '空爆,1,55', '月见夜,1,55', '泡普卡,1,55', '香草,1,55',
    '米格鲁,1,55', '安赛尔,1,55', '芙蓉,1,55', '炎熔,1,55', '史都华德,1,55', '梓兰,1,55',
    '地灵,1,60', '桃金娘,2,70', '极境,2,80', '红,2,80', '食铁兽,2,80', '雷蛇,2,80',
  ]

  // Success fixtures need enough eligible ordinary backups in every facility.
  const FULL_TEST_OPS = OPERATORS.map(o =>
    `${o.name},${o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2},${o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90}`,
  )

  it('applies singleton fallback for a limited mixed-level pool', async ({ annotate }) => {
    await annotate('同步排班前确认测试进度已送达')
    // Four built dorms also need keepers in addition to mains and independent relief staff.
    const withKeepers = [...LIMITED_TEST_OPS, '杜林,0,30', '12F,0,30', 'Lancet-2,0,30', '安德切尔,1,55']
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ enabled: true, text: withKeepers.join('\n') }))
    const vm = mountWithPinia(WorkbenchShell).vm as any
    const original = JSON.stringify(vm.store.workspace)
    vm.handleConfirmSmartRosterConfig({ seed: 42, branchCount: 1, enableDeepSearch: false })
    await flushPromises()
    expect(vm.replaceStatusMessage).toContain('排班成功')
    expect(JSON.stringify(vm.store.workspace)).not.toBe(original)
    for (const room of Object.values(vm.store.workspace.mainPlan.facilities) as import('../../workbench/model').MowerFacility[]) {
      if (room.type === 'dormitory' && room.level > 0) {
        expect(room.slots.some(slot => slot.occupant.kind === 'operator')).toBe(true)
      }
    }
  }, 60000)

  it('keeps the workspace unchanged when the owned pool truly lacks enough people', async () => {
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ enabled: true, text: LIMITED_TEST_OPS.slice(0,5).join('\n') }))
    const vm = mountWithPinia(WorkbenchShell).vm as any
    const original = JSON.stringify(vm.store.workspace)
    vm.handleConfirmSmartRosterConfig({ seed: 42, branchCount: 1, enableDeepSearch: false })
    await flushPromises()
    expect(vm.replaceStatusMessage).toContain('未成功')
    expect(vm.replaceStatusMessage).toContain('主班与独立替补')
    expect(JSON.stringify(vm.store.workspace)).toBe(original)
  },60000)

  // These generation cases execute every branch and final replacement serially in jsdom.
  it('triggers smart roster generation, keeps user placed operators, and updates store', async ({ annotate }) => {
    await annotate('同步排班前确认测试进度已送达')
    localStorage.setItem(
      'arcinc-operator-inventory-v1',
      JSON.stringify({
        enabled: true,
        text: FULL_TEST_OPS.join('\n'),
      })
    )

    const wrapper = mountWithPinia(WorkbenchShell)
    const vm = wrapper.vm as any

    // Pre-place Texas in room_1_1 slot 0
    vm.store.workspace.mainPlan.facilities.room_1_1.slots[0].occupant = {
      kind: 'operator',
      operatorId: 'char_102_texas',
    }

    // Trigger auto generate
    vm.activeTab = 'settings'
    vm.handleAutoGenerate()
    await flushPromises()

    // Verify Texas is preserved in room_1_1 slot 0
    expect(vm.store.workspace.mainPlan.facilities.room_1_1.slots[0].occupant).toEqual({
      kind: 'operator',
      operatorId: 'char_102_texas',
    })

    // Verify success status message
    expect(vm.replaceStatusMessage).toContain('排班成功')
    expect(vm.activeTab).toBe('workbench')
    expect(vm.calculationConfigOpen).toBe(false)
    expect(vm.isCalculating).toBe(false)
    expect(vm.calculationError).toBeNull()
    expect(vm.calculationReport?.summary?.totalScore82).toBeGreaterThan(0)
    expect(wrapper.get('[data-test="metric-lmd"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-test="metric-exp"]').isVisible()).toBe(true)
  }, 180000)

  // 18. Abort roster generation
  it('cancels a pending roster when weights change and ignores its late callbacks after a new task starts', async () => {
    class PendingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage = vi.fn()
      terminate = vi.fn()
      constructor() { pending.push(this) }
    }
    const pending: PendingWorker[] = []
    vi.stubGlobal('Worker', PendingWorker)
    vi.stubEnv('VITEST', '')
    localStorage.setItem('arcinc-operator-inventory-v1', JSON.stringify({ enabled: true, text: '温蒂,2,1\n清流,1,1' }))
    const wrapper = mountWithPinia(WorkbenchShell)
    await flushPromises()
    const weightsA = { ...DEFAULT_PRODUCTION_WEIGHTS, exp: 2 }
    const weightsB = { ...DEFAULT_PRODUCTION_WEIGHTS, exp: 3 }
    const options = { trials: 1, maxStaticEvals: 500, simulationTopK: 1, simulationSampleHours: 24, simulationWarmupHours: 6, enableDeepSearch: false, droneTarget: 'none' as const, seed: 42 }
    wrapper.vm.handleConfirmSmartRosterConfig({ ...options, productionWeights: weightsA })
    expect(wrapper.vm.isGeneratingRoster).toBe(true)
    expect(pending[0]!.terminate).not.toHaveBeenCalled()
    expect(pending[0]!.postMessage.mock.calls[0]![0].options.productionWeights).toEqual(weightsA)
    wrapper.vm.simSettings.productionWeights = { ...weightsA }
    await flushPromises()
    expect(wrapper.vm.isGeneratingRoster).toBe(true)
    expect(pending[0]!.terminate).not.toHaveBeenCalled()
    const lateMessage = pending[0]!.onmessage!
    const lateError = pending[0]!.onerror!
    const outdatedWorkspace = structuredClone(pending[0]!.postMessage.mock.calls[0]![0].base)
    outdatedWorkspace.name = '过期任务 A 排班'
    wrapper.vm.simSettings.productionWeights = weightsB
    await flushPromises()
    expect(pending[0]!.terminate).toHaveBeenCalledOnce()
    expect(wrapper.vm.isGeneratingRoster).toBe(false)
    expect(wrapper.vm.generationProgress).toBeNull()
    expect(wrapper.vm.replaceStatusMessage).toContain('系数已变更')
    expect(wrapper.vm.replaceStatusMessage).toContain('重新生成')
    const unchangedWorkspace = JSON.stringify(wrapper.vm.store.workspace)
    wrapper.vm.handleConfirmSmartRosterConfig({ ...options, productionWeights: weightsB })
    expect(pending).toHaveLength(2)
    expect(wrapper.vm.isGeneratingRoster).toBe(true)
    const currentProgress = { phase: 'building', phaseProgress: .25, label: '任务 B 运行中' }
    pending[1]!.onmessage!({ data: { type: 'progress', progress: currentProgress } } as MessageEvent)
    lateMessage({ data: { type: 'complete', report: { status: 'draft', workspace: outdatedWorkspace, score: 100, diagnostics: [] } } } as MessageEvent)
    lateMessage({ data: { type: 'progress', progress: { phase: 'building', phaseProgress: .9, label: '过期任务 A' } } } as MessageEvent)
    lateError({ message: '过期任务 A 错误' } as ErrorEvent)
    await flushPromises()
    expect(JSON.stringify(wrapper.vm.store.workspace)).toBe(unchangedWorkspace)
    expect(wrapper.vm.simSettings.productionWeights).toEqual(weightsB)
    expect(wrapper.vm.calculationReport).toBeNull()
    expect(wrapper.vm.isCalculating).toBe(false)
    expect(wrapper.vm.isGeneratingRoster).toBe(true)
    expect(wrapper.vm.generationProgress).toEqual(currentProgress)
    expect(pending[1]!.terminate).not.toHaveBeenCalled()
    expect(pending).toHaveLength(2)
    expect(wrapper.vm.replaceStatusMessage).not.toContain('过期任务 A')
  })

  it('aborts active roster generation worker and updates status message', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    wrapper.vm.isGeneratingRoster = true
    wrapper.vm.generationProgress = { phase: 'building', phaseProgress: 0.5, label: '计算中...' }

    wrapper.vm.handleAbortAutoGenerate()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.isGeneratingRoster).toBe(false)
    expect(wrapper.vm.generationProgress).toBeNull()
    expect(wrapper.vm.replaceStatusMessage).toContain('已中止自动排班计算')
  })

  // 19. Switch to skills tab and render RIIC skills browser
  it('switches between workbench and skills tab, displaying riic skills browser', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    expect(wrapper.vm.activeTab).toBe('workbench')

    const skillsTabBtn = wrapper.find('[data-test="tab-skills"]')
    expect(skillsTabBtn.exists()).toBe(true)

    await skillsTabBtn.trigger('click')
    expect(wrapper.vm.activeTab).toBe('skills')

    const skillsPanel = wrapper.find('[data-test="skills-tab-panel"]')
    expect(skillsPanel.exists()).toBe(true)
    expect(skillsPanel.find('[data-test="riic-skills-browser"]').exists()).toBe(true)
  })

  // 19.5 Switch to backup-plans tab and render BackupPlanEditor
  it('switches to backup-plans tab, displaying backup plan editor and updating badge', async () => {
    const wrapper = mountWithPinia(WorkbenchShell)
    expect(wrapper.vm.activeTab).toBe('workbench')

    const vm = wrapper.vm as any
    vm.store.workspace.compatibility.backupPlans = [
      { name: 'Plan 1', trigger_timing: 'BEFORE_PLANNING', trigger: 'True' },
    ]
    await flushPromises()

    const badge = wrapper.find('[data-test="backup-plans-tab-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('1')

    const backupTabBtn = wrapper.find('[data-test="tab-backup-plans"]')
    expect(backupTabBtn.exists()).toBe(true)

    await backupTabBtn.trigger('click')
    expect(wrapper.vm.activeTab).toBe('backup-plans')

    const backupPanel = wrapper.find('[data-test="backup-plans-tab-panel"]')
    expect(backupPanel.exists()).toBe(true)
    expect(backupPanel.find('[data-test="backup-plan-editor"]').exists()).toBe(true)
  })

  // 20. Smart roster config modal interaction and execution
  it('runs a custom configuration successfully with ideal run orders', async ({ annotate }) => {
    await annotate('同步排班前确认测试进度已送达')
    localStorage.setItem(
      'arcinc-operator-inventory-v1',
      JSON.stringify({ enabled: true, text: FULL_TEST_OPS.join('\n') })
    )

    const wrapper = mountWithPinia(WorkbenchShell)
    const vm = wrapper.vm as any

    const originalWorkspace = JSON.stringify(vm.store.workspace)
    vm.smartRosterConfigModalOpen = true
    expect(vm.smartRosterConfigModalOpen).toBe(true)

    vm.handleConfirmSmartRosterConfig({
      trials: 1,
      maxStaticEvals: 500,
      simulationTopK: 1,
      simulationSampleHours: 24,
      simulationWarmupHours: 6,
      enableDeepSearch: false,
      droneTarget: 'gold',
      seed: 42,
    })
    await flushPromises()

    expect(vm.smartRosterConfigModalOpen).toBe(false)
    expect(vm.replaceStatusMessage).toContain('排班成功')
    expect(JSON.stringify(vm.store.workspace)).not.toBe(originalWorkspace)
    expect(vm.calculationConfigOpen).toBe(false)
    expect(vm.calculationReport?.summary).toBeDefined()
    expect(vm.simSettings.droneTarget).toBe('gold')
    expect(vm.simulationReport).toBeNull()
    expect(vm.calculationStatus).toContain('本次排班验证产出')
    expect(wrapper.get('[data-test="results-panel"]').isVisible()).toBe(true)
  }, 180000)
})
