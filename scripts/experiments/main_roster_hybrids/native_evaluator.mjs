// Research CLI only. Default denies physical evaluation; all labels come from actual same-run responses.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
/** Bump when interpreting native quality evidence changes; solver source is not part of the F key. */
export const NATIVE_EVIDENCE_SCHEMA = 'riic-native-evidence-v2-permanent-primary'
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const clone = value => JSON.parse(JSON.stringify(value))
const finite = value => typeof value === 'number' && Number.isFinite(value)
const jsonFile = (path, value) => { assert(!existsSync(path), `Refuse overwriting evidence: ${path}`); writeFileSync(path, JSON.stringify(value, null, 2)) }
const artifact = path => ({ path: resolve(path), sha256: sha256(readFileSync(path)) })

/** Preserve native insertion order, including facilities and member arrays. Never sort job keys. */
export function orderedJobIdentity(job, engineIdentity) {
  const jobJson = JSON.stringify(job), job_json_sha256 = sha256(jobJson)
  const engine_fingerprint = sha256(JSON.stringify(engineIdentity))
  return { cache_key: sha256(JSON.stringify({ schemaVersion: 1, engine_fingerprint, job_json_sha256 })),
    engine_fingerprint, job_json_sha256, jobJson }
}

export function makeTrainingJob(caseInput, workspace, fidelity = 'full', seed = 42) {
  if (seed !== 42) return { status: 'unsupported', reason: 'unsupported-seed', requested_seed: seed }
  if (!['full', 'short'].includes(fidelity)) return { status: 'unsupported', reason: 'unsupported-fidelity' }
  const template = caseInput.fullJob ?? { workspace: caseInput.initial ?? caseInput.incumbent, options: caseInput.options, assumptions: caseInput.assumptions }
  if (!template?.options || !template.assumptions) return { status: 'unknown', reason: 'missing-exact-native-job-template' }
  const job = clone(template)
  if (job.options.production?.seed !== 42) return { status: 'unsupported', reason: 'case-template-seed-is-not-42' }
  if (job.options.maxStepHours !== 0.25) return { status: 'unsupported', reason: 'case-template-step-is-not-quarter-hour' }
  if (job.options.warmupHours !== 24 || job.options.sampleHours !== 72) return { status: 'unsupported', reason: 'case-template-is-not-full-training-window' }
  job.workspace = clone(workspace)
  // Existing property assignment does not reorder native option fields.
  job.options.warmupHours = fidelity === 'full' ? 24 : 6
  job.options.sampleHours = fidelity === 'full' ? 72 : 18
  job.options.maxStepHours = 0.25
  job.options.production = { ...job.options.production, seed }
  if (job.options.production.droneTarget !== 'none') return { status: 'rejected', reason: 'training-requires-drone-none' }
  if (job.incomeComparison !== undefined || job.generatedBackup !== undefined || job.workspace?.compatibility?.backupPlans?.length) {
    return { status: 'rejected', reason: 'unsupported-job-admission-mode-or-side-plans' }
  }
  return { status: 'ready', job }
}

/** A single invocation; raw response comes from the frozen engine observer, never a second bridge call. */
export function runObservedSimulation(simulate, job) {
  const captures = { responses: [], bridgeInputs: [], effectiveInputs: [], candidateJobs: [] }
  const names = ['__fullLayoutObserveResponse', '__fullLayoutObserveBridge', '__fullLayoutObserveEffectiveBridge', '__fullLayoutObserveCandidate']
  const previous = new Map(names.map(name => [name, globalThis[name]]))
  globalThis.__fullLayoutObserveResponse = value => captures.responses.push(value)
  globalThis.__fullLayoutObserveBridge = value => captures.bridgeInputs.push(value)
  globalThis.__fullLayoutObserveEffectiveBridge = value => captures.effectiveInputs.push(value)
  globalThis.__fullLayoutObserveCandidate = value => captures.candidateJobs.push(value)
  const cpu = process.cpuUsage(), started = performance.now()
  let result = null, error = null
  try { result = simulate(job) } catch (caught) { error = { message: caught.message, stack: caught.stack } }
  const elapsed_ms = performance.now() - started, used = process.cpuUsage(cpu)
  for (const name of names) { if (previous.get(name) === undefined) delete globalThis[name]; else globalThis[name] = previous.get(name) }
  return { result, error, captures, timing: { native_elapsed_ms: elapsed_ms, native_cpu_user_ms: used.user / 1000, native_cpu_system_ms: used.system / 1000 } }
}

export function nativeMetadata(report, summarizeIncome) {
  if (!report) return { native_complete: false, strictEligibility: null, ordinaryFatiguedHours: null, unresolvedEpisodes: null, strictIssues: null }
  let income = null, error = null
  try { income = summarizeIncome(report) } catch (caught) { error = caught.message }
  const configuredPermanent = new Set(report.inputs?.schedule?.policies?.workaholic ?? [])
  const operatorsKnown = Array.isArray(report.operators)
  const observed = report.observedHours, sample = report.assumptions?.sampleHours, warmup = report.assumptions?.warmupHours
  const primarySlots = (report.inputs?.schedule?.rooms ?? []).filter(room => room.type !== 'dormitory').flatMap(room => room.slots)
  // Match incomeComparison's measured permanent-primary exception; configuration alone is not proof.
  const provenPermanent = op => configuredPermanent.has(op.operatorId)
    && primarySlots.filter(slot => slot.primaryOperatorId === op.operatorId).length === 1
    && finite(observed) && finite(op.permanentPrimaryOccupancyHours) && Math.abs(op.permanentPrimaryOccupancyHours - observed) <= 1e-5
    && finite(op.workHours) && finite(op.exhaustedHours) && Math.abs(op.workHours + op.exhaustedHours - observed) <= 1e-5
    && op.restHours === 0 && op.idleHours === 0
  const exempt = operatorsKnown ? report.operators.filter(provenPermanent) : []
  const validFatigueTimes = operatorsKnown && report.operators.every(op => finite(op.exhaustedHours) && op.exhaustedHours >= 0)
  const fatigue = validFatigueTimes ? report.operators.filter(op => !provenPermanent(op)).reduce((n, op) => n + op.exhaustedHours, 0) : null
  const episodesKnown = Array.isArray(report.shiftDeferrals), episodes = report.shiftDeferrals ?? []
  const native_complete = report.success === true && report.production?.success === true && finite(observed) && observed > 0
    && finite(sample) && Math.abs(observed - sample) < 1e-5 && Math.abs(report.elapsedHours - sample - warmup) < 1e-5
  const completed = report.production?.sample?.completed, ratio = observed > 0 ? 24 / observed : null
  return { native_complete, native_success: report.success, production_success: report.production?.success ?? null,
    observedHours: observed, elapsedHours: report.elapsedHours, strictEligibility: income?.eligible ?? null, strictIssues: income?.issues ?? null,
    strictMetadataError: error, ordinaryFatiguedHours: finite(fatigue) ? fatigue : null,
    provenPermanentPrimaryExemptions: exempt.map(op => ({ operatorId: op.operatorId, exhaustedHours: op.exhaustedHours,
      permanentPrimaryOccupancyHours: op.permanentPrimaryOccupancyHours })),
    configuredWorkaholicIsNotAutomaticExemption: true,
    unresolvedEpisodes: episodesKnown ? episodes.filter(episode => episode.resolvedAt === undefined).length : null,
    resolvedEpisodes: episodesKnown ? episodes.filter(episode => episode.resolvedAt !== undefined).length : null,
    shiftDeferrals: episodesKnown ? episodes : null,
    blockingDiagnostics: (report.diagnostics ?? []).filter(issue => issue.code === 'group-blocked'),
    incomeOutputDaily: income?.output?.daily ?? null,
    exp: ratio !== null && finite(completed?.exp) ? completed.exp * ratio : null,
    gold: ratio !== null && finite(completed?.gold) ? completed.gold * ratio : null,
    order_lmd: ratio !== null && finite(completed?.orderLmd) ? completed.orderLmd * ratio : null,
    qualityMeaning: 'Strict comparison eligibility, sample ordinary fatigue, pending deferrals and actual game verification are separate; game execution was not tested.' }
}

export class NativeEvaluator {
  static async create(config) {
    const instance = new NativeEvaluator(config)
    await instance.initialize()
    return instance
  }
  constructor(config) { this.config = config; this.physical = 0; this.candidateInvocations = 0; this.imports = 0; this.sequence = 0; this.nativeMs = 0; this.cpuMs = 0 }
  async initialize() {
    const config = this.config
    this.bindingPath = resolve(config.engineBindingPath); this.binding = read(this.bindingPath)
    this.bundlePath = resolve(this.binding.bundlePath); this.manifestPath = resolve(this.binding.manifestPath)
    this.manifest = read(this.manifestPath)
    assert.equal(sha256(readFileSync(this.bundlePath)), this.binding.bundleSha256)
    assert.equal(sha256(readFileSync(this.manifestPath)), this.binding.manifestSha256)
    assert.equal(this.manifest.sourceSha256, this.binding.sourceSha256)
    assert(Array.isArray(this.manifest.inputs) && this.manifest.inputs.length > 0, 'Missing native transitive source binding')
    this.verifySource()
    this.engineIdentity = { source_sha256: this.binding.sourceSha256, bundle_sha256: this.binding.bundleSha256, manifest_sha256: this.binding.manifestSha256,
      node_version: process.version, analysis_schema: NATIVE_EVIDENCE_SCHEMA }
    this.engine = await import(pathToFileURL(this.bundlePath).href)
    for (const fn of ['simulateCandidateWithProgress', 'summarizeIncome', 'compileRosterSchedule', 'compileOperatorInventory', 'validateScheduleInventory', 'validatePhysicalRoster']) assert.equal(typeof this.engine[fn], 'function')
    this.out = resolve(config.outDir); mkdirSync(this.out, { recursive: true })
    if (config.casePath) {
      this.casePath = resolve(config.casePath); this.caseInput = read(this.casePath)
      const jobPath = this.caseInput.fullJobPath ?? this.caseInput.fullJobTemplatePath
      if (jobPath) this.caseInput.fullJob = read(resolve(dirname(this.casePath), jobPath))
      else if (existsSync(resolve(dirname(this.casePath), 'full-job.json'))) this.caseInput.fullJob = read(resolve(dirname(this.casePath), 'full-job.json'))
    }
    if (config.domainPath) {
      this.domainPath = resolve(config.domainPath); this.domain = read(this.domainPath)
      this.domainFileSha256 = sha256(readFileSync(this.domainPath))
      assert.equal(this.domain.schemaVersion, 1)
      assert.equal(this.domain.sceneId, this.caseInput.sceneId)
      assert(this.domain.publicSpec && this.domain.materializations)
      const domainBindingPath = resolve(dirname(this.domainPath), 'domain-binding.json')
      if (existsSync(domainBindingPath)) {
        this.domainBindingPath = domainBindingPath; this.domainBinding = read(domainBindingPath)
        this.domainBindingFileSha256 = sha256(readFileSync(domainBindingPath))
        assert.equal(this.domainBinding.domainSha256, this.domainFileSha256)
        assert.equal(this.domainBinding.caseSha256, sha256(readFileSync(this.casePath)))
        assert.equal(this.domainBinding.engineBundleSha256, this.binding.bundleSha256)
        assert.equal(this.domainBinding.engineSourceSha256, this.binding.sourceSha256)
      } else assert(!config.allowNative, 'Physical training requires an independently source-bound domain; cache-only smoke may record file-only provenance')
      this.verifySource()
    }
  }
  verifySource() {
    assert(this.manifest.inputs.every(row => existsSync(row.path) && sha256(readFileSync(row.path)) === row.sha256), 'Native source bytes drifted; HEAD equality alone is insufficient')
    assert.equal(sha256(readFileSync(this.bundlePath)), this.binding.bundleSha256)
    if (this.domainPath) assert.equal(sha256(readFileSync(this.domainPath)), this.domainFileSha256, 'Private domain artifact changed')
    if (this.domainBinding) {
      assert.equal(sha256(readFileSync(this.domainBindingPath)), this.domainBindingFileSha256, 'Domain binding changed')
      assert(this.domainBinding.inputs.every(row => sha256(readFileSync(row.path)) === row.sha256), 'Domain transitive sources changed')
      assert.equal(sha256(readFileSync(this.domainBinding.domainBundlePath)), this.domainBinding.domainBundleSha256)
      assert.equal(sha256(readFileSync(this.domainBinding.inputPath)), this.domainBinding.inputSha256)
    }
  }
  stats() { return { candidate_invocations: this.candidateInvocations, physical_f_calls: this.physical, imported_physical_records: this.imports,
    native_elapsed_ms: this.nativeMs, native_cpu_ms: this.cpuMs, phase: this.config.phase ?? 'training' } }
  hello() { return { protocol: 'riic-native-jsonl-v1', engine_identity: this.engineIdentity, fixed_seed: 42, full: { warmup: 24, sample: 72 }, short: { warmup: 6, sample: 18 },
    allow_native: this.config.allowNative === true, metrics: ['exp', 'order_lmd', 'gold', 'change_cost', 'ordinaryFatiguedHours', 'strictEligibility', 'unresolvedEpisodes'], stats: this.stats() } }
  prepare(vector, fidelity = 'full', seed = 42) {
    if (seed !== 42) return { status: 'unsupported', reason: 'unsupported-seed', requested_seed: seed, score: null }
    if (!this.domain) return { status: 'unknown', reason: 'missing-domain', score: null }
    this.verifySource()
    if (!Array.isArray(vector) || vector.length !== this.domain.publicSpec.domains.length || vector.some((value, index) => !Number.isSafeInteger(value) || value < 0 || value >= this.domain.publicSpec.domains[index])) {
      return { status: 'rejected', reason: 'invalid-vector', score: null }
    }
    const materialization = this.domain.materializations[vector.join(',')]
    if (!materialization) return { status: 'unknown', reason: 'undeclared-materialization', score: null }
    if (materialization.status !== 'ready') return { status: materialization.status, reason: 'materialization-' + materialization.status, diagnostics: materialization.diagnostics, score: null }
    if (!materialization.workspace || !finite(materialization.primaryHourlyScore)) return { status: 'unknown', reason: 'unmeasured-ready-materialization', score: null }
    const prepared = makeTrainingJob(this.caseInput, materialization.workspace, fidelity, seed)
    if (prepared.status !== 'ready') return { ...prepared, score: null }
    const identity = orderedJobIdentity(prepared.job, this.engineIdentity)
    return { status: 'ready', vector: [...vector], fidelity, seed, job: prepared.job, identity, analysis_schema: NATIVE_EVIDENCE_SCHEMA, primaryHourlyScore: materialization.primaryHourlyScore,
      changeCost: materialization.changedOperators?.length ?? null, diagnostics: materialization.diagnostics, domainAdmission: 'ready-bound-materialization',
      domain_binding: { domainPath: this.domainPath, domainSha256: this.domainFileSha256, bindingPath: this.domainBindingPath ?? null,
        bindingSha256: this.domainBindingFileSha256 ?? null, sourceBound: !!this.domainBinding } }
  }
  admission(job) {
    try {
      const physical = this.engine.validatePhysicalRoster(job.workspace), schedule = this.engine.compileRosterSchedule(job.workspace, job.assumptions)
      const inventory = this.engine.compileOperatorInventory(job.options.operatorInventory ?? [])
      const owned = this.engine.validateScheduleInventory(schedule, inventory)
      const compileErrors = schedule.diagnostics.filter(issue => issue.severity === 'error')
      return { valid: !physical.length && !compileErrors.length && owned.valid, physical, compileErrors, inventoryValid: owned.valid, inventoryDiagnostics: owned.diagnostics }
    } catch (error) { return { valid: false, reason: error.message } }
  }
  makeRecord(prepared, candidate, response, admission, provenance, timing, counters, error = null) {
    const metadata = nativeMetadata(response?.report, this.engine.summarizeIncome)
    const observed_score = metadata.native_complete && finite(candidate?.simScore) ? candidate.simScore : null
    const valid = admission.valid && prepared.domainAdmission !== 'rejected' && candidate?.completed === true && metadata.native_complete && finite(observed_score)
    let reason = null
    if (error) reason = error.message
    else if (!admission.valid) reason = 'structural-native-admission-rejected'
    else if (candidate?.completed !== metadata.native_complete) reason = 'compact-native-completion-mismatch'
    else if (!valid) reason = 'incomplete-or-nonfinite-native-result'
    const incomeScore = metadata.incomeOutputDaily?.total
    if (finite(incomeScore) && finite(observed_score) && Math.abs(incomeScore - observed_score) > 1e-5) reason = 'compact-native-score-mismatch'
    return { vector: prepared.vector ?? null, fidelity: prepared.fidelity, seed: prepared.seed, analysis_schema: NATIVE_EVIDENCE_SCHEMA, valid: valid && reason !== 'compact-native-score-mismatch',
      score: valid && reason !== 'compact-native-score-mismatch' ? observed_score : null, observed_score,
      completed: candidate?.completed ?? false, native_complete: metadata.native_complete, reason,
      compact_result_fields: { completed: candidate?.completed ?? null, simScore: finite(candidate?.simScore) ? candidate.simScore : null, diagnostics: candidate?.diagnostics ?? null },
      evidence_type: provenance.kind === 'incumbent-exact-reuse' ? 'riic-native-exact-incumbent-reuse' : 'riic-native-same-run',
      metrics: { ...metadata, change_cost: prepared.changeCost ?? null, domainAdmission: prepared.domainAdmission ?? 'external-exact-job',
        domainPrimaryHourlyScore: prepared.primaryHourlyScore ?? null, gameVerified: null },
      identity: { cache_key: prepared.identity.cache_key, engine_fingerprint: prepared.identity.engine_fingerprint, job_json_sha256: prepared.identity.job_json_sha256 },
      engine_identity: this.engineIdentity, provenance, timing, counters }
  }
  persistRecord(dir, record) {
    const path = resolve(dir, 'evaluation.json'); jsonFile(path, record)
    return { ...record, provenance: { ...record.provenance, evaluationRecordPath: path, evaluationRecordSha256: sha256(readFileSync(path)) } }
  }
  async evaluate(prepared) {
    if (prepared.status !== 'ready') return { valid: false, score: null, reason: prepared.reason, status: prepared.status, counters: { physical_f_calls: 0 } }
    if (!this.config.allowNative) return { valid: false, score: null, reason: 'native-evaluation-not-authorized', counters: { physical_f_calls: 0 } }
    if (this.physical >= (this.config.maxPhysicalF ?? Infinity)) return { valid: false, score: null, reason: 'physical-budget-exhausted', counters: { physical_f_calls: 0 } }
    this.verifySource()
    assert.equal(orderedJobIdentity(prepared.job, this.engineIdentity).cache_key, prepared.identity.cache_key, 'Prepared job changed')
    const admission = this.admission(prepared.job)
    if (!admission.valid) return { valid: false, score: null, reason: 'structural-native-admission-rejected', metrics: { admission }, counters: { physical_f_calls: 0 } }
    const dir = resolve(this.out, `physical-${String(++this.sequence).padStart(5, '0')}`); assert(!existsSync(dir)); mkdirSync(dir)
    this.candidateInvocations++
    const run = runObservedSimulation(job => this.engine.simulateCandidateWithProgress(job), prepared.job)
    // Timer is already stopped: all report inspection, JSON/hashes and filesystem work happens below.
    const physical = run.captures.effectiveInputs.length
    this.physical += physical; this.nativeMs += run.timing.native_elapsed_ms; this.cpuMs += run.timing.native_cpu_user_ms + run.timing.native_cpu_system_ms
    const response = run.captures.responses.length === 1 ? run.captures.responses[0] : null
    jsonFile(resolve(dir, 'exact-job.json'), prepared.job); jsonFile(resolve(dir, 'candidate-result.json'), run.result)
    jsonFile(resolve(dir, 'native-response.json'), response)
    jsonFile(resolve(dir, 'bridge-inputs.json'), run.captures.bridgeInputs); jsonFile(resolve(dir, 'effective-inputs.json'), run.captures.effectiveInputs)
    assert(run.captures.responses.length <= 1 && physical <= 1, 'A single logical evaluator secretly invoked multiple native F calls')
    this.verifySource()
    const provenance = { kind: 'same-run', engineBindingPath: this.bindingPath, engineBindingSha256: sha256(readFileSync(this.bindingPath)),
      casePath: this.casePath ?? null, domainPath: this.domainPath ?? null, rawResponseSource: 'same __fullLayoutObserveResponse reference; no extra bridge invocation',
      domain_binding: prepared.domain_binding ?? null,
      artifact_files: ['exact-job.json', 'candidate-result.json', 'native-response.json', 'bridge-inputs.json', 'effective-inputs.json'].map(name => artifact(resolve(dir, name))) }
    const record = this.makeRecord(prepared, run.result, response, admission, provenance, run.timing,
      { candidate_invocations: 1, physical_f_calls: physical, physical_native_reports: response?.report ? 1 : 0, reused_physical_records: 0 }, run.error)
    return this.persistRecord(dir, record)
  }
  async importIncumbent(prepared) {
    const evidence = this.caseInput?.incumbentEvidence
    if (prepared.status !== 'ready' || !evidence) return { status: 'unavailable', reason: 'missing-ready-incumbent-evidence' }
    this.verifySource()
    const pathOf = (...keys) => { const value = keys.map(key => evidence[key]).find(Boolean); return value ? resolve(dirname(this.casePath), typeof value === 'string' ? value : value.path) : null }
    const enginePath = pathOf('engineBindingPath'), jobPath = pathOf('exactJobPath'), summaryPath = pathOf('summaryPath'),
      responsePath = pathOf('nativeResponsePath'), observationsPath = pathOf('candidateObservationsPath', 'candidateObservationPath', 'candidateResultPath'), caseBindingPath = pathOf('caseBindingPath')
    if ([enginePath, jobPath, summaryPath, responsePath, observationsPath, caseBindingPath].some(path => !path || !existsSync(path))) return { status: 'unavailable', reason: 'incomplete-incumbent-proof-paths' }
    const oldEngine = read(enginePath), oldJob = read(jobPath), oldSummary = read(summaryPath), oldBinding = read(caseBindingPath)
    if (oldEngine.bundleSha256 !== this.binding.bundleSha256 || oldEngine.sourceSha256 !== this.binding.sourceSha256 || oldEngine.manifestSha256 !== this.binding.manifestSha256) return { status: 'unavailable', reason: 'incumbent-native-engine-binding-differs' }
    if (this.manifest.node && this.manifest.node !== process.version) return { status: 'unavailable', reason: 'incumbent-node-runtime-differs' }
    if (JSON.stringify(oldJob) !== prepared.identity.jobJson) return { status: 'unavailable', reason: 'incumbent-entire-ordered-job-differs' }
    if (oldBinding.productBundleSha256 !== this.binding.bundleSha256 || oldBinding.sourceSha256 !== this.binding.sourceSha256 || oldSummary.sourceBindingStillValid !== true) return { status: 'unavailable', reason: 'incumbent-run-source-proof-missing' }
    const observations = read(observationsPath), expectedHash = prepared.identity.job_json_sha256
    const observation = (Array.isArray(observations) ? observations : [observations]).find(row => row.jobSha256 === expectedHash)
    if (!observation || observation.reportSha256 !== oldSummary.reportSha256 || oldSummary.selectedCandidateReportMatchesFinal !== true) return { status: 'unavailable', reason: 'incumbent-compact-report-proof-mismatch' }
    const response = read(responsePath), admission = this.admission(oldJob)
    const capacity = response.report?.inputs?.options?.efficiencyResources?.droneCapacity
    const expectedWorkspace = { ...oldJob.workspace, droneCapacity: capacity }
    const expectedOptions = { schedulingModel: 'mower-alpha', ...oldJob.options,
      efficiencyResources: { ...oldJob.options.efficiencyResources, droneCapacity: capacity } }
    if (!Number.isSafeInteger(capacity) || JSON.stringify(response.report?.inputs?.schedule?.sourceWorkspace) !== JSON.stringify(expectedWorkspace)
      || JSON.stringify(response.report?.inputs?.options) !== JSON.stringify(expectedOptions)) {
      return { status: 'unavailable', reason: 'incumbent-raw-response-ordered-input-proof-differs' }
    }
    const dir = resolve(this.out, `incumbent-${String(++this.sequence).padStart(5, '0')}`); assert(!existsSync(dir)); mkdirSync(dir)
    this.imports++
    const provenance = { kind: 'incumbent-exact-reuse', engineBindingPath: this.bindingPath, sourceEvidence: clone(evidence),
      compactEvidenceKind: 'original observed completed/simScore/report hash fields; not a fabricated full CandidateResult',
      artifact_files: [enginePath, jobPath, summaryPath, responsePath, observationsPath, caseBindingPath].map(artifact),
      reuseIsNotColdRuntimeSpeedup: true }
    const record = this.makeRecord(prepared, observation, response, admission, provenance,
      { native_elapsed_ms: 0, native_cpu_user_ms: 0, native_cpu_system_ms: 0, historicalGenerationElapsedMs: oldSummary.generationElapsedMs ?? null },
      { candidate_invocations: 0, physical_f_calls: 0, physical_native_reports: 0, reused_physical_records: 1 })
    return { status: 'ready', evaluation: this.persistRecord(dir, record) }
  }
}

/** Holdout uses only an independently derived exact training job; no domain search or generated repair. */
export async function evaluateExactJob(job, config) {
  assert.equal(config.phase, 'holdout', 'Custom-window exact jobs are holdout only')
  const evaluator = await NativeEvaluator.create({ ...config, phase: 'holdout' })
  const prepared = { status: 'ready', job: clone(job), vector: null, fidelity: 'holdout', seed: job.options?.production?.seed,
    domainAdmission: 'external-exact-job', identity: orderedJobIdentity(job, evaluator.engineIdentity) }
  return evaluator.evaluate(prepared)
}

async function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) { assert(process.argv[index]?.startsWith('--') && process.argv[index + 1]); args.set(process.argv[index].slice(2), process.argv[index + 1]) }
  for (const name of ['case', 'domain', 'engine-binding', 'out']) assert(args.has(name), `Missing --${name}`)
  const evaluator = await NativeEvaluator.create({ casePath: args.get('case'), domainPath: args.get('domain'), engineBindingPath: args.get('engine-binding'), outDir: args.get('out'),
    allowNative: args.get('allow-native') === 'yes', maxPhysicalF: Number(args.get('max-physical-f') ?? 0) })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    let request
    try {
      request = JSON.parse(line)
      let result
      if (request.op === 'hello') result = evaluator.hello()
      else if (request.op === 'prepare') result = evaluator.prepare(request.vector, request.fidelity, request.seed)
      else if (request.op === 'evaluate') {
        const prepared = evaluator.prepare(request.vector, request.fidelity, request.seed)
        if (request.expected_cache_key && prepared.identity?.cache_key !== request.expected_cache_key) result = { valid: false, score: null, reason: 'prepared-key-mismatch' }
        else result = await evaluator.evaluate(prepared)
      } else if (request.op === 'import-incumbent') result = await evaluator.importIncumbent(evaluator.prepare(request.vector, 'full', 42))
      else if (request.op === 'stats') result = evaluator.stats()
      else if (request.op === 'close') { process.stdout.write(JSON.stringify({ id: request.id, result: evaluator.stats() }) + '\n'); break }
      else result = { valid: false, score: null, reason: 'unsupported-operation' }
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
    } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id ?? null, error: { message: error.message, stack: error.stack } }) + '\n') }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
