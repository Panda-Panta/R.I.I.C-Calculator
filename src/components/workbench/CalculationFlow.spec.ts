// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
vi.hoisted(() => {
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  if (typeof window !== 'undefined') window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})
import WorkbenchShell from './WorkbenchShell.vue'
import PlanToolbar from './PlanToolbar.vue'

const workers: TestWorker[] = []
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { workers.push(this) }
}
let wrapper: VueWrapper<any>
beforeEach(() => {
  localStorage.clear()
  workers.length = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('Worker', TestWorker)
  wrapper = mount(WorkbenchShell, { global: { plugins: [createPinia()] } })
})
afterEach(() => { wrapper.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('asks for drone settings before launching a cancellable background calculation', async () => {
  await wrapper.get('[data-test="tab-settings"]').trigger('click')
  expect(wrapper.find('[data-test="jaye-elite0-select"]').exists()).toBe(false)
  await wrapper.get('[data-test="fiammetta-fool"]').setValue('false')
  await wrapper.get('[data-test="fiammetta-threshold"]').setValue('80')
  await wrapper.get('[data-test="resting-threshold"]').setValue('70')
  await wrapper.get('[data-test="rescue-threshold"]').setValue('90')
  await wrapper.get('[data-test="free-room"]').setValue('true')
  await wrapper.get('[data-test="tab-workbench"]').trigger('click')
  await wrapper.get('[data-test="calc-btn"]').trigger('click')
  expect(wrapper.vm.calculationConfigOpen).toBe(true)
  expect(workers).toHaveLength(0)
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'trading', droneTradingRoomId: 'room_3_1' })
  await wrapper.vm.$nextTick()
  expect(workers).toHaveLength(1)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationAssumptions).toEqual({ fiammettaFool: false, fiammettaThreshold: .8, restingThreshold: .7, rescueThreshold: .9, freeRoom: true })
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions.production).toMatchObject({
    droneTarget: 'trading', droneTradingRoomId: 'room_3_1',
  })
  workers[0]!.onmessage!({ data: { type: 'progress', progress: { label: '正在采样 12 / 24 小时', fraction: .5 } } } as MessageEvent)
  await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-test="calculation-progress-row"]').text()).toContain('正在采样')
  expect(wrapper.get('[data-test="calc-btn"]').attributes('disabled')).toBeDefined()
  const staleMessage = workers[0]!.onmessage!
  await wrapper.get('[data-test="abort-calculation-btn"]').trigger('click')
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  expect(wrapper.vm.isCalculating).toBe(false)
  wrapper.vm.handleCalculate()
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  staleMessage({ data: { type: 'error', error: 'obsolete failure' } } as MessageEvent)
  expect(wrapper.vm.isCalculating).toBe(true)
  expect(wrapper.vm.calculationError).toBeNull()
  wrapper.unmount()
  expect(workers[1]!.terminate).toHaveBeenCalledOnce()
})

it('cancels an active snapshot when the roster changes and reports worker failures without blocking fallback', async () => {
  wrapper.vm.handleCalculate()
  expect(workers).toHaveLength(0)
  expect(wrapper.vm.calculationConfigOpen).toBe(true)
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  wrapper.vm.store.workspace.name = 'changed roster'
  await wrapper.vm.$nextTick()
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  expect(wrapper.vm.isCalculating).toBe(false)
  wrapper.vm.handleCalculate()
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  workers[1]!.onerror!({ message: 'worker failed' } as ErrorEvent)
  await wrapper.vm.$nextTick()
  expect(wrapper.vm.isCalculating).toBe(false)
  expect(wrapper.vm.calculationError).toContain('worker failed')
  expect(wrapper.findComponent(PlanToolbar).props('isCalculating')).toBe(false)
})

it('estimates remaining time from real progress and resets timing on restart', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-test="calculation-progress-row"]').text()).toContain('估算中')
  workers[0]!.onmessage!({ data: { type: 'progress', progress: { label: '正在采样', fraction: .25 } } } as MessageEvent)
  vi.advanceTimersByTime(10000)
  await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-test="calculation-progress-row"]').text()).toContain('约剩余 30 秒')
  await wrapper.get('[data-test="abort-calculation-btn"]').trigger('click')
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  await wrapper.vm.$nextTick()
  expect(wrapper.get('[data-test="calculation-progress-row"]').text()).toContain('已用 0 秒')
  expect(wrapper.get('[data-test="calculation-progress-row"]').text()).toContain('估算中')
})

it('shows a recoverable error when workers are unavailable instead of running on the UI thread', async () => {
  vi.stubGlobal('Worker', class { constructor() { throw new Error('worker unavailable') } })
  wrapper.vm.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '' })
  await wrapper.vm.$nextTick()
  expect(wrapper.vm.isCalculating).toBe(false)
  expect(wrapper.vm.calculationReport).toBeNull()
  expect(wrapper.get('[data-test="calculation-error"]').text()).toContain('worker unavailable')
  expect(wrapper.get('[data-test="calc-btn"]').attributes('disabled')).toBeUndefined()
})

it('can ignore the current inventory and forwards the exact manufacturing room',()=>{
 wrapper.vm.handleInventoryChange({enabled:true,valid:true,entries:[{operatorId:'芬',elite:0,level:1}]})
 wrapper.vm.handleConfirmCalculation({droneTarget:'gold',droneTradingRoomId:'',droneRoomId:'room_1_2',useOperatorInventory:false})
 const options=workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions
 expect(options.operatorInventory).toBeUndefined()
 expect(options.production.droneRoomId).toBe('room_1_2')
 wrapper.vm.handleAbortCalculation()
 wrapper.vm.handleConfirmCalculation({droneTarget:'none',droneTradingRoomId:'',useOperatorInventory:true})
 expect(workers[1]!.postMessage.mock.calls[0]![0].options.simulationOptions.operatorInventory).toHaveLength(1)
})
