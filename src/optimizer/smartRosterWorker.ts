import { runSmartRosterParallel, type SmartRosterOptions } from './smartRoster'
import { CandidateSimulationPool } from './candidateSimulationPool'
import type { RosterWorkspace } from '../workbench/model'
import type { OwnedOperatorInput } from '../domain/operatorInventory'

export interface SmartRosterWorkerMessage {
  base: RosterWorkspace
  entries: OwnedOperatorInput[]
  options?: SmartRosterOptions
}

self.onmessage = async (event: MessageEvent<SmartRosterWorkerMessage>) => {
  const pool = new CandidateSimulationPool()
  try {
    const { base, entries, options } = event.data
    const report = await runSmartRosterParallel(base, entries, options ?? {},
      (jobs, onComplete) => pool.run(jobs, onComplete), (progress) => {
      self.postMessage({ type: 'progress', progress })
    })
    pool.dispose()
    self.postMessage({ type: 'complete', report })
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally { pool.dispose() }
}
