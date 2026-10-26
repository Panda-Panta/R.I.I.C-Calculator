// Benchmark the formal optimizer from a fixed source tree and an explicit request.
// Outputs are local evidence; the source tree, request, and existing outputs are read-only.
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { availableParallelism, cpus } from 'node:os'
import { Worker } from 'node:worker_threads'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(new URL('../package.json', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const usage = `Usage: node scripts/benchmark-auto-roster.mjs --request <request.json> --out <new-directory>
       [--source-root <read-only-source-tree>] [--concurrency <1-4>]

Request: { "workspace" (or "base"): ..., "entries": [...], "options": {...} }
options must explicitly include simulationWarmupHours and simulationSampleHours.
All options, including seed, branch count, weights and deep-search mode, pass through unchanged.
The output directory must not exist. It receives source/request hashes, a frozen engine,
the full result, progress events, wall/CPU time, simulation counts and roster validation.
`

function argumentsFrom(argv) {
  const args = { sourceRoot: projectRoot, concurrency: 4 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return null
    if (!['--source-root', '--request', '--out', '--concurrency'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--source-root') args.sourceRoot = resolve(value)
    if (flag === '--request') args.requestPath = resolve(value)
    if (flag === '--out') args.out = resolve(value)
    if (flag === '--concurrency') args.concurrency = Number(value)
  }
  if (!args.requestPath || !args.out) throw new Error('--request and --out are required')
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 4) throw new Error('--concurrency must be an integer from 1 to 4')
  if (existsSync(args.out)) throw new Error(`Refusing to overwrite existing output: ${args.out}`)
  return args
}

async function freezeEngine(sourceRoot, out) {
  const { build, version } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
  const captured = new Map()
  const enginePath = resolve(out, 'engine.mjs')
  const exported = ['optimizer/smartRoster', 'optimizer/candidateSimulation', 'optimizer/candidateSimulationPool',
    'optimizer/rosterDraft', 'optimizer/recoveryGroupCapacity']
  const result = await build({
    stdin: { contents: exported.map(path => `export * from './src/${path}';`).join('\n'), resolveDir: sourceRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: enginePath, metafile: true,
    plugins: [{ name: 'capture-inputs-and-observe-simulation', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, args => {
        const bytes = readFileSync(args.path)
        captured.set(args.path, hash(bytes))
        let contents = bytes.toString('utf8')
        if (args.path.replaceAll('\\', '/').endsWith('/optimizer/candidateSimulation.ts')) {
          const signature = 'export function simulateCandidateWithProgress('
          if (!contents.includes(signature)) throw new Error('Simulation observation signature changed; update the benchmark adapter')
          contents = contents.replace(signature, 'function benchmarkOriginalSimulateCandidateWithProgress(') + `
export function simulateCandidateWithProgress(job: CandidateSimulationJob, onProgress?: (progress: ScheduleSimulationProgress) => void): CandidateSimulationResult {
  const started = performance.now(); let result: CandidateSimulationResult | undefined;
  try { result = benchmarkOriginalSimulateCandidateWithProgress(job, onProgress); return result }
  finally {
    const event = { elapsedMs: performance.now() - started, completed: result?.completed ?? false,
      score: result?.simScore ?? null, incomeComparison: !!job.incomeComparison,
      warmupHours: job.options?.warmupHours, sampleHours: job.options?.sampleHours };
    (globalThis as any).__rosterBenchmarkMetrics ??= [];
    (globalThis as any).__rosterBenchmarkMetrics.push(event);
    (globalThis as any).__rosterBenchmarkObserve?.(event);
  }
}
`
        }
        if (args.path.replaceAll('\\', '/').endsWith('/simulator/scheduleSimulation.ts')) {
          const signature = 'export function simulateSchedule('
          if (!contents.includes(signature)) throw new Error('Simulation engine signature changed; update the benchmark adapter')
          contents = contents.replace(signature, 'function benchmarkOriginalSimulateSchedule(') + `
export function simulateSchedule(...args: Parameters<typeof benchmarkOriginalSimulateSchedule>): ReturnType<typeof benchmarkOriginalSimulateSchedule> {
  const started = performance.now(); let report: ScheduleSimulationReport | undefined;
  try { report = benchmarkOriginalSimulateSchedule(...args); return report }
  finally {
    const event = { elapsedMs: performance.now() - started, elapsedHours: report?.elapsedHours ?? null,
      observedHours: report?.observedHours ?? null,
      completed: !!(report?.success && report.production?.success && report.production.sample.completed && report.observedHours > 0) };
    (globalThis as any).__rosterBenchmarkEngineMetrics ??= [];
    (globalThis as any).__rosterBenchmarkEngineMetrics.push(event);
    (globalThis as any).__rosterBenchmarkEngineObserve?.(event);
  }
}
`
        }
        const loader = args.path.endsWith('.json') ? 'json' : args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js'
        return { contents, loader, resolveDir: dirname(args.path) }
      })
    }}],
  })
  const inputs = Object.keys(result.metafile.inputs).filter(path => path !== '<stdin>').map(path => {
    const absolute = resolve(path), capturedHash = captured.get(absolute)
    if (!capturedHash || hash(readFileSync(absolute)) !== capturedHash) throw new Error(`Source changed while bundling: ${absolute}`)
    return { path: relative(sourceRoot, absolute).replaceAll('\\', '/'), sha256: capturedHash }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { sourceRoot, sourceSha256: hash(JSON.stringify(inputs)), bundleSha256: hash(readFileSync(enginePath)),
    nodeVersion: process.version, esbuildVersion: version, inputs,
    observation: 'Observe candidate entry and actual simulateSchedule entry separately. Engine calls include bridge fallback and are never added to candidate-entry counts. Inputs/results are unchanged.' }
  writeFileSync(resolve(out, 'source-manifest.json'), JSON.stringify(manifest, null, 2))
  return { enginePath, manifest }
}

async function benchmark(args) {
  const requestBytes = readFileSync(args.requestPath)
  const input = JSON.parse(requestBytes.toString('utf8'))
  if (input.workspace && input.base) throw new Error('Provide workspace or base, not both')
  const request = { workspace: input.workspace ?? input.base, entries: input.entries, options: input.options }
  const normalizedRequestSha256 = hash(JSON.stringify(request))
  if (!request.workspace?.mainPlan?.facilities || !Array.isArray(request.entries) || !request.options) throw new Error('Request must contain workspace/base, entries and options')
  const { simulationWarmupHours: warmup, simulationSampleHours: sample } = request.options
  if (!Number.isFinite(warmup) || warmup < 0 || !Number.isFinite(sample) || sample <= 0) throw new Error('Request must explicitly provide non-negative simulationWarmupHours and positive simulationSampleHours')
  if (!existsSync(resolve(args.sourceRoot, 'src/optimizer/smartRoster.ts'))) throw new Error(`Missing optimizer source in ${args.sourceRoot}`)
  mkdirSync(dirname(args.out), { recursive: true })
  mkdirSync(args.out)
  writeFileSync(resolve(args.out, 'request.json'), requestBytes)
  const { enginePath, manifest } = await freezeEngine(args.sourceRoot, args.out)
  const engineUrl = pathToFileURL(enginePath).href
  const engine = await import(engineUrl)
  const workerPath = resolve(args.out, 'worker.mjs')
  writeFileSync(workerPath, `import { parentPort, workerData } from 'node:worker_threads';
const engine = await import(workerData.engineUrl);
parentPort.on('message', job => {
  globalThis.__rosterBenchmarkMetrics = [];
  globalThis.__rosterBenchmarkEngineMetrics = [];
  let result, error;
  let lastProgressAt = -Infinity;
  const progress = value => {
    if (performance.now() - lastProgressAt >= 5000 || value.elapsedHours >= value.totalHours) {
      parentPort.postMessage({ type: 'progress', progress: value }); lastProgressAt = performance.now();
    }
  };
  try { result = engine.simulateCandidateWithProgress(job, progress) }
  catch (failure) { error = failure.message ?? String(failure) }
  parentPort.postMessage({ result, error, metrics: globalThis.__rosterBenchmarkMetrics, engineMetrics: globalThis.__rosterBenchmarkEngineMetrics });
});\n`)
  const started = performance.now(), cpuStarted = process.cpuUsage()
  const events = [], workerMetrics = [], workerEngineMetrics = [], batches = [], rejectedBatches = [], workerTerminations = []
  const jobTags = new WeakMap()
  let batchId = 0
  let createdWorkers = 0, lastPhase, lastProgressAt = -Infinity
  const record = event => {
    const item = { ms: performance.now() - started, ...event }
    events.push(item)
    appendFileSync(resolve(args.out, 'events.jsonl'), JSON.stringify(item) + '\n')
    return item
  }
  globalThis.__rosterBenchmarkMetrics = []
  globalThis.__rosterBenchmarkEngineMetrics = []
  globalThis.__rosterBenchmarkObserve = event => record({ kind: 'direct-simulation', ...event })
  globalThis.__rosterBenchmarkEngineObserve = event => record({ kind: 'direct-engine-simulation', ...event })
  const createWorker = () => {
    createdWorkers++
    const worker = new Worker(pathToFileURL(workerPath), { workerData: { engineUrl } })
    let activeTag
    const adapter = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage: job => { activeTag = jobTags.get(job); worker.postMessage(job) }, terminate: () => { workerTerminations.push(worker.terminate()) } }
    worker.on('message', message => {
      if (message.type === 'progress') {
        record({ kind: 'simulation-clock', ...activeTag, ...message.progress })
        adapter.onmessage?.({ data: message }); return
      }
      const { result, error, metrics, engineMetrics } = message
      workerMetrics.push(...metrics)
      workerEngineMetrics.push(...engineMetrics)
      for (const metric of metrics) record({ kind: 'worker-simulation', ...activeTag, ...metric })
      for (const metric of engineMetrics) record({ kind: 'worker-engine-simulation', ...activeTag, ...metric })
      if (error) { adapter.onerror?.({ message: error }); return }
      adapter.onmessage?.({ data: result })
    })
    worker.on('error', error => adapter.onerror?.({ message: error.message }))
    worker.on('messageerror', () => adapter.onmessageerror?.({}))
    return adapter
  }
  const pool = new engine.CandidateSimulationPool({ concurrency: args.concurrency, createWorker })
  let result, failure
  try {
    result = await engine.runSmartRosterParallel(request.workspace, request.entries, request.options, async (jobs, onComplete, onProgress) => {
      const batchStart = performance.now()
      batchId++
      jobs.forEach((job, index) => jobTags.set(job, { batchId, jobIndex: index, workspaceSha256: hash(JSON.stringify(job.workspace)) }))
      record({ kind: 'batch-start', batchId, jobs: jobs.length })
      let values
      try { values = await pool.run(jobs, onComplete, onProgress) }
      catch (error) {
        // A search can catch the rejection and return its previous draft. Keep
        // this marker even then: terminated workers may not return their metrics.
        rejectedBatches.push(record({ kind: 'batch-error', batchId, jobs: jobs.length, message: error.message ?? String(error) }))
        throw error
      }
      const batch = { batchId, jobs: jobs.length, elapsedMs: performance.now() - batchStart }
      batches.push(batch); record({ kind: 'batch-end', ...batch })
      return values
    }, progress => {
      if (progress.phase !== lastPhase || performance.now() - lastProgressAt > 3000 || progress.phase === 'done') {
        console.log(JSON.stringify(record({ kind: 'progress', ...progress })))
        lastProgressAt = performance.now()
      }
      lastPhase = progress.phase
    })
  } catch (error) {
    failure = error
    record({ kind: 'error', message: error.stack ?? String(error) })
  } finally {
    pool.dispose()
    await Promise.allSettled(workerTerminations)
    delete globalThis.__rosterBenchmarkObserve
    delete globalThis.__rosterBenchmarkEngineObserve
  }
  const elapsedMs = performance.now() - started, cpuUsage = process.cpuUsage(cpuStarted)
  const metrics = [...workerMetrics, ...globalThis.__rosterBenchmarkMetrics]
  const engineMetrics = [...workerEngineMetrics, ...globalThis.__rosterBenchmarkEngineMetrics]
  const countsAreLowerBound = !!failure || rejectedBatches.length > 0
  if (result) writeFileSync(resolve(args.out, 'result.json'), JSON.stringify(result))
  const summary = {
    status: failure ? 'error' : result.status, score: result?.score ?? null, elapsedMs,
    cpuUsage: { userMicros: cpuUsage.user, systemMicros: cpuUsage.system, totalMicros: cpuUsage.user + cpuUsage.system },
    cpu: cpus()[0]?.model, logicalCpus: availableParallelism(), concurrency: args.concurrency,
    requestSha256: hash(requestBytes), normalizedRequestSha256,
    sourceSha256: manifest.sourceSha256, bundleSha256: manifest.bundleSha256,
    requestedOptions: request.options, generatedCandidates: result?.phases?.static?.candidates.length ?? 0,
    simulationCalls: engineMetrics.length, completedSimulationCalls: engineMetrics.filter(item => item.completed).length,
    simulationCountCompleteness: countsAreLowerBound ? 'lower-bound' : 'complete',
    simulationCallsAreLowerBound: countsAreLowerBound, rejectedBatchCount: rejectedBatches.length, rejectedBatches,
    directSimulationCalls: globalThis.__rosterBenchmarkEngineMetrics.length, workerSimulationCalls: workerEngineMetrics.length,
    candidateEntryCalls: metrics.length, eligibleCandidateResults: metrics.filter(item => item.completed).length,
    simulationTaskWallSumMs: engineMetrics.reduce((sum, item) => sum + item.elapsedMs, 0), createdWorkers, batches,
    simulationCandidates: result?.phases?.simulation?.candidates.map(candidate => ({ id: candidate.id, score: candidate.simScore, diagnostics: candidate.diagnostics })),
    phases: events.filter(event => event.kind === 'progress').map(({ ms, phase, label }) => ({ ms, phase, label })),
    search: result?.phases?.search ? { improved: result.phases.search.improved, gain: result.phases.search.gain } : null,
    physicalErrors: result?.workspace ? engine.validatePhysicalRoster(result.workspace) : null,
    recoveryErrors: result?.workspace ? engine.recoveryGroupCapacityIssues(result.workspace) : null,
    diagnostics: result?.diagnostics, error: failure?.message,
    evidence: 'Formal optimizer/simulator in Node with observation only. simulationCalls counts actual simulateSchedule invocations reported after return/throw, including bridge fallback; candidateEntryCalls is a separate outer-entry count, never added to it. Counts are lower bounds if the run fails or any batch rejects, even when the optimizer catches that rejection and returns a draft: terminated workers may not report in-flight calls. Check simulationCountCompleteness. CPU includes worker threads; per-engine-call wall sums are not CPU time. Clock telemetry is throttled to five seconds without changing simulation inputs. Fixed input benchmark, not browser or real game evidence.',
  }
  writeFileSync(resolve(args.out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  if (failure) throw failure
}

try {
  const args = argumentsFrom(process.argv.slice(2))
  if (args) await benchmark(args)
  else console.log(usage)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
