import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './state.mjs';
import { mergeLinkedAuxiliarySources } from './linked-sources.mjs';
function fixture() { const input = { familyId: 'family7', seed: 7 }, failed = { completed: false, score: null }, done = { completed: true, score: 0 }, c = { familyId: 'family7', inputHash: digest(input), inventoryHash: 'inventory', seed: 7 }, pm = { sourceKind: 'molecular-simulated', purpose: 'training', cases: [c], provenance: { sourceHash: 'p', bundleHash: 'pb' } }, attempt = { resultPath: 'parent-result', resultHash: digest(failed) }, checkpoint = { manifestHash: digest(pm), cases: { family7: [attempt] } }, rm = { sourceKind: 'molecular-simulated', purpose: 'training', cases: [{ ...c, parentResultPath: attempt.resultPath, parentResultHash: attempt.resultHash, parentAttemptHash: digest(attempt) }], provenance: { sourceHash: 'retry', bundleHash: 'rb' }, lineage: { parentManifestHash: digest(pm), parentCheckpointHash: digest(checkpoint), parentSourceHash: 'p', parentBundleHash: 'pb', sameInput: true, sameFamilies: true } }, source = (manifest, outcome, path) => ({ teacherKind: 'molecular-simulated', purpose: 'train', teacherManifest: manifest, teacherManifestHash: digest(manifest), pending: [], records: [{ input, outcome, resultPath: path, resultHash: digest(outcome) }] }); return { parent: source(pm, failed, 'parent-result'), retry: source(rm, done, 'retry-result'), checkpoint }; }
test('linked zero-score completed family retains null parent and each distinct producer manifest', () => { const f = fixture(), result = mergeLinkedAuxiliarySources(f.parent, f.retry, f.checkpoint); assert.equal(result.records.length, 2); assert.equal(result.records[0].outcome.score, null); assert.equal(result.records[1].outcome.score, 0); assert.notEqual(result.records[0].sourceManifestHash, result.records[1].sourceManifestHash); assert.equal(f.parent.records.length, 1); });
test('linked retry rejects changed input, parent proof and duplicate completed families', () => {
    for (const change of [f => f.checkpoint.cases.family7.push({}), f => { f.retry.teacherManifest.cases[0].inputHash = 'changed'; f.retry.teacherManifestHash = digest(f.retry.teacherManifest); }, f => f.retry.records.push(f.retry.records[0]), f => f.retry.records[0].input.seed = 8]) {
        const f = fixture();
        change(f);
        assert.throws(() => mergeLinkedAuxiliarySources(f.parent, f.retry, f.checkpoint));
    }
});
