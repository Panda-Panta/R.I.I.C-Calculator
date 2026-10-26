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
import { verifyTeacherSourceCompatibility, LATEST_POLICY_SOURCE_TRANSITION, LATEST_RUNORDER_SOURCE_TRANSITION } from './source-compatibility.mjs';
import { verifyProducerReplayRecord } from './policy-replay-contract.mjs';
import { openBaselineCache } from './baseline-cache.mjs';
import { sourceContracts } from '../full-train.mjs';
import { FULL_UNION_KIND, verifyFullTrainingUnion, fullUnionDatasetContract } from './full-union-contract.mjs';
import { FEATURE_MIGRATION_ID, FEATURE_MIGRATION_CONTRACT, FEATURE_MIGRATION_SOURCE_PAIRS, ALIGNED_SOURCE_TRANSITION } from './feature-migration-contract.mjs';
import { inspectPolicyBinary, verifyAppendOnlyPolicyMigration, reconstructMigrationByteReceipt } from './parity-report-migration.mjs';
import { verifyPreparedUnionMembership, verifyMigrationParentMembership } from './parity-report-populations.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LEGACY_POLICY = 'legacy-unconstrained-v1', LATEST_POLICY = 'latest-warmup-exhaustion-v1', RUNORDER_POLICY = 'latest-warmup-runorder-v2';
// Explicitly reviewed versions only: importing a future producer mode never opts this reporter in.
const POLICY_TRANSITIONS = Object.freeze({ [LATEST_POLICY]: LATEST_POLICY_SOURCE_TRANSITION, [RUNORDER_POLICY]: LATEST_RUNORDER_SOURCE_TRANSITION });
const constrainedPolicy = mode => Object.hasOwn(POLICY_TRANSITIONS, mode);
export function objectiveVersionForPolicy(mode = LEGACY_POLICY) {
    if (![LEGACY_POLICY, LATEST_POLICY, RUNORDER_POLICY].includes(mode)) throw Error('Unsupported explicit policy mode');
    return mode === RUNORDER_POLICY ? 'latest-default-runtime-lexicographic-v3' : 'latest-default-lexicographic-v2';
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const equal = (a, b, label) => { if (digest(a) !== digest(b)) throw Error(label + ' mismatch'); };
const requireThat = (condition, label) => { if (!condition) throw Error(label); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const omitReplayRecords = ({ proof, ...evidence }) => evidence;
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
export function reconstructExternalDecodeJob({ trainingManifest, trainingDataset, referenceContract, producerReplay, record, source, evaluationDirectory, modelHash }) {
    const explicitPolicy = trainingManifest.config.policyMode !== undefined;
    return { referenceContract, ...(producerReplay ? { producerReplayProof: producerReplay } : {}), ...(trainingManifest.config.featureMigration ? { featureMigration: trainingManifest.config.featureMigration } : {}), ...(explicitPolicy ? { policyMode: trainingManifest.config.policyMode } : {}),
        archivedTeacherTrace: { ...(explicitPolicy ? { policyMode: record.policyMode ?? LEGACY_POLICY } : {}), constructionOrder: record.constructionOrder ?? 'legacy-v1', actionIds: record.actionIds, teacherSemanticHash: record.teacherSemanticHash },
        constructionOrder: trainingManifest.config.constructionOrder ?? 'legacy-v1', input: record.input, outcome: source?.outcome, trainingInputs: trainingDataset.records.map(r => r.input), modelPath: join(evaluationDirectory, 'model.bin'), modelHash };
}
export function verifyDecodeArtifact(artifact, { binding, job, protocol }) {
    equal(artifact?.binding, binding, 'Decode artifact binding');
    equal(artifact.jobHash, digest(job), 'Decode exact job');
    objectiveVersionForPolicy(job.policyMode);
    const result = artifact.outcome?.result;
    if (artifact.outcome?.status !== 'completed') return { available: false, result: null };
    requireThat(result?.familyId === job.input.familyId && result.modelHash === binding.modelHash, 'Decode family/model mismatch');
    if (job.policyMode !== undefined) equal(result.policyMode, job.policyMode, 'Decode explicit policy mode');
    if (constrainedPolicy(job.policyMode)) {
        equal(binding.producerReplayProofHash, digest(job.producerReplayProof), 'External independent producer replay binding');
        const partial = verifyProducerReplayRecord(job.producerReplayProof, job.input, job.outcome, job.archivedTeacherTrace);
        const original = job.producerReplayProof.records.find(r => r.familyId === job.input.familyId);
        equal(job.archivedTeacherTrace.actionIds, original.actionIds, 'External archived original action IDs');
        equal(job.archivedTeacherTrace.policyMode, LEGACY_POLICY, 'External archived original policy');
        equal(result.producerReplay, partial, 'Decoded independent replay proof');
    } else requireThat(!result.producerReplay && !job.producerReplayProof && !binding.producerReplayProofHash, 'Unexpected replay proof on legacy decode');
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
        } else row.status = semantic.length || row.issues.some(issue => /AUTHENTICATION_FAILED|mismatch|unsupported|INVALID|FORBIDDEN|CHANGED|MISSING_ORDINARY|UNOWNED|UNSUPPORTED|fallback/i.test(issue)) ? 'fail' : 'inconclusive';
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
function verifyReviewedFeatureContract() {
    equal(digest(FEATURE_MIGRATION_CONTRACT), '34d6bad33043558804640a60ea9e4bd0d63b71d3efa3b7fb6d2a628812986c67', 'Reviewed feature migration contract');
    equal(digest(FEATURE_MIGRATION_SOURCE_PAIRS), '3457c9874ca6532856320ed89f712a503d8ec3ddff3499d1ab1b47b3bf8644cf', 'Reviewed feature source pairs');
}
function verifyPreparedFeatureBinding(manifest, dataset, proof) {
    if (manifest.config.sourceTransition === ALIGNED_SOURCE_TRANSITION) {
        verifyReviewedFeatureContract();
        requireThat(manifest.config.policyMode === RUNORDER_POLICY && manifest.config.featureMigration === FEATURE_MIGRATION_ID && dataset.schemaVersion === 6, 'Missing explicit aligned feature migration');
        equal(dataset.featureMigration, FEATURE_MIGRATION_CONTRACT, 'Prepared feature migration declaration');
        requireThat(dataset.featureManifestHash === FEATURE_MIGRATION_CONTRACT.newHash && proof.featureManifestHash === FEATURE_MIGRATION_CONTRACT.oldHash, 'Prepared old/new feature identities mismatch');
    } else requireThat(!manifest.config.featureMigration && !dataset.featureMigration, 'Unexpected feature migration');
}
export function verifyPolicyContract(manifest, dataset, sources) {
    const mode = manifest.config.policyMode ?? LEGACY_POLICY, transition = manifest.config.sourceTransition ?? 'none', union = sources.kind === FULL_UNION_KIND;
    objectiveVersionForPolicy(mode);
    requireThat((dataset.policyMode ?? LEGACY_POLICY) === mode && dataset.records.every(r => (r.policyMode ?? LEGACY_POLICY) === mode), 'Dataset/record policy-mode mismatch');
    if (constrainedPolicy(mode)) {
        const aligned = transition === ALIGNED_SOURCE_TRANSITION;
        requireThat((transition === POLICY_TRANSITIONS[mode] || (aligned && mode === RUNORDER_POLICY)) && manifest.config.constructionOrder === 'staffing-first-v1' && manifest.config.teacherKind === 'full-optimizer', 'Latest mode lacks explicit producer replay transition');
        if (union) {
            requireThat(aligned && !manifest.config.producerReplayRun && isAbsolute(manifest.config.fullSourceUnion ?? ''), 'Unsupported union initialization contract');
            verifyPreparedUnionMembership(dataset, sources);
            for (const member of sources.members) verifyPreparedFeatureBinding(manifest, dataset, member.sources.producerReplay);
        } else {
            requireThat(typeof manifest.config.producerReplayRun === 'string' && /^[\w-]+$/.test(manifest.config.producerReplayRun), 'Latest mode lacks explicit producer replay transition');
            requireThat(dataset.schemaVersion === (aligned ? 6 : 5) && sources.producerReplay && dataset.producerReplayProofHash === digest(sources.producerReplay), 'Latest dataset lacks exact producer replay proof');
            requireThat(Array.isArray(sources.producerReplay.records), 'Latest replay cohort missing');
            equal(dataset.records.map(r => r.familyId).sort(), sources.producerReplay.records.map(r => r.familyId).sort(), 'Latest prepared full producer cohort');
            verifyPreparedFeatureBinding(manifest, dataset, sources.producerReplay);
        }
    } else requireThat(transition === 'none' && !union && !sources.producerReplay && !dataset.producerReplayProofHash && !dataset.records.some(r => r.producerReplay) && !manifest.config.featureMigration && !dataset.featureMigration, 'Unsupported legacy policy/source transition');
    return mode;
}
export function verifyProducerReplayEvidence({ proof, producerManifest, producerSnapshot, producerBundle, producerSources, producerDataset, producerPreparation, job, outcome, replayedDataset, sources, expectedProducerDirectory }) {
    const config = producerManifest.config;
    requireThat(config?.teacherKind === 'full-optimizer' && config.purpose === sources.purpose && (config.policyMode ?? LEGACY_POLICY) === LEGACY_POLICY && (config.sourceTransition ?? 'none') === 'none', 'Original producer role/policy mismatch');
    verifyFrozenProvenance(producerManifest.provenance, producerSnapshot, producerBundle);
    equal(producerSources.teacherManifest, sources.teacherManifest, 'Original replay mathematical teacher manifest');
    equal(producerSources.records, sources.records, 'Original replay raw source records'); equal(producerSources.pending ?? [], sources.pending ?? [], 'Original replay pending attempts');
    requireThat(producerDataset.purpose === sources.purpose && producerDataset.records.length > 0 && producerDataset.records.every(r => (r.policyMode ?? LEGACY_POLICY) === LEGACY_POLICY), 'Original producer dataset purpose/policy');
    equal(producerDataset.sourceRecordsHash, digest(producerSources), 'Original producer dataset source commitment');
    requireThat(producerPreparation.status === 'completed' && producerPreparation.result?.status === 'dataset-ready', 'Original producer preparation unavailable');
    equal(producerPreparation.result.datasetHash, digest(producerDataset), 'Original producer prepared dataset');
    equal(replayedDataset, producerDataset, 'Independently replayed entire original dataset');
    requireThat(outcome.status === 'completed' && outcome.exitCode === 0 && outcome.result?.status === 'dataset-ready', 'Independent prepare-only replay unavailable');
    equal(outcome.result.datasetHash, digest(replayedDataset), 'Independent replay outcome dataset');
    requireThat(typeof job.directory === 'string' && isAbsolute(job.directory), 'Replay job requires an exact absolute directory');
    equal(job, { mode: 'prepare', directory: job.directory, purpose: config.purpose, teacherKind: 'full-optimizer', constructionOrder: config.constructionOrder ?? 'legacy-v1', inputProfile: config.inputProfile ?? 'actual-mixture-v1', sourceTransition: 'none' }, 'Independent prepare-only job');
    const expected = { schemaVersion: 1, kind: 'frozen-full-reference-replay-v1', mode: 'prepare-only-zero-training-zero-simulation', producerDirectory: expectedProducerDirectory,
        producerManifestHash: digest(producerManifest), producerSourceHash: producerManifest.provenance.sourceHash, producerBundleHash: producerManifest.provenance.bundleHash,
        teacherManifestHash: digest(sources.teacherManifest), sourceRecordsHash: digest(producerSources), archivedDatasetHash: digest(producerDataset), replayedDatasetHash: digest(replayedDataset),
        featureManifestHash: producerDataset.featureManifestHash, constructionOrder: producerDataset.constructionOrder ?? 'legacy-v1', policyMode: LEGACY_POLICY,
        preparationJobHash: digest(job), preparationOutcomeHash: digest(outcome), records: producerDataset.records.map(r => ({ familyId: r.familyId, inputHash: digest(r.input), teacherRecordHash: r.teacherRecordHash,
            actionIds: r.actionIds, teacherSemanticHash: r.teacherSemanticHash, constructionOrder: r.constructionOrder ?? 'legacy-v1', policyMode: r.policyMode ?? LEGACY_POLICY })) };
    equal(proof, expected, 'Complete independent producer replay receipt');
    requireThat(new Set(proof.records.map(r => r.familyId)).size === proof.records.length, 'Duplicate original replay family');
    for (const record of producerDataset.records) {
        const source = sources.records.filter(r => r.input.familyId === record.familyId && digest(r.outcome) === record.teacherRecordHash);
        requireThat(source.length === 1, 'Missing exact original replay teacher'); equal(source[0].input, record.input, 'Original replay input');
        verifyProducerReplayRecord(proof, source[0].input, source[0].outcome, record);
    }
    return digest(proof);
}
function verifyReplaySourceTransition(original, current, transition) {
    requireThat([...Object.values(POLICY_TRANSITIONS), ALIGNED_SOURCE_TRANSITION].includes(transition), 'Unsupported replay source transition');
    if (transition === ALIGNED_SOURCE_TRANSITION) verifyReviewedFeatureContract();
    const onlySrc = p => ({ sourceHashes: Object.fromEntries(Object.entries(p.sourceHashes).filter(([path]) => path.startsWith('src/'))) });
    for (const path of Object.keys(onlySrc(original).sourceHashes)) requireThat(current.sourceHashes[path], 'Missing original replay dependency: ' + path);
    return verifyTeacherSourceCompatibility(onlySrc(original), onlySrc(current), transition);
}
/** Authenticate receipt files, not merely their caller-provided hashes. No worker is executed. */
export function authenticateProducerReplay(root, directory, proof, sources, trainingProvenance, expectedProducerDirectory, transition = LATEST_POLICY_SOURCE_TRANSITION) {
    const producerDirectory = safeChild(root, relative(root, expectedProducerDirectory)), declaredProducer = read(join(producerDirectory, 'manifest.json'));
    requireThat((declaredProducer.config?.policyMode ?? LEGACY_POLICY) === LEGACY_POLICY && (declaredProducer.config?.sourceTransition ?? 'none') === 'none', 'Replay producer must be original legacy preparation');
    const producer = preparedRun(root, producerDirectory, sources.purpose);
    const names = { 'producer-manifest.json': 'manifest.json', 'producer-source-snapshot.json': 'source-snapshot.json', 'producer-dataset.json': 'dataset.json', 'producer-preparation.json': 'preparation.json', 'source-records.json': 'source-records.json', 'worker.mjs': 'worker.mjs' };
    for (const [copy, original] of Object.entries(names)) equal(digest(readFileSync(join(directory, copy))), digest(readFileSync(join(producerDirectory, original))), 'Exact copied original replay file: ' + copy);
    const job = read(join(directory, 'job.json')), outcome = read(join(directory, 'preparation.json')), replayedDataset = read(join(directory, 'dataset.json'));
    equal(read(join(directory, 'proof.json')), proof, 'Stored independent replay proof');
    // Evaluation mirrors retain the ORIGINAL absolute job directory; copied proof files must agree.
    const originalReplayDirectory = safeChild(root, relative(root, job.directory));
    if (realpathSync(originalReplayDirectory) !== realpathSync(directory)) for (const name of [...Object.keys(names), 'proof.json', 'job.json', 'preparation.json', 'dataset.json', 'qualification.json', 'feature-manifest.json'])
        equal(digest(readFileSync(join(directory, name))), digest(readFileSync(join(originalReplayDirectory, name))), 'Mirrored original replay artifact: ' + name);
    const proofHash = verifyProducerReplayEvidence({ proof, producerManifest: producer.manifest, producerSnapshot: producer.snapshot, producerBundle: readFileSync(join(directory, 'worker.mjs')),
        producerSources: producer.sources, producerDataset: producer.dataset, producerPreparation: read(join(directory, 'producer-preparation.json')), job, outcome, replayedDataset, sources, expectedProducerDirectory: producerDirectory });
    const sourceTransition = verifyReplaySourceTransition(producer.manifest.provenance, trainingProvenance, transition), qualification = read(join(directory, 'qualification.json'));
    requireThat(qualification.qualified === producer.dataset.records.length, 'Original replay qualification count mismatch');
    for (const record of producer.dataset.records) requireThat(qualification.audits.filter(a => a.familyId === record.familyId && a.qualified && a.exactReplay && a.complete).length === 1, 'Original replay exact qualification missing');
    equal(read(join(directory, 'feature-manifest.json')), read(join(producerDirectory, 'feature-manifest.json')), 'Original replay feature definitions');
    return { proofHash, producerDirectory, directory, sourceTransition, qualificationHash: digest(qualification), proof };
}
function verifyOriginalTeachers(root, run, dataset, sources, memberIndex = null) {
    const population = memberIndex === null ? dataset.records : dataset.records.filter(r => r.sourceMemberIndex === memberIndex);
    if (memberIndex === null) equal(dataset.sourceRecordsHash, digest(sources), 'Dataset source-record commitment');
    else {
        requireThat(run.manifest.sourceContracts?.kind === FULL_UNION_KIND, 'Missing original union declaration');
        equal(dataset.sourceUnion?.members?.[memberIndex]?.sourceRecordsHash, digest(sources), 'Union member source-record commitment');
        equal(run.manifest.sourceContracts.members[memberIndex], { index: memberIndex, ...sourceContracts(sources).primary, producerReplayProofHash: digest(sources.producerReplay), sourceRecordsHash: digest(sources) }, 'Declared independent union member');
    }
    equal(sources.teacherManifestHash, digest(sources.teacherManifest), 'Teacher manifest commitment');
    const name = sources.teacherManifest.config?.run;
    requireThat(typeof name === 'string' && /^[\w-]+$/.test(name), 'Invalid original teacher directory');
    const original = frozenRun(safeChild(root, 'training_data/neural-full-v2/' + name));
    equal(original.manifest, sources.teacherManifest, 'Original teacher manifest');
    if (memberIndex === null) verifyPrimarySourceDeclaration(run.manifest, sources);
    const checkpoint = read(join(original.directory, 'checkpoint.json'));
    equal(checkpoint.manifestHash, digest(original.manifest), 'Original teacher checkpoint manifest');
    const fullReference = referenceManifestContract(original.manifest, sources.records.map(r => r.input));
    equal(fullReference.referenceProtocol, referenceProtocol(LATEST_DEFAULT_REFERENCE), 'Latest default reference protocol');
    equal(sources.referenceContract, fullReference, 'Source reference contract');
    equal(memberIndex === null ? dataset.referenceContract : dataset.referenceContracts?.[memberIndex], referenceManifestContract(original.manifest, population.map(r => r.input)), 'Dataset reference contract');
    equal(dataset.referenceProtocols, [referenceProtocol(LATEST_DEFAULT_REFERENCE)], 'Dataset reference population');
    requireThat(['none', ...Object.values(POLICY_TRANSITIONS), ALIGNED_SOURCE_TRANSITION].includes(run.manifest.config.sourceTransition), 'Unsupported source-transition policy');
    const compatibility = verifyTeacherSourceCompatibility(original.manifest.provenance, run.manifest.provenance, run.manifest.config.sourceTransition);
    equal(sources.sourceCompatibility, compatibility, 'Teacher source compatibility');
    const records = new Map(), declaredInputs = new Map();
    for (const { declaration } of declaredCohort(original.manifest.cases, population)) {
        requireThat(/^[\w.-]+$/.test(declaration.familyId), 'Unsafe declared family identifier');
        const input = read(join(original.directory, declaration.familyId + '.input.json'));
        equal(declaration.inputHash, digest(input), 'Declared original input hash');
        requireThat(input.familyId === declaration.familyId && input.size === declaration.size && input.split === (dataset.purpose === 'train' ? 'train' : 'dev'), 'Declared original input identity/split');
        referenceManifestContract(original.manifest, [input]); declaredInputs.set(declaration.familyId, input);
    }
    for (const record of population) {
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
    return { original, records, declaredInputs, sourceReference: fullReference, reference: referenceManifestContract(original.manifest, population.map(r => r.input)), compatibility };
}
function verifyCurrentPolicyQualification(directory, dataset, proofForRecord, teachers) {
    const qualification = read(join(directory, 'qualification.json'));
    requireThat(qualification.qualified === dataset.records.length, 'Current policy qualification count mismatch');
    for (const { record, source } of teachers.records.values()) {
        const partial = verifyProducerReplayRecord(proofForRecord(record), record.input, source.outcome, record);
        equal(record.producerReplay, partial, 'Current policy original replay record');
        const audits = qualification.audits.filter(a => a.familyId === record.familyId && a.qualified && a.exactReplay && a.complete);
        requireThat(audits.length === 1, 'Current policy exact teacher qualification missing'); equal(audits[0].producerReplay, partial, 'Current policy qualification replay commitment');
    }
}
function preparedUnion(root, run, dataset, sources, policyMode) {
    verifyFullTrainingUnion(sources);
    equal(sources.trainingProvenance, run.manifest.provenance, 'Union frozen training provenance');
    equal(dataset.sourceRecordsHash, digest(sources), 'Complete union source-record commitment');
    equal(dataset.sourceUnion, fullUnionDatasetContract(sources), 'Complete prepared union declaration');
    equal(run.manifest.sourceContracts, sourceContracts(sources), 'Complete union source contracts');
    requireThat(run.manifest.config.source === sources.definition.name && !sources.teacherManifest && !sources.producerReplay, 'Synthetic or conflicting union primary source');
    equal(run.manifest.fullSourceUnionDefinitionHash, digest(sources.definition), 'Union manifest definition commitment');
    equal(read(safeChild(root, relative(root, run.manifest.config.fullSourceUnion))), sources.definition, 'Original frozen union definition file');
    const teachers = { records: new Map() }, producerReplays = [];
    for (const [index, member] of sources.members.entries()) {
        const audited = verifyOriginalTeachers(root, run, dataset, member.sources, index);
        equal(realpathSync(member.directory), realpathSync(audited.original.directory), 'Original union teacher directory');
        equal(member.checkpoint, read(join(audited.original.directory, 'checkpoint.json')), 'Original union checkpoint artifact');
        equal(member.inputs, [...audited.declaredInputs.values()], 'Original union full input artifacts');
        for (const [familyId, record] of audited.records) { requireThat(!teachers.records.has(familyId), 'Duplicate cross-member family'); teachers.records.set(familyId, record); }
        producerReplays.push(authenticateProducerReplay(root, join(run.directory, 'producer-replay', 'member-' + index), member.sources.producerReplay, member.sources, run.manifest.provenance,
            sources.definition.members[index].producerReplayDirectory, run.manifest.config.sourceTransition));
    }
    for (const excluded of sources.excludedCohorts) {
        const directory = safeChild(root, relative(root, excluded.directory)), original = frozenRun(directory);
        equal(excluded.manifest, original.manifest, 'Original excluded DEV manifest');
        equal(excluded.inputs, original.manifest.cases.map(c => read(join(directory, c.familyId + '.input.json'))), 'Original excluded DEV input artifacts');
    }
    equal(read(join(run.directory, 'qualification.json')).cohortAccounting, sources.cohortAccounting, 'Prepared union cohort accounting');
    verifyCurrentPolicyQualification(run.directory, dataset, record => sources.members[record.sourceMemberIndex].sources.producerReplay, teachers);
    equal(digest(read(join(run.directory, 'feature-manifest.json'))), FEATURE_MIGRATION_CONTRACT.newManifestSha256, 'Prepared aligned complete feature manifest');
    return { ...run, dataset, sources, teachers, policyMode, producerReplay: null, producerReplays };
}
function preparedRun(root, directory, purpose) {
    const run = frozenRun(directory), dataset = read(join(directory, 'dataset.json')), sources = read(join(directory, 'source-records.json'));
    requireThat(run.manifest.config.purpose === purpose && dataset.purpose === purpose && sources.purpose === purpose, 'TRAIN versus DEV purpose mismatch');
    requireThat(run.manifest.config.teacherKind === 'full-optimizer' && dataset.baselineEligible === true && dataset.records?.length > 0, 'Only qualified full-optimizer datasets supported');
    requireThat(dataset.records.every(r => r.input?.split === (purpose === 'train' ? 'train' : 'dev') && r.originalSplit === r.input.split && r.familyId === r.input.familyId), 'TRAIN versus DEV split mismatch');
    equal(read(join(directory, 'preparation.json')).result?.datasetHash, digest(dataset), 'Prepared dataset hash');
    const policyMode = verifyPolicyContract(run.manifest, dataset, sources);
    if (sources.kind === FULL_UNION_KIND) return preparedUnion(root, run, dataset, sources, policyMode);
    const teachers = verifyOriginalTeachers(root, run, dataset, sources);
    let producerReplay = null;
    if (constrainedPolicy(policyMode)) {
        producerReplay = authenticateProducerReplay(root, join(directory, 'producer-replay'), sources.producerReplay, sources, run.manifest.provenance,
            join(root, 'training_data/neural-full-v2/training-runs', run.manifest.config.producerReplayRun), run.manifest.config.sourceTransition);
        if (run.manifest.config.sourceTransition === ALIGNED_SOURCE_TRANSITION) equal(digest(read(join(directory, 'feature-manifest.json'))), FEATURE_MIGRATION_CONTRACT.newManifestSha256, 'Prepared aligned complete feature manifest');
        else equal(dataset.featureManifestHash, sources.producerReplay.featureManifestHash, 'Policy transition feature manifest');
        verifyCurrentPolicyQualification(directory, dataset, () => sources.producerReplay, teachers);
    }
    return { ...run, dataset, sources, teachers, policyMode, producerReplay };
}
const checkpointBinding = run => ({ datasetHash: digest(run.dataset), sourceHash: run.manifest.provenance.sourceHash, bundleHash: run.manifest.provenance.bundleHash,
    featureManifestHash: run.dataset.featureManifestHash, ...run.manifest.config, ...(run.manifest.lineage ? { lineageHash: digest(run.manifest.lineage) } : {}) });
export function verifyTrainForkLink({ lineage, childManifest, childDataset, parentManifest, parentDataset, parentState, initialBytes, parentBytes, producerReplay = null, parentProducerReplay = null }) {
    requireThat(lineage?.spec?.mode === 'fork' && /^[\w-]+$/.test(lineage.spec.parentRun) && /^checkpoint-[\d-]+$/.test(lineage.parent?.generation), 'Invalid TRAIN fork ancestry');
    requireThat(childManifest.config.purpose === 'train' && parentManifest.config.purpose === 'train', 'DEV parameters cannot enter TRAIN lineage');
    const childMode = childManifest.config.policyMode ?? LEGACY_POLICY, parentMode = parentManifest.config.policyMode ?? LEGACY_POLICY;
    objectiveVersionForPolicy(childMode); objectiveVersionForPolicy(parentMode);
    const policyTransition = childMode !== parentMode;
    requireThat(!policyTransition || (constrainedPolicy(childMode) && (parentMode === LEGACY_POLICY || (parentMode === LATEST_POLICY && childMode === RUNORDER_POLICY))), 'Unsupported parameter fork policy direction');
    const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
    equal(omit(childManifest.config, policyTransition ? ['chunkSize', 'policyMode', 'sourceTransition', 'producerReplayRun'] : ['chunkSize']), omit(parentManifest.config, policyTransition ? ['chunkSize', 'policyMode', 'sourceTransition', 'producerReplayRun'] : ['chunkSize']), 'Fork numerical/training configuration');
    if (policyTransition) {
        requireThat(childManifest.config.sourceTransition === POLICY_TRANSITIONS[childMode] && (parentManifest.config.sourceTransition ?? 'none') === (POLICY_TRANSITIONS[parentMode] ?? 'none'), 'Unsupported parameter fork policy transition');
        const proof = producerReplay?.proof;
        requireThat(proof && producerReplay.proofHash === digest(proof), 'Parameter fork needs authenticated independent producer replay');
        if (parentMode === LEGACY_POLICY) {
            equal(proof.archivedDatasetHash, digest(parentDataset), 'Policy-fork original trained dataset');
            equal(proof.producerSourceHash, parentManifest.provenance.sourceHash, 'Policy-fork original executable source');
            equal(proof.producerBundleHash, parentManifest.provenance.bundleHash, 'Policy-fork original executable bundle');
        } else {
            const parentProof = parentProducerReplay?.proof;
            requireThat(parentProof && parentProducerReplay.proofHash === digest(parentProof), 'Policy-fork parent needs authenticated original producer replay');
            // Execution directories/outcome timings vary; the original producer and entire population must not.
            equal(omit(proof, ['preparationJobHash', 'preparationOutcomeHash']), omit(parentProof, ['preparationJobHash', 'preparationOutcomeHash']), 'Policy-fork common original producer population');
            equal(parentDataset.producerReplayProofHash, digest(parentProof), 'Policy-fork parent dataset replay binding');
        }
        equal(childDataset.producerReplayProofHash, digest(proof), 'Policy-fork child dataset replay binding');
        equal(proof.featureManifestHash, childDataset.featureManifestHash, 'Policy-fork immutable features');
        verifyReplaySourceTransition(parentManifest.provenance, childManifest.provenance, childManifest.config.sourceTransition);
        equal(omit(childDataset, ['schemaVersion', 'policyMode', 'producerReplayProofHash', 'sourceRecordsHash', 'records']), omit(parentDataset, ['schemaVersion', 'policyMode', 'producerReplayProofHash', 'sourceRecordsHash', 'records']), 'Policy-fork dataset settings');
        requireThat(childDataset.records.length === parentDataset.records.length && new Set(childDataset.records.map(r => r.familyId)).size === childDataset.records.length, 'Policy-fork TRAIN cohort changed');
        for (const record of childDataset.records) {
            const original = parentDataset.records.find(r => r.familyId === record.familyId), archived = proof.records.filter(r => r.familyId === record.familyId);
            requireThat(original && archived.length === 1 && record.policyMode === childMode, 'Policy-fork missing original family');
            equal(omit(record, ['policyMode', 'producerReplay', 'actionIds']), omit(original, ['policyMode', 'producerReplay', 'actionIds']), 'Policy-fork exact input/teacher/native semantics');
            const originalPartial = { producerActionIdsHash: digest(archived[0].actionIds), producerSemanticHash: original.teacherSemanticHash };
            if (parentMode === LEGACY_POLICY) equal(archived[0].actionIds, original.actionIds, 'Policy-fork original trained action IDs');
            else equal(original.producerReplay, { producerReplayProofHash: parentProducerReplay.proofHash, ...originalPartial }, 'Policy-fork parent record dual proof');
            equal(record.producerReplay, { producerReplayProofHash: digest(proof), ...originalPartial }, 'Policy-fork record dual proof');
        }
    } else {
        equal(childDataset, parentDataset, 'Fork exact TRAIN dataset');
        const executable = p => ({ sourceHash: p.sourceHash, sourceHashes: p.sourceHashes, bundleHash: p.bundleHash });
        equal(executable(childManifest.provenance), executable(parentManifest.provenance), 'Fork exact frozen source/bundle');
    }
    verifyParentCheckpointLink({ lineage, parentManifest, parentDataset, parentState, initialBytes, parentBytes });
}
function verifyParentCheckpointLink({ lineage, parentManifest, parentDataset, parentState, initialBytes, parentBytes }) {
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

export function verifyFeatureMigrationTrainLink({ lineage, childManifest, childDataset, parentManifest, parentDataset, parentState, initialBytes, parentBytes, migratedBytes, oldFeatureManifest, newFeatureManifest, parentReplay, childReplay }) {
    verifyReviewedFeatureContract();
    requireThat(lineage?.spec?.mode === 'feature-migration' && lineage.spec.featureMigration === FEATURE_MIGRATION_ID && /^[\w-]+$/.test(lineage.spec.parentRun) && /^checkpoint-[\d-]+$/.test(lineage.parent?.generation), 'Unknown explicit feature migration lineage');
    requireThat(childManifest.config.purpose === 'train' && parentManifest.config.purpose === 'train' && childManifest.config.policyMode === RUNORDER_POLICY && constrainedPolicy(parentManifest.config.policyMode), 'Feature migration requires supported actual TRAIN policy parents');
    requireThat(childManifest.config.featureMigration === FEATURE_MIGRATION_ID && childManifest.config.sourceTransition === ALIGNED_SOURCE_TRANSITION && childDataset.sourceUnion?.kind === FULL_UNION_KIND && !parentDataset.sourceUnion, 'Unsupported feature migration population/source contract');
    requireThat(parentDataset.featureManifestHash === FEATURE_MIGRATION_CONTRACT.oldHash && childDataset.featureManifestHash === FEATURE_MIGRATION_CONTRACT.newHash, 'Feature migration dataset identities mismatch');
    const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const configurationChanges = ['source', 'sourceTransition', 'policyMode', 'producerReplayRun', 'fullSourceUnion', 'featureMigration'];
    equal(omit(childManifest.config, configurationChanges), omit(parentManifest.config, configurationChanges), 'Feature migration unchanged numerical configuration');
    equal(lineage.featureMigration, { id: FEATURE_MIGRATION_ID, parentFeatureManifestHash: digest(oldFeatureManifest), parentNumericalConfig: Object.fromEntries(['optimizer', 'learningRate', 'hiddenSize', 'seed', 'chunkSize'].map(key => [key, parentManifest.config[key]])) }, 'Feature migration original numerical declaration');
    const datasetChanges = ['schemaVersion', 'policyMode', 'producerReplayProofHash', 'sourceRecordsHash', 'records', 'featureManifestHash', 'featureMigration', 'sourceUnion', 'referenceContract', 'referenceContracts'];
    equal(omit(childDataset, datasetChanges), omit(parentDataset, datasetChanges), 'Feature migration preserved dataset settings');
    equal(childDataset.referenceContracts?.[0], parentDataset.referenceContract, 'Feature migration original parent reference population');
    verifyReplaySourceTransition(parentManifest.provenance, childManifest.provenance, ALIGNED_SOURCE_TRANSITION);
    verifyParentCheckpointLink({ lineage, parentManifest, parentDataset, parentState, initialBytes, parentBytes });
    equal(digest(oldFeatureManifest), FEATURE_MIGRATION_CONTRACT.oldManifestSha256, 'Migration original complete feature manifest');
    equal(digest(newFeatureManifest), FEATURE_MIGRATION_CONTRACT.newManifestSha256, 'Migration target complete feature manifest');
    const args = { initialBytes, migratedBytes, oldManifest: oldFeatureManifest, newManifest: newFeatureManifest, oldHash: FEATURE_MIGRATION_CONTRACT.oldHash, newHash: FEATURE_MIGRATION_CONTRACT.newHash };
    const byteEvidence = verifyAppendOnlyPolicyMigration(args), population = verifyMigrationParentMembership({ parentDataset, childDataset, parentReplay, childReplay });
    requireThat(byteEvidence.inheritedTrainingUpdates === parentState.cursor.updates, 'Migration cumulative update metadata mismatch');
    const parsed = inspectPolicyBinary(initialBytes, { ...oldFeatureManifest, manifestHash: FEATURE_MIGRATION_CONTRACT.oldHash }).header;
    requireThat(parsed.hiddenSize === parentManifest.config.hiddenSize && parsed.metadata.seed === parentManifest.config.seed && (parsed.metadata.optimizerVersion ?? 'sgd-v1') === parentManifest.config.optimizer, 'Migration original model numerical metadata mismatch');
    const preserved = parentDataset.records.map(r => ({ familyId: r.familyId, inputHash: digest(r.input), teacherRecordHash: r.teacherRecordHash, teacherSemanticHash: r.teacherSemanticHash })).sort((a, b) => a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0);
    const receiptPopulation = { parentDatasetHash: population.parentDatasetHash, newDatasetHash: population.newDatasetHash, parentFamilyCount: population.parentFamilyCount, parentMemberIndex: 0, additionalFamilies: population.additionalFamilies, preserved };
    const expectedReceipt = { ...reconstructMigrationByteReceipt(args, FEATURE_MIGRATION_CONTRACT), population: receiptPopulation, lineageHash: digest(lineage), parentFeatureManifestHash: digest(oldFeatureManifest), featureManifestHash: digest(newFeatureManifest), sourceHash: childManifest.provenance.sourceHash, bundleHash: childManifest.provenance.bundleHash };
    return { byteEvidence, population, expectedReceipt };
}
function metadataForFrozenParent(bytes, parent, runtime) {
    if (parent.dataset.featureManifestHash === runtime.FULL_FEATURE_MANIFEST_HASH) return runtime.modelMetadata(bytes);
    verifyReviewedFeatureContract();
    const features = read(join(parent.directory, 'feature-manifest.json'));
    requireThat(parent.dataset.featureManifestHash === FEATURE_MIGRATION_CONTRACT.oldHash, 'Unsupported historical parent feature contract');
    equal(digest(features), FEATURE_MIGRATION_CONTRACT.oldManifestSha256, 'Historical parent full feature manifest');
    const model = inspectPolicyBinary(bytes, { ...features, manifestHash: parent.dataset.featureManifestHash }).header;
    return { ...model.metadata, hiddenSize: model.hiddenSize, manifestHash: model.manifestHash };
}
function authenticateTrainingLineage(root, training, runtime, seen = new Set()) {
    const identity = realpathSync(training.directory), lineage = read(join(training.directory, 'lineage.json'));
    requireThat(!seen.has(identity) && seen.size < 16, 'TRAIN ancestry cycle or unsupported depth'); seen.add(identity);
    equal(lineage, training.manifest.lineage, 'TRAIN initialization lineage');
    if (lineage?.spec?.mode === 'fresh') {
        requireThat(lineage.parent === null && lineage.initialModelHash === null && lineage.spec.parentRun === null, 'Unsupported fresh TRAIN ancestry');
        return [{ directory: training.directory, mode: 'fresh', manifestHash: digest(training.manifest), lineageHash: digest(lineage) }];
    }
    requireThat(['fork', 'feature-migration'].includes(lineage?.spec?.mode) && /^[\w-]+$/.test(lineage.spec.parentRun) && /^checkpoint-[\d-]+$/.test(lineage.parent?.generation), 'Unknown TRAIN lineage policy');
    const parentDirectory = safeChild(root, relative(root, join(dirname(training.directory), lineage.spec.parentRun))), parent = preparedRun(root, parentDirectory, 'train');
    const generation = safeChild(parentDirectory, lineage.parent.generation), parentState = read(join(generation, 'state.json'));
    equal(read(join(training.directory, 'parent-manifest.json')), parent.manifest, 'Frozen copied parent manifest');
    equal(read(join(training.directory, 'parent-checkpoint.json')), parentState, 'Frozen copied parent checkpoint');
    const initialBytes = readFileSync(join(training.directory, 'initial-model.bin')), parentBytes = readFileSync(join(generation, 'model.bin'));
    if (lineage.spec.mode === 'feature-migration') {
        equal(read(join(training.directory, 'parent-dataset.json')), parent.dataset, 'Original migration parent dataset sidecar');
        const oldFeatures = read(join(training.directory, 'parent-feature-manifest.json')), newFeatures = read(join(training.directory, 'feature-manifest.json'));
        equal(oldFeatures, read(join(parent.directory, 'feature-manifest.json')), 'Original migration parent feature sidecar');
        const migratedBytes = readFileSync(join(training.directory, 'migrated-initial-model.bin'));
        const checked = verifyFeatureMigrationTrainLink({ lineage, childManifest: training.manifest, childDataset: training.dataset, parentManifest: parent.manifest, parentDataset: parent.dataset, parentState, initialBytes, parentBytes, migratedBytes,
            oldFeatureManifest: oldFeatures, newFeatureManifest: newFeatures, parentReplay: parent.producerReplay, childReplay: training.producerReplays?.[0] });
        equal(read(join(training.directory, 'feature-migration.json')), checked.expectedReceipt, 'Independently reconstructed feature migration receipt');
        const migration = { id: FEATURE_MIGRATION_ID, parentUpdates: parentState.cursor.updates, receiptHash: digest(checked.expectedReceipt), ...checked.byteEvidence, population: checked.population };
        return [{ directory: training.directory, mode: 'feature-migration', manifestHash: digest(training.manifest), lineageHash: digest(lineage), parentStateHash: digest(parentState), initialModelHash: digest(initialBytes), featureMigration: migration }, ...authenticateTrainingLineage(root, parent, runtime, seen)];
    }
    verifyTrainForkLink({ lineage, childManifest: training.manifest, childDataset: training.dataset, parentManifest: parent.manifest, parentDataset: parent.dataset, parentState, initialBytes, parentBytes, producerReplay: training.producerReplay, parentProducerReplay: parent.producerReplay });
    const metadata = metadataForFrozenParent(initialBytes, parent, runtime);
    requireThat(metadata.hiddenSize === parent.manifest.config.hiddenSize && metadata.seed === parent.manifest.config.seed && metadata.trainingUpdates === parentState.cursor.updates && metadata.manifestHash === parent.dataset.featureManifestHash, 'Fork binary metadata mismatch');
    const policyTransition = training.policyMode !== parent.policyMode;
    return [{ directory: training.directory, mode: 'fork', manifestHash: digest(training.manifest), lineageHash: digest(lineage), parentStateHash: digest(parentState), initialModelHash: digest(initialBytes), ...(policyTransition ? { policyTransition: { from: parent.policyMode, to: training.policyMode, parentUpdates: parentState.cursor.updates, producerReplayProofHash: training.producerReplay.proofHash } } : {}) }, ...authenticateTrainingLineage(root, parent, runtime, seen)];
}
export function canonicalReporterSourceManifest(sourceHashes) {
    requireThat(sourceHashes && Object.keys(sourceHashes).length && Object.entries(sourceHashes).every(([path, hash]) => path.length && sha(hash)), 'Invalid reporter source map');
    const sorted = Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    return { sourceHashes: sorted, sourceHash: digest(sorted), sourceHashScheme: 'sha256-sorted-path-map-v1' };
}
export function verifyReporterSourceManifest(provenance) {
    const canonical = canonicalReporterSourceManifest(provenance.sourceHashes);
    if (provenance.sourceHashScheme === undefined) equal(provenance.sourceHash, digest(provenance.sourceHashes), 'Historical reporter stored-map hash');
    else {
        requireThat(provenance.sourceHashScheme === canonical.sourceHashScheme, 'Unknown reporter source hash scheme');
        equal(provenance.sourceHashes, canonical.sourceHashes, 'Canonical reporter stored source order');
        equal(provenance.sourceHash, canonical.sourceHash, 'Canonical reporter source hash');
    }
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
        return { runtime, provenance: { ...canonicalReporterSourceManifest(sourceHashes), bundleHash: digest(built.outputFiles[0].contents), adapterHash: digest(readFileSync(fileURLToPath(import.meta.url))), adapterSupportHashes: Object.fromEntries(['parity-report-migration.mjs', 'parity-report-populations.mjs'].map(name => [name, digest(readFileSync(join(root, 'scripts/neural/full-training', name)))])) } };
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
        if (training.manifest.config.featureMigration) {
            const receipt = read(join(training.directory, 'feature-migration.json'));
            equal(state.initializationProofHash, digest(receipt), 'TRAIN checkpoint feature initialization proof');
            requireThat(state.cursor.updates >= receipt.metadata.trainingUpdates, 'Migrated update counter regressed');
            if (state.cursor.updates === receipt.metadata.trainingUpdates) {
                equal(state.modelHash, receipt.newModelHash, 'Zero-update migrated checkpoint exact parameters');
                requireThat(state.cursor.epoch === 0 && state.cursor.family === 0 && state.cursor.action === 0, 'Zero-update migration checkpoint cursor mismatch');
            }
        }
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
            trainBundleHash: training.manifest.provenance.bundleHash, trainingLineage, familyInventoryHashes,
            ...(training.producerReplay ? { trainingProducerReplay: omitReplayRecords(training.producerReplay) } : {}),
            ...(training.producerReplays ? { trainingProducerReplays: training.producerReplays.map(omitReplayRecords), trainingUnion: training.dataset.sourceUnion } : {}) };
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
        const referenceContract = { ...verifyTeacherSourceCompatibility(dev.teachers.original.manifest.provenance, training.manifest.provenance, training.manifest.config.sourceTransition), reference: dev.teachers.sourceReference };
        equal(binding.referenceContract, referenceContract, 'External latest reference binding');
        let externalProducerReplay = null;
        if (constrainedPolicy(training.policyMode)) {
            const proof = read(join(evaluationDirectory, 'producer-replay/proof.json'));
            equal(binding.producerReplayProofHash, digest(proof), 'External independent replay hash');
            externalProducerReplay = authenticateProducerReplay(root, join(evaluationDirectory, 'producer-replay'), proof, dev.sources, training.manifest.provenance, devDirectory, training.manifest.config.sourceTransition);
            if (training.manifest.config.sourceTransition === ALIGNED_SOURCE_TRANSITION) verifyPreparedFeatureBinding(training.manifest, training.dataset, proof);
            else equal(proof.featureManifestHash, training.dataset.featureManifestHash, 'External original/current feature manifest');
            report.authentication.commitments.externalProducerReplay = omitReplayRecords(externalProducerReplay);
        } else requireThat(!binding.producerReplayProofHash, 'Unexpected external policy transition proof');
        requireThat(sha(binding.decodeBundleHash) && Object.keys(binding.sourceHashes ?? {}).length > 0, 'Missing external frozen decode provenance');
        equal(binding.decodeBundleHash, digest(readFileSync(join(evaluationDirectory, 'decode-worker.mjs'))), 'External decode bundle');
        for (const [path, hash] of Object.entries(binding.sourceHashes)) {
            requireThat(sha(hash), 'Invalid external source hash');
            equal(hash, digest(readFileSync(safeChild(root, path))), 'External source file: ' + path);
        }
        for (const [path, hash] of Object.entries(training.manifest.provenance.sourceHashes)) equal(hash, digest(readFileSync(safeChild(root, path))), 'Current frozen TRAIN inference source: ' + path);
        const checkpoint = authenticateCheckpoint(training, evaluationDirectory, binding, runtime, checkpointArchive);
        Object.assign(report.authentication.commitments, { evaluationBindingHash: digest(binding), modelHash: binding.modelHash, checkpoint });
        const transitionRecord = trainingLineage.find(r => r.featureMigration || r.policyTransition), transition = transitionRecord?.featureMigration ?? transitionRecord?.policyTransition;
        if (transition) {
            requireThat(binding.cursor.updates >= transition.parentUpdates, 'Policy-transition cumulative update counter regressed');
            report.learningEvidence = { policyMode: training.policyMode, ...(transitionRecord.featureMigration ? { featureMigration: transitionRecord.featureMigration.id, initializationProofHash: transitionRecord.featureMigration.receiptHash } : {}), inheritedTrainingUpdates: transition.parentUpdates, evaluatedCumulativeUpdates: binding.cursor.updates, newUpdatesSincePolicyTransition: binding.cursor.updates - transition.parentUpdates,
                limitation: 'A zero-update policy fork is not new learning. Comparisons against an earlier differently weighted checkpoint cannot isolate a policy-only income effect.' };
        }
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
            const decodeJob = reconstructExternalDecodeJob({ trainingManifest: training.manifest, trainingDataset: training.dataset, referenceContract, producerReplay: externalProducerReplay?.proof, record, source, evaluationDirectory, modelHash: binding.modelHash });
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
        const manifest = { objective: { version: objectiveVersionForPolicy(training.policyMode), ...referenceBinding }, mode: 'development', scope: report.scope,
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
