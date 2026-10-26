import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './state.mjs';
import { sourceContracts } from '../full-train.mjs';
const api = await import('./parity-report.mjs').catch(error => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error));
const binding = { modelHash: 'a'.repeat(64), timeoutMs: 120000 };
const input = { options: { simulationWarmupHours: 24, simulationSampleHours: 72, productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 }, droneTarget: 'gold' }, entries: [] };
const job = { mode: 'evaluate', input, workspace: { exact: true }, seed: 42, maxStepHours: .25 };
function fixture() {
    const summary = { exp: 10, goldValue: 20, virtualGoldValue: 0, orderLmd: 30, fragments: 0, orundum: 0, totalScore82: 32, scoreBreakdown: { exp: 10, goldValue: 20, orderValue: 30, weightedExp: 10, weightedGold: 16, weightedOrders: 6, weightedFragments: 0, weightedOrundum: 0, total: 32 } };
    const settings = { warmupHours: 24, sampleHours: 72, maxStepHours: .25, productionWeights: input.options.productionWeights, operatorInventory: [], production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'gold', seed: 42 } };
    return { binding, jobHash: digest(job), baselineReuse: { reused: false }, outcome: { status: 'completed', durationMs: 1, result: { completed: true, score: 32, fallbackPhysicalPlacements: 0, settings, result: { completed: true, simScore: 32, diagnostics: [], calculationReport: { summary } } } } };
}
test('authenticator API is present', () => assert.equal(typeof api.verifySimulationArtifact, 'function'));
test('a raw paired simulation supplies score and unweighted daily production', () => {
    const actual = api.verifySimulationArtifact(fixture(), { binding, job });
    assert.equal(actual.score, 32);
    assert.deepEqual(actual.rawDaily, { exp: 10, gold: 20, orders: 30, fragments: 0, orundum: 0 });
});
for (const [label, mutate] of [
    ['changed model binding', a => { a.binding = { ...binding, modelHash: 'b'.repeat(64) }; }],
    ['changed job', a => { a.jobHash = digest({ ...job, seed: 43 }); }],
    ['changed resolved simulator seed', a => { a.outcome.result.settings.production.seed++; }],
    ['changed simulation step', a => { a.outcome.result.settings.maxStepHours = .125; }],
    ['changed production weights', a => { a.outcome.result.settings.productionWeights = { ...input.options.productionWeights, gold: 1 }; }],
    ['summary-only score', a => { delete a.outcome.result.result; }],
    ['conflicting raw simulation score', a => { a.outcome.result.result.simScore++; }],
    ['conflicting production report', a => { a.outcome.result.result.calculationReport.summary.totalScore82++; }],
    ['unknown daily production', a => { delete a.outcome.result.result.calculationReport.summary.fragments; }],
    ['negative daily production', a => { a.outcome.result.result.calculationReport.summary.exp = -10; }],
    ['invalid weighted component', a => { a.outcome.result.result.calculationReport.summary.scoreBreakdown.weightedExp = -10; }],
    ['inconsistent weighted sum', a => { a.outcome.result.result.calculationReport.summary.scoreBreakdown.weightedGold++; }],
    ['fallback repair', a => { a.outcome.result.fallbackPhysicalPlacements = 1; }],
    ['unvalidated cache provenance', a => { a.baselineReuse = { sourceArtifactPath: '/tmp/forged', proof: {} }; }],
]) test('rejects ' + label, () => { const a = fixture(); mutate(a); assert.throws(() => api.verifySimulationArtifact(a, { binding, job })); });
test('failed workers never yield a score even when stale finite values remain', () => {
    for (const status of ['timeout', 'worker-error', 'cancelled']) { const a = fixture(); a.outcome.status = status; assert.equal(api.verifySimulationArtifact(a, { binding, job }).score, null); }
});
test('pure runtime does not permit model metadata to shadow dimensions or feature identity', async () => {
    const { createRequire } = await import('node:module'), { mkdtempSync, rmSync } = await import('node:fs'), { join } = await import('node:path'), { tmpdir } = await import('node:os'), { execFileSync } = await import('node:child_process');
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), directory = mkdtempSync(join(tmpdir(), 'parity-report-contract-'));
    try {
        const path = join(directory, 'contracts.mjs');
        await build({ entryPoints: ['scripts/neural/full-training/parity-report-contract-tests.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: path, logLevel: 'silent' });
        assert.match(execFileSync(process.execPath, [path], { encoding: 'utf8', timeout: 10000 }), /pure report contracts passed/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('incomplete real simulation never becomes a zero score', () => { const a = fixture(); a.outcome.result.completed = false; a.outcome.result.result.completed = false; assert.equal(api.verifySimulationArtifact(a, { binding, job }).score, null); });
test('frozen provenance authenticates every source, aggregate and bundle', () => {
    const snapshot = { 'src/physics.ts': 'physics source' }, bundle = Buffer.from('frozen bundle'), sourceHashes = { 'src/physics.ts': digest(snapshot['src/physics.ts']) };
    const provenance = { sourceHashes, sourceHash: digest(sourceHashes), bundleHash: digest(bundle) };
    assert.doesNotThrow(() => api.verifyFrozenProvenance(provenance, snapshot, bundle));
    assert.throws(() => api.verifyFrozenProvenance(provenance, { ...snapshot, 'src/physics.ts': 'tampered' }, bundle));
    assert.throws(() => api.verifyFrozenProvenance(provenance, snapshot, Buffer.from('tampered')));
    assert.throws(() => api.verifyFrozenProvenance({ ...provenance, sourceHash: '0'.repeat(64) }, snapshot, bundle));
});
test('arbitrary summary fields are not an input to authentication', () => { const a = fixture(); a.summary = { score: 1e20 }; assert.equal(api.verifySimulationArtifact(a, { binding, job }).score, 32); });
test('committed result hash detects an internally consistent forged simulation score', () => { const a = fixture(), hash = digest(a); a.outcome.result.score++; a.outcome.result.result.simScore++; a.outcome.result.result.calculationReport.summary.totalScore82++; a.outcome.result.result.calculationReport.summary.scoreBreakdown.total++; assert.throws(() => api.verifySimulationArtifact(a, { binding, job, artifactHash: hash }), /commitment/); });
test('decode authentication rejects changed inputs, model, unsupported reference and fallback', () => {
    const decodeJob = { input: { familyId: 'dev1' }, modelHash: binding.modelHash }, protocol = { id: 'latest' };
    const a = { binding, jobHash: digest(decodeJob), outcome: { status: 'completed', result: { familyId: 'dev1', modelHash: binding.modelHash, referenceProtocol: protocol, complete: true, workspace: {}, fallbackPhysicalPlacements: 0, generationElapsedMs: 3, qualification: { qualified: true, reasons: [] } } } };
    assert.equal(api.verifyDecodeArtifact(a, { binding, job: decodeJob, protocol }).available, true);
    for (const mutate of [x => x.jobHash = 'changed', x => x.outcome.result.modelHash = 'changed', x => x.outcome.result.referenceProtocol = {}, x => x.outcome.result.fallbackPhysicalPlacements = 1, x => x.outcome.result.qualification.qualified = false]) { const b = structuredClone(a); mutate(b); assert.throws(() => api.verifyDecodeArtifact(b, { binding, job: decodeJob, protocol })); }
});
test('baseline-only reuse links must reproduce a separately verified proof and exact fresh raw outcome', () => {
    const sourceArtifact = { job, outcome: fixture().outcome }, sourcePath = '/root/cache/family-baseline.json', proof = { artifactHash: digest(sourceArtifact), reusedSide: 'baseline-only' };
    const artifact = { ...fixture(), baselineReuse: { sourceArtifactPath: sourcePath, proof } };
    const parameters = { side: 'baseline', artifact, sourceArtifact, sourcePath, verifiedProof: proof };
    assert.doesNotThrow(() => api.verifyBaselineReuseLink(parameters));
    assert.throws(() => api.verifyBaselineReuseLink({ ...parameters, side: 'neural' }));
    assert.throws(() => api.verifyBaselineReuseLink({ ...parameters, verifiedProof: { ...proof, artifactHash: 'forged' } }));
    assert.throws(() => api.verifyBaselineReuseLink({ ...parameters, sourceArtifact: { ...sourceArtifact, outcome: { status: 'completed', score: 1e30 } } }));
    assert.throws(() => api.verifyBaselineReuseLink({ ...parameters, sourceArtifact: { ...sourceArtifact, baselineReuse: { sourceArtifactPath: sourcePath, proof } } }));
});
test('teacher selection retains failed history but selects only exact committed successful attempt', () => {
    const failed = { input: { familyId: 'f' }, resultHash: 'failed', attempt: 1 }, successful = { input: { familyId: 'f' }, resultHash: 'success', attempt: 2 };
    assert.equal(api.selectTeacherRecord([failed, successful], { familyId: 'f', teacherRecordHash: 'success' }), successful);
    assert.throws(() => api.selectTeacherRecord([failed], { familyId: 'f', teacherRecordHash: 'success' }));
    assert.throws(() => api.selectTeacherRecord([successful, successful], { familyId: 'f', teacherRecordHash: 'success' }));
});
test('declared DEV cohort denominator retains unqualified and missing teacher families', () => {
    const cases = [{ familyId: 'dev1' }, { familyId: 'dev2' }], records = [{ familyId: 'dev1', qualified: true }];
    const cohort = api.declaredCohort(cases, records);
    assert.equal(cohort.length, 2); assert.equal(cohort[0].record, records[0]); assert.equal(cohort[1].record, null);
    assert.throws(() => api.declaredCohort(cases, [{ familyId: 'outside' }]));
    assert.throws(() => api.declaredCohort([...cases, cases[0]], records));
});
test('unknown hardware/common budget keeps authenticated quality values but parity stays inconclusive', () => {
    const rows = [{ caseId: 'a', baselineScore: 10, neuralScore: 11, baselineRawDaily: {}, neuralRawDaily: {}, issues: [], delta: null, ratio: null }];
    const gate = { status: 'fail', issues: ['INVALID_EXPECTED_CASE'], pairs: [{ caseId: 'a', issues: ['BASELINE_GENERATION_BUDGET_OR_SOURCE_INVALID', 'NEURAL_GENERATION_BUDGET_OR_SOURCE_INVALID'], preferenceComparison: 0, efficiencyComparison: 0 }] };
    const concluded = api.concludeOutputQuality(gate, rows);
    assert.equal(concluded.status, 'inconclusive'); assert.equal(rows[0].status, 'pass'); assert.equal(rows[0].delta, 1); assert.equal(rows[0].neuralScore, 11);
    gate.pairs[0].issues.push('NEURAL_LATEST_UNSUPPORTED_POLICY_REFERENCE:resting_priority');
    assert.equal(api.concludeOutputQuality(gate, rows).status, 'fail'); assert.equal(rows[0].neuralScore, null); assert.equal(rows[0].delta, null);
});
test('tiny authenticated regression remains failure; missing rows stay null and inconclusive', () => {
    const rows = [{ caseId: 'a', baselineScore: 10, neuralScore: 10 - 1e-10, issues: [] }, { caseId: 'b', baselineScore: null, neuralScore: null, issues: ['FULL_REFERENCE_NOT_QUALIFIED'] }];
    const gate = { pairs: [{ caseId: 'a', issues: ['SCORE_REGRESSION'], preferenceComparison: 0, efficiencyComparison: 0 }, { caseId: 'b', issues: ['BASELINE_UNAVAILABLE', 'NEURAL_UNAVAILABLE'], preferenceComparison: null, efficiencyComparison: null }] };
    assert.equal(api.concludeOutputQuality(gate, rows).status, 'fail'); assert.equal(rows[0].status, 'fail'); assert.equal(rows[1].status, 'inconclusive'); assert.equal(rows[1].delta, null);
});
test('missing required policy on a completed workspace is a real failure, not missing evidence', () => {
    const rows = [{ caseId: 'a', baselineScore: 10, neuralScore: 9, issues: [] }], gate = { pairs: [{ caseId: 'a', issues: ['NEURAL_LATEST_WARMUP_POLICY_MISSING', 'SCORE_REGRESSION'], preferenceComparison: 0, efficiencyComparison: 0 }] };
    assert.equal(api.concludeOutputQuality(gate, rows).status, 'fail'); assert.equal(rows[0].status, 'fail'); assert.equal(rows[0].neuralScore, null);
});
test('declared TRAIN/DEV source must bind the exact authenticated primary teacher without linked populations', () => {
    const teacher = { config: { run: 'full-reference' }, provenance: { sourceHash: 'a', bundleHash: 'b' } }, compatibility = { policy: 'none', drifts: [], legacyProofRequired: false, reason: 'Exact shared-source bytes required' };
    const sources = { teacherManifest: teacher, sourceCompatibility: compatibility, records: [] }, manifest = { config: { source: 'full-reference' }, sourceContracts: sourceContracts(sources) };
    assert.doesNotThrow(() => api.verifyPrimarySourceDeclaration(manifest, sources));
    for (const mutate of [m => m.config.source = 'other', m => m.sourceContracts.primary.manifestHash = 'other', m => m.sourceContracts.linked.push({ run: 'unreviewed' })]) { const m = structuredClone(manifest); mutate(m); assert.throws(() => api.verifyPrimarySourceDeclaration(m, sources)); }
    assert.throws(() => api.verifyPrimarySourceDeclaration(manifest, { ...sources, linkedSourceManifests: [teacher] }));
    assert.throws(() => api.verifyPrimarySourceDeclaration(manifest, { ...sources, additionalSourceManifests: [teacher] }));
});
test('baseline-only root cannot shed origin to bypass its committed producer receipt', () => {
    const origin = { mode: 'baseline-only-no-neural-inference', orchestratorHash: 'o', devManifestHash: 'm', devDatasetHash: 'd', timeoutMs: 600000 };
    const raw = { binding: { referenceContract: { id: 'latest' } }, origin }, rawJob = { input: { familyId: 'f' }, seed: 42, maxStepHours: .25 };
    const manifest = { origin, referenceContract: raw.binding.referenceContract }, receipt = { ...manifest, reports: [{ familyId: 'f', seed: 42, maxStepHours: .25, artifactHash: digest(raw) }] };
    const options = { artifact: raw, job: rawJob, baselineOnlyManifest: manifest, receipt, orchestratorHash: 'o', cacheManifestHash: 'm', cacheDatasetHash: 'd' };
    assert.doesNotThrow(() => api.verifyCacheRootReceipt(options));
    const withoutOrigin = structuredClone(raw); delete withoutOrigin.origin;
    assert.throws(() => api.verifyCacheRootReceipt({ ...options, artifact: withoutOrigin }));
    assert.throws(() => api.verifyCacheRootReceipt({ ...options, receipt: { ...receipt, reports: [] } }));
    assert.throws(() => api.verifyCacheRootReceipt({ ...options, orchestratorHash: 'changed' }));
});
test('only exact same-data TRAIN parameter fork with explicit chunk change authenticates', () => {
    const bytes = Buffer.from('synthetic frozen parameters'), dataset = { featureManifestHash: 'feature' }, config = { purpose: 'train', source: 'teacher', chunkSize: 128, hiddenSize: 64, seed: 43, learningRate: .01, optimizer: 'common-l2-sgd-v1', teacherKind: 'full-optimizer', constructionOrder: 'staffing-first-v1', inputProfile: 'actual-mixture-v1' };
    const parentManifest = { config, provenance: { sourceHash: 'source', bundleHash: 'bundle' }, lineage: { spec: { mode: 'fresh' } } }, childManifest = { ...parentManifest, config: { ...config, chunkSize: 512 } };
    const state = { modelHash: digest(bytes), cursor: { epoch: 10, family: 0, action: 0, updates: 26210 }, binding: { datasetHash: digest(dataset), sourceHash: 'source', bundleHash: 'bundle', featureManifestHash: 'feature', ...config, lineageHash: digest(parentManifest.lineage) } };
    const lineage = { spec: { mode: 'fork', parentRun: 'parent' }, initialModelHash: digest(bytes), parent: { run: 'parent', manifestHash: digest(parentManifest), modelHash: digest(bytes), sourceHash: 'source', bundleHash: 'bundle', datasetHash: digest(dataset), featureManifestHash: 'feature', purpose: 'train', optimizer: config.optimizer, teacherKind: config.teacherKind, constructionOrder: config.constructionOrder, inputProfile: config.inputProfile, cursor: state.cursor, generation: 'checkpoint-26210-123-1' } };
    const options = { lineage, childManifest, childDataset: dataset, parentManifest, parentDataset: dataset, parentState: state, initialBytes: bytes, parentBytes: bytes };
    assert.doesNotThrow(() => api.verifyTrainForkLink(options));
    const commits = structuredClone(options); commits.parentManifest.provenance = { ...commits.parentManifest.provenance, gitCommit: 'documentation-only-old' }; commits.childManifest.provenance = { ...commits.childManifest.provenance, gitCommit: 'documentation-only-new' }; commits.lineage.parent.manifestHash = digest(commits.parentManifest);
    assert.doesNotThrow(() => api.verifyTrainForkLink(commits));
    for (const mutate of [o => o.parentManifest.config.purpose = 'dev-overfit', o => o.childManifest.config.learningRate = .02, o => o.parentDataset.extra = 'changed', o => o.parentState.cursor.action = 1, o => o.lineage.parent.modelHash = 'changed']) { const o = structuredClone(options); mutate(o); assert.throws(() => api.verifyTrainForkLink(o)); }
    assert.throws(() => api.verifyTrainForkLink({ ...options, initialBytes: Buffer.from('other model') }));
});
test('latest policy is bound across config, dataset, records and the explicit replay transition', () => {
    const manifest = { config: { policyMode: 'latest-warmup-exhaustion-v1', sourceTransition: 'latest-default-to-warmup-policy-v1', constructionOrder: 'staffing-first-v1', teacherKind: 'full-optimizer', producerReplayRun: 'original' } }, proof = { records: [{ familyId: 'a' }, { familyId: 'b' }] };
    const dataset = { schemaVersion: 5, policyMode: manifest.config.policyMode, producerReplayProofHash: digest(proof), records: ['a', 'b'].map(familyId => ({ familyId, policyMode: manifest.config.policyMode })) }, sources = { producerReplay: proof };
    assert.equal(api.verifyPolicyContract(manifest, dataset, sources), manifest.config.policyMode);
    for (const mutate of [x => x.manifest.config.sourceTransition = 'none', x => x.dataset.policyMode = 'legacy-unconstrained-v1', x => x.dataset.records[0].policyMode = 'unknown', x => x.sources.producerReplay = null, x => x.dataset.records.pop()]) { const x = structuredClone({ manifest, dataset, sources }); mutate(x); assert.throws(() => api.verifyPolicyContract(x.manifest, x.dataset, x.sources)); }
});
function replayEvidence() {
    const input = { familyId: 'family', split: 'train' }, teacherOutcome = { original: true }, record = { familyId: 'family', input, teacherRecordHash: digest(teacherOutcome), actionIds: ['original-a'], teacherSemanticHash: 'same-native-workspace', constructionOrder: 'staffing-first-v1' };
    const producerSources = { purpose: 'train', teacherManifest: { original: true }, records: [{ input, outcome: teacherOutcome }], pending: [] }, producerSnapshot = { 'src/frozen.ts': 'original source' }, producerBundle = Buffer.from('original immutable worker'), sourceHashes = { 'src/frozen.ts': digest('original source') };
    const producerManifest = { config: { purpose: 'train', teacherKind: 'full-optimizer', sourceTransition: 'none', constructionOrder: 'staffing-first-v1', inputProfile: 'actual-mixture-v1' }, provenance: { sourceHashes, sourceHash: digest(sourceHashes), bundleHash: digest(producerBundle) } };
    const producerDataset = { purpose: 'train', featureManifestHash: 'same-feature', constructionOrder: 'staffing-first-v1', sourceRecordsHash: digest(producerSources), records: [record] }, producerPreparation = { status: 'completed', result: { status: 'dataset-ready', datasetHash: digest(producerDataset) } };
    const job = { mode: 'prepare', directory: '/synthetic-proof', purpose: 'train', teacherKind: 'full-optimizer', constructionOrder: 'staffing-first-v1', inputProfile: 'actual-mixture-v1', sourceTransition: 'none' }, outcome = { status: 'completed', exitCode: 0, result: producerPreparation.result };
    const proof = { schemaVersion: 1, kind: 'frozen-full-reference-replay-v1', mode: 'prepare-only-zero-training-zero-simulation', producerDirectory: '/synthetic-original', producerManifestHash: digest(producerManifest), producerSourceHash: producerManifest.provenance.sourceHash, producerBundleHash: producerManifest.provenance.bundleHash, teacherManifestHash: digest(producerSources.teacherManifest), sourceRecordsHash: digest(producerSources), archivedDatasetHash: digest(producerDataset), replayedDatasetHash: digest(producerDataset), featureManifestHash: producerDataset.featureManifestHash, constructionOrder: 'staffing-first-v1', policyMode: 'legacy-unconstrained-v1', preparationJobHash: digest(job), preparationOutcomeHash: digest(outcome), records: [{ familyId: 'family', inputHash: digest(input), teacherRecordHash: record.teacherRecordHash, actionIds: record.actionIds, teacherSemanticHash: record.teacherSemanticHash, constructionOrder: 'staffing-first-v1', policyMode: 'legacy-unconstrained-v1' }] };
    return { proof, producerManifest, producerSnapshot, producerBundle, producerSources, producerDataset, producerPreparation, job, outcome, replayedDataset: structuredClone(producerDataset), sources: structuredClone(producerSources), expectedProducerDirectory: '/synthetic-original' };
}
test('independent producer replay authenticates actual old worker, datasets, job, outcome and full original action IDs', () => {
    assert.doesNotThrow(() => api.verifyProducerReplayEvidence(replayEvidence()));
    for (const mutate of [x => x.producerBundle = Buffer.from('substitute'), x => x.producerSnapshot['src/frozen.ts'] = 'changed', x => x.proof.records[0].actionIds.push('forged'), x => x.job.mode = 'train', x => x.outcome.status = 'timeout', x => x.replayedDataset.records[0].teacherSemanticHash = 'changed', x => x.producerManifest.config.purpose = 'dev-overfit', x => x.sources.records[0].input.split = 'dev', x => x.proof.featureManifestHash = 'other']) { const x = structuredClone(replayEvidence()); mutate(x); assert.throws(() => api.verifyProducerReplayEvidence(x)); }
});
test('new-policy fork may preserve TRAIN weights only through the fully bound old dataset and semantics', () => {
    const e = replayEvidence(), bytes = Buffer.from('unchanged TRAIN model'), config = e.producerManifest.config, parentManifest = e.producerManifest, parentDataset = e.producerDataset;
    const parentState = { modelHash: digest(bytes), cursor: { epoch: 30, family: 0, action: 0, updates: 78630 }, binding: { datasetHash: digest(parentDataset), sourceHash: parentManifest.provenance.sourceHash, bundleHash: parentManifest.provenance.bundleHash, featureManifestHash: parentDataset.featureManifestHash, ...config } };
    const partial = { producerReplayProofHash: digest(e.proof), producerActionIdsHash: digest(parentDataset.records[0].actionIds), producerSemanticHash: parentDataset.records[0].teacherSemanticHash };
    const childManifest = { config: { ...config, policyMode: 'latest-warmup-exhaustion-v1', sourceTransition: 'latest-default-to-warmup-policy-v1', producerReplayRun: 'original' }, provenance: { ...parentManifest.provenance, bundleHash: 'new-policy-wrapper' } }, childDataset = { ...parentDataset, schemaVersion: 5, policyMode: 'latest-warmup-exhaustion-v1', producerReplayProofHash: digest(e.proof), sourceRecordsHash: 'new-bound-sources', records: parentDataset.records.map(r => ({ ...r, policyMode: 'latest-warmup-exhaustion-v1', actionIds: ['new-legal-action'], producerReplay: partial })) };
    const lineage = { spec: { mode: 'fork', parentRun: 'parent' }, initialModelHash: digest(bytes), parent: { run: 'parent', manifestHash: digest(parentManifest), modelHash: digest(bytes), sourceHash: parentState.binding.sourceHash, bundleHash: parentState.binding.bundleHash, datasetHash: digest(parentDataset), featureManifestHash: parentDataset.featureManifestHash, purpose: 'train', optimizer: 'sgd-v1', teacherKind: 'full-optimizer', constructionOrder: 'staffing-first-v1', inputProfile: 'actual-mixture-v1', cursor: parentState.cursor, generation: 'checkpoint-78630-123-1' } };
    const options = { lineage, childManifest, childDataset, parentManifest, parentDataset, parentState, initialBytes: bytes, parentBytes: bytes, producerReplay: { proof: e.proof, proofHash: digest(e.proof) } };
    assert.doesNotThrow(() => api.verifyTrainForkLink(options));
    const v2 = structuredClone(options); v2.childManifest.config.policyMode = v2.childDataset.policyMode = v2.childDataset.records[0].policyMode = 'latest-warmup-runorder-v2'; v2.childManifest.config.sourceTransition = 'latest-default-to-warmup-runorder-v2';
    assert.doesNotThrow(() => api.verifyTrainForkLink(v2));
    for (const mutate of [x => x.producerReplay = null, x => x.childDataset.records[0].teacherSemanticHash = 'changed', x => x.childManifest.provenance.sourceHashes = {}, x => x.childManifest.config.teacherKind = 'auxiliary', x => x.producerReplay.proofHash = 'changed']) { const x = structuredClone(options); mutate(x); assert.throws(() => api.verifyTrainForkLink(x)); }
});
test('new-policy external decode binds explicit mode and independent original replay partial proof', () => {
    const e = replayEvidence(), job = { input: e.producerDataset.records[0].input, outcome: e.sources.records[0].outcome, modelHash: binding.modelHash, policyMode: 'latest-warmup-exhaustion-v1', producerReplayProof: e.proof, archivedTeacherTrace: { policyMode: 'legacy-unconstrained-v1', actionIds: e.proof.records[0].actionIds, teacherSemanticHash: e.proof.records[0].teacherSemanticHash } }, protocol = { id: 'latest' };
    const b = { ...binding, producerReplayProofHash: digest(e.proof) }, partial = { producerReplayProofHash: digest(e.proof), producerActionIdsHash: digest(e.proof.records[0].actionIds), producerSemanticHash: e.proof.records[0].teacherSemanticHash };
    const artifact = { binding: b, jobHash: digest(job), outcome: { status: 'completed', result: { familyId: job.input.familyId, modelHash: b.modelHash, policyMode: job.policyMode, producerReplay: partial, referenceProtocol: protocol, complete: true, workspace: {}, fallbackPhysicalPlacements: 0, generationElapsedMs: 1, qualification: { qualified: true, reasons: [] } } } };
    assert.equal(api.verifyDecodeArtifact(artifact, { binding: b, job, protocol }).available, true);
    const v2job = { ...job, policyMode: 'latest-warmup-runorder-v2' }, v2artifact = structuredClone(artifact); v2artifact.jobHash = digest(v2job); v2artifact.outcome.result.policyMode = v2job.policyMode;
    assert.equal(api.verifyDecodeArtifact(v2artifact, { binding: b, job: v2job, protocol }).available, true);
    const unknownJob = { ...job, policyMode: 'future-mode' }, unknownArtifact = structuredClone(artifact); unknownArtifact.jobHash = digest(unknownJob); unknownArtifact.outcome.result.policyMode = unknownJob.policyMode; delete unknownJob.producerReplayProof; delete unknownArtifact.outcome.result.producerReplay; const unknownBinding = { ...b }; delete unknownBinding.producerReplayProofHash; unknownArtifact.binding = unknownBinding; unknownArtifact.jobHash = digest(unknownJob);
    assert.throws(() => api.verifyDecodeArtifact(unknownArtifact, { binding: unknownBinding, job: unknownJob, protocol }));
    for (const mutate of [a => a.outcome.result.policyMode = 'legacy-unconstrained-v1', a => delete a.outcome.result.producerReplay, a => a.outcome.result.producerReplay.producerSemanticHash = 'other']) { const a = structuredClone(artifact); mutate(a); assert.throws(() => api.verifyDecodeArtifact(a, { binding: b, job, protocol })); }
});
test('explicit runtime-admission mode selects only V3 while prior modes retain V2', () => {
    assert.equal(api.objectiveVersionForPolicy(undefined), 'latest-default-lexicographic-v2');
    assert.equal(api.objectiveVersionForPolicy('latest-warmup-exhaustion-v1'), 'latest-default-lexicographic-v2');
    assert.equal(api.objectiveVersionForPolicy('latest-warmup-runorder-v2'), 'latest-default-runtime-lexicographic-v3');
    assert.throws(() => api.objectiveVersionForPolicy('future-mode'));
    const manifest = { config: { policyMode: 'latest-warmup-runorder-v2', sourceTransition: 'latest-default-to-warmup-runorder-v2', constructionOrder: 'staffing-first-v1', teacherKind: 'full-optimizer', producerReplayRun: 'original' } }, proof = { records: [{ familyId: 'a' }] };
    const dataset = { schemaVersion: 5, policyMode: manifest.config.policyMode, producerReplayProofHash: digest(proof), records: [{ familyId: 'a', policyMode: manifest.config.policyMode }] }, sources = { producerReplay: proof };
    assert.equal(api.verifyPolicyContract(manifest, dataset, sources), manifest.config.policyMode);
    for (const transition of ['none', 'latest-default-to-warmup-policy-v1']) assert.throws(() => api.verifyPolicyContract({ config: { ...manifest.config, sourceTransition: transition } }, dataset, sources));
});
function policyToRuntimeFork() {
    const e = replayEvidence(), bytes = Buffer.from('unchanged trained v1 parameters');
    const parentMode = 'latest-warmup-exhaustion-v1', childMode = 'latest-warmup-runorder-v2', parentProof = e.proof, childProof = { ...e.proof, preparationOutcomeHash: digest({ independent: 'new-execution' }), preparationJobHash: digest({ directory: 'new-proof' }) };
    const partial = proof => ({ producerReplayProofHash: digest(proof), producerActionIdsHash: digest(proof.records[0].actionIds), producerSemanticHash: proof.records[0].teacherSemanticHash });
    const parentManifest = { ...e.producerManifest, config: { ...e.producerManifest.config, policyMode: parentMode, sourceTransition: 'latest-default-to-warmup-policy-v1', producerReplayRun: 'original' } };
    const childManifest = { ...parentManifest, config: { ...parentManifest.config, policyMode: childMode, sourceTransition: 'latest-default-to-warmup-runorder-v2' } };
    const dataset = (mode, proof) => ({ ...e.producerDataset, schemaVersion: 5, policyMode: mode, producerReplayProofHash: digest(proof), sourceRecordsHash: mode, records: e.producerDataset.records.map(r => ({ ...r, policyMode: mode, actionIds: [mode + '-action'], producerReplay: partial(proof) })) });
    const parentDataset = dataset(parentMode, parentProof), childDataset = dataset(childMode, childProof);
    const parentState = { modelHash: digest(bytes), cursor: { epoch: 5, family: 0, action: 0, updates: 91735 }, binding: { datasetHash: digest(parentDataset), sourceHash: parentManifest.provenance.sourceHash, bundleHash: parentManifest.provenance.bundleHash, featureManifestHash: parentDataset.featureManifestHash, ...parentManifest.config } };
    const lineage = { spec: { mode: 'fork', parentRun: 'parent' }, initialModelHash: digest(bytes), parent: { run: 'parent', manifestHash: digest(parentManifest), modelHash: digest(bytes), sourceHash: parentState.binding.sourceHash, bundleHash: parentState.binding.bundleHash, datasetHash: digest(parentDataset), featureManifestHash: parentDataset.featureManifestHash, purpose: 'train', optimizer: 'sgd-v1', teacherKind: 'full-optimizer', constructionOrder: 'staffing-first-v1', inputProfile: 'actual-mixture-v1', cursor: parentState.cursor, generation: 'checkpoint-91735-123-1' } };
    return { lineage, childManifest, childDataset, parentManifest, parentDataset, parentState, initialBytes: bytes, parentBytes: bytes, producerReplay: { proof: childProof, proofHash: digest(childProof) }, parentProducerReplay: { proof: parentProof, proofHash: digest(parentProof) } };
}
test('V1 to V2 exact-parameter fork compares both authenticated original producer populations, not transformed datasets', () => {
    const options = policyToRuntimeFork();
    assert.notEqual(options.producerReplay.proof.archivedDatasetHash, digest(options.parentDataset));
    assert.notEqual(options.producerReplay.proofHash, options.parentProducerReplay.proofHash);
    assert.doesNotThrow(() => api.verifyTrainForkLink(options));
    for (const mutate of [x => x.parentProducerReplay = null, x => x.childManifest.config.sourceTransition = 'latest-default-to-warmup-policy-v1', x => x.childManifest.config.learningRate = .1, x => x.parentProducerReplay.proof.records[0].actionIds.push('changed'), x => x.childDataset.records[0].producerReplay.producerActionIdsHash = 'changed', x => x.parentDataset.records[0].producerReplay.producerSemanticHash = 'changed', x => x.childDataset.featureManifestHash = 'other-feature', x => x.initialBytes = Buffer.from('transformed-parameters')]) { const x = structuredClone(options); mutate(x); assert.throws(() => api.verifyTrainForkLink(x)); }
    const mismatched = structuredClone(options); mismatched.producerReplay.proof.records[0].actionIds.push('different-original'); mismatched.producerReplay.proofHash = digest(mismatched.producerReplay.proof);
    assert.throws(() => api.verifyTrainForkLink(mismatched));
});
test('aligned feature policy requires its explicit schema, immutable migration declaration and both feature identities', async () => {
    const { FEATURE_MIGRATION_ID, FEATURE_MIGRATION_CONTRACT: contract, ALIGNED_SOURCE_TRANSITION } = await import('./feature-migration-contract.mjs');
    const manifest = { config: { policyMode: 'latest-warmup-runorder-v2', sourceTransition: ALIGNED_SOURCE_TRANSITION, featureMigration: FEATURE_MIGRATION_ID, constructionOrder: 'staffing-first-v1', teacherKind: 'full-optimizer', producerReplayRun: 'original' } }, proof = { featureManifestHash: contract.oldHash, records: [{ familyId: 'a' }] }, sources = { producerReplay: proof };
    const dataset = { schemaVersion: 6, featureMigration: contract, featureManifestHash: contract.newHash, policyMode: manifest.config.policyMode, producerReplayProofHash: digest(proof), records: [{ familyId: 'a', policyMode: manifest.config.policyMode }] };
    assert.equal(api.verifyPolicyContract(manifest, dataset, sources), manifest.config.policyMode);
    for (const mutate of [x => delete x.manifest.config.featureMigration, x => x.dataset.schemaVersion = 5, x => x.dataset.featureManifestHash = contract.oldHash, x => x.sources.producerReplay.featureManifestHash = contract.newHash, x => x.dataset.featureMigration = { ...contract, newCount: 1 }, x => x.manifest.config.sourceTransition = 'latest-default-to-warmup-runorder-v2']) { const x = structuredClone({ manifest, dataset, sources }); mutate(x); assert.throws(() => api.verifyPolicyContract(x.manifest, x.dataset, x.sources)); }
});
test('composed aligned external decode reconstructs the exact producer featureMigration job field and historical absence', async () => {
    const { FEATURE_MIGRATION_ID: id, FEATURE_MIGRATION_CONTRACT: contract, ALIGNED_SOURCE_TRANSITION: transition } = await import('./feature-migration-contract.mjs'), e = replayEvidence();
    const manifest = { config: { policyMode: 'latest-warmup-runorder-v2', constructionOrder: 'staffing-first-v1', featureMigration: id } }, dataset = { records: [{ input: { split: 'train' } }] }, record = e.producerDataset.records[0], source = e.sources.records[0], referenceContract = { policy: transition, featureMigration: contract, reference: { referenceProtocol: { id: 'latest' } } };
    const options = { trainingManifest: manifest, trainingDataset: dataset, referenceContract, producerReplay: e.proof, record, source, evaluationDirectory: '/frozen/eval', modelHash: binding.modelHash };
    const expected = { referenceContract, producerReplayProof: e.proof, featureMigration: id, policyMode: manifest.config.policyMode, archivedTeacherTrace: { policyMode: 'legacy-unconstrained-v1', constructionOrder: record.constructionOrder, actionIds: record.actionIds, teacherSemanticHash: record.teacherSemanticHash }, constructionOrder: manifest.config.constructionOrder, input: record.input, outcome: source.outcome, trainingInputs: dataset.records.map(r => r.input), modelPath: '/frozen/eval/model.bin', modelHash: binding.modelHash };
    const composed = api.reconstructExternalDecodeJob(options); assert.equal(digest(composed), digest(expected));
    const b = { ...binding, producerReplayProofHash: digest(e.proof) }, partial = { producerReplayProofHash: digest(e.proof), producerActionIdsHash: digest(e.proof.records[0].actionIds), producerSemanticHash: e.proof.records[0].teacherSemanticHash };
    const artifact = { binding: b, jobHash: digest(expected), outcome: { status: 'completed', result: { familyId: record.familyId, modelHash: b.modelHash, policyMode: composed.policyMode, producerReplay: partial, referenceProtocol: referenceContract.reference.referenceProtocol, complete: true, workspace: {}, fallbackPhysicalPlacements: 0, generationElapsedMs: 1, qualification: { qualified: true, reasons: [] } } } };
    assert.equal(api.verifyDecodeArtifact(artifact, { binding: b, job: composed, protocol: referenceContract.reference.referenceProtocol }).available, true);
    const omitted = { ...composed }; delete omitted.featureMigration; assert.throws(() => api.verifyDecodeArtifact(artifact, { binding: b, job: omitted, protocol: referenceContract.reference.referenceProtocol }));
    const historical = api.reconstructExternalDecodeJob({ ...options, trainingManifest: { config: { constructionOrder: 'staffing-first-v1' } }, producerReplay: null }); assert.equal(Object.hasOwn(historical, 'featureMigration'), false); assert.equal(Object.hasOwn(historical, 'policyMode'), false); assert.equal(Object.hasOwn(historical.archivedTeacherTrace, 'policyMode'), false);
});
test('future reporter source provenance is canonical across permuted asynchronous collection order', () => {
    const a = { 'src/z.ts': digest('z'), 'src/a.ts': digest('a'), 'src/m.ts': digest('m') }, b = { 'src/m.ts': a['src/m.ts'], 'src/z.ts': a['src/z.ts'], 'src/a.ts': a['src/a.ts'] }, original = structuredClone(a);
    const first = api.canonicalReporterSourceManifest(a), second = api.canonicalReporterSourceManifest(b);
    assert.deepEqual(first, second); assert.equal(digest(first), digest(second)); assert.equal(first.sourceHash, digest(first.sourceHashes)); assert.deepEqual(Object.keys(first.sourceHashes), ['src/a.ts', 'src/m.ts', 'src/z.ts']); assert.equal(first.sourceHashScheme, 'sha256-sorted-path-map-v1'); assert.deepEqual(a, original);
    assert.doesNotThrow(() => api.verifyReporterSourceManifest(first)); assert.throws(() => api.canonicalReporterSourceManifest({ 'src/a.ts': 'not-a-hash' }));
    assert.notEqual(first.sourceHash, api.canonicalReporterSourceManifest({ ...a, 'src/m.ts': digest('changed') }).sourceHash);
});
test('historical reporter provenance still validates its own original stored map order without rewriting', () => {
    const sourceHashes = { 'src/z.ts': digest('z'), 'src/a.ts': digest('a') }, historical = { sourceHashes, sourceHash: digest(sourceHashes), bundleHash: digest('bundle') }, before = digest(historical);
    assert.doesNotThrow(() => api.verifyReporterSourceManifest(historical)); assert.equal(digest(historical), before);
    assert.notEqual(historical.sourceHash, api.canonicalReporterSourceManifest(sourceHashes).sourceHash);
    assert.throws(() => api.verifyReporterSourceManifest({ ...historical, sourceHashScheme: 'sha256-sorted-path-map-v1' }));
    assert.throws(() => api.verifyReporterSourceManifest({ ...historical, sourceHashScheme: 'future-unknown' }));
    assert.throws(() => api.verifyReporterSourceManifest({ ...historical, sourceHash: digest('forged') }));
});
