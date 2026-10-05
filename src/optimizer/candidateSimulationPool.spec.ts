import { describe, expect, it } from 'vitest'
import { runCandidateBatch, candidateConcurrency, CandidateSimulationPool } from './candidateSimulationPool'
import type { CandidateSimulationJob, CandidateWorkerMessage } from './candidateSimulation'
import { simulateCandidate } from './candidateSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'

class TestWorker {
  onmessage: ((event: MessageEvent<CandidateWorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  jobs: CandidateSimulationJob[] = []
  terminated = false
  postMessage(job: CandidateSimulationJob) { this.jobs.push(job) }
  terminate() { this.terminated = true }
  finish(score: number) { this.onmessage?.(new MessageEvent('message', { data: { completed: true, simScore: score, diagnostics: [] } })) }
}
const jobs = [0, 1, 2, 3, 4].map(i => ({ workspace: { name: String(i) } })) as CandidateSimulationJob[]

describe('bounded candidate CPU workers', () => {
  it('forwards in-flight simulation progress without completing or redispatching the job', async () => {
    const workers: TestWorker[] = [], progress: { index: number; elapsed: number }[] = [], completed: number[] = []
    const pool = new CandidateSimulationPool({ concurrency: 2, createWorker: () => {
      const worker = new TestWorker(); workers.push(worker); return worker
    } })
    try {
      const result = pool.run(jobs.slice(0, 2), (_result, i) => completed.push(i), (p, i) => progress.push({ index: i, elapsed: p.elapsedHours }))
      void result.catch(() => {})
      workers[0]!.onmessage?.(new MessageEvent('message', { data: { type: 'progress', progress: { phase: 'warmup', elapsedHours: 12, totalHours: 96, warmupHours: 24 } } }))
      expect(completed).toEqual([])
      expect(progress).toEqual([{ index: 0, elapsed: 12 }])
      expect(workers.map(w => w.jobs.length)).toEqual([1, 1])
      workers[1]!.finish(20); workers[0]!.finish(10)
      expect((await result).map(r => r.simScore)).toEqual([10, 20])
    } finally { pool.dispose() }
  })
  it('keeps workers alive across search batches and releases them at the end', async () => {
    const workers: TestWorker[] = []
    const pool = new CandidateSimulationPool({ concurrency: 2, createWorker: () => {
      const worker = new TestWorker(); workers.push(worker); return worker
    } })
    try {
      const first = pool.run(jobs.slice(0, 2))
      workers[1]!.finish(1); workers[0]!.finish(0)
      expect((await first).map(r => r.simScore)).toEqual([0, 1])
      expect(workers.every(w => !w.terminated)).toBe(true)
      const second = pool.run(jobs.slice(2, 4))
      expect(workers).toHaveLength(2)
      workers[0]!.finish(2); workers[1]!.finish(3)
      expect((await second).map(r => r.simScore)).toEqual([2, 3])
      expect(workers.map(w => w.jobs.length)).toEqual([2, 2])
    } finally { pool.dispose() }
    expect(workers.every(w => w.terminated)).toBe(true)
  })
  it('rejects overlapping batches and cancels an active pool without leaving a pending promise', async () => {
    const workers: TestWorker[] = []
    const pool = new CandidateSimulationPool({ concurrency: 2, createWorker: () => {
      const worker = new TestWorker(); workers.push(worker); return worker
    } })
    const active = pool.run(jobs)
    const canceled = expect(active).rejects.toThrow('已取消')
    await expect(pool.run(jobs)).rejects.toThrow('上一批')
    pool.dispose(); pool.dispose()
    await canceled
    expect(workers.every(w => w.terminated)).toBe(true)
    await expect(pool.run(jobs)).rejects.toThrow('已关闭')
  })
  it('limits active jobs, reuses workers, and returns input order despite reverse completion', async () => {
    const workers: TestWorker[] = [], completed: number[] = []
    const result = runCandidateBatch(jobs, { concurrency: 2, createWorker: () => {
      const w = new TestWorker(); workers.push(w); return w
    }, onComplete: (_result, index) => completed.push(index) })
    expect(workers).toHaveLength(2)
    workers[1]!.finish(10) // index 1; receives index 2
    workers[1]!.finish(20) // receives index 3
    workers[0]!.finish(0) // receives index 4
    workers[0]!.finish(40)
    workers[1]!.finish(30)
    expect((await result).map(r => r.simScore)).toEqual([0, 10, 20, 30, 40])
    expect(completed).toEqual([1, 2, 0, 4, 3])
    expect(workers.every(w => w.terminated)).toBe(true)
  })
  it('terminates every worker and rejects on runtime or deserialization errors', async () => {
    for (const kind of ['runtime', 'message'] as const) {
      const workers: TestWorker[] = []
      const result = runCandidateBatch(jobs, { concurrency: 2, createWorker: () => {
        const w = new TestWorker(); workers.push(w); return w
      } })
      const assertion = expect(result).rejects.toThrow()
      if (kind === 'runtime') workers[0]!.onerror?.({ message: 'worker crashed' } as ErrorEvent)
      else workers[0]!.onmessageerror?.(new MessageEvent('messageerror'))
      await assertion
      expect(workers.every(w => w.terminated)).toBe(true)
    }
  })
  it('cleans up partially created pools and falls back to the same serial calculation', async () => {
    const job = { workspace: createDefaultWorkspace(), options: { sampleHours: 1 }, assumptions: {} }
    const first = new TestWorker()
    let creates = 0
    const result = await runCandidateBatch([job, job], { concurrency: 2, createWorker: () => {
      if (++creates > 1) throw new Error('workers unavailable')
      return first
    } })
    expect(first.terminated).toBe(true)
    expect(first.jobs).toHaveLength(0)
    expect(result).toEqual([simulateCandidate(job), simulateCandidate(job)])
  })
  it('releases the pool when posting input throws', async () => {
    const worker = new TestWorker()
    worker.postMessage = () => { throw new Error('input could not be cloned') }
    await expect(runCandidateBatch(jobs, { concurrency: 2, createWorker: () => worker })).rejects.toThrow('input could not be cloned')
    expect(worker.terminated).toBe(true)
  })
  it('uses a conservative core budget and never creates workers for an empty batch', async () => {
    expect([1, 2, 4, 8, 20].map(n => candidateConcurrency(n))).toEqual([1, 1, 2, 4, 4])
    expect(candidateConcurrency(undefined)).toBe(1)
    expect(candidateConcurrency(NaN)).toBe(1)
    expect(await runCandidateBatch([], { createWorker: () => { throw Error('unexpected') } })).toEqual([])
  })
})
