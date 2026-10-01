// Profile one exact, normalized scenario from the saved serial search baseline.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Session } from 'node:inspector'
import { isDeepStrictEqual } from 'node:util'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const out = resolve('validation/neighborhood-performance-2026-10-01')
const baseline = JSON.parse(readFileSync(`${out}/current-before-result.json`, 'utf8'))
await build({ stdin: { contents: `export {simulateCandidate} from './src/optimizer/candidateSimulation';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: `${out}/profile-engine.mjs` })
const { simulateCandidate } = await import(pathToFileURL(`${out}/profile-engine.mjs`).href)
const job = { workspace: baseline.baseline.workspace, assumptions: baseline.settings.assumptions, incomeComparison: true,
  options: { ...baseline.settings.options, maxStepHours: baseline.settings.steps[0],
    production: { ...baseline.settings.options.production, seed: baseline.settings.seeds[0] } } }
const session = new Session()
const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)))
session.connect()
try {
  await post('Profiler.enable')
  await post('Profiler.start')
  const start = performance.now()
  const result = simulateCandidate(job)
  const elapsedMs = performance.now() - start
  const { profile } = await post('Profiler.stop')
  writeFileSync(`${out}/neighborhood.cpuprofile`, JSON.stringify(profile))
  const nodes = new Map(profile.nodes.map(n => [n.id, n]))
  const parents = new Map()
  for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n.id)
  const self = new Map(), inclusive = new Map()
  const totalMs = profile.timeDeltas.reduce((sum, t) => sum + t / 1000, 0)
  for (let i = 0; i < profile.samples.length; i++) {
    const leaf = profile.samples[i], ms = profile.timeDeltas[i] / 1000
    self.set(leaf, (self.get(leaf) ?? 0) + ms)
    for (let id = leaf; id !== undefined; id = parents.get(id)) inclusive.set(id, (inclusive.get(id) ?? 0) + ms)
  }
  const rank = times => [...times].map(([id, ms]) => ({ name: nodes.get(id).callFrame.functionName || '(anonymous)',
    line: nodes.get(id).callFrame.lineNumber + 1, ms: Math.round(ms), percent: Number((100 * ms / totalMs).toFixed(2)) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 25)
  const summary = { warmupHours: job.options.warmupHours, sampleHours: job.options.sampleHours, seed: job.options.production.seed,
    step: job.options.maxStepHours, elapsedMs, eligible: result.incomeCase.eligible,
    matchesBaseline: isDeepStrictEqual(result.incomeCase, baseline.baseline.cases[0]), self: rank(self), inclusive: rank(inclusive) }
  writeFileSync(`${out}/profile-summary.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.matchesBaseline) process.exitCode = 1
} finally { session.disconnect() }
