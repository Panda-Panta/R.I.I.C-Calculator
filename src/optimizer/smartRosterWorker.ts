import { runSmartRosterParallel } from './smartRoster'
import { CandidateSimulationPool } from './candidateSimulationPool'
import type { SmartRosterWorkerRequest, SmartRosterWorkerResponse } from './smartRosterProtocol'

// Preserve the original request type export for existing callers.
export type { SmartRosterWorkerRequest as SmartRosterWorkerMessage } from './smartRosterProtocol'

self.onmessage = async (event: MessageEvent<SmartRosterWorkerRequest>) => {
  const pool = new CandidateSimulationPool()
  try {
    const { base, entries, options } = event.data
    const report = await runSmartRosterParallel(base, entries, options ?? {},
      (jobs, onComplete, onProgress) => pool.run(jobs, onComplete, onProgress), ({ incumbent, ...progress }) => {
      if (incumbent) self.postMessage({ type: 'incumbent', report: incumbent } satisfies SmartRosterWorkerResponse)
      self.postMessage({ type: 'progress', progress } satisfies SmartRosterWorkerResponse)
    })
    pool.dispose()
    self.postMessage({ type: 'complete', report } satisfies SmartRosterWorkerResponse)
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies SmartRosterWorkerResponse)
  } finally { pool.dispose() }
}
