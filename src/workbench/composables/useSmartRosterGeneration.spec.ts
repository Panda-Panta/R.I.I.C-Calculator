// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSmartRosterGeneration } from './useSmartRosterGeneration'
import { useWorkbenchCalculation } from './useWorkbenchCalculation'
import { useWorkbenchPersistence } from './useWorkbenchPersistence'
import { createWorkbenchSession } from '../session'
import { useRosterWorkbenchStore } from '../store'
import { createDefaultConfig } from '../../domain/defaults'
import { calculate } from '../../engine/calculate'
import type { RosterWorkspace } from '../../domain/roster'
import type { SmartRosterResult } from '../../optimizer/smartRoster'

const workers: PendingWorker[] = []
class PendingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { workers.push(this) }
}
let wrapper: VueWrapper
let api: ReturnType<typeof useSmartRosterGeneration>
let session: ReturnType<typeof createWorkbenchSession>
let store: ReturnType<typeof useRosterWorkbenchStore>
const config = { seed: 42, trials: 10, maxStaticEvals: 500, simulationTopK: 10,
  simulationSampleHours: 24, simulationWarmupHours: 6, enableDeepSearch: false, droneTarget: 'none' as const }
function completed(workspace: RosterWorkspace): SmartRosterResult {
  return { status: 'draft', workspace, score: 100, calculationReport: calculate(createDefaultConfig()), diagnostics: [], specialOperators: [],
    phases: { static: { candidates: [], bestScore: 100 }, simulation: null, search: null } }
}
const deliver = (callback: NonNullable<PendingWorker['onmessage']>, report: SmartRosterResult) => callback({ data: { type: 'complete', report } } as MessageEvent)

beforeEach(() => {
  workers.length = 0; localStorage.clear()
  vi.stubGlobal('Worker', PendingWorker); vi.stubEnv('VITEST', '')
  setActivePinia(createPinia()); store = useRosterWorkbenchStore(); session = createWorkbenchSession()
  session.operatorInventory.value = { enabled: true, valid: true, entries: [{ operator: '芬', elitePhase: 1, level: 55 }] }
  wrapper = mount(defineComponent({ setup() {
    api = useSmartRosterGeneration(store, session)
    useWorkbenchCalculation(store, session, computed(() => ({ isValid: true, criticalErrors: [], warnings: [], issues: [], power: { generation: 810, consumption: 810, margin: 0, sufficient: true } })))
    useWorkbenchPersistence(store, session)
    return () => h('div')
  } }))
})
afterEach(() => { wrapper.unmount(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('uses two stages for a legacy request without a deep-search choice', () => {
  const legacy = { ...config }
  Reflect.deleteProperty(legacy, 'enableDeepSearch')
  api.handleConfirmSmartRosterConfig(legacy)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.enableDeepSearch).toBe(false)
})

it('requests one initial roster independently of legacy candidate counts while preserving explicit simulation settings', () => {
  const saved = { ...config, trials: 17, simulationTopK: 11, maxStaticEvals: 7000, simulationSampleHours: 72, simulationWarmupHours: 24 }
  const before = structuredClone(saved)
  api.handleConfirmSmartRosterConfig(saved)
  const options = workers[0]!.postMessage.mock.calls[0]![0].options
  expect(options).toMatchObject({
    branchCount: 1, seed: 42, simulationSampleHours: 72, simulationWarmupHours: 24, enableDeepSearch: false,
  })
  expect(options).not.toHaveProperty('trials')
  expect(options).not.toHaveProperty('simulationTopK')
  expect(options).not.toHaveProperty('maxStaticEvals')
  expect(saved).toEqual(before)
})

it('preserves an explicit optional deep-search request', () => {
  api.handleConfirmSmartRosterConfig({ ...config, enableDeepSearch: true })
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.enableDeepSearch).toBe(true)
})

it.each(['primary', 'facility', 'policy', 'backup', 'import'] as const)('keeps a newer %s edit when a pending generation returns its older snapshot', kind => {
  api.handleConfirmSmartRosterConfig(config)
  const callback = workers[0]!.onmessage!, original = workers[0]!.postMessage.mock.calls[0]![0].base as RosterWorkspace
  if (kind === 'primary') store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_102_texas' })
  else if (kind === 'facility') store.updateFacility('room_1_1', { product: 'exp' })
  else if (kind === 'policy') store.updateConf({ rest_in_full: ['char_102_texas'] })
  else if (kind === 'backup') store.workspace.compatibility.backupPlans.push({ name: 'new', trigger: 'False' })
  else store.loadWorkspace({ ...original, name: 'new imported plan' })
  const edited = JSON.stringify(store.workspace)
  deliver(callback, completed(original))
  expect(JSON.stringify(store.workspace)).toBe(edited)
  expect(session.isGeneratingRoster.value).toBe(false)
  expect(session.calculationReport.value).toBeNull()
  expect(session.replaceStatusMessage.value).toContain('已变更')
})

it('accepts its own completed workspace and report after its weight initialization without cancelling itself', async () => {
  api.handleConfirmSmartRosterConfig({ ...config, productionWeights: { exp: 2, gold: .8, orders: .2, fragments: 0, orundum: 0 } })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.workspace!.name = 'generated plan'
  store.selectRoom('central')
  deliver(workers[0]!.onmessage!, report)
  await nextTick()
  expect(store.workspace.name).toBe('generated plan')
  expect(session.calculationReport.value).toEqual(report.calculationReport)
  expect(session.isGeneratingRoster.value).toBe(false)
  expect(session.replaceStatusMessage.value).toContain('排班成功')
})

it.each([
  { status: 'limited', message: '已到计算预算' },
  { status: 'invalid', message: '分配优化未完成，已验证并保留初始方案' },
  { status: 'unsupported', message: '当前配置未进入制造组优化' },
] as const)('shows the $status allocation outcome without invalidating its verified report', async ({ status, message }) => {
  api.handleConfirmSmartRosterConfig(config)
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.workspace!.name = `verified ${status}`
  report.phases.calculation = { status, libraryComplete: status !== 'limited', columnCount: 2, quantifiedColumnCount: 2,
    initialObjective: 100, frozenComponents: [], elapsedMs: 1, proofScope: 'quantified-manufacturing-model-only' }
  deliver(workers[0]!.onmessage!, report)
  await nextTick()
  expect(store.workspace.name).toBe(`verified ${status}`)
  expect(session.calculationReport.value).toEqual(report.calculationReport)
  expect(session.calculationStatus.value).toContain('本次排班验证产出')
  expect(session.replaceStatusMessage.value).toContain(message)
  expect(session.replaceStatusMessage.value).toContain('100.0 分/日')
  expect(session.calculationError.value).toBeNull()
  expect(session.isGeneratingRoster.value).toBe(false)
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
})

it('does not label a non-budget supported-scope limit as an exhausted budget', async () => {
  api.handleConfirmSmartRosterConfig(config)
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.phases.calculation = { status: 'limited', libraryComplete: true, columnCount: 3, quantifiedColumnCount: 2,
    initialObjective: 100, frozenComponents: [], elapsedMs: 1, proofScope: 'quantified-manufacturing-model-only' }
  deliver(workers[0]!.onmessage!, report)
  await nextTick()
  expect(session.replaceStatusMessage.value).toContain('分配计算受当前支持范围限制')
  expect(session.replaceStatusMessage.value).not.toContain('已到计算预算')
  expect(session.calculationReport.value).toEqual(report.calculationReport)
})

it('keeps the normal success wording for a complete allocation', () => {
  api.handleConfirmSmartRosterConfig(config)
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.phases.calculation = { status: 'complete', libraryComplete: true, columnCount: 2, quantifiedColumnCount: 2,
    initialObjective: 100, frozenComponents: [], elapsedMs: 1, proofScope: 'quantified-manufacturing-model-only' }
  deliver(workers[0]!.onmessage!, report)
  expect(session.replaceStatusMessage.value).toBe('一键排班成功！已保留当前建筑与已配置干员，并采用完整仿真确认的排班（加权预测：100.0 分/日）。')
})

it('does not call an optional deep-comparison winner the initial roster after allocation failed', () => {
  api.handleConfirmSmartRosterConfig({ ...config, enableDeepSearch: true })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.phases.calculation = { status: 'invalid', libraryComplete: true, columnCount: 2, quantifiedColumnCount: 2,
    initialObjective: 100, frozenComponents: [], elapsedMs: 1, proofScope: 'quantified-manufacturing-model-only' }
  deliver(workers[0]!.onmessage!, report)
  expect(session.replaceStatusMessage.value).toContain('分配优化未完成，已采用完整仿真验证的方案')
  expect(session.replaceStatusMessage.value).not.toContain('保留初始方案')
  expect(session.calculationReport.value).toEqual(report.calculationReport)
})

it('ignores cancelled callbacks after weights change and a new generation starts', () => {
  api.handleConfirmSmartRosterConfig(config)
  const callback = workers[0]!.onmessage!, stale = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  stale.workspace!.name = 'stale'
  session.simSettings.value.productionWeights = { exp: 3, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  api.handleConfirmSmartRosterConfig(config)
  deliver(callback, stale)
  expect(store.workspace.name).not.toBe('stale')
  expect(session.isGeneratingRoster.value).toBe(true)
  const current = completed(workers[1]!.postMessage.mock.calls[0]![0].base)
  current.workspace!.name = 'current'
  deliver(workers[1]!.onmessage!, current)
  expect(store.workspace.name).toBe('current')
})

it('ignores a captured generation callback after unmounting', () => {
  api.handleConfirmSmartRosterConfig(config)
  const callback = workers[0]!.onmessage!, stale = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  const previous = JSON.stringify(store.workspace)
  stale.workspace!.name = 'after unmount'
  wrapper.unmount()
  deliver(callback, stale)
  expect(JSON.stringify(store.workspace)).toBe(previous)
  expect(session.calculationReport.value).toBeNull()
})
