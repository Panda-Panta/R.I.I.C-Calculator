// Re-evaluate saved H reports only. No schedule, production F, or new H may run.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(new URL('../package.json', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const same = (a, b) => canonical(a) === canonical(b)
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const reportFrom = value => value.report ?? value
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const usage = `Usage: node scripts/benchmark-duty-model.mjs --cases <manifest.json> --out <new-directory>

Manifest: { nativeSourceManifest, protectedFiles?: [], comparisonModule?, cases: [
  { id, split, job, calendar, native, baseline?, baselineTrajectory?, baselineSummary?, expectedSha256? }
] }
All manifest paths resolve relative to the manifest. baseline is a saved old projection.
The source is this script's project. Output must not exist; old reports are never changed.
This command converts saved H segments and integrates rates. A runtime guard rejects
any attempt to start simulateSchedule; native F, short F, and new H counts must be zero.
`

function argumentsFrom(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return null
    assert(['--cases', '--out'].includes(argv[i]), `Unknown option: ${argv[i]}`)
    const key = argv[i].slice(2), value = argv[++i]
    assert(value && !value.startsWith('--'), `Missing value for --${key}`)
    assert(result[key] === undefined, `Repeated option: --${key}`)
    result[key] = resolve(value)
  }
  assert(result.cases && result.out, '--cases and --out are required')
  assert(!existsSync(result.out), `Refusing to overwrite output: ${result.out}`)
  return result
}

function fileBinding(path) {
  const bytes = readFileSync(path)
  return { path, sha256: sha(bytes), bytes: bytes.length }
}

function nativeCompatibility(path) {
  const manifest = json(path)
  assert(typeof manifest.root === 'string' && Array.isArray(manifest.inputs), 'Unsupported Native source manifest')
  const overrides = new Map((manifest.instrumentation ?? []).map(row => [row.path, row.originalSha256]))
  const inputs = manifest.inputs.flatMap(row => {
    const name = relative(manifest.root, row.path).replaceAll('\\', '/')
    if (!/^src\/(data|domain|engine|rules|scheduler|simulator|workbench)\//.test(name)) return []
    const expectedSha256 = overrides.get(row.path) ?? row.sha256
    const currentPath = resolve(root, name), currentSha256 = existsSync(currentPath) ? sha(readFileSync(currentPath)) : null
    return [{ path: name, currentPath, expectedSha256, currentSha256, matches: expectedSha256 === currentSha256 }]
  })
  assert(inputs.length > 0, 'No Native runtime dependencies found in source manifest')
  const differences = inputs.filter(row => !row.matches)
  assert(!differences.length, `Native runtime source differs: ${differences.map(row => row.path).join(', ')}`)
  return { manifest: fileBinding(path), scope: 'All recorded data/domain/engine/rules/scheduler/simulator/workbench inputs; optimizer proposal and H code are separate.',
    count: inputs.length, matches: true, inputs }
}

function bindCase(row, manifestDirectory) {
  assert(typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.id), 'Case id must be a safe directory name')
  assert(typeof row.split === 'string' && row.split.trim(), `Missing explicit split: ${row.id}`)
  if (row.baseline !== undefined) {
    assert(typeof row.baselineSummary === 'string' && typeof row.baselineTrajectory === 'string',
      `Baseline requires both paired baselineSummary and baselineTrajectory: ${row.id}`)
  }
  const files = {}
  for (const key of ['job', 'calendar', 'native', 'baseline', 'baselineTrajectory', 'baselineSummary', 'calendarSummary']) {
    if (row[key] === undefined) { assert(!['job', 'calendar', 'native'].includes(key), `Missing ${row.id}.${key}`); continue }
    assert(typeof row[key] === 'string', `Expected path for ${row.id}.${key}`)
    files[key] = fileBinding(resolve(manifestDirectory, row[key]))
    if (row.expectedSha256?.[key]) assert(files[key].sha256 === row.expectedSha256[key], `Input hash mismatch: ${row.id}.${key}`)
  }
  const job = json(files.job.path), calendar = reportFrom(json(files.calendar.path)), native = reportFrom(json(files.native.path))
  assert(job.options?.production && calendar.inputs?.schedule && native.inputs?.schedule, `Missing original input: ${row.id}`)
  assert(calendar.production === undefined && native.production, `Expected saved H and Native F respectively: ${row.id}`)
  assert(same(calendar.inputs.schedule, native.inputs.schedule), `H/F exact schedule mismatch: ${row.id}`)
  const nativeOptions = structuredClone(native.inputs.options)
  delete nativeOptions.production; nativeOptions.recordSegments = true
  assert(same(nativeOptions, calendar.inputs.options), `H/F options differ beyond documented production-off/recordSegments: ${row.id}`)
  const { production, ...originalOptions } = job.options
  for (const [key, value] of Object.entries(originalOptions)) {
    assert(same(value, native.inputs.options[key]), `Original job option mismatch: ${row.id}.${key}`)
  }
  assert(same(production, native.inputs.options.production), `Native production/seed differs from job: ${row.id}`)
  assert(native.production.assumptions.seed === production.seed, `Actual Native seed differs: ${row.id}`)
  assert(production.outputMode === 'potential' && production.droneTarget === 'none', `Unsupported production scope: ${row.id}`)
  assert(same(calendar.assumptions, native.assumptions), `H/F assumptions differ: ${row.id}`)
  assert(Array.isArray(calendar.segments) && calendar.segments.length, `Missing full saved H segments: ${row.id}`)
  if (files.baselineSummary) {
    const old = json(files.baselineSummary.path), source = old.source
    for (const [key, oldKey] of [['job', 'jobSha256'], ['calendar', 'hReportSha256'], ['native', 'nativeReferenceSha256']]) {
      assert(source?.[oldKey] === files[key].sha256, `Old baseline is not paired to ${row.id}.${key}`)
    }
    if (files.baseline) {
      const baseline = json(files.baseline.path)
      assert(same(old.amounts, baseline.amounts) && same(old.score, baseline.score), `Old projection/summary amounts or score mismatch: ${row.id}`)
    }
  }
  return { id: row.id, split: row.split, files, job, calendar, native, baseline: files.baseline ? json(files.baseline.path) : null,
    baselineTrajectory: files.baselineTrajectory ? json(files.baselineTrajectory.path) : null,
    binding: { exactCompiledSchedule: true, exactHNativeOptionsExceptProductionAndSegments: true, originalJobOptionsPreserved: true,
      seed: production.seed, HHasProductionRng: false, window: { warmupHours: job.options.warmupHours, sampleHours: job.options.sampleHours, maxStepHours: job.options.maxStepHours },
      weights: job.options.productionWeights ?? job.workspace.productionWeights, droneTarget: production.droneTarget,
      inventoryEntries: job.options.operatorInventory?.length, inventorySha256: sha(canonical(job.options.operatorInventory)),
      HSegmentCount: calendar.segments.length, nativeSegmentCount: native.segments?.length ?? 0 } }
}

async function freezeEngine(out, comparisonModule) {
  const { build, version } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
  const captured = new Map(), guards = []
  const enginePath = resolve(out, 'engine.mjs')
  const entry = [
    "export { dutyTrajectoryFromReport } from './src/optimizer/mainRosterDutyTrace';",
    "export { integrateMainRosterDutyOutput } from './src/optimizer/mainRosterDutyIntegration';",
    "export { simulationOutputAmounts } from './src/simulator/productionScore';",
    `export { compareMainRosterDutyPrediction } from ${JSON.stringify('./' + comparisonModule)};`,
  ].join('\n')
  const result = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, absWorkingDir: root,
    bundle: true, platform: 'node', format: 'esm', outfile: enginePath, metafile: true,
    plugins: [{ name: 'bind-sources-and-forbid-simulation', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, args => {
        const bytes = readFileSync(args.path), sourceSha256 = sha(bytes)
        captured.set(args.path, sourceSha256)
        let contents = bytes.toString('utf8')
        if (args.path.replaceAll('\\', '/').endsWith('/simulator/scheduleSimulation.ts')) {
          const header = contents.match(/^export function simulateSchedule[^\r\n]*\{\r?$/m)?.[0]
          assert(header, 'simulateSchedule signature changed; cannot install zero-call guard')
          contents = contents.replace(header, header + '\n; (globalThis as any).__dutyReplayForbiddenCalls++; throw new Error("DUTY_REPLAY_SIMULATION_FORBIDDEN");')
          guards.push({ path: relative(root, args.path).replaceAll('\\', '/'), sourceSha256, guardedSha256: sha(contents) })
        }
        return { contents, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(args.path) }
      })
    }}] })
  const inputs = Object.keys(result.metafile.inputs).filter(name => name !== '<stdin>').map(name => {
    const path = resolve(root, name), sha256 = captured.get(path)
    assert(sha256 && sha(readFileSync(path)) === sha256, `Source changed while bundling: ${path}`)
    return { path, sha256 }
  }).sort((a, b) => a.path.localeCompare(b.path))
  assert(guards.length === 1, 'Exactly one Native/H schedule entry guard is required')
  const manifest = { schemaVersion: 1, root, node: process.version, esbuild: version, entry, inputs,
    sourceSha256: sha(canonical(inputs)), bundle: fileBinding(enginePath), guards,
    script: fileBinding(fileURLToPath(import.meta.url)), exports: ['dutyTrajectoryFromReport', 'integrateMainRosterDutyOutput', 'compareMainRosterDutyPrediction', 'simulationOutputAmounts'],
    guardMeaning: 'Only the local replay bundle is instrumented to fail on simulateSchedule. Production source remains unchanged.' }
  write(resolve(out, 'source-manifest.json'), manifest)
  return manifest
}

function scalarErrors(predicted, actual) {
  return Object.fromEntries(['exp', 'gold', 'orderLmd', 'virtualGold', 'fragments', 'orundum'].map(key => {
    const expected = actual?.[key] ?? null
    const value = predicted?.[key] ?? null
    return [key, { predicted: value, nativeCompleted: expected, signedError: value === null || expected === null ? null : value - expected,
      relativeError: value === null || !expected ? null : (value - expected) / expected }]
  }))
}

function approximatelySameAmounts(a, b) {
  return a && b && Object.keys(a).every(key => typeof a[key] === 'number' && typeof b[key] === 'number'
    && Math.abs(a[key] - b[key]) <= Math.max(1e-7, 1e-11 * Math.abs(a[key])))
}

function approximatelySameEvidence(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return typeof a === 'number' && typeof b === 'number'
    && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-7, 1e-11 * Math.max(Math.abs(a), Math.abs(b)))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && approximatelySameEvidence(a[key], b[key]))
}

function roomDiagnostics(calendar, native) {
  const indexed = new Map(native.rooms.map(room => [room.roomId, room]))
  return calendar.rooms.map(predicted => {
    const observed = indexed.get(predicted.roomId)
    const histogram = room => (room?.teams ?? []).map(team => ({ operatorIds: team.operatorIds, hours: team.hours, fraction: team.fraction }))
    return { roomId: predicted.roomId, roomType: predicted.roomType,
      efficiencyPercentHours: { predicted: predicted.efficiencyPercentHours, observed: observed?.efficiencyPercentHours ?? null,
        difference: observed ? predicted.efficiencyPercentHours - observed.efficiencyPercentHours : null },
      occupiedHours: { predicted: predicted.occupiedHours, observed: observed?.occupiedHours ?? null },
      predictedJointTeamHistogram: histogram(predicted), observedJointTeamHistogram: histogram(observed),
      crossRoomChronology: 'not-observed',
      interpretation: 'Direct saved within-room team observations; no products of marginal operator proportions.' }
  })
}

async function benchmark(args) {
  const started = performance.now(), manifestBytes = readFileSync(args.cases), manifest = JSON.parse(manifestBytes.toString('utf8'))
  const manifestDirectory = dirname(args.cases)
  assert(Array.isArray(manifest.cases) && manifest.cases.length, 'Manifest must contain cases')
  assert(typeof manifest.nativeSourceManifest === 'string', 'nativeSourceManifest is required to reuse old F labels')
  const compatibility = nativeCompatibility(resolve(manifestDirectory, manifest.nativeSourceManifest))
  const cases = manifest.cases.map(row => bindCase(row, manifestDirectory))
  assert(new Set(cases.map(row => row.id)).size === cases.length, 'Duplicate case id')
  const protectedFiles = [...new Set([args.cases, compatibility.manifest.path,
    ...(manifest.protectedFiles ?? []).map(path => resolve(manifestDirectory, path)),
    ...cases.flatMap(row => Object.values(row.files).map(file => file.path))])].map(fileBinding)
  mkdirSync(dirname(args.out), { recursive: true })
  mkdirSync(args.out)
  args.outputCreated = true
  write(resolve(args.out, 'input-manifest.json'), { schemaVersion: 1, manifest: { path: args.cases, sha256: sha(manifestBytes) },
    protectedFiles, cases: cases.map(({ id, split, files, binding }) => ({ id, split, files, binding })) })
  write(resolve(args.out, 'native-compatibility.json'), compatibility)
  const source = await freezeEngine(args.out, manifest.comparisonModule ?? 'src/optimizer/mainRosterDutyCalibration.ts')
  globalThis.__dutyReplayForbiddenCalls = 0
  const engine = await import(pathToFileURL(source.bundle.path).href)
  const results = []
  for (const row of cases) {
    const caseStarted = performance.now(), cpuStarted = process.cpuUsage(), out = resolve(args.out, row.id)
    mkdirSync(out)
    const weights = row.job.options.productionWeights ?? row.job.workspace.productionWeights
    const trajectory = engine.dutyTrajectoryFromReport({ job: row.job }, row.calendar)
    assert(trajectory.cost.scheduleOnlyCalls === 0, `Saved report conversion unexpectedly charged new H: ${row.id}`)
    const projection = engine.integrateMainRosterDutyOutput(trajectory, weights)
    assert(projection.status === 'estimated', `Cannot quantify ${row.id}: ${projection.status}; ${projection.diagnostics.join('; ')}`)
    const comparison = engine.compareMainRosterDutyPrediction(row.job, row.calendar, row.native, projection)
    write(resolve(out, 'trajectory.json'), trajectory)
    write(resolve(out, 'projection.json'), projection)
    write(resolve(out, 'comparison.json'), comparison)
    write(resolve(out, 'rooms.json'), roomDiagnostics(row.calendar, row.native))
    assert(comparison.status === 'comparable', `Paired comparison rejected ${row.id}: ${comparison.status}; ${comparison.diagnostics.join('; ')}`)
    let baselinePhaseReplay = null, baselineComparison = null
    if (row.baseline) {
      if (row.baselineTrajectory) {
        const frame = phase => ({ start: phase.start, end: phase.end, jointState: phase.jointState })
        assert(row.baselineTrajectory.sourceKind === 'predicted-schedule'
          && same(row.baselineTrajectory.window, trajectory.window)
          && same(row.baselineTrajectory.operators, trajectory.operators), `Old trajectory does not preserve exact predicted input identity: ${row.id}`)
        assert(same(row.baselineTrajectory.phases.map(frame), trajectory.phases.map(frame)), `Old and new projection use different joint calendar phases: ${row.id}`)
        const replay = engine.integrateMainRosterDutyOutput(row.baselineTrajectory, weights)
        const identityKeys = ['status', 'coverageHours', 'operatorDuty', 'jointStateHours', 'predictionEligible', 'nativeScheduleParity']
        assert(replay.status === 'estimated' && approximatelySameAmounts(replay.amounts, row.baseline.amounts)
          && approximatelySameEvidence(replay.score, row.baseline.score)
          && identityKeys.every(key => approximatelySameEvidence(replay[key], row.baseline[key])), `Saved old phase integral cannot reproduce baseline amounts/score/identity: ${row.id}`)
        baselinePhaseReplay = { matchesSavedAmounts: true, matchesSavedScore: true, matchesSavedProjectionIdentity: true,
          exactCalendarPhasesUnchanged: true, projection: replay, baselineSource: row.files.baseline, trajectorySource: row.files.baselineTrajectory }
        write(resolve(out, 'baseline-phase-replay.json'), baselinePhaseReplay)
      }
      baselineComparison = engine.compareMainRosterDutyPrediction(row.job, row.calendar, row.native, row.baseline)
      write(resolve(out, 'baseline-comparison.json'), baselineComparison)
      assert(baselineComparison.status === 'comparable', `Old paired comparison rejected ${row.id}: ${baselineComparison.status}`)
    }
    const nativeAmounts = engine.simulationOutputAmounts(row.native)
    const before = row.baseline ? scalarErrors(row.baseline.amounts, nativeAmounts) : null
    const after = scalarErrors(projection.amounts, nativeAmounts)
    const cpu = process.cpuUsage(cpuStarted)
    const summary = { id: row.id, split: row.split, binding: row.binding, files: row.files,
      newFullFCalls: 0, newShortFCalls: 0, newHCalls: 0, forbiddenSimulationCalls: globalThis.__dutyReplayForbiddenCalls,
      trajectoryStatus: trajectory.status, projectionStatus: projection.status, nativeScheduleParity: trajectory.nativeScheduleParity,
      coverageHours: projection.coverageHours, phaseCount: trajectory.phases.length, nativeAmounts,
      nativeSavedCompletedAmounts: row.native.production.sample.completed,
      nativeAmountScope: 'Shared simulationOutputAmounts: sample completed physical output plus event-derived virtual gold/fragments/orundum, exactly as Native scoring.',
      nativeQuality: comparison.nativeQuality, activeWorkerErrors: comparison.activeWorkerErrors,
      crossRoomJointParity: comparison.crossRoomJointParity,
      priorHCost: row.files.calendarSummary ? json(row.files.calendarSummary.path).timing : null,
      conversionCost: trajectory.cost,
      baseline: row.baseline ? { status: row.baseline.status, score: row.baseline.score, errors: before, phaseIntegralReproduced: baselinePhaseReplay?.matchesSavedAmounts ?? null } : null,
      current: { score: projection.score, errors: after },
      absoluteErrorReduction: before ? Object.fromEntries(Object.keys(after).map(key => [key, before[key].signedError === null || after[key].signedError === null ? null
        : Math.abs(before[key].signedError) - Math.abs(after[key].signedError)])) : null,
      elapsedMs: performance.now() - caseStarted, cpuMs: (cpu.user + cpu.system) / 1000 }
    write(resolve(out, 'summary.json'), summary)
    results.push(summary)
    console.log(JSON.stringify({ id: row.id, projectionStatus: projection.status, before: row.baseline?.amounts ?? null, after: projection.amounts, native: nativeAmounts, newF: 0, newH: 0 }))
  }
  assert(globalThis.__dutyReplayForbiddenCalls === 0, 'A forbidden schedule call was attempted')
  for (const file of [...protectedFiles, ...source.inputs, source.script]) assert(sha(readFileSync(file.path)) === file.sha256, `Input/source drifted during replay: ${file.path}`)
  const boundaries = [
    'This replay reads saved predicted H calendars and already completed Native labels; it starts no calendar and no F.',
    'All cases are development/retrospective evidence unless an independently declared unobserved split is supplied. The present two known layouts are not a blind holdout.',
    'Manufacturing is continuous potential output versus completed discrete batches; sample opening unfinished batch progress is not recorded.',
    'Trading renewal expectation lacks cross-phase pending-order memory and is not exact single-seed completed revenue.',
    'Native room teams give within-room joint histograms, without cross-room chronology. Missing Native global segments cannot be reconstructed by multiplying marginal duty fractions.',
    'Observed production is used only to measure errors, never to fit a multiplier or alter predicted phase rates.',
    'No accuracy gain here enables theoretical projections for final optimizer selection or establishes real game behavior.',
  ]
  const summary = { schemaVersion: 1, kind: 'saved-H-duty-model-replay', completed: true,
    manifest: fileBinding(args.cases), sourceManifest: fileBinding(resolve(args.out, 'source-manifest.json')),
    nativeCompatibility: { count: compatibility.count, matches: true },
    newFullFCalls: 0, newShortFCalls: 0, newHCalls: 0, forbiddenSimulationCalls: 0,
    protectedFilesUnchanged: true, bundledSourcesUnchanged: true,
    blindHoldoutCases: cases.filter(row => row.split === 'blind-holdout').length,
    results, boundaries, elapsedMs: performance.now() - started }
  write(resolve(args.out, 'summary.json'), summary)
  const table = results.map(row => `| ${row.id} | ${row.split} | ${row.baseline?.errors.orderLmd.relativeError === null || !row.baseline ? 'n/a' : (100 * row.baseline.errors.orderLmd.relativeError).toFixed(6) + '%'} | ${(100 * row.current.errors.orderLmd.relativeError).toFixed(6)}% | ${row.current.score.total.toFixed(6)} |`).join('\n')
  writeFileSync(resolve(args.out, 'REPORT.md'), `# Saved H duty-model replay\n\n0 new F, 0 short F, 0 new H. Native dependencies matched: ${compatibility.count}. Protected evidence and bundled sources remain unchanged.\n\n| Case | Split | Old trade error | Current trade error | Current predicted daily score |\n| --- | --- | --- | --- | --- |\n${table}\n\nPer-person W/E/R/I and W/T errors are in each case's comparison.json; output errors and hashes are in summary.json.\n\n${boundaries.map(item => '- ' + item).join('\n')}\n`, { flag: 'wx' })
  return summary
}

let args
try {
  args = argumentsFrom(process.argv.slice(2))
  if (!args) console.log(usage)
  else await benchmark(args)
} catch (error) {
  if (args?.outputCreated && !existsSync(resolve(args.out, 'failure.json'))) {
    write(resolve(args.out, 'failure.json'), { completed: false, error: error instanceof Error ? error.stack : String(error),
      newFullFCalls: 0, newShortFCalls: 0, newHCalls: 0, forbiddenSimulationCalls: globalThis.__dutyReplayForbiddenCalls ?? 0 })
  }
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
}
