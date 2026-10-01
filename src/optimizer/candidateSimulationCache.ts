import type { CandidateSimulationJob, CandidateSimulationResult } from './candidateSimulation'

/** One immutable-input cache per roster run. Never reuse an incomplete report. */
export class CandidateSimulationCache {
  private readonly results = new Map<string, CandidateSimulationResult>()

  key(job: CandidateSimulationJob): string {
    // The bridge accepts JSON data. Preserve nested object insertion order too:
    // facility order drives room/operator/bed traversal and can affect ties.
    // Only the outer, named job envelope is normalized here.
    return JSON.stringify([job.workspace, job.options, job.assumptions, Boolean(job.incomeComparison)])
  }

  remember(key: string, result: CandidateSimulationResult): void {
    if (result.completed && Number.isFinite(result.simScore)) this.results.set(key, structuredClone(result))
  }

  get(job: CandidateSimulationJob): CandidateSimulationResult | undefined {
    const result = this.results.get(this.key(job))
    return result ? structuredClone(result) : undefined
  }
}
