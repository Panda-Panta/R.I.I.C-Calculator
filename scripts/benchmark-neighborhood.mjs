// Compare the identical bounded neighborhood search with one/four CPU workers.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { cpus, availableParallelism } from 'node:os'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const out = resolve('validation/neighborhood-performance-2026-10-01')
mkdirSync(out, { recursive: true })
const label = process.argv[2] ?? 'before'
const concurrency = Number(process.argv[3] ?? 1)
const maxCandidates = Number(process.argv[4] ?? 4)
const baselineLabel = process.argv[5] ?? 'before'
await build({ stdin: { contents: `export * from './src/optimizer/rosterIncomeSearch'; export * from './src/optimizer/candidateSimulationPool';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: `${out}/engine.mjs` })
const engine = await import(pathToFileURL(`${out}/engine.mjs`).href)
const request = { ...JSON.parse(readFileSync(new URL('./fixtures/neighborhood-request.json', import.meta.url), 'utf8')), maxCandidates }
writeFileSync(`${out}/request.json`, JSON.stringify(request))
let createdWorkers = 0, terminatedWorkers = 0
const createWorker = () => {
  createdWorkers++
  const worker = new Worker(pathToFileURL(`${out}/scenario-worker.mjs`))
  const adapter = { onmessage: null, onerror: null, onmessageerror: null, postMessage: job => worker.postMessage(job), terminate: () => { terminatedWorkers++; void worker.terminate() } }
  worker.on('message', data => adapter.onmessage?.({ data }))
  worker.on('error', error => adapter.onerror?.({ message: error.message }))
  worker.on('messageerror', () => adapter.onmessageerror?.({}))
  return adapter
}
if (concurrency > 1) await build({ stdin: { contents: `import {parentPort} from 'node:worker_threads'; import {simulateCandidate} from './src/optimizer/candidateSimulation'; parentPort.on('message', job => parentPort.postMessage(simulateCandidate(job)));`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: `${out}/scenario-worker.mjs` })
const start = performance.now()
const batches = []
const progress = p => { if (p.completed) console.log(JSON.stringify({ candidate: p.completed.id, scenarios: p.completedScenarios, ms: performance.now() - start })) }
const pool = label.includes('persistent') ? new engine.CandidateSimulationPool({ concurrency, createWorker }) : null
let result
try {
  result = concurrency === 1 ? engine.runRosterIncomeSearch(request, progress)
    : await engine.runRosterIncomeSearchParallel(request, async (jobs, onComplete) => {
      const batchStart = performance.now()
      const output = await (pool ? pool.run(jobs, onComplete) : engine.runCandidateBatch(jobs, { concurrency, createWorker, onComplete }))
      batches.push({ jobs: jobs.length, elapsedMs: performance.now() - batchStart })
      return output
    }, progress)
} finally { pool?.dispose() }
const elapsedMs = performance.now() - start
writeFileSync(`${out}/${label}-result.json`, JSON.stringify(result))
const matchesBaseline = label === baselineLabel ? null : isDeepStrictEqual(JSON.parse(readFileSync(`${out}/${baselineLabel}-result.json`, 'utf8')), JSON.parse(JSON.stringify(result)))
const timing = { cpu: cpus()[0].model, logicalCpus: availableParallelism(), concurrency, elapsedMs, evaluatedCandidates: result.evaluatedCandidates, simulatedCandidates: result.simulatedCandidates, bestCandidateId: result.bestCandidateId, bestPath: result.bestPath, matchesBaseline, createdWorkers, terminatedWorkers, batches }
writeFileSync(`${out}/${label}-timing.json`, JSON.stringify(timing, null, 2))
console.log(JSON.stringify(timing))
if (matchesBaseline === false) process.exitCode = 1
