// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchCalculation } from './useWorkbenchCalculation'
import { createWorkbenchSession } from '../session'
import { useRosterWorkbenchStore } from '../store'
import type { CalculationWorkerMessage } from '../calculationWorker'
import type { SimulationActivity } from '../../simulator/simulationActivity'
import { createCalculationResultSender, type CalculationResultMessage, type CalculationResultPayload } from '../calculationResultTransport'
import { calculate } from '../../engine/calculate'
import { createDefaultConfig } from '../../domain/defaults'

const workers: TestWorker[] = []
class TestWorker {
  onmessage: ((event: MessageEvent<CalculationWorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { workers.push(this) }
  progress(activity?: SimulationActivity) { this.onmessage?.({ data: { type: 'progress', progress: { label: '正在采样', fraction: .99, activity } } } as MessageEvent<CalculationWorkerMessage>) }
}
let wrapper: VueWrapper
let api: ReturnType<typeof useWorkbenchCalculation>
let session: ReturnType<typeof createWorkbenchSession>
let store: ReturnType<typeof useRosterWorkbenchStore>
const start = () => api.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '', useOperatorInventory: false })
const slow: SimulationActivity = { status: 'slow', message: 'slow', capturedHours: 5, windowSeconds: 15, advancedHours: 0, iterations: 10, operators: [], recentEvents: [] }

async function chunkedResult() {
  const payload: CalculationResultPayload = {
    result: { success: true, report: { power: { generation: 0, consumption: 0, margin: 0, sufficient: true }, layoutValid: true,
      validationMessages: ['完整结果'.repeat(1000)], manufacture: [], trading: [], drones: 0, morale: [], roomShiftDetails: {}, summary: null },
    validation: { isValid: true, criticalErrors: [], warnings: [], issues: [], power: { generation: 0, consumption: 0, margin: 0, sufficient: true } } },
    timelineData: { totalHours: 744, warmupHours: 72, observedHours: 672, facilityTracks: [], operatorTracks: [], events: [] },
  }
  const messages: CalculationResultMessage[] = []
  const sender = createCalculationResultSender(message => {
    messages.push(message)
    if (message.type === 'result-chunk') queueMicrotask(() => sender.acknowledge(message.sequence))
  }, { maxChunkBytes: 2048 })
  await sender.sendResult(payload)
  return { payload, messages }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  localStorage.clear()
  workers.length = 0
  vi.stubGlobal('Worker', TestWorker)
  setActivePinia(createPinia())
  store = useRosterWorkbenchStore()
  session = createWorkbenchSession()
  wrapper = mount(defineComponent({ setup() {
    api = useWorkbenchCalculation(store, session, computed(() => ({ isValid: true, criticalErrors: [], warnings: [], issues: [], power: { generation: 0, consumption: 0, margin: 0, sufficient: true } })))
    return () => h('div')
  } }))
})
afterEach(() => { wrapper.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it.each(['primary', 'facility', 'policy', 'backup', 'weights'] as const)('invalidates a completed income report after a %s change', kind => {
  start()
  const report = calculate(createDefaultConfig())
  workers[0]!.onmessage?.({ data: { type: 'complete', result: { success: true, report }, timelineData: null } } as MessageEvent<CalculationWorkerMessage>)
  expect(session.calculationReport.value).toEqual(report)
  if (kind === 'primary') store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_102_texas' })
  else if (kind === 'facility') store.updateFacility('room_1_1', { product: 'exp' })
  else if (kind === 'policy') store.updateConf({ rest_in_full: ['char_102_texas'] })
  else if (kind === 'backup') store.workspace.compatibility.backupPlans.push({ trigger: 'False' })
  else store.workspace.productionWeights = { exp: 2, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  expect(session.calculationReport.value).toBeNull()
  expect(session.simulationReport.value).toBeNull()
  expect(session.timelineData.value).toBeNull()
  expect(session.calculationStatus.value).toContain('重新计算')
})

it('keeps a completed report while changing only the selected editor room', () => {
  start()
  const report = calculate(createDefaultConfig())
  workers[0]!.onmessage?.({ data: { type: 'complete', result: { success: true, report }, timelineData: null } } as MessageEvent<CalculationWorkerMessage>)
  store.selectRoom('central')
  expect(session.calculationReport.value).toEqual(report)
})

it('requests a fresh crypto uint32 for every production-mode random-seed request without persisting it', () => {
  vi.stubEnv('VITEST', '')
  const pseudoRandom = vi.spyOn(Math, 'random').mockReturnValue(.25)
  const values = [0xffffffff, 0]
  const random = vi.fn((array: Uint32Array) => {
    expect(array).toBeInstanceOf(Uint32Array)
    expect(array).toHaveLength(1)
    array[0] = values.shift()!
    return array
  })
  vi.stubGlobal('crypto', { getRandomValues: random })
  expect(session.simSettings.value.seed).toBe(-1)
  start()
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions.production.seed).toBe(0xffffffff)
  api.handleAbortCalculation()
  start()
  expect(workers[1]!.postMessage.mock.calls[0]![0].options.simulationOptions.production.seed).toBe(0)
  expect(random).toHaveBeenCalledTimes(2)
  expect(random.mock.calls[0]![0]).not.toBe(random.mock.calls[1]![0])
  expect(pseudoRandom).not.toHaveBeenCalled()
  expect(session.simSettings.value.seed).toBe(-1)
})

it.each([0, 42, 0xffffffff])('preserves explicit seed %d without requesting randomness', seed => {
  vi.stubEnv('VITEST', '')
  const random = vi.fn(() => { throw new Error('explicit seed must not request randomness') })
  vi.stubGlobal('crypto', { getRandomValues: random })
  session.simSettings.value.seed = seed
  start()
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions.production.seed).toBe(seed)
  expect(random).not.toHaveBeenCalled()
  expect(session.calculationError.value).toBeNull()
})

it('preserves the existing VITEST mock-request seed without borrowing crypto randomness', () => {
  vi.stubEnv('VITEST', 'true')
  const random = vi.fn(() => { throw new Error('test branch must not request randomness') })
  vi.stubGlobal('crypto', { getRandomValues: random })
  start()
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions.production.seed).toBe(42)
  expect(random).not.toHaveBeenCalled()
})

it.each(['unavailable', 'throws'] as const)('shows a %s crypto failure before starting a worker and permits a fresh retry', kind => {
  vi.stubEnv('VITEST', '')
  const pseudoRandom = vi.spyOn(Math, 'random').mockReturnValue(.25)
  vi.stubGlobal('crypto', kind === 'unavailable' ? undefined : { getRandomValues() { throw new Error('crypto request failed') } })
  start()
  expect(workers).toHaveLength(0)
  expect(session.isCalculating.value).toBe(false)
  expect(session.calculationError.value).toContain('无法启动后台计算')
  expect(session.calculationError.value).toContain(kind === 'unavailable' ? '安全随机数' : 'crypto request failed')
  expect(api.calculationBottleneckSummary.value?.outcome).toBe('failed')
  expect(session.calculationReport.value).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  expect(pseudoRandom).not.toHaveBeenCalled()
  const random = vi.fn((array: Uint32Array) => { array[0] = 123456789; return array })
  vi.stubGlobal('crypto', { getRandomValues: random })
  start()
  expect(random).toHaveBeenCalledOnce()
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.simulationOptions.production.seed).toBe(123456789)
  expect(session.calculationError.value).toBeNull()
})

it('detects missing initial progress after 15 seconds without terminating the worker', () => {
  start()
  vi.advanceTimersByTime(14_999)
  expect(api.calculationSilence.value).toBeNull()
  vi.advanceTimersByTime(1)
  expect(api.calculationSilence.value).toEqual({ seconds: 15, lastProgressSeconds: null })
  expect(api.calculationTiming.value).toContain('暂无法估算')
  expect(workers[0]!.terminate).not.toHaveBeenCalled()
  expect(session.isCalculating.value).toBe(true)
})

it('retains last progress time, suppresses ETA for slow and silent work, and recovers on a new message', () => {
  start()
  vi.advanceTimersByTime(2000)
  workers[0]!.progress(slow)
  expect(api.calculationTiming.value).toContain('暂无法估算')
  expect(api.calculationTiming.value).not.toContain('即将完成')
  vi.advanceTimersByTime(15000)
  expect(api.calculationSilence.value).toMatchObject({ seconds: 15, lastProgressSeconds: 2 })
  expect(api.calculationProgress.value?.activity).toEqual(slow)
  workers[0]!.progress({ ...slow, status: 'running' })
  expect(api.calculationSilence.value).toBeNull()
  expect(api.calculationTiming.value).toContain('即将完成')
  vi.advanceTimersByTime(14000)
  expect(api.calculationSilence.value).toBeNull()
})

it('clears silence on cancellation and excludes progress and errors from an old worker', () => {
  start()
  vi.advanceTimersByTime(15000)
  api.handleAbortCalculation()
  expect(api.calculationSilence.value).toBeNull()
  expect(api.calculationProgress.value).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  start()
  workers[0]!.progress(slow)
  workers[0]!.onerror?.({ message: 'obsolete' } as ErrorEvent)
  expect(api.calculationProgress.value?.activity).toBeUndefined()
  expect(session.calculationError.value).toBeNull()
  vi.advanceTimersByTime(15000)
  expect(api.calculationSilence.value?.lastProgressSeconds).toBeNull()
  expect(session.isCalculating.value).toBe(true)
})

it('retains the last observation during a silent report summary without marking responsive summary as slow', () => {
  start()
  vi.advanceTimersByTime(2000)
  workers[0]!.progress(slow)
  vi.advanceTimersByTime(1000)
  workers[0]!.onmessage?.({ data: { type: 'progress', progress: { label: '正在汇总产出报告…', fraction: .99 } } } as MessageEvent<CalculationWorkerMessage>)
  expect(api.calculationProgress.value?.activity).toBeUndefined()
  expect(api.calculationTiming.value).toContain('即将完成')
  vi.advanceTimersByTime(15000)
  expect(api.calculationSilence.value).toEqual({ seconds: 15, lastProgressSeconds: 3, observation: { activity: slow, receivedSeconds: 2 } })
  expect(api.calculationTiming.value).toContain('暂无法估算')
  api.handleAbortCalculation()
  start()
  vi.advanceTimersByTime(15000)
  expect(api.calculationSilence.value?.observation).toBeUndefined()
})

it.each(['error', 'messageerror', 'reported-error', 'complete'] as const)('cleans timers and observations after %s and allows a new calculation', kind => {
  start()
  workers[0]!.progress(slow)
  vi.advanceTimersByTime(15000)
  if (kind === 'error') workers[0]!.onerror?.({ message: 'failed' } as ErrorEvent)
  else if (kind === 'messageerror') workers[0]!.onmessageerror?.()
  else if (kind === 'reported-error') workers[0]!.onmessage?.({ data: { type: 'error', error: 'failed' } } as MessageEvent<CalculationWorkerMessage>)
  else workers[0]!.onmessage?.({ data: { type: 'complete', result: { success: false, error: 'no result' }, timelineData: null } } as MessageEvent<CalculationWorkerMessage>)
  expect(session.isCalculating.value).toBe(false)
  expect(api.calculationSilence.value).toBeNull()
  expect(api.calculationProgress.value).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  expect(api.calculationBottleneckSummary.value).toMatchObject({ outcome: 'failed', latest: { activity: slow } })
  expect(api.calculationBottleneckSummary.value?.error).toBeTruthy()
  start()
  expect(session.calculationError.value).toBeNull()
  expect(session.isCalculating.value).toBe(true)
  expect(api.calculationSilence.value).toBeNull()
})

it('discards observations when the roster changes or the component unmounts', () => {
  start()
  workers[0]!.progress(slow)
  vi.advanceTimersByTime(15000)
  store.workspace.name = 'changed'
  expect(api.calculationSilence.value).toBeNull()
  expect(session.isCalculating.value).toBe(false)
  start()
  wrapper.unmount()
  expect(workers[1]!.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps historical slow observations after recovery and manual stop until the next run', () => {
  start()
  vi.advanceTimersByTime(15000)
  workers[0]!.progress(slow)
  vi.advanceTimersByTime(1000)
  workers[0]!.progress({ ...slow, status: 'running', capturedHours: 20 })
  vi.advanceTimersByTime(15000)
  api.handleAbortCalculation()
  expect(api.calculationBottleneckSummary.value).toMatchObject({
    outcome: 'cancelled', elapsedSeconds: 31,
    slowest: { receivedSeconds: 15, activity: { capturedHours: 5 } },
    latest: { receivedSeconds: 16, activity: { capturedHours: 20 } },
    silence: { seconds: 15, lastProgressSeconds: 16 },
  })
  const saved = api.calculationBottleneckSummary.value
  workers[0]!.progress(slow)
  workers[0]!.onmessageerror?.()
  expect(api.calculationBottleneckSummary.value).toBe(saved)
  api.handleCalculate()
  expect(api.calculationBottleneckSummary.value).toBe(saved)
  start()
  expect(api.calculationBottleneckSummary.value).toBeNull()
  workers[0]!.onerror?.({ message: 'obsolete' } as ErrorEvent)
  expect(api.calculationBottleneckSummary.value).toBeNull()
})
it('preserves roster change evidence and startup failures without borrowing the previous run', () => {
  start()
  workers[0]!.progress(slow)
  store.workspace.name = 'changed'
  expect(api.calculationBottleneckSummary.value).toMatchObject({ outcome: 'changed', latest: { activity: slow } })
  vi.stubGlobal('Worker', class { constructor() { throw new Error('startup failed') } })
  start()
  expect(api.calculationBottleneckSummary.value).toMatchObject({ outcome: 'failed', error: '无法启动后台计算：startup failed', diagnostics: [] })
  expect(api.calculationBottleneckSummary.value?.latest).toBeUndefined()
})

it('publishes a chunked result only after the complete stream closes and acknowledges every applied chunk', async () => {
  const { payload, messages } = await chunkedResult()
  start()
  const worker = workers[0]!
  for (const message of messages.slice(0, -1)) {
    worker.onmessage?.({ data: message } as MessageEvent<CalculationWorkerMessage>)
    expect(session.isCalculating.value).toBe(true)
    expect(session.calculationReport.value).toBeNull()
    expect(session.simulationReport.value).toBeNull()
    expect(session.timelineData.value).toBeNull()
  }
  expect(worker.postMessage.mock.calls.slice(1).map(([message]) => message)).toEqual(messages.filter(message => message.type === 'result-chunk').map(message => ({ type: 'result-ack', sequence: message.sequence })))
  worker.onmessage?.({ data: messages[messages.length - 1]! } as MessageEvent<CalculationWorkerMessage>)
  expect(session.isCalculating.value).toBe(false)
  expect(session.calculationReport.value).toEqual(payload.result.report)
  expect(session.timelineData.value).toEqual(payload.timelineData)
  expect(api.calculationBottleneckSummary.value?.outcome).toBe('completed')
  expect(worker.onmessage).toBeNull()
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('treats arriving report chunks as heartbeats while retaining the last scheduler observation', async () => {
  const { messages } = await chunkedResult()
  start()
  workers[0]!.progress(slow)
  for (const message of messages) {
    vi.advanceTimersByTime(14000)
    workers[0]!.onmessage?.({ data: message } as MessageEvent<CalculationWorkerMessage>)
    expect(api.calculationSilence.value).toBeNull()
  }
  expect(api.calculationBottleneckSummary.value).toMatchObject({ outcome: 'completed', latest: { activity: slow } })
  expect(api.calculationBottleneckSummary.value?.silence).toBeUndefined()
  expect(api.calculationBottleneckSummary.value?.progressLabel).toBe('正在整理计算结果…')
})

it('discards a cancelled partial tree and excludes captured callbacks from that worker after restart', async () => {
  const { payload, messages } = await chunkedResult()
  start()
  const oldMessage = workers[0]!.onmessage!
  for (const message of messages.slice(0, 2)) oldMessage({ data: message } as MessageEvent<CalculationWorkerMessage>)
  api.handleAbortCalculation()
  expect(session.calculationReport.value).toBeNull()
  expect(session.timelineData.value).toBeNull()
  start()
  for (const message of messages.slice(2)) oldMessage({ data: message } as MessageEvent<CalculationWorkerMessage>)
  oldMessage({ data: { type: 'error', error: 'old failed stream' } } as MessageEvent<CalculationWorkerMessage>)
  expect(session.isCalculating.value).toBe(true)
  expect(session.calculationError.value).toBeNull()
  expect(workers[1]!.postMessage).toHaveBeenCalledTimes(1)
  for (const message of messages) workers[1]!.onmessage?.({ data: message } as MessageEvent<CalculationWorkerMessage>)
  expect(session.calculationReport.value).toEqual(payload.result.report)
})

it.each(['sequence', 'truncated', 'decode', 'ack-send', 'worker-error'] as const)('fails a %s stream without publishing a partial result and permits restart', async kind => {
  const { messages } = await chunkedResult()
  start()
  const worker = workers[0]!
  const deliver = (message: CalculationWorkerMessage) => worker.onmessage?.({ data: message } as MessageEvent<CalculationWorkerMessage>)
  deliver(messages[0]!)
  if (kind === 'sequence') deliver({ type: 'result-chunk', sequence: 9, records: [{ kind: 'value', key: null, value: {} }] })
  else if (kind === 'truncated') deliver(messages[messages.length - 1]!)
  else if (kind === 'decode') deliver({ type: 'result-chunk', sequence: 0, records: [{ kind: 'close' }] })
  else if (kind === 'ack-send') {
    worker.postMessage.mockImplementation(() => { throw new Error('ack send failed') })
    deliver(messages[1]!)
  } else deliver({ type: 'error', error: 'worker failed during transfer' })
  expect(session.isCalculating.value).toBe(false)
  expect(session.calculationError.value).toBeTruthy()
  expect(session.calculationReport.value).toBeNull()
  expect(session.simulationReport.value).toBeNull()
  expect(session.timelineData.value).toBeNull()
  expect(api.calculationBottleneckSummary.value?.outcome).toBe('failed')
  expect(worker.onmessage).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  start()
  expect(session.isCalculating.value).toBe(true)
  expect(session.calculationError.value).toBeNull()
})

it('terminates an incomplete transfer when the roster changes or the component unmounts', async () => {
  const { messages } = await chunkedResult()
  start()
  workers[0]!.onmessage?.({ data: messages[0]! } as MessageEvent<CalculationWorkerMessage>)
  store.workspace.name = 'changed while receiving'
  expect(session.isCalculating.value).toBe(false)
  expect(session.calculationReport.value).toBeNull()
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  start()
  workers[1]!.onmessage?.({ data: messages[0]! } as MessageEvent<CalculationWorkerMessage>)
  wrapper.unmount()
  expect(workers[1]!.terminate).toHaveBeenCalledOnce()
  expect(workers[1]!.onmessage).toBeNull()
  expect(session.calculationReport.value).toBeNull()
})
