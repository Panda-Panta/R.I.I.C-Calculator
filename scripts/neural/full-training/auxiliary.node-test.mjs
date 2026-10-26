import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './state.mjs';
import { inspectAuxiliaryEvidence } from './auxiliary-evidence.mjs';
function fixture() { const input = { familyId: 'fixture', sourceKind: 'molecular-simulated', purpose: 'training', split: 'train', options: { branchCount: 3, enableDeepSearch: false, simulationWarmupHours: 24, simulationSampleHours: 72 } }, manifest = { sourceKind: 'molecular-simulated', purpose: 'training', provenance: { sourceHash: 'fixture', bundleHash: 'fixture' }, cases: [{ familyId: 'fixture', inputHash: digest(input) }] }, outcome = { status: 'completed', completed: true, score: 0, result: { sourceKind: 'molecular-simulated', purpose: 'training', completed: true, score: 0, branchCount: 3, enableDeepSearch: false, selectedId: 'one', candidates: [{ id: 'one' }], result: { status: 'draft', score: 0, workspace: {}, calculationReport: {} } } }, authorization = { purpose: 'training', allowedTeacherKinds: ['molecular-simulated'], manifest, manifestHash: digest(manifest) }; return { input, outcome, authorization }; }
test('auxiliary source requires explicit TRAIN authorization and manifest/input commitments; completed zero survives', () => {
    const x = fixture(), r = inspectAuxiliaryEvidence(x.input, x.outcome, x.authorization);
    assert.equal(r.eligibleEvidence, true);
    assert.equal(r.baselineEligible, false);
    assert.equal(r.fullOptimizerTeacher, false);
    for (const change of [x => x.authorization.allowedTeacherKinds = [], x => x.authorization.purpose = 'release', x => x.authorization.manifestHash = 'changed', x => x.input.split = 'dev', x => x.input.sourceKind = 'full-optimizer', x => delete x.outcome.result.sourceKind]) {
        const y = fixture();
        change(y);
        assert.equal(inspectAuxiliaryEvidence(y.input, y.outcome, y.authorization).eligibleEvidence, false);
    }
});
test('auxiliary unknown/conflicting/incomplete selected score and incomplete candidate list are never admitted', () => {
    for (const change of [x => x.outcome.score = null, x => x.outcome.result.result.score = 1, x => x.outcome.completed = false, x => x.outcome.result.candidates = [], x => x.outcome.result.candidates.push({ id: 'one' }), x => x.outcome.result.selectedId = 'missing']) {
        const y = fixture();
        change(y);
        const before = JSON.stringify(y);
        assert.equal(inspectAuxiliaryEvidence(y.input, y.outcome, y.authorization).eligibleEvidence, false);
        assert.equal(JSON.stringify(y), before);
    }
});
test('auxiliary full traces and objective ordering are independently rechecked without treating failed scores as zero', async () => {
    const { createRequire } = await import('node:module'), { execFileSync } = await import('node:child_process'), { mkdtempSync, rmSync } = await import('node:fs'), { join } = await import('node:path'), { tmpdir } = await import('node:os'), { fileURLToPath } = await import('node:url'), require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), dir = mkdtempSync(join(tmpdir(), 'aux-contract-'));
    try {
        const outfile = join(dir, 'test.mjs');
        await build({ entryPoints: [fileURLToPath(new URL('./auxiliary-contract-tests.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning' });
        const output = execFileSync(process.execPath, [outfile], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
        assert.match(output, /all passed/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('partial-family durable candidate snapshots are not family training targets', () => { const x = fixture(); x.outcome.result.comparisonComplete = false; x.outcome.result.admittedTarget = false; assert.ok(inspectAuxiliaryEvidence(x.input, x.outcome, x.authorization).reasons.includes('PARTIAL_FAMILY_NOT_ADMITTED')); });
test('original full gate rejects explicitly weaker source even if numerical option flags are forged full', async () => { const { qualifyEnvelope } = await import('./state.mjs'), x = fixture(); Object.assign(x.input.options, { branchCount: 10, enableDeepSearch: true }); assert.ok(qualifyEnvelope(x.input, x.outcome, 'train').reasons.includes('SOURCE_KIND_NOT_FULL_OPTIMIZER')); });
test('full-baseline evaluator rejects auxiliary provenance before any simulator is launched', async () => { const { assertFullBaselineDataset } = await import('./evaluate.mjs'); assert.throws(() => assertFullBaselineDataset({ records: [], teacherKinds: ['molecular-simulated'] }, { config: { teacherKind: 'molecular-simulated' } }), /never full/); assert.throws(() => assertFullBaselineDataset({ records: [{ sourceKind: 'molecular-simulated', baselineEligible: false }] }, {}), /never full/); assert.doesNotThrow(() => assertFullBaselineDataset({ records: [{ sourceKind: 'full-optimizer', baselineEligible: true }], teacherKinds: ['full-optimizer'] }, { config: { teacherKind: 'full-optimizer' } })); });
test('degraded full-search outputs remain records but cannot qualify as full mathematical references', async () => { const { qualifyEnvelope } = await import('./state.mjs'); const input = { split: 'dev', options: { branchCount: 10, enableDeepSearch: true, simulationWarmupHours: 24, simulationSampleHours: 72 } }, outcome = { status: 'completed', completed: true, score: 0, result: { completed: true, score: 0, degradedBaseline: true, result: { status: 'draft', score: 0, workspace: {}, calculationReport: {} }, validation: { physical: [] } } }; const result = qualifyEnvelope(input, outcome, 'dev-overfit'); assert.equal(result.qualified, false); assert.ok(result.reasons.includes('DEGRADED_NOT_FULL_MATHEMATICAL_REFERENCE')); assert.equal(outcome.result.degradedBaseline, true); });
test('enriched catalog profile requires explicit authorization and matching input/manifest/envelope markers', () => { const x = fixture(), profile = 'TRAIN-enriched-catalog-high-stage-v1'; x.input.inputProfile = profile; x.outcome.result.inputProfile = profile; x.authorization.manifest.inputProfile = profile; x.authorization.manifest.cases[0].inputHash = digest(x.input); x.authorization.manifestHash = digest(x.authorization.manifest); assert.equal(inspectAuxiliaryEvidence(x.input, x.outcome, x.authorization).eligibleEvidence, false); x.authorization.allowedInputProfiles = [profile]; assert.equal(inspectAuxiliaryEvidence(x.input, x.outcome, x.authorization).eligibleEvidence, true); delete x.outcome.result.inputProfile; assert.equal(inspectAuxiliaryEvidence(x.input, x.outcome, x.authorization).eligibleEvidence, false); });
