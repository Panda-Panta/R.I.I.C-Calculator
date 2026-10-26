import test from 'node:test';
import assert from 'node:assert/strict';
import { STAFFING_SOURCE_TRANSITION, verifyTeacherSourceCompatibility } from './source-compatibility.mjs';
const source = (path, hash) => ({ sourceHashes: { [path]: hash } });
test('shared action drift requires explicit narrow transition and records both contracts', () => { const p = source('src/optimizer/neural/fullActionSpace.ts', 'producer'), t = source('src/optimizer/neural/fullActionSpace.ts', 'trainer'); assert.throws(() => verifyTeacherSourceCompatibility(p, t), /shared source mismatch/); const r = verifyTeacherSourceCompatibility(p, t, STAFFING_SOURCE_TRANSITION); assert.equal(r.legacyProofRequired, true); assert.deepEqual(r.drifts, [{ path: 'src/optimizer/neural/fullActionSpace.ts', producerHash: 'producer', trainerHash: 'trainer' }]); });
test('transition never permits core, simulator, feature, numeric or selection drift', () => { for (const path of ['src/domain/operators.ts', 'src/engine/calculate.ts', 'src/optimizer/candidateSimulation.ts', 'src/optimizer/neural/fullFeatures.ts', 'src/optimizer/neural/fullTraining.ts', 'src/optimizer/automaticCombinationPreferences.ts', 'src/optimizer/neural/newUnreviewedHelper.ts'])
    assert.throws(() => verifyTeacherSourceCompatibility(source(path, 'old'), source(path, 'new'), STAFFING_SOURCE_TRANSITION), /shared source mismatch/); assert.throws(() => verifyTeacherSourceCompatibility({ sourceHashes: {} }, { sourceHashes: {} }, 'allow-anything'), /Unknown/); });
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSources, sourceContracts } from '../full-train.mjs';
test('production source collection requires opt-in and persists both source contracts', () => { const dir = mkdtempSync(join(tmpdir(), 'source-transition-')); try {
    const p = source('src/optimizer/neural/fullActionSpace.ts', 'old'), t = source('src/optimizer/neural/fullActionSpace.ts', 'new'), manifest = { sourceKind: 'molecular-simulated', purpose: 'training', cases: [], provenance: { ...p, sourceHash: 'producer-source', bundleHash: 'producer-bundle' } };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => collectSources(dir, 'train', t, 'molecular-simulated'), /shared source mismatch/);
    const collected = collectSources(dir, 'train', t, 'molecular-simulated', STAFFING_SOURCE_TRANSITION), contracts = sourceContracts(collected);
    assert.equal(contracts.primary.compatibility.drifts[0].producerHash, 'old');
    assert.equal(contracts.primary.compatibility.drifts[0].trainerHash, 'new');
    assert.equal(contracts.primary.producerBundleHash, 'producer-bundle');
}
finally {
    rmSync(dir, { recursive: true, force: true });
} });
