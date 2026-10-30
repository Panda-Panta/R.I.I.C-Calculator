import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SmartRosterProgress, SmartRosterResult } from './smartRoster'

const { run, dispose } = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn() }))
vi.mock('./smartRoster', () => ({ runSmartRosterParallel: run }))
vi.mock('./candidateSimulationPool', () => ({
  CandidateSimulationPool: class { run = vi.fn(); dispose = dispose },
}))
const worker = { onmessage: null as ((event: MessageEvent) => Promise<void>) | null, postMessage: vi.fn() }

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('self', worker)
  await import('./smartRosterWorker')
})
afterEach(() => vi.unstubAllGlobals())

it('sends a confirmed incumbent separately and keeps ordinary progress and complete messages compatible', async () => {
  const incumbent = { status: 'draft', score: 100 } as SmartRosterResult
  const report = { status: 'draft', score: 110 } as SmartRosterResult
  run.mockImplementation((_base: unknown, _entries: unknown, _options: unknown, _executor: unknown, progress: (value: SmartRosterProgress) => void) => {
    progress({ phase: 'searching', phaseProgress: .5, label: '优化中', bestScore: 100, incumbent })
    progress({ phase: 'searching', phaseProgress: .75, label: '继续优化', bestScore: 100 })
    return report
  })
  const options = { enableMainOptimization: true, allowFreeCombinations: true, optimizationMaxSimulations: 3, optimizationTimeBudgetMs: 30000 }
  await worker.onmessage!({ data: { base: {}, entries: [], options } } as MessageEvent)
  expect(run.mock.calls[0]![2]).toEqual(options)
  expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
    { type: 'incumbent', report: incumbent },
    { type: 'progress', progress: { phase: 'searching', phaseProgress: .5, label: '优化中', bestScore: 100 } },
    { type: 'progress', progress: { phase: 'searching', phaseProgress: .75, label: '继续优化', bestScore: 100 } },
    { type: 'complete', report },
  ])
  expect(dispose).toHaveBeenCalled()
})

it('reports an optimization failure after a confirmed incumbent without announcing a new complete result', async () => {
  const incumbent = { status: 'draft', score: 100 } as SmartRosterResult
  run.mockImplementation((_base: unknown, _entries: unknown, _options: unknown, _executor: unknown, progress: (value: SmartRosterProgress) => void) => {
    progress({ phase: 'searching', phaseProgress: .5, label: '优化中', incumbent })
    throw new Error('optimization failed')
  })
  await worker.onmessage!({ data: { base: {}, entries: [] } } as MessageEvent)
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'incumbent', report: incumbent })
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'error', error: 'optimization failed' })
  expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'complete')).toBe(false)
  expect(dispose).toHaveBeenCalledOnce()
})
