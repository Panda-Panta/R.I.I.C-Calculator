/** Read-only artifact authentication for exposed latest FULL DEV. Never launches a model or simulator.
 * Usage: node parity-report.mjs TRAIN_RUN DEV_REFERENCE_RUN EXTERNAL_EVAL [--out NEW_REPORT.json]
 * Local SHA-256 integrity chains are not third-party signatures or proof of real-game accuracy.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { digest, qualifyEnvelope } from './state.mjs';
import { referenceManifestContract, referenceProtocol, LATEST_DEFAULT_REFERENCE } from '../full-baseline/reference-protocol.mjs';
import { verifyTeacherSourceCompatibility } from './source-compatibility.mjs';
import { openBaselineCache } from './baseline-cache.mjs';
import { sourceContracts } from '../full-train.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const equal = (a, b, label) => { if (digest(a) !== digest(b)) throw Error(label + ' mismatch'); };
const requireThat = (condition, label) => { if (!condition) throw Error(label); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function safeChild(root, child) {
    requireThat(typeof child === 'string' && child.length && !isAbsolute(child), 'Invalid relative artifact path');
    const path = resolve(root, child), rel = relative(realpathSync(root), realpathSync(path));
    requireThat(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Artifact escapes authenticated root');
    return path;
}
export function verifyFrozenProvenance(provenance, snapshot, bundle) {
    requireThat(provenance && sha(provenance.sourceHash) && sha(provenance.bundleHash) && provenance.sourceHashes && Object.keys(provenance.sourceHashes).length, 'Missing frozen provenance');
    equal(provenance.sourceHash, digest(provenance.sourceHashes), 'Frozen aggregate source hash');
    equal(provenance.bundleHash, digest(bundle), 'Frozen bundle hash');
    for (const [path, hash] of Object.entries(provenance.sourceHashes)) {
        requireThat(sha(hash) && typeof snapshot?.[path] === 'string', 'Missing source snapshot: ' + path);
        equal(hash, digest(snapshot[path]), 'Frozen source snapshot: ' + path);
    }
    return { sourceHash: provenance.sourceHash, bundleHash: provenance.bundleHash };
}
export function resolvedSimulationSettings(job) {
    return { warmupHours: job.input.options.simulationWarmupHours, sampleHours: job.input.options.simulationSampleHours,
        maxStepHours: job.maxStepHours, productionWeights: job.input.options.productionWeights, operatorInventory: job.input.entries,
        production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: job.input.options.droneTarget, droneRoomId: job.input.options.droneRoomId, seed: job.seed } };
}
export function verifySimulationArtifact(artifact, { binding, job, artifactHash }) {
    if (artifactHash !== undefined) equal(digest(artifact), artifactHash, 'Simulation artifact commitment');
    equal(artifact?.binding, binding, 'Simulation artifact binding');
    equal(artifact.jobHash, digest(job), 'Simulation artifact job');
    // Reuse is not self-authenticating. This adapter deliberately supports fresh paired runs only.
    requireThat(!artifact.baselineReuse?.sourceArtifactPath && !artifact.baselineReuse?.proof && artifact.baselineReuse?.reused !== true, 'Unvalidated baseline cache provenance');
    const outcome = artifact.outcome, wrapper = outcome?.result, result = wrapper?.result;
    if (outcome?.status !== 'completed' || wrapper?.completed !== true || result?.completed === false)
        return { available: false, score: null, rawDaily: null, status: outcome?.status ?? 'missing', result: null };
    requireThat(result?.completed === true && Number.isFinite(result.simScore), 'Missing authoritative simulation result');
    equal(wrapper.settings, resolvedSimulationSettings(job), 'Resolved simulator settings');
    requireThat(wrapper.fallbackPhysicalPlacements === 0, 'Simulation fallback or repair');
    requireThat(wrapper.score === result.simScore && (!result.incomeCase || result.incomeCase.eligible === true), 'Authoritative simulation score conflict');
    const summary = result.calculationReport?.summary;
    requireThat(summary && summary.totalScore82 === result.simScore && summary.scoreBreakdown?.total === result.simScore, 'Authoritative production report conflict');
    requireThat(['exp', 'goldValue', 'virtualGoldValue', 'orderLmd', 'fragments', 'orundum'].every(key => Number.isFinite(summary[key]) && summary[key] >= 0), 'Missing or negative authoritative daily production');
    const breakdown = summary.scoreBreakdown, weights = job.input.options.productionWeights;
    requireThat(['exp', 'goldValue', 'orderValue', 'weightedExp', 'weightedGold', 'weightedOrders', 'weightedFragments', 'weightedOrundum', 'total'].every(key => Number.isFinite(breakdown[key]) && breakdown[key] >= 0), 'Invalid authoritative score breakdown');
    requireThat(breakdown.weightedExp === weights.exp * breakdown.exp && breakdown.weightedOrders === weights.orders * breakdown.orderValue,
        'Authoritative weighted component conflict');
    if (summary.virtualGoldValue === 0) requireThat(breakdown.weightedGold === weights.gold * breakdown.goldValue, 'Authoritative weighted gold conflict');
    if (weights.fragments === 0) requireThat(breakdown.weightedFragments === 0, 'Authoritative fragment weight conflict');
    if (weights.orundum === 0) requireThat(breakdown.weightedOrundum === 0, 'Authoritative orundum weight conflict');
    requireThat(breakdown.total === breakdown.weightedExp + breakdown.weightedGold + breakdown.weightedOrders + breakdown.weightedFragments + breakdown.weightedOrundum, 'Authoritative ordered weighted sum conflict');
    const rawDaily = { exp: summary.exp, gold: summary.goldValue + summary.virtualGoldValue, orders: summary.orderLmd, fragments: summary.fragments, orundum: summary.orundum };
    requireThat(Object.values(rawDaily).every(Number.isFinite), 'Nonfinite authoritative daily production');
    return { available: true, score: result.simScore, rawDaily, status: 'completed', result };
}
export function verifyDecodeArtifact(artifact, { binding, job, protocol }) {
    equal(artifact?.binding, binding, 'Decode artifact binding');
    equal(artifact.jobHash, digest(job), 'Decode exact job');
    const result = artifact.outcome?.result;
    if (artifact.outcome?.status !== 'completed') return { available: false, result: null };
    requireThat(result?.familyId === job.input.familyId && result.modelHash === binding.modelHash, 'Decode family/model mismatch');
    equal(result.referenceProtocol, protocol, 'Decode reference protocol');
    requireThat(result.qualification?.qualified === true && result.qualification.reasons?.length === 0, 'Unqualified decode reference');
    requireThat(result.fallbackPhysicalPlacements === 0, 'Decode fallback or repair');
    requireThat(Number.isFinite(result.generationElapsedMs) && result.generationElapsedMs >= 0 && result.generationElapsedMs <= binding.timeoutMs, 'Decode generation budget invalid');
    requireThat(typeof result.complete === 'boolean', 'Missing decode completion state');
    return { available: result.complete && !!result.workspace, result };
}
/** The current cache producer has exactly one supported edge to a fresh DEV raw simulation.
 * Never recursively trust arbitrary proof objects; nested chains/cycles are unsupported and fail closed.
 */
export function verifyBaselineReuseLink({ side, artifact, sourceArtifact, sourcePath, verifiedProof }) {
    requireThat(side === 'baseline', 'Neural cache reuse forbidden');
    equal(artifact.baselineReuse?.sourceArtifactPath, sourcePath, 'Baseline cache source path');
    equal(artifact.baselineReuse?.proof, verifiedProof, 'Baseline cache independently reproduced proof');
    requireThat(verifiedProof?.reusedSide === 'baseline-only', 'Unknown baseline cache proof role');
    equal(verifiedProof.artifactHash, digest(sourceArtifact), 'Fresh baseline root artifact hash');
    equal(artifact.outcome, sourceArtifact.outcome, 'Reused baseline exact raw outcome');
    requireThat(!sourceArtifact.baselineReuse?.sourceArtifactPath && !sourceArtifact.baselineReuse?.proof && sourceArtifact.baselineReuse?.reused !== true, 'Unsupported nested baseline chain or cycle');
}
export function verifyCacheRootReceipt({ artifact, job, baselineOnlyManifest, receipt, orchestratorHash, cacheManifestHash, cacheDatasetHash, cacheSourceHash }) {
    if (baselineOnlyManifest) {
        const origin = artifact.origin;
        requireThat(origin?.mode === 'baseline-only-no-neural-inference' && Number.isSafeInteger(origin.timeoutMs) && origin.timeoutMs >= 100, 'Missing or unknown baseline-only cache origin');
        equal(origin.orchestratorHash, orchestratorHash, 'Baseline-only orchestrator source');
        equal(origin.devManifestHash, cacheManifestHash, 'Baseline-only origin manifest'); equal(origin.devDatasetHash, cacheDatasetHash, 'Baseline-only origin dataset');
        equal(baselineOnlyManifest, { origin, referenceContract: artifact.binding.referenceContract }, 'Baseline-only producer manifest');
        equal(receipt.origin, origin, 'Baseline-only completion origin'); equal(receipt.referenceContract, artifact.binding.referenceContract, 'Baseline-only completion reference');
        const matches = receipt.reports?.filter(r => r.familyId === job.input.familyId && r.seed === job.seed && r.maxStepHours === job.maxStepHours);
        requireThat(matches?.length === 1 && matches[0].artifactHash === digest(artifact), 'Baseline-only raw root receipt commitment mismatch');
    } else {
        requireThat(!artifact.origin && sha(artifact.binding?.modelHash), 'Unknown standard evaluation cache root schema');
        requireThat(receipt.scope === 'EXPOSED DEVELOPMENT ONLY; NOT PARITY' && receipt.parity === false && receipt.modelHash === artifact.binding.modelHash, 'Standard baseline cache receipt mismatch');
        const matches = receipt.pairs?.filter(r => r.familyId === job.input.familyId && r.seed === job.seed && r.maxStepHours === job.maxStepHours);
        requireThat(matches?.length === 1 && matches[0].baseline?.artifactHash === digest(artifact) && matches[0].modelHash === artifact.binding.modelHash && matches[0].sourceHash === cacheSourceHash, 'Standard baseline raw root receipt commitment mismatch');
        equal(matches[0].referenceContract, artifact.binding.referenceContract, 'Standard baseline receipt reference');
    }
}
export function concludeOutputQuality(gate, rows) {
    for (const row of rows) {
        row.delta = row.ratio = null;
        const audited = gate.pairs.find(p => p.caseId === row.caseId);
        requireThat(audited, 'Missing pure-gate pair audit');
        // Generation/source issue can be ignored ONLY here: the adapter already checked sources,
        // measured timings and each actual declared budget; it never claimed a common budget.
        const semantic = audited.issues.filter(issue => !['BASELINE_GENERATION_BUDGET_OR_SOURCE_INVALID', 'NEURAL_GENERATION_BUDGET_OR_SOURCE_INVALID', 'BASELINE_UNAVAILABLE', 'NEURAL_UNAVAILABLE', 'SCORE_REGRESSION', 'PREFERENCE_REGRESSION', 'EFFICIENCY_REGRESSION'].includes(issue));
        row.issues.push(...semantic);
        if (semantic.length) { row.baselineScore = row.neuralScore = null; row.baselineRawDaily = row.neuralRawDaily = null; }
        if (row.baselineScore !== null && row.neuralScore !== null) {
            row.delta = row.neuralScore - row.baselineScore; row.ratio = row.baselineScore === 0 ? null : row.neuralScore / row.baselineScore;
            row.preferenceComparison = audited.preferenceComparison; row.efficiencyComparison = audited.efficiencyComparison;
            row.issues.push(...audited.issues.filter(issue => ['SCORE_REGRESSION', 'PREFERENCE_REGRESSION', 'EFFICIENCY_REGRESSION'].includes(issue)));
            row.status = row.issues.length ? 'fail' : 'pass';
        } else row.status = row.issues.some(issue => /AUTHENTICATION_FAILED|mismatch|unsupported|INVALID|FORBIDDEN|CHANGED|MISSING_ORDINARY|UNOWNED|UNSUPPORTED|fallback/i.test(issue)) ? 'fail' : 'inconclusive';
    }
    return { rows, status: rows.some(r => r.status === 'fail') ? 'fail' : 'inconclusive' };
}
function frozenRun(directory) {
    const manifest = read(join(directory, 'manifest.json')), snapshot = read(join(directory, 'source-snapshot.json'));
    verifyFrozenProvenance(manifest.provenance, snapshot, readFileSync(join(directory, 'worker.mjs')));
    return { directory, manifest, snapshot };
}
export function selectTeacherRecord(records, record) {
    const matches = records.filter(r => r.input?.familyId === record.familyId && r.resultHash === record.teacherRecordHash);
    requireThat(matches.length === 1, 'Missing or duplicate exact committed original teacher attempt');
    return matches[0];
}
export function declaredCohort(cases, records) {
    const families = new Set(cases.map(c => c.familyId)), qualified = new Map(records.map(r => [r.familyId, r]));
    requireThat(families.size === cases.length && qualified.size === records.length && records.every(r => families.has(r.familyId)), 'Duplicate or undeclared cohort family');
    return cases.map(declaration => ({ declaration, record: qualified.get(declaration.familyId) ?? null }));
}
export function verifyPrimarySourceDeclaration(manifest, sources) {
    requireThat(manifest.config.source === sources.teacherManifest.config.run, 'Declared primary teacher run mismatch');
    requireThat(!(sources.linkedSourceManifests?.length || sources.linkedSourceManifestHashes?.length || sources.linkedSourceCompatibilities?.length || sources.additionalSourceManifests?.length || sources.additionalSourceCompatibilities?.length || sources.additionalSourceDescriptors?.length)
        && !sources.records.some(r => r.sourceManifest || r.sourceManifestHash), 'Linked/additional source populations unsupported');
    equal(manifest.sourceContracts, sourceContracts(sources), 'Frozen primary source declaration');
}
function verifyOriginalTeachers(root, run, dataset, sources) {
    equal(dataset.sourceRecordsHash, digest(sources), 'Dataset source-record commitment');
    equal(sources.teacherManifestHash, digest(sources.teacherManifest), 'Teacher manifest commitment');
    const name = sources.teacherManifest.config?.run;
    requireThat(typeof name === 'string' && /^[\w-]+$/.test(name), 'Invalid original teacher directory');
    const original = frozenRun(safeChild(root, 'training_data/neural-full-v2/' + name));
    equal(original.manifest, sources.teacherManifest, 'Original teacher manifest');
    verifyPrimarySourceDeclaration(run.manifest, sources);
    const checkpoint = read(join(original.directory, 'checkpoint.json'));
    equal(checkpoint.manifestHash, digest(original.manifest), 'Original teacher checkpoint manifest');
    const fullReference = referenceManifestContract(original.manifest, sources.records.map(r => r.input));
    equal(fullReference.referenceProtocol, referenceProtocol(LATEST_DEFAULT_REFERENCE), 'Latest default reference protocol');
    equal(sources.referenceContract, fullReference, 'Source reference contract');
    equal(dataset.referenceContract, referenceManifestContract(original.manifest, dataset.records.map(r => r.input)), 'Dataset reference contract');
    equal(dataset.referenceProtocols, [referenceProtocol(LATEST_DEFAULT_REFERENCE)], 'Dataset reference population');
    requireThat(run.manifest.config.sourceTransition === 'none', 'Unsupported source-transition policy');
    const compatibility = verifyTeacherSourceCompatibility(original.manifest.provenance, run.manifest.provenance, 'none');
    equal(sources.sourceCompatibility, compatibility, 'Teacher source compatibility');
    const records = new Map(), declaredInputs = new Map();
    for (const { declaration } of declaredCohort(original.manifest.cases, dataset.records)) {
        requireThat(/^[\w.-]+$/.test(declaration.familyId), 'Unsafe declared family identifier');
        const input = read(join(original.directory, declaration.familyId + '.input.json'));
        equal(declaration.inputHash, digest(input), 'Declared original input hash');
        requireThat(input.familyId === declaration.familyId && input.size === declaration.size && input.split === (dataset.purpose === 'train' ? 'train' : 'dev'), 'Declared original input identity/split');
        referenceManifestContract(original.manifest, [input]); declaredInputs.set(declaration.familyId, input);
    }
    for (const record of dataset.records) {
        requireThat(!records.has(record.familyId) && /^[\w.-]+$/.test(record.familyId), 'Duplicate or unsafe dataset family');
        const source = selectTeacherRecord(sources.records, record), declared = original.manifest.cases.filter(c => c.familyId === record.familyId);
        requireThat(declared.length === 1, 'Missing or duplicate original manifest family');
        equal(record.input, source.input, 'Dataset original input');
        equal(declared[0].inputHash, digest(record.input), 'Original manifest input hash');
        equal(read(join(original.directory, record.familyId + '.input.json')), record.input, 'Original input artifact');
        equal(source.resultHash, digest(source.outcome), 'Original source result hash');
        equal(record.teacherRecordHash, source.resultHash, 'Dataset teacher hash');
        const originalPath = safeChild(root, source.resultPath);
        requireThat(dirname(originalPath) === original.directory, 'Teacher result belongs to another run');
        equal(read(originalPath), source.outcome, 'Original teacher result artifact');
        const attempts = checkpoint.cases[record.familyId], attempt = attempts?.find(a => a.attempt === source.attempt);
        requireThat(attempt?.status === 'completed' && attempt.resultPath === source.resultPath && attempt.resultHash === source.resultHash, 'Original teacher checkpoint attempt mismatch');
        requireThat(attempt.inputHash === declared[0].inputHash && attempt.bundleHash === original.manifest.provenance.bundleHash, 'Original attempt input/bundle mismatch');
        const qualified = qualifyEnvelope(record.input, source.outcome, dataset.purpose);
        requireThat(qualified.qualified, 'Unqualified original teacher: ' + qualified.reasons.join(','));
        requireThat(record.sourceKind === 'full-optimizer' && record.fullOptimizerTeacher === true && record.baselineEligible === true && record.teacherScore === source.outcome.score, 'Non-full or conflicting teacher record');
        equal(record.referenceProtocol, fullReference.referenceProtocol, 'Record reference protocol');
        records.set(record.familyId, { record, source, attempt });
    }
    return { original, records, declaredInputs, sourceReference: fullReference, reference: referenceManifestContract(original.manifest, dataset.records.map(r => r.input)), compatibility };
}
function preparedRun(root, directory, purpose) {
    const run = frozenRun(directory), dataset = read(join(directory, 'dataset.json')), sources = read(join(directory, 'source-records.json'));
    requireThat(run.manifest.config.purpose === purpose && dataset.purpose === purpose && sources.purpose === purpose, 'TRAIN versus DEV purpose mismatch');
    requireThat(run.manifest.config.teacherKind === 'full-optimizer' && dataset.baselineEligible === true && dataset.records?.length > 0, 'Only qualified full-optimizer datasets supported');
    requireThat(dataset.records.every(r => r.input?.split === (purpose === 'train' ? 'train' : 'dev') && r.originalSplit === r.input.split && r.familyId === r.input.familyId), 'TRAIN versus DEV split mismatch');
    equal(read(join(directory, 'preparation.json')).result?.datasetHash, digest(dataset), 'Prepared dataset hash');
    const teachers = verifyOriginalTeachers(root, run, dataset, sources);
    return { ...run, dataset, sources, teachers };
}
const checkpointBinding = run => ({ datasetHash: digest(run.dataset), sourceHash: run.manifest.provenance.sourceHash, bundleHash: run.manifest.provenance.bundleHash,
    featureManifestHash: run.dataset.featureManifestHash, ...run.manifest.config, ...(run.manifest.lineage ? { lineageHash: digest(run.manifest.lineage) } : {}) });
export function verifyTrainForkLink({ lineage, childManifest, childDataset, parentManifest, parentDataset, parentState, initialBytes, parentBytes }) {
    requireThat(lineage?.spec?.mode === 'fork' && /^[\w-]+$/.test(lineage.spec.parentRun) && /^checkpoint-[\d-]+$/.test(lineage.parent?.generation), 'Invalid TRAIN fork ancestry');
    requireThat(childManifest.config.purpose === 'train' && parentManifest.config.purpose === 'train', 'DEV parameters cannot enter TRAIN lineage');
    const withoutChunk = config => Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'chunkSize'));
    equal(withoutChunk(childManifest.config), withoutChunk(parentManifest.config), 'Fork numerical/training configuration');
    equal(childDataset, parentDataset, 'Fork exact TRAIN dataset');
    const executable = p => ({ sourceHash: p.sourceHash, sourceHashes: p.sourceHashes, bundleHash: p.bundleHash });
    equal(executable(childManifest.provenance), executable(parentManifest.provenance), 'Fork exact frozen source/bundle');
    equal(parentState.binding, checkpointBinding({ manifest: parentManifest, dataset: parentDataset }), 'Parent TRAIN checkpoint binding');
    requireThat(parentState.cursor.family === 0 && parentState.cursor.action === 0, 'Parent fork checkpoint is not an outer epoch boundary');
    equal(digest(parentBytes), parentState.modelHash, 'Original parent parameter bytes');
    equal(digest(initialBytes), parentState.modelHash, 'Fork initial parameter bytes');
    equal(lineage.initialModelHash, parentState.modelHash, 'Fork initial model commitment');
    const b = parentState.binding;
    equal(lineage.parent, { run: lineage.spec.parentRun, manifestHash: digest(parentManifest), modelHash: parentState.modelHash,
        sourceHash: b.sourceHash, bundleHash: b.bundleHash, datasetHash: b.datasetHash, featureManifestHash: b.featureManifestHash,
        purpose: parentManifest.config.purpose, optimizer: parentManifest.config.optimizer ?? 'sgd-v1', teacherKind: parentManifest.config.teacherKind ?? 'legacy-full-optimizer',
        constructionOrder: parentManifest.config.constructionOrder ?? 'legacy-v1', inputProfile: parentManifest.config.inputProfile ?? 'actual-mixture-v1',
        cursor: parentState.cursor, generation: lineage.parent.generation }, 'Fork parent commitments');
}
function authenticateTrainingLineage(root, training, runtime, seen = new Set()) {
    const identity = realpathSync(training.directory), lineage = read(join(training.directory, 'lineage.json'));
    requireThat(!seen.has(identity) && seen.size < 16, 'TRAIN ancestry cycle or unsupported depth'); seen.add(identity);
    equal(lineage, training.manifest.lineage, 'TRAIN initialization lineage');
    if (lineage?.spec?.mode === 'fresh') {
        requireThat(lineage.parent === null && lineage.initialModelHash === null && lineage.spec.parentRun === null, 'Unsupported fresh TRAIN ancestry');
        return [{ directory: training.directory, mode: 'fresh', manifestHash: digest(training.manifest), lineageHash: digest(lineage) }];
    }
    requireThat(lineage?.spec?.mode === 'fork' && /^[\w-]+$/.test(lineage.spec.parentRun) && /^checkpoint-[\d-]+$/.test(lineage.parent?.generation), 'Unknown TRAIN lineage policy');
    const parentDirectory = safeChild(root, relative(root, join(dirname(training.directory), lineage.spec.parentRun))), parent = preparedRun(root, parentDirectory, 'train');
    const generation = safeChild(parentDirectory, lineage.parent.generation), parentState = read(join(generation, 'state.json'));
    equal(read(join(training.directory, 'parent-manifest.json')), parent.manifest, 'Frozen copied parent manifest');
    equal(read(join(training.directory, 'parent-checkpoint.json')), parentState, 'Frozen copied parent checkpoint');
    const initialBytes = readFileSync(join(training.directory, 'initial-model.bin')), parentBytes = readFileSync(join(generation, 'model.bin'));
    verifyTrainForkLink({ lineage, childManifest: training.manifest, childDataset: training.dataset, parentManifest: parent.manifest, parentDataset: parent.dataset, parentState, initialBytes, parentBytes });
    const metadata = runtime.modelMetadata(initialBytes);
    requireThat(metadata.hiddenSize === parent.manifest.config.hiddenSize && metadata.seed === parent.manifest.config.seed && metadata.trainingUpdates === parentState.cursor.updates && metadata.manifestHash === parent.dataset.featureManifestHash, 'Fork binary metadata mismatch');
    return [{ directory: training.directory, mode: 'fork', manifestHash: digest(training.manifest), lineageHash: digest(lineage), parentStateHash: digest(parentState), initialModelHash: digest(initialBytes) }, ...authenticateTrainingLineage(root, parent, runtime, seen)];
}
async function reportRuntime(root, training) {
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), sourceHashes = {};
    const built = await build({ entryPoints: [join(root, 'scripts/neural/full-training/parity-report-runtime.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, logLevel: 'silent', plugins: [{ name: 'authenticate-report-runtime', setup(b) { b.onLoad({ filter: /\.(ts|json|mjs)$/ }, args => {
        const contents = readFileSync(args.path, 'utf8'), path = relative(root, args.path).replaceAll('\\', '/');
        sourceHashes[path] = digest(contents);
        if (training.manifest.provenance.sourceHashes[path]) equal(sourceHashes[path], training.manifest.provenance.sourceHashes[path], 'Report runtime/frozen TRAIN source: ' + path);
        return { contents, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith('.ts') ? 'ts' : 'js' };
    }); } }] });
    const directory = mkdtempSync(join(tmpdir(), 'riic-parity-report-'));
    try {
        const path = join(directory, 'runtime.mjs'); writeFileSync(path, built.outputFiles[0].contents);
        const runtime = await import(pathToFileURL(path).href);
        return { runtime, provenance: { sourceHashes, sourceHash: digest(sourceHashes), bundleHash: digest(built.outputFiles[0].contents), adapterHash: digest(readFileSync(fileURLToPath(import.meta.url))) } };
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
function authenticateCheckpoint(training, evaluationDirectory, binding, runtime, checkpointArchive) {
    const bytes = readFileSync(join(evaluationDirectory, 'model.bin'));
    equal(digest(bytes), binding.modelHash, 'External frozen model hash');
    const expected = checkpointBinding(training);
    equal(read(join(training.directory, 'lineage.json')), training.manifest.lineage, 'TRAIN initialization lineage');
    const candidates = readdirSync(training.directory).filter(name => /^checkpoint-[\d-]+$/.test(name)).map(name => join(training.directory, name));
    if (checkpointArchive) {
        const pointer = read(join(checkpointArchive, 'checkpoint.json')), state = read(join(checkpointArchive, 'state.json'));
        requireThat(/^checkpoint-[\d-]+$/.test(pointer.generation), 'Invalid archived checkpoint pointer');
        equal(pointer.stateHash, digest(state), 'Archived checkpoint pointer state hash');
        equal(read(join(checkpointArchive, 'manifest.json')), training.manifest, 'Archived TRAIN manifest');
        equal(read(join(checkpointArchive, 'dataset.json')), training.dataset, 'Archived TRAIN dataset');
        equal(read(join(checkpointArchive, 'lineage.json')), training.manifest.lineage, 'Archived TRAIN lineage');
        candidates.unshift(checkpointArchive);
    }
    // Optional archival sidecar is accepted only with the exact binary/state pair, never a summary.
    if (existsSync(join(evaluationDirectory, 'checkpoint-state.json'))) candidates.unshift(evaluationDirectory);
    let matched = null;
    for (const directory of candidates) {
        const state = read(join(directory, directory === evaluationDirectory ? 'checkpoint-state.json' : 'state.json'));
        if (state.modelHash !== binding.modelHash || digest(state.cursor) !== digest(binding.cursor)) continue;
        equal(state.binding, expected, 'TRAIN checkpoint source/data/config binding');
        equal(digest(readFileSync(join(directory, 'model.bin'))), state.modelHash, 'TRAIN checkpoint bytes');
        matched = { path: directory, stateHash: digest(state), modelHash: state.modelHash, cursor: state.cursor }; break;
    }
    requireThat(matched, 'Original TRAIN checkpoint state unavailable; preserve matching generation before resuming');
    const metadata = runtime.modelMetadata(bytes);
    requireThat(metadata.seed === training.manifest.config.seed && metadata.trainingUpdates === binding.cursor.updates && metadata.hiddenSize === training.manifest.config.hiddenSize && (metadata.optimizerVersion ?? 'sgd-v1') === (training.manifest.config.optimizer ?? 'sgd-v1'), 'Model binary metadata/checkpoint mismatch');
    equal(metadata.manifestHash, training.dataset.featureManifestHash, 'Model feature manifest');
    equal(runtime.FULL_FEATURE_MANIFEST_HASH, training.dataset.featureManifestHash, 'Report runtime feature manifest');
    equal(read(join(training.directory, 'feature-manifest.json')), runtime.FULL_FEATURE_MANIFEST, 'Frozen feature definitions');
    return matched;
}
/** Fail closed globally on identity tampering; locally on missing/failed pair evidence. */
export async function authenticatedParityReport({ root = ROOT, trainingDirectory, devDirectory, evaluationDirectory, checkpointArchive = null }) {
    const report = { schemaVersion: 1, kind: 'artifact-authenticated-latest-dev-output-quality', createdUtc: new Date().toISOString(),
        status: 'inconclusive', parity: false, releaseParity: false,
        scope: 'Exposed independently sampled FULL DEV transfer only; not release, population, real-game, speed, or hardware parity.',
        paths: { trainingDirectory, devDirectory, evaluationDirectory, checkpointArchive }, authentication: { status: 'incomplete', issues: [], commitments: {} },
        missingGateEvidence: ['NO_COMMON_EXECUTION_RESOURCE_ATTESTATION'], generationBudgets: [], outputQuality: [], gate: null,
        limitation: 'SHA-256 chains verify local frozen artifact consistency, not signatures or independent proof of execution. Summary scores are never evidence; only committed exact-job raw simulation results are compared. Exposed DEV cannot become a release cohort. A new untouched preregistered release cohort is required.' };
    try {
        const training = preparedRun(root, trainingDirectory, 'train'), dev = preparedRun(root, devDirectory, 'dev-overfit');
        const { runtime, provenance } = await reportRuntime(root, training);
        const trainingLineage = authenticateTrainingLineage(root, training, runtime);
        equal(runtime.FULL_LATEST_REFERENCE_PROTOCOL, dev.teachers.reference.referenceProtocol, 'Pure gate/latest teacher protocol');
        const familyInventoryHashes = {}, usedInventories = new Map(), allFamilies = new Set();
        const devCohort = declaredCohort(dev.teachers.original.manifest.cases, dev.dataset.records).map(({ declaration, record }) => record ?? { familyId: declaration.familyId, input: dev.teachers.declaredInputs.get(declaration.familyId) });
        for (const record of [...training.dataset.records, ...devCohort]) {
            const canonical = runtime.canonicalInventory(record.input.entries), hash = digest(canonical);
            requireThat(canonical.length === record.input.size && !allFamilies.has(record.familyId), 'Inventory size or TRAIN/DEV family overlap');
            requireThat(!usedInventories.has(hash), 'TRAIN/DEV canonical inventory overlap');
            allFamilies.add(record.familyId); usedInventories.set(hash, record.familyId); familyInventoryHashes[record.familyId] = hash;
        }
        report.authentication.commitments = { reporter: provenance, trainManifestHash: digest(training.manifest), trainDatasetHash: digest(training.dataset),
            trainSourceRecordsHash: digest(training.sources), devManifestHash: digest(dev.manifest), devDatasetHash: digest(dev.dataset),
            devSourceRecordsHash: digest(dev.sources), devReference: dev.teachers.reference, trainSourceHash: training.manifest.provenance.sourceHash,
            trainBundleHash: training.manifest.provenance.bundleHash, trainingLineage, familyInventoryHashes };
        report.expectedFamilies = devCohort.map(r => ({ familyId: r.familyId, size: r.input.size, qualifiedReference: dev.teachers.records.has(r.familyId) }));
        report.expectedPairs = devCohort.length * 4;
        if (!existsSync(join(evaluationDirectory, 'manifest.json'))) {
            report.authentication.issues.push('EXTERNAL_EVALUATION_NOT_AVAILABLE');
            report.authentication.status = 'prepared-sources-authenticated';
            return report;
        }
        const binding = read(join(evaluationDirectory, 'manifest.json'));
        requireThat(Number.isSafeInteger(binding.timeoutMs) && binding.timeoutMs >= 100 && binding.timeoutMs <= 600000, 'Invalid frozen external timeout');
        equal(binding.trainingManifestHash, digest(training.manifest), 'External TRAIN manifest');
        equal(binding.trainingDatasetHash, digest(training.dataset), 'External TRAIN dataset');
        equal(binding.devManifestHash, digest(dev.manifest), 'External DEV manifest');
        equal(binding.devDatasetHash, digest(dev.dataset), 'External DEV dataset');
        equal(binding.devSourceRecordsHash, digest(dev.sources), 'External DEV sources');
        const referenceContract = { ...verifyTeacherSourceCompatibility(dev.teachers.original.manifest.provenance, training.manifest.provenance, 'none'), reference: dev.teachers.sourceReference };
        equal(binding.referenceContract, referenceContract, 'External latest reference binding');
        requireThat(sha(binding.decodeBundleHash) && Object.keys(binding.sourceHashes ?? {}).length > 0, 'Missing external frozen decode provenance');
        equal(binding.decodeBundleHash, digest(readFileSync(join(evaluationDirectory, 'decode-worker.mjs'))), 'External decode bundle');
        for (const [path, hash] of Object.entries(binding.sourceHashes)) {
            requireThat(sha(hash), 'Invalid external source hash');
            equal(hash, digest(readFileSync(safeChild(root, path))), 'External source file: ' + path);
        }
        for (const [path, hash] of Object.entries(training.manifest.provenance.sourceHashes)) equal(hash, digest(readFileSync(safeChild(root, path))), 'Current frozen TRAIN inference source: ' + path);
        const checkpoint = authenticateCheckpoint(training, evaluationDirectory, binding, runtime, checkpointArchive);
        Object.assign(report.authentication.commitments, { evaluationBindingHash: digest(binding), modelHash: binding.modelHash, checkpoint });
        const summaryPath = join(evaluationDirectory, 'summary.json'), summary = existsSync(summaryPath) ? read(summaryPath) : null;
        if (summary) {
            equal(summary.binding, binding, 'External completion summary binding');
            requireThat(Array.isArray(summary.reports) && new Set(summary.reports.map(r => r.familyId)).size === summary.reports.length && summary.reports.every(r => dev.teachers.declaredInputs.has(r.familyId)), 'Duplicate/unexpected external summary family');
            report.authentication.commitments.summaryHash = digest(summary);
        }
        const referenceBinding = { referenceProtocol: dev.teachers.reference.referenceProtocol, producerSourceHash: dev.teachers.reference.producerSourceHash, producerBundleHash: dev.teachers.reference.producerBundleHash };
        const sourceHashes = training.manifest.provenance.sourceHashes;
        const catalogSources = Object.fromEntries(Object.entries(sourceHashes).filter(([path]) => path.startsWith('src/data/') && path.endsWith('.json')));
        const ruleSources = Object.fromEntries(Object.entries(sourceHashes).filter(([path]) => /^src\/(domain|scheduler|simulator|optimizer)\//.test(path) && !path.includes('/neural/')));
        requireThat(Object.keys(catalogSources).length && Object.keys(ruleSources).length, 'Missing catalog/rule provenance');
        const expectedCases = [], attempts = [], rows = [], caches = new Map();
        const authenticatedSimulation = async (artifact, context) => {
            equal(digest(artifact), context.artifactHash, 'Simulation artifact commitment');
            if (!artifact.baselineReuse?.sourceArtifactPath && !artifact.baselineReuse?.proof && artifact.baselineReuse?.reused !== true)
                return verifySimulationArtifact(artifact, context);
            requireThat(context.side === 'baseline', 'Neural cache reuse forbidden');
            requireThat(binding.baselineCacheStatus?.enabled === true && typeof binding.baselineCacheStatus.requested === 'string', 'Unbound baseline reuse request');
            const path = safeChild(root, relative(root, artifact.baselineReuse.sourceArtifactPath)), cacheDirectory = dirname(path);
            requireThat(path !== context.artifactPath && dirname(cacheDirectory) !== evaluationDirectory, 'Baseline cache cycle');
            requireThat(realpathSync(resolve(root, binding.baselineCacheStatus.requested)) === realpathSync(cacheDirectory), 'Baseline cache request/source mismatch');
            requireThat(path === join(cacheDirectory, context.fileName), 'Baseline cache exact filename mismatch');
            if (!caches.has(cacheDirectory)) {
                // Authenticate ALL frozen original source snapshots, dataset inputs and teacher records,
                // in addition to the established cache verifier's transitive physics+adapter proof.
                const cacheRun = preparedRun(root, dirname(cacheDirectory), 'dev-overfit');
                equal(cacheRun.teachers.reference, dev.teachers.reference, 'Baseline cache original reference population');
                caches.set(cacheDirectory, await openBaselineCache(root, cacheDirectory, trainingDirectory, training.manifest, referenceContract));
            }
            const verified = caches.get(cacheDirectory).tryReuse(context.fileName, context.job);
            requireThat(verified.hit, 'Baseline cache provenance verification failed: ' + verified.reason);
            const producerManifestPath = join(cacheDirectory, 'baseline-only-manifest.json'), baselineOnlyManifest = existsSync(producerManifestPath) ? read(producerManifestPath) : null;
            const cacheManifest = read(join(dirname(cacheDirectory), 'manifest.json')), cacheDataset = read(join(dirname(cacheDirectory), 'dataset.json'));
            verifyCacheRootReceipt({ artifact: verified.artifact, job: context.job, baselineOnlyManifest,
                receipt: read(join(cacheDirectory, baselineOnlyManifest ? 'baseline-only-summary.json' : 'summary.json')),
                orchestratorHash: baselineOnlyManifest ? digest(readFileSync(join(root, 'artifacts/neural/latest-pipeline/precompute-baselines.mjs'))) : null,
                cacheManifestHash: digest(cacheManifest), cacheDatasetHash: digest(cacheDataset), cacheSourceHash: cacheManifest.provenance.sourceHash });
            verifyBaselineReuseLink({ side: context.side, artifact, sourceArtifact: verified.artifact, sourcePath: verified.path, verifiedProof: verified.proof });
            const raw = verifySimulationArtifact({ ...artifact, baselineReuse: { reused: false } }, { binding: context.binding, job: context.job });
            return { ...raw, baselineRoot: { path: verified.path, artifactHash: digest(verified.artifact), proofHash: digest(verified.proof), chainDepth: 1 } };
        };
        for (const record of devCohort) {
            const { source = null, attempt = null } = dev.teachers.records.get(record.familyId) ?? {};
            const input = record.input, familyId = record.familyId, summarized = summary?.reports.find(r => r.familyId === familyId);
            const decodeJob = { referenceContract, archivedTeacherTrace: { constructionOrder: record.constructionOrder ?? 'legacy-v1', actionIds: record.actionIds, teacherSemanticHash: record.teacherSemanticHash },
                constructionOrder: training.manifest.config.constructionOrder ?? 'legacy-v1', input, outcome: source?.outcome, trainingInputs: training.dataset.records.map(r => r.input),
                modelPath: join(evaluationDirectory, 'model.bin'), modelHash: binding.modelHash };
            let decoded = null, decodeIssue = null;
            const decodePath = join(evaluationDirectory, familyId + '-decode.json');
            try {
                if (!source) decodeIssue = 'FULL_REFERENCE_NOT_QUALIFIED';
                else if (existsSync(decodePath)) decoded = verifyDecodeArtifact(read(decodePath), { binding, job: decodeJob, protocol: referenceBinding.referenceProtocol });
                else decodeIssue = 'MISSING_DECODE_ARTIFACT';
            } catch (error) { decodeIssue = String(error); }
            const baselineBudget = attempt?.wallTimeoutMs ?? null, neuralBudget = binding.timeoutMs;
            if (source) requireThat(Number.isFinite(baselineBudget) && baselineBudget > 0 && Number.isFinite(source.outcome.durationMs) && source.outcome.durationMs >= 0 && source.outcome.durationMs <= baselineBudget, 'Original baseline generation budget invalid');
            report.generationBudgets.push({ familyId, baselineAllowedMs: baselineBudget, baselineMeasuredMs: source?.outcome.durationMs ?? null, neuralAllowedMs: neuralBudget,
                neuralMeasuredMs: decoded?.result?.generationElapsedMs ?? null, commonBudgetAuthenticated: baselineBudget === neuralBudget });
            if (baselineBudget !== neuralBudget && !report.missingGateEvidence.includes('NO_IDENTICAL_DECLARED_GENERATION_BUDGET')) report.missingGateEvidence.push('NO_IDENTICAL_DECLARED_GENERATION_BUDGET');
            for (const seed of [input.options.seed, (input.options.seed + 1) >>> 0]) for (const maxStepHours of [.25, .125]) {
                const caseId = `${familyId}:${seed}:${maxStepHours}`, contract = { scenarioHash: digest(input.workspace), inventoryHash: familyInventoryHashes[familyId], sharedEngineHash: training.manifest.provenance.sourceHash,
                    catalogHash: digest(catalogSources), rulesHash: digest(ruleSources), weights: input.options.productionWeights, droneTarget: input.options.droneTarget, droneRoomId: input.options.droneRoomId ?? null,
                    warmupHours: input.options.simulationWarmupHours, sampleHours: input.options.simulationSampleHours, seed, optimizerSeed: input.options.seed, maxStepHours,
                    generationWallBudgetMs: baselineBudget === neuralBudget ? baselineBudget : 0, executionResourcesHash: '',
                    resolvedSimulatorOptionsHash: digest({ options: resolvedSimulationSettings({ input, seed, maxStepHours }), assumptions: { restingThreshold: .65, operationDurationHours: 0 } }) };
                expectedCases.push({ caseId, familyId, size: input.size, stratum: dev.dataset.inputProfile, contract });
                const a = { caseId, inputWorkspace: input.workspace, entries: input.entries, baseline: null, neural: null };
                const row = { caseId, familyId, size: input.size, seed, maxStepHours, status: 'inconclusive', issues: decodeIssue ? [decodeIssue] : [], baselineScore: null, neuralScore: null, delta: null, ratio: null, baselineRawDaily: null, neuralRawDaily: null, artifacts: {} };
                const pairSummaries = summarized?.pairs?.filter(p => p.seed === seed && p.maxStepHours === maxStepHours) ?? [];
                requireThat(pairSummaries.length <= 1, 'Duplicate external pair summary');
                for (const side of ['baseline', 'neural']) {
                    const workspace = side === 'baseline' ? source?.outcome.result.result.workspace : decoded?.available ? decoded.result.workspace : null;
                    const path = join(evaluationDirectory, `${familyId}-${seed}-${maxStepHours}-${side}.json`), committed = pairSummaries[0]?.[side];
                    if (!workspace || !existsSync(path) || !committed?.artifactHash) { row.issues.push(`${side.toUpperCase()}_MISSING_OR_UNCOMMITTED_ARTIFACT`); continue; }
                    try {
                        requireThat(!decodeIssue, 'Decode provenance unavailable');
                        const artifact = read(path), job = { mode: 'evaluate', input, workspace, seed, maxStepHours };
                        const verified = await authenticatedSimulation(artifact, { binding, job, artifactHash: committed.artifactHash, side, artifactPath: path, fileName: `${familyId}-${seed}-${maxStepHours}-${side}.json` });
                        row.artifacts[side] = { path, hash: digest(artifact), available: verified.available, workerStatus: verified.status, ...(verified.baselineRoot ? { baselineRoot: verified.baselineRoot } : {}) };
                        if (!verified.available) { row.issues.push(`${side.toUpperCase()}_SIMULATION_UNAVAILABLE`); continue; }
                        a[side] = { referenceBinding, ...(side === 'baseline' ? { generationProvenance: { sourceHash: referenceBinding.producerSourceHash, bundleHash: referenceBinding.producerBundleHash } } : { checkpointHash: binding.modelHash }),
                            status: 'completed', contract, sourceHash: training.manifest.provenance.sourceHash, generationElapsedMs: side === 'baseline' ? source.outcome.durationMs : decoded.result.generationElapsedMs,
                            workspace, result: verified.result, authoritativeArtifactHash: digest(artifact), rawDaily: verified.rawDaily, fallbackPhysicalPlacements: 0 };
                        row[side + 'Score'] = verified.score; row[side + 'RawDaily'] = verified.rawDaily;
                    } catch (error) { row.issues.push(`${side.toUpperCase()}_AUTHENTICATION_FAILED: ${String(error)}`); }
                }
                attempts.push(a); rows.push(row);
            }
        }
        const manifest = { objective: { version: 'latest-default-lexicographic-v2', ...referenceBinding }, mode: 'development', scope: report.scope,
            expectedCases, minimumFamiliesPerStratum: { [dev.dataset.inputProfile]: 1 },
            splitFamilies: { training: training.dataset.records.map(r => r.familyId), development: devCohort.map(r => r.familyId), release: [] }, familyInventoryHashes, checkpointHash: binding.modelHash };
        const gate = runtime.evaluateFullParity(manifest, attempts);
        const conclusion = concludeOutputQuality(gate, rows);
        report.gate = { manifestHash: digest(manifest), status: conclusion.status, strictEvaluatorStatus: gate.status, issues: gate.issues, report: gate,
            note: 'Empty execution-resource commitment and zero nonidentical generation budget are intentional unknowns, never fabricated proof. This incomplete-contract gate cannot establish parity.' };
        report.outputQuality = rows;
        const compared = rows.filter(r => r.delta !== null);
        report.outputQualitySummary = { expectedPairs: rows.length, independentFamilies: devCohort.length, comparable: compared.length, passes: rows.filter(r => r.status === 'pass').length,
            failures: rows.filter(r => r.status === 'fail').length, inconclusive: rows.filter(r => r.status === 'inconclusive').length,
            wins: compared.filter(r => r.delta > 0).length, ties: compared.filter(r => r.delta === 0).length, losses: compared.filter(r => r.delta < 0).length,
            meanDelta: compared.length ? compared.reduce((n, r) => n + r.delta / compared.length, 0) : null,
            worstDelta: compared.length ? Math.min(...compared.map(r => r.delta)) : null };
        report.authentication.status = rows.some(r => r.issues.some(issue => /AUTHENTICATION_FAILED|mismatch/i.test(issue))) ? 'failed' : 'verified-available-artifacts';
        report.status = conclusion.status;
        return report;
    } catch (error) {
        report.authentication.status = 'failed'; report.authentication.issues.push(String(error)); report.status = 'fail';
        return report;
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length < 3 || args.includes('--help')) {
        console.log('Usage: node scripts/neural/full-training/parity-report.mjs TRAIN_RUN DEV_REFERENCE_RUN EXTERNAL_EVAL [--checkpoint-archive DIRECTORY] [--out NEW_REPORT.json]\nRead-only; no training/simulation, no release claim. Missing results stay null. Existing report files are never overwritten.');
        process.exitCode = args.includes('--help') ? 0 : 1;
    } else {
        const [train, dev, evaluation, ...flags] = args, options = {};
        for (let i = 0; i < flags.length; i += 2) { requireThat(['--out', '--checkpoint-archive'].includes(flags[i]) && flags[i + 1], 'Unknown report option'); requireThat(!options[flags[i]], 'Duplicate report option'); options[flags[i]] = flags[i + 1]; }
        const report = await authenticatedParityReport({ trainingDirectory: resolve(train), devDirectory: resolve(dev), evaluationDirectory: resolve(evaluation), checkpointArchive: options['--checkpoint-archive'] ? resolve(options['--checkpoint-archive']) : null });
        const text = JSON.stringify(report, null, 2) + '\n';
        if (options['--out']) writeFileSync(resolve(options['--out']), text, { flag: 'wx', mode: 0o600 });
        console.log(text); process.exitCode = report.status === 'fail' ? 2 : 0;
    }
}
