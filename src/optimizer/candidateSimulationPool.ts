import { simulateCandidateWithProgress, type CandidateSimulationJob, type CandidateSimulationResult, type CandidateWorkerMessage, type CandidateSimulationBatch } from './candidateSimulation'

export interface CandidateWorker {
  onmessage: ((event: MessageEvent<CandidateWorkerMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(job: CandidateSimulationJob): void
  terminate(): void
}

export function candidateConcurrency(cores?: number): number {
  // Reserve capacity for the UI/other apps and bound per-worker engine memory.
  return Number.isFinite(cores) ? Math.max(1, Math.min(4, Math.floor(cores!) - 2)) : 1
}

export interface CandidateBatchOptions {
  concurrency?: number
  createWorker?: () => CandidateWorker
  onComplete?: (result: CandidateSimulationResult, index: number) => void
  onProgress?: CandidateSimulationBatch['onProgress']
}

export async function runCandidateBatch(jobs: CandidateSimulationJob[], options: CandidateBatchOptions = {}): Promise<CandidateSimulationResult[]> {
  const pool = new CandidateSimulationPool(options)
  try { return await pool.run(jobs) } finally { pool.dispose() }
}

/** A run-scoped pool keeps engine initialization warm across adaptive search batches. */
export class CandidateSimulationPool {
  private workers: CandidateWorker[] = []
  private active = false
  private disposed = false
  private serialOnly = false
  private cancelActive?: () => void

  constructor(private readonly options: CandidateBatchOptions = {}) {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const cancel = this.cancelActive
    this.cancelActive = undefined
    this.releaseWorkers()
    cancel?.()
  }

  private releaseWorkers(): void {
    this.workers.forEach(w => {
      w.onmessage = null; w.onerror = null; w.onmessageerror = null; w.terminate()
    })
    this.workers = []
  }

  async run(jobs: CandidateSimulationJob[], onComplete = this.options.onComplete, onProgress = this.options.onProgress): Promise<CandidateSimulationResult[]> {
    if (this.disposed) throw new Error('候选仿真线程池已关闭')
    if (this.active) throw new Error('候选仿真线程池正在执行上一批场景')
    if (!jobs.length) return []
    const options = this.options
    const requested = options.concurrency ?? candidateConcurrency(globalThis.navigator?.hardwareConcurrency)
    const count = Math.min(jobs.length, Number.isFinite(requested) ? Math.max(1, Math.min(4, Math.floor(requested))) : 1)
    const serial = () => jobs.map((job, index) => {
      const result = simulateCandidateWithProgress(job, onProgress ? progress => onProgress(progress, index) : undefined)
      onComplete?.(result, index)
      return result
    })
    if (this.serialOnly || count === 1 || (!options.createWorker && typeof Worker === 'undefined')) return serial()
    try {
      // Construct the entire pool before dispatch so startup fallback runs each job only once.
      for (let i = this.workers.length; i < count; i++) this.workers.push(options.createWorker
        ? options.createWorker()
        : new Worker(new URL('./candidateSimulationWorker.ts', import.meta.url), { type: 'module' }))
    } catch {
      this.releaseWorkers()
      this.serialOnly = true
      return serial()
    }
    const workers = this.workers.slice(0, count)
    this.active = true
    try {
      return await new Promise<CandidateSimulationResult[]>((resolve, reject) => {
        const results = new Array<CandidateSimulationResult>(jobs.length)
        let next = 0, completed = 0, stopped = false
        const fail = (error: unknown) => {
          if (stopped) return
          stopped = true; this.cancelActive = undefined; this.dispose(); reject(error)
        }
        this.cancelActive = () => fail(new Error('候选仿真线程池已取消'))
        const dispatch = (worker: CandidateWorker) => {
          if (stopped || next >= jobs.length) return
          const index = next++
          worker.onmessage = event => {
            if (stopped) return
            try {
              const message = event.data
              if ('type' in message) { onProgress?.(message.progress, index); return }
              results[index] = message
              onComplete?.(message, index)
              if (++completed === jobs.length) {
                stopped = true; this.cancelActive = undefined
                workers.forEach(w => { w.onmessage = null; w.onerror = null; w.onmessageerror = null })
                resolve(results)
              } else dispatch(worker)
            } catch (error) { fail(error) }
          }
          worker.onerror = event => fail(new Error(event.message || '候选仿真线程运行失败'))
          worker.onmessageerror = () => fail(new Error('候选仿真线程返回数据无法读取'))
          try { worker.postMessage(jobs[index]!) } catch (error) { fail(error) }
        }
        workers.forEach(dispatch)
      })
    } finally { this.active = false }
  }
}
