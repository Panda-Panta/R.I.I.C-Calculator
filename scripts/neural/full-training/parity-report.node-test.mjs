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
