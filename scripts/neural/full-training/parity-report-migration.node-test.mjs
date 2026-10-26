import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./parity-report-migration.mjs').catch(error => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error));
const oldManifest = { version: 'old-fixture', featureCount: 2, featureKeys: ['old-a', 'old-b'] }, newManifest = { version: 'new-fixture', featureCount: 4, featureKeys: ['old-a', 'old-b', 'new-a', 'new-b'] };
const oldHash = 'old-bound-feature-hash', newHash = 'new-bound-feature-hash';
function binary(header, values) {
    const h = Buffer.from(JSON.stringify(header)), bytes = Buffer.alloc(8 + h.length + values.length * 8);
    bytes.writeUInt32LE(0x46503242, 0); bytes.writeUInt32LE(h.length, 4); h.copy(bytes, 8);
    values.forEach((value, i) => bytes.writeDoubleLE(value, 8 + h.length + 8 * i)); return bytes;
}
function fixture() {
    const oldHeader = { version: 2, featureVersion: oldManifest.version, manifestHash: oldHash, featureCount: 2, hiddenSize: 1, metadata: { seed: 43, trainingUpdates: 91735, optimizerVersion: 'common-l2-sgd-v1', resume: { datasetHash: 'original', optimizerVersion: 'common-l2-sgd-v1', learningRate: .01, epoch: 5, sampleIndex: 0 } } };
    const newHeader = { ...oldHeader, featureVersion: newManifest.version, manifestHash: newHash, featureCount: 4, metadata: { ...oldHeader.metadata } }; delete newHeader.metadata.resume;
    return { oldHeader, newHeader, initialBytes: binary(oldHeader, [1, -0, 2, 3]), migratedBytes: binary(newHeader, [1, -0, 0, 0, 2, 3]), oldManifest, newManifest, oldHash, newHash };
}
test('migration byte inspection preserves every old float64 bit and adds only positive-zero rows without executing the migrator', () => {
    const f = fixture(), actual = api.verifyAppendOnlyPolicyMigration(f);
    assert.equal(actual.inheritedTrainingUpdates, 91735); assert.equal(actual.oldFeatureCount, 2); assert.equal(actual.newFeatureCount, 4);
    assert.equal(actual.appendedRowCount, 2); assert.equal(actual.hiddenSize, 1); assert.equal(actual.oldInputBytesHash, actual.newPrefixBytesHash); assert.equal(actual.oldTailBytesHash, actual.newTailBytesHash);
    assert.equal(api.inspectPolicyBinary(f.initialBytes, { manifestHash: oldHash, ...oldManifest }).header.metadata.trainingUpdates, 91735);
});
for (const [label, mutate] of [
    ['old input changed', f => f.migratedBytes = binary(f.newHeader, [4, -0, 0, 0, 2, 3])],
    ['negative zero old bit changed', f => f.migratedBytes = binary(f.newHeader, [1, 0, 0, 0, 2, 3])],
    ['appended nonzero', f => f.migratedBytes = binary(f.newHeader, [1, -0, 1, 0, 2, 3])],
    ['appended negative zero', f => f.migratedBytes = binary(f.newHeader, [1, -0, -0, 0, 2, 3])],
    ['hidden bias changed', f => f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 7, 3])],
    ['output weights changed', f => f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 2, 7])],
    ['update counter changed', f => { f.newHeader.metadata.trainingUpdates++; f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 2, 3]); }],
    ['seed changed', f => { f.newHeader.metadata.seed++; f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 2, 3]); }],
    ['resume retained', f => { f.newHeader.metadata.resume = f.oldHeader.metadata.resume; f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 2, 3]); }],
    ['header shadow field added', f => { f.newHeader.hidden = 'unknown-new-field'; f.migratedBytes = binary(f.newHeader, [1, -0, 0, 0, 2, 3]); }],
    ['original feature order changed', f => f.newManifest.featureKeys[0] = 'different'],
    ['both tensors nonfinite', f => { f.initialBytes = binary(f.oldHeader, [NaN, -0, 2, 3]); f.migratedBytes = binary(f.newHeader, [NaN, -0, 0, 0, 2, 3]); }],
    ['trailing bytes', f => f.migratedBytes = Buffer.concat([f.migratedBytes, Buffer.from([0])])],
    ['wrong binary magic', f => f.initialBytes[0] ^= 1],
    ['invalid old resume shape', f => { f.oldHeader.metadata.resume = []; f.initialBytes = binary(f.oldHeader, [1, -0, 2, 3]); }],
]) test('append-only migration rejects ' + label, () => { const f = structuredClone(fixture()); mutate(f); assert.throws(() => api.verifyAppendOnlyPolicyMigration(f)); });
test('named production feature manifests bind independent bytes and complete TRAIN migration ancestry', async () => {
    const { createRequire } = await import('node:module'), { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path'), { fileURLToPath } = await import('node:url'), { execFileSync } = await import('node:child_process');
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), dir = mkdtempSync(join(tmpdir(), 'parity-migration-'));
    try { const outfile = join(dir, 'test.mjs'); await build({ entryPoints: [fileURLToPath(new URL('./parity-report-migration-contract-tests.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' }); assert.match(execFileSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 30000 }), /complete parent member and exact TRAIN lineage pass/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
});
