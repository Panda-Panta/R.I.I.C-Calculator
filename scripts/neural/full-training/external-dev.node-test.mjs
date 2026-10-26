import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExternalSources } from './external-dev.mjs';
const train = { config: { purpose: 'train', teacherKind: 'molecular-simulated' } }, dev = { config: { purpose: 'dev-overfit', teacherKind: 'full-optimizer' } }, td = { purpose: 'train', records: [{ familyId: 'train1' }] }, dd = { purpose: 'dev-overfit', baselineEligible: true, records: [{ familyId: 'dev1', input: { split: 'dev' }, sourceKind: 'full-optimizer', baselineEligible: true }] };
test('explicit auxiliary TRAIN can be evaluated against separate full DEV, never as its baseline', () => { assert.doesNotThrow(() => validateExternalSources(train, dev, td, dd)); assert.throws(() => validateExternalSources(train, { config: { purpose: 'dev-overfit', teacherKind: 'molecular-simulated' } }, td, dd), /Auxiliary/); });
test('transfer evaluation rejects DEV-trained weights, release splits and duplicate families', () => { assert.throws(() => validateExternalSources(dev, dev, td, dd), /TRAIN model/); assert.throws(() => validateExternalSources(train, dev, td, { ...dd, records: [{ ...dd.records[0], input: { split: 'test' } }] }), /exposed FULL DEV/); assert.throws(() => validateExternalSources(train, dev, { ...td, records: [{ familyId: 'dev1' }] }, dd), /overlap/); });
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from './process.mjs';
test('real bundled external decode worker rejects unauthorized split before reading a model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'full-external-dev-'));
    try {
        const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), bundle = join(dir, 'worker.mjs');
        await build({ entryPoints: ['scripts/neural/full-training/external-dev-worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'silent' });
        const result = await runWorker(bundle, { input: { split: 'test' } }, { timeoutMs: 10000, stderrPath: join(dir, 'error.log') });
        assert.notEqual(result.status, 'completed');
        assert.match(readFileSync(join(dir, 'error.log'), 'utf8'), /exposed DEV only/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('real model-only decode enforces inventory split, immutable model and full baseline boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'external-dev-boundaries-'));
    try {
        const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), bundle = join(dir, 'tests.mjs');
        await build({ entryPoints: ['scripts/neural/full-training/external-dev-contract-tests.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'silent' });
        const { execFileSync } = await import('node:child_process');
        assert.match(execFileSync(process.execPath, [bundle], { encoding: 'utf8', timeout: 10000 }), /model-only decode checks passed/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('external FULL DEV must reject changed producer/shared physics before jobs, while explicit action transition is narrow', async () => { const { validateExternalTeacherContract } = await import('./external-dev.mjs'); assert.equal(typeof validateExternalTeacherContract, 'function'); const source = (path, hash) => ({ sourceHashes: { [path]: hash } }), sources = { teacherManifest: { provenance: source('src/simulator/core.ts', 'old') } }; assert.throws(() => validateExternalTeacherContract({ config: {}, provenance: source('src/simulator/core.ts', 'new') }, sources), /shared source mismatch/); const actionSources = { teacherManifest: { provenance: source('src/optimizer/neural/fullTransitions.ts', 'old') } }; assert.throws(() => validateExternalTeacherContract({ config: {}, provenance: source('src/optimizer/neural/fullTransitions.ts', 'new') }, actionSources), /shared source mismatch/); const accepted = validateExternalTeacherContract({ config: { constructionOrder: 'staffing-first-v1', sourceTransition: 'legacy-action-replay-to-staffing-first-v1' }, provenance: source('src/optimizer/neural/fullTransitions.ts', 'new') }, actionSources); assert.equal(accepted.legacyProofRequired, true); });
test('external evaluator binds actual TRAIN checkpoint settings, source, features and lineage before snapshot',async()=>{const {verifyExternalTrainCheckpoint}=await import('./external-dev.mjs');const {digest}=await import('./state.mjs');const manifest={config:{purpose:'train',teacherKind:'full-optimizer'},provenance:{sourceHash:'source',bundleHash:'bundle'}},dataset={featureManifestHash:'feature',records:[]},binding={datasetHash:digest(dataset),sourceHash:'source',bundleHash:'bundle',featureManifestHash:'feature',...manifest.config};assert.doesNotThrow(()=>verifyExternalTrainCheckpoint(manifest,dataset,{state:{binding}}));for(const key of ['purpose','sourceHash','bundleHash','featureManifestHash'])assert.throws(()=>verifyExternalTrainCheckpoint(manifest,dataset,{state:{binding:{...binding,[key]:'dev-or-other'}}}),/mismatch/);});
