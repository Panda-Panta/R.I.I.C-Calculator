import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceKey, inferenceContractHash } from './provenance.mjs';
test('Windows separators normalize to POSIX and scripts do not change inference contract', () => {
    const a = { 'src\\optimizer\\neural\\features.ts': 'a'.repeat(64), 'scripts\\neural\\run.mjs': 'b'.repeat(64) };
    const b = { 'src/optimizer/neural/features.ts': 'a'.repeat(64), 'scripts/neural/run.mjs': 'c'.repeat(64) };
    assert.equal(normalizeSourceKey('src\\optimizer\\neural\\features.ts'), 'src/optimizer/neural/features.ts');
    assert.equal(inferenceContractHash(a), inferenceContractHash(b));
    assert.notEqual(inferenceContractHash(b), inferenceContractHash({ 'src/optimizer/neural/features.ts': 'b'.repeat(64) }));
    assert.throws(() => inferenceContractHash({ 'src/foo.ts': undefined }), /Invalid/);
});
