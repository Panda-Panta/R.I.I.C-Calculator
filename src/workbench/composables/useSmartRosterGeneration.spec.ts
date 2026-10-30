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
import { EDITION } from '../../domain/edition'
import { exportMowerJson } from '../compat/mowerJson'

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
let calculationApi: ReturnType<typeof useWorkbenchCalculation>
const config = { seed: 42, trials: 10, maxStaticEvals: 500, simulationTopK: 10,
  simulationSampleHours: 24, simulationWarmupHours: 6, enableDeepSearch: false, droneTarget: 'none' as const }
function completed(workspace: RosterWorkspace): SmartRosterResult {
  return { status: 'draft', workspace, score: 100, calculationReport: calculate(createDefaultConfig()), diagnostics: [], specialOperators: [],
    phases: { static: { candidates: [], bestScore: 100 }, simulation: null, search: null } }
}
const deliver = (callback: NonNullable<PendingWorker['onmessage']>, report: SmartRosterResult) => callback({ data: { type: 'complete', report } } as MessageEvent)
const deliverIncumbent = (callback: NonNullable<PendingWorker['onmessage']>, report: SmartRosterResult) => callback({ data: { type: 'incumbent', report } } as MessageEvent)

beforeEach(() => {
  workers.length = 0; localStorage.clear()
  vi.stubGlobal('Worker', PendingWorker); vi.stubEnv('VITEST', '')
  setActivePinia(createPinia()); store = useRosterWorkbenchStore(); session = createWorkbenchSession()
  session.operatorInventory.value = { enabled: true, valid: true, entries: [{ operator: '芬', elitePhase: 1, level: 55 }] }
  wrapper = mount(defineComponent({ setup() {
    api = useSmartRosterGeneration(store, session)
    calculationApi = useWorkbenchCalculation(store, session, computed(() => ({ isValid: true, criticalErrors: [], warnings: [], issues: [], power: { generation: 810, consumption: 810, margin: 0, sufficient: true } })))
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

it('defaults legacy requests to no conditional backup generation', () => {
  api.handleConfirmSmartRosterConfig(config)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.enableBackupGeneration).toBe(false)
})

it('defaults legacy requests to fast generation without freely combining presets or extra optimization', () => {
  api.handleConfirmSmartRosterConfig(config)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options).toMatchObject({
    enableMainOptimization: false, allowFreeCombinations: false, optimizationMaxSimulations: 3, optimizationTimeBudgetMs: 30000,
  })
})

it('forwards explicit main optimization and free-combination budgets without changing the config', () => {
  const incoming = { ...config, enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: 5, optimizationTimeBudgetMs: 90000 }
  const original = structuredClone(incoming)
  api.handleConfirmSmartRosterConfig(incoming)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options).toMatchObject({
    enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: 5, optimizationTimeBudgetMs: 90000,
  })
  expect(incoming).toEqual(original)
})

it('bounds extra simulation work and requires true for either main optimization option', () => {
  const incoming = { ...config, optimizationMaxSimulations: 100, optimizationTimeBudgetMs: 1000000 }
  Reflect.set(incoming, 'enableMainOptimization', 'true')
  Reflect.set(incoming, 'allowFreeCombinations', 'true')
  api.handleConfirmSmartRosterConfig(incoming)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options).toMatchObject({
    enableMainOptimization: false, allowFreeCombinations: false, optimizationMaxSimulations: 8, optimizationTimeBudgetMs: 300000,
  })
})

it('keeps confirmed snapshots private until manual stop, then adopts the best roster and its same-run report', async () => {
  api.handleConfirmSmartRosterConfig({ ...config, enableMainOptimization: true })
  const worker = workers[0]!, callback = worker.onmessage!
  const original = JSON.stringify(store.workspace)
  const report = completed(worker.postMessage.mock.calls[0]![0].base)
  report.workspace!.name = 'confirmed best'
  deliverIncumbent(callback, report)
  expect(JSON.stringify(store.workspace)).toBe(original)
  expect(session.calculationReport.value).toBeNull()
  expect(session.isGeneratingRoster.value).toBe(true)
  expect(api.hasVerifiedIncumbent.value).toBe(true)
  expect(worker.terminate).not.toHaveBeenCalled()
  const worse = structuredClone(report)
  worse.workspace!.name = 'worse confirmed'
  worse.score = 90
  deliverIncumbent(callback, worse)
  api.handleAbortAutoGenerate()
  await nextTick()
  expect(store.workspace.name).toBe('confirmed best')
  expect(session.calculationReport.value).toBe(report.calculationReport)
  expect(session.calculationStatus.value).toContain('本次排班验证产出')
  expect(session.replaceStatusMessage.value).toContain('结束优化')
  expect(session.replaceStatusMessage.value).toContain('保留')
  expect(session.isGeneratingRoster.value).toBe(false)
  expect(api.hasVerifiedIncumbent.value).toBe(false)
  expect(worker.terminate).toHaveBeenCalledOnce()
  const stale = structuredClone(report)
  stale.workspace!.name = 'late complete'
  deliver(callback, stale)
  deliverIncumbent(callback, stale)
  expect(store.workspace.name).toBe('confirmed best')
})

it.each(['blocked', 'workspace', 'score', 'report', 'summary', 'report score'] as const)('does not retain an unknown or incomplete incumbent: %s', kind => {
  api.handleConfirmSmartRosterConfig({ ...config, enableMainOptimization: true })
  const worker = workers[0]!, callback = worker.onmessage!
  const original = JSON.stringify(store.workspace)
  const report = completed(worker.postMessage.mock.calls[0]![0].base)
  if (kind === 'blocked') report.status = 'blocked'
  else if (kind === 'workspace') report.workspace = null
  else if (kind === 'score') report.score = Number.NaN
  else if (kind === 'report') delete report.calculationReport
  else if (kind === 'summary') report.calculationReport!.summary = null
  else report.calculationReport!.summary!.totalScore82 = Number.NaN
  deliverIncumbent(callback, report)
  expect(api.hasVerifiedIncumbent.value).toBe(false)
  api.handleAbortAutoGenerate()
  expect(JSON.stringify(store.workspace)).toBe(original)
  expect(session.calculationReport.value).toBeNull()
  expect(session.replaceStatusMessage.value).toBe('已中止自动排班计算。')
})

it.each(['weights', 'edit', 'unmount'] as const)('discards a confirmed incumbent after %s cancellation and ignores all late results', kind => {
  api.handleConfirmSmartRosterConfig({ ...config, enableMainOptimization: true })
  const worker = workers[0]!, callback = worker.onmessage!
  const stale = completed(worker.postMessage.mock.calls[0]![0].base)
  stale.workspace!.name = 'stale confirmed'
  deliverIncumbent(callback, stale)
  expect(api.hasVerifiedIncumbent.value).toBe(true)
  if (kind === 'weights') session.simSettings.value.productionWeights = { exp: 3, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  else if (kind === 'edit') store.updateFacility('room_1_1', { product: 'exp' })
  else wrapper.unmount()
  const current = JSON.stringify(store.workspace)
  expect(api.hasVerifiedIncumbent.value).toBe(false)
  api.handleAbortAutoGenerate()
  deliverIncumbent(callback, stale)
  deliver(callback, stale)
  expect(JSON.stringify(store.workspace)).toBe(current)
  expect(session.calculationReport.value).toBeNull()
  expect(session.isGeneratingRoster.value).toBe(false)
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it.each([false, 'false', 'true', 1, null, {}])('does not opt into backup generation for non-true preference %j', value => {
  const incoming = { ...config }
  Reflect.set(incoming, 'enableBackupGeneration', value)
  api.handleConfirmSmartRosterConfig(incoming)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options.enableBackupGeneration).toBe(false)
})

it('forwards both optional comparisons without mutating their config', () => {
  const incoming = { ...config, enableDeepSearch: true, enableBackupGeneration: true }
  const original = structuredClone(incoming)
  api.handleConfirmSmartRosterConfig(incoming)
  expect(workers[0]!.postMessage.mock.calls[0]![0].options).toMatchObject({ enableDeepSearch: true, enableBackupGeneration: true })
  expect(incoming).toEqual(original)
})

it('retains a returned backup with its same-run report, persisted draft and income-worker input', async () => {
  api.handleConfirmSmartRosterConfig({ ...config, enableBackupGeneration: true })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  const backup = { name: '条件副表', trigger: 'True', plan: { room_1_1: { plans: [{ agent: '芬', group: '', replacement: ['香草'] }] } } }
  report.workspace!.name = 'generated main and backup'
  report.workspace!.compatibility.backupPlans = [backup]
  report.workspace!.compatibility.importedHasBackupPlans = true
  const exportedBefore = JSON.parse(exportMowerJson(report.workspace!)).backup_plans
  deliver(workers[0]!.onmessage!, report)
  await nextTick()
  session.activeTab.value = 'logs'
  await nextTick()
  expect(store.workspace.compatibility.backupPlans).toEqual([backup])
  expect(session.calculationReport.value).toBe(report.calculationReport)
  expect(session.calculationStatus.value).toContain('本次排班验证产出')
  const saved = JSON.parse(localStorage.getItem(`arc-income-calculator-workspace-v8-${EDITION.storageNamespace}`)!)
  expect(saved.compatibility.backupPlans).toEqual([backup])
  expect(JSON.parse(localStorage.getItem(`arc-income-calculator-report-v1-${EDITION.storageNamespace}`)!)).toEqual(report.calculationReport)
  expect(JSON.parse(exportMowerJson(store.workspace)).backup_plans).toEqual(exportedBefore)
  calculationApi.handleConfirmCalculation({ droneTarget: 'none', droneTradingRoomId: '', useOperatorInventory: true })
  expect(workers[1]!.postMessage.mock.calls[0]![0].workspace.compatibility.backupPlans).toEqual([backup])
  expect(store.workspace.compatibility.backupPlans).toEqual([backup])
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

it.each([
  { improved: true, qualityRepaired: false, gain: 12.34, message: '本次持续优化额外提高 12.3 分/日' },
  { improved: false, qualityRepaired: true, gain: -20, message: '采用工休完整性合格的方案' },
  { improved: true, qualityRepaired: true, gain: 20, message: '采用工休完整性合格的方案' },
  { improved: false, qualityRepaired: false, gain: 0, message: '额外比较未发现更高产出' },
])('describes the continuous optimization outcome accurately: $message', ({ improved, qualityRepaired, gain, message }) => {
  api.handleConfirmSmartRosterConfig({ ...config, enableMainOptimization: true })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.phases.mainOptimization = { generatedCandidates: 4, evaluatedCandidates: 3, cacheHits: 0, acceptedCandidates: 2,
    improved, qualityRepaired, gain, termination: 'simulation-budget', candidates: [] }
  deliver(workers[0]!.onmessage!, report)
  expect(session.replaceStatusMessage.value).toContain(message)
  if (qualityRepaired) expect(session.replaceStatusMessage.value).not.toContain('额外提高')
  expect(session.calculationReport.value).toBe(report.calculationReport)
  expect(session.replaceStatusMessage.value).not.toMatch(/generatedCandidates|cacheHits|候选预算|ALNS|F仿真/)
})

it.each([
  { code: 'MAIN_OPTIMIZATION_NO_QUALIFIED_RESULT', message: '预算内未找到满足新增工休收益质量门槛的方案，保留快速入口结果及其原有诊断。', hasSummary: true },
  { code: 'MAIN_OPTIMIZATION_FAILED', message: '持续优化未完成，保留最近已完成排班及其同次报告：测试中断', hasSummary: false },
])('prioritizes the original $code diagnostic instead of claiming continuous optimization succeeded', ({ code, message, hasSummary }) => {
  api.handleConfirmSmartRosterConfig({ ...config, enableMainOptimization: true })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.diagnostics.push({ code, message })
  if (hasSummary) report.phases.mainOptimization = { generatedCandidates: 4, evaluatedCandidates: 3, cacheHits: 0, acceptedCandidates: 0,
    improved: false, qualityRepaired: false, gain: 0, termination: 'simulation-budget', candidates: [] }
  deliver(workers[0]!.onmessage!, report)
  expect(session.replaceStatusMessage.value).toContain(message)
  expect(session.replaceStatusMessage.value?.startsWith(message)).toBe(true)
  expect(session.replaceStatusMessage.value).not.toContain('排班成功')
  expect(session.replaceStatusMessage.value).not.toContain('未发现更高产出')
  expect(session.replaceStatusMessage.value).not.toContain('工休完整性合格')
  expect(session.calculationReport.value).toBe(report.calculationReport)
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

it('does not call a joint backup comparison winner the initial roster after allocation failed', () => {
  api.handleConfirmSmartRosterConfig({ ...config, enableBackupGeneration: true })
  const report = completed(workers[0]!.postMessage.mock.calls[0]![0].base)
  report.phases.calculation = { status: 'invalid', libraryComplete: true, columnCount: 2, quantifiedColumnCount: 2,
    initialObjective: 100, frozenComponents: [], elapsedMs: 1, proofScope: 'quantified-manufacturing-model-only' }
  deliver(workers[0]!.onmessage!, report)
  expect(session.replaceStatusMessage.value).toContain('分配优化未完成，已采用完整仿真验证的方案')
  expect(session.replaceStatusMessage.value).not.toContain('保留初始方案')
  expect(session.calculationReport.value).toBe(report.calculationReport)
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
