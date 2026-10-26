import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './state.mjs';
import { verifyBaselineReuse, simulationAdapterHash } from './baseline-cache.mjs';
function fixture() { const job = { mode: 'evaluate', workspace: { untouched: 'teacher' }, seed: 42, maxStepHours: .25 }, provenance = { bundleHash: 'old', sourceHashes: { 'src/simulator/core.ts': 'physics' } }; return { job, artifact: { job, binding: { jobHash: digest(job), bundleHash: 'old' }, score: 0, outcome: { status: 'completed', result: { completed: true, score: 0 } } }, cacheManifest: { provenance }, currentManifest: { provenance: { ...provenance, bundleHash: 'new' } }, cacheAdapterHash: 'adapter', currentAdapterHash: 'adapter', physicsPaths: ['src/simulator/core.ts'] }; }
test('exact full baseline reuse accepts completed real zero and binds unchanged physics', () => { const proof = verifyBaselineReuse(fixture()); assert.equal(proof.score, 0); assert.equal(proof.reusedSide, 'baseline-only'); assert.equal(proof.physicsSourceHashes['src/simulator/core.ts'], 'physics'); });
test('baseline reuse rejects job, workspace, unknown score, adapter and transitive physics mismatch', () => {
    for (const change of [x => x.job.seed++, x => x.job.workspace = { neural: 'different' }, x => x.artifact.score = null, x => x.artifact.outcome.result.completed = false, x => x.currentAdapterHash = 'different', x => x.currentManifest.provenance.sourceHashes = { 'src/simulator/core.ts': 'different' }, x => x.physicsPaths = []]) {
        const x = fixture();
        change(x);
        assert.throws(() => verifyBaselineReuse(x));
    }
});
test('simulation adapter hash includes assumptions/settings body and fails closed on unknown source shape', () => { const s = { 'scripts/neural/full-train-worker.ts': 'export function simulationJob(a){ return { assumptions: .65 }; }\nfunction evaluate(job){}' }; assert.notEqual(simulationAdapterHash(s), simulationAdapterHash({ 'scripts/neural/full-train-worker.ts': s['scripts/neural/full-train-worker.ts'].replace('.65', '.5') })); assert.throws(() => simulationAdapterHash({}), /Missing/); });
test('baseline cache adapter binds evaluate invocation and score extraction, not only job settings', () => { const before = { 'scripts/neural/full-train-worker.ts': 'export function simulationJob(a){ return a; }\nfunction evaluate(job){return {score: simulateCandidate(simulationJob(job)).simScore};}\nif (run) evaluate(job);' }, after = { 'scripts/neural/full-train-worker.ts': before['scripts/neural/full-train-worker.ts'].replace('score: simulateCandidate(simulationJob(job)).simScore', 'score: 0') }; assert.notEqual(simulationAdapterHash(before), simulationAdapterHash(after)); const router = { 'scripts/neural/full-train-worker.ts': before['scripts/neural/full-train-worker.ts'].replace('if (run) evaluate(job);', 'if (run) returnFakeScore(job);') }; assert.notEqual(simulationAdapterHash(before), simulationAdapterHash(router)); });
