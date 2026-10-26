import { compileOperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import { currentMoraleRates } from '../engine/morale'
import type { CandidateSimulationJob } from './candidateSimulation'
import { shiftSnapshot } from './combinationModel'
import { projectRosterConfig } from './rosterProjection'

/** Initial fatigue only estimates event density; it is neither income nor a runtime bound. */
function estimatedEventDensity(job: CandidateSimulationJob): number {
  try {
    const entries = job.options?.operatorInventory
    if (!entries?.length) return 0
    const inventory = compileOperatorInventory(entries)
    if (!inventory.valid) return 0
    const records = inventoryOperatorRecords(inventory)
    const permanent = new Set(job.workspace.mainPlan.conf.workaholic.map(resolveOperatorCharId))
    let maximum = 0
    for (const role of ['main', 'backup'] as const) {
      const snapshot = shiftSnapshot(job.workspace, role)
      // operatorFor may otherwise fall back to maximum catalog skills for an
      // absent inventory row. An invalid job is left to the formal simulator.
      for (const room of Object.values(snapshot.mainPlan.facilities)) for (const slot of room.slots) {
        if (slot.occupant.kind === 'operator' && !records[resolveOperatorCharId(slot.occupant.operatorId)]) return 0
      }
      const config = projectRosterConfig(snapshot)
      config.operatorRecords = records
      const rates = currentMoraleRates(config)
      if (rates.unquantified.length) return 0
      for (const [operator, rate] of Object.entries(rates.rates)) {
        if (!Number.isFinite(rate)) return 0
        if (!permanent.has(resolveOperatorCharId(operator))) maximum = Math.max(maximum, rate)
      }
    }
    return maximum
  } catch {
    // Scheduling priority must never reject a job or replace its validation.
    return 0
  }
}

/** Return every original index once, with potentially event-heavy jobs first. */
export function candidateExecutionOrder(jobs: readonly CandidateSimulationJob[]): number[] {
  return jobs.map((job, index) => ({ index, cost: estimatedEventDensity(job) }))
    .sort((a, b) => b.cost - a.cost || a.index - b.index)
    .map(value => value.index)
}
