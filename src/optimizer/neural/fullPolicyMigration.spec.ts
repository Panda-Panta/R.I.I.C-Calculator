import { expect, it } from 'vitest';
import { FULL_FEATURE_COUNT, FULL_FEATURE_MANIFEST, FULL_FEATURE_MANIFEST_HASH, FULL_FEATURE_VERSION, LEGACY_FULL_FEATURE_MANIFEST, fullFingerprint, type FullEncodedDecision } from './fullFeatures';
import { createFullPolicy, deserializeFullPolicy, fullPolicyForwardUnchecked, fullPolicyLogits, serializeFullPolicy, type FullPolicyModel } from './fullPolicy';
import { migrateLegacyFullPolicy } from './fullPolicyMigration';
function legacy() {
    const model = createFullPolicy({ hiddenSize: 2, seed: 37 });
    return { ...model, featureVersion: LEGACY_FULL_FEATURE_MANIFEST.version, manifestHash: '116a7915c860ef4f44b9629f93df2abd', featureCount: 53006, inputWeights: model.inputWeights.slice(0, 53006), metadata: { seed: 37, trainingUpdates: 91735, optimizerVersion: 'common-l2-sgd-v1', resume: { datasetHash: 'old-curriculum', optimizerVersion: 'common-l2-sgd-v1', learningRate: .001, epoch: 35, sampleIndex: 0 } } };
}
function binary(model: ReturnType<typeof legacy>) {
    const { inputWeights, hiddenBias, outputWeights, ...header } = model;
    const h = new TextEncoder().encode(JSON.stringify(header)), bytes = new Uint8Array(8 + h.length + 8 * (inputWeights.length + 2) * model.hiddenSize), v = new DataView(bytes.buffer);
    v.setUint32(0, 0x46503242, true); v.setUint32(4, h.length, true); bytes.set(h, 8);
    let offset = 8 + h.length;
    for (const row of [...inputWeights, hiddenBias, outputWeights]) for (const x of row) { v.setFloat64(offset, x, true); offset += 8; }
    return bytes;
}
it('authenticates the exact frozen source manifest and append-only prefix', () => {
    expect(fullFingerprint(LEGACY_FULL_FEATURE_MANIFEST)).toBe('116a7915c860ef4f44b9629f93df2abd');
    expect(FULL_FEATURE_MANIFEST.featureKeys.slice(0, 53006)).toEqual(LEGACY_FULL_FEATURE_MANIFEST.featureKeys);
    const m = migrateLegacyFullPolicy(binary(legacy()), LEGACY_FULL_FEATURE_MANIFEST);
    expect(m.featureCount).toBe(FULL_FEATURE_COUNT);
});
it('preserves every old float bit, seed and update count; zero extends and resets only the resume cursor', () => {
    const old = legacy(); old.inputWeights[0]![0] = -0; old.hiddenBias[0] = -0;
    const bytes = binary(old), before = bytes.slice(), model = migrateLegacyFullPolicy(bytes, LEGACY_FULL_FEATURE_MANIFEST);
    expect(bytes).toEqual(before);
    expect(model.inputWeights.slice(0, 53006)).toEqual(old.inputWeights);
    expect(Object.is(model.inputWeights[0]![0], -0)).toBe(true);
    expect(model.hiddenBias).toEqual(old.hiddenBias); expect(model.outputWeights).toEqual(old.outputWeights);
    expect(model.metadata).toEqual({ seed: 37, trainingUpdates: 91735, optimizerVersion: 'common-l2-sgd-v1' });
    expect(model.inputWeights.slice(53006).every(row => row.every(x => Object.is(x, 0)))).toBe(true);
    expect(deserializeFullPolicy(serializeFullPolicy(model))).toEqual(model);
    const d: FullEncodedDecision = { version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: [[3, .75]] as [number, number][], candidates: [[[5, 1]]] as [number, number][][] };
    expect(fullPolicyLogits(model, { ...d, common: [...d.common, [53006, 1]], candidates: [[[5, 1], [56176, 1]]] })).toEqual(fullPolicyLogits(model, d));
});
it('rejects legacy models through default readers and both forward entry points', () => {
    const old = legacy(); const d: FullEncodedDecision = { version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: [], candidates: [[]] };
    expect(() => deserializeFullPolicy(binary(old))).toThrow();
    expect(() => fullPolicyLogits(old as unknown as FullPolicyModel, d)).toThrow();
    expect(() => fullPolicyForwardUnchecked(old as unknown as FullPolicyModel, d)).toThrow();
});
it('rejects source, prefix, version, dimensions, nonfinite weights, truncation and repeated migration', () => {
    const bytes = binary(legacy());
    for (const manifest of [{ ...LEGACY_FULL_FEATURE_MANIFEST, sourceCommit: 'bad' }, { ...LEGACY_FULL_FEATURE_MANIFEST, featureKeys: ['bad', ...LEGACY_FULL_FEATURE_MANIFEST.featureKeys.slice(1)] }, FULL_FEATURE_MANIFEST]) expect(() => migrateLegacyFullPolicy(bytes, manifest)).toThrow();
    for (const patch of [{ featureVersion: 'bad' }, { manifestHash: 'bad' }, { featureCount: 53005 }, { hiddenSize: 0 }, { metadata: { seed: 37, trainingUpdates: -1 } }]) expect(() => migrateLegacyFullPolicy(binary({ ...legacy(), ...patch } as ReturnType<typeof legacy>), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const bad = legacy(); bad.inputWeights[12]![1] = NaN;
    expect(() => migrateLegacyFullPolicy(binary(bad), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    expect(() => migrateLegacyFullPolicy(bytes.slice(0, -1), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const extended = new Uint8Array(bytes.length + 1); extended.set(bytes);
    expect(() => migrateLegacyFullPolicy(extended, LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const migrated = migrateLegacyFullPolicy(bytes, LEGACY_FULL_FEATURE_MANIFEST);
    expect(() => migrateLegacyFullPolicy(serializeFullPolicy(migrated), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
});
it('rejects malformed byte headers before tensor allocation', () => {
    const bytes = binary(legacy());
    for (const bad of [new Uint8Array(0), bytes.slice(0, 7), bytes.slice(0, 16)]) expect(() => migrateLegacyFullPolicy(bad, LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const magic = bytes.slice(); new DataView(magic.buffer).setUint32(0, 0, true);
    expect(() => migrateLegacyFullPolicy(magic, LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const length = bytes.slice(); new DataView(length.buffer).setUint32(4, 65537, true);
    expect(() => migrateLegacyFullPolicy(length, LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    const nonfinite = legacy(); nonfinite.outputWeights[1] = Infinity;
    expect(() => migrateLegacyFullPolicy(binary(nonfinite), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
});
it('rejects malformed optional legacy resume cursors instead of silently resetting them', () => {
    for (const resume of [null, false, 0, '', []]) {
        const model = legacy(); Object.assign(model.metadata, { resume });
        expect(() => migrateLegacyFullPolicy(binary(model), LEGACY_FULL_FEATURE_MANIFEST)).toThrow();
    }
});
