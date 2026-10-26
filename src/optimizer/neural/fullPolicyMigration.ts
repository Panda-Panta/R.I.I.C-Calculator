import { FULL_FEATURE_COUNT, FULL_FEATURE_MANIFEST, FULL_FEATURE_MANIFEST_HASH, FULL_FEATURE_VERSION, LEGACY_FULL_FEATURE_MANIFEST, fullFingerprint } from './fullFeatures';
import { assertFullPolicy, type FullPolicyModel } from './fullPolicy';
const OLD_COUNT = 53006;
const OLD_HASH = '116a7915c860ef4f44b9629f93df2abd';
/**
 * Explicit, one-way migration of the exact input-conf contract. Caller must
 * authenticate artifact/source/TRAIN ancestry and persist old/new byte hashes.
 * No training occurs here. Resetting resume starts a new curriculum, while the
 * cumulative update counter and all old float64 parameters remain unchanged.
 */
export function migrateLegacyFullPolicy(bytes: Uint8Array, legacyManifest: unknown): FullPolicyModel {
    if (LEGACY_FULL_FEATURE_MANIFEST.featureCount !== OLD_COUNT || fullFingerprint(LEGACY_FULL_FEATURE_MANIFEST) !== OLD_HASH ||
        JSON.stringify(legacyManifest) !== JSON.stringify(LEGACY_FULL_FEATURE_MANIFEST) ||
        JSON.stringify(FULL_FEATURE_MANIFEST.featureKeys.slice(0, OLD_COUNT)) !== JSON.stringify(LEGACY_FULL_FEATURE_MANIFEST.featureKeys))
        throw Error('Legacy migration manifest/source/prefix mismatch');
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw Error('Invalid legacy binary policy');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46503242) throw Error('Invalid legacy binary magic');
    const length = view.getUint32(4, true);
    if (length > 65536 || length + 8 > bytes.length) throw Error('Invalid legacy binary header');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length))) as FullPolicyModel;
    if (!header || header.version !== 2 || (header.featureVersion as string) !== LEGACY_FULL_FEATURE_MANIFEST.version || header.manifestHash !== OLD_HASH || header.featureCount !== OLD_COUNT)
        throw Error('Legacy migration contract mismatch');
    const n = header.hiddenSize;
    if (!Number.isSafeInteger(n) || n < 1 || n > 256 || bytes.length !== 8 + length + 8 * (OLD_COUNT + 2) * n)
        throw Error('Invalid legacy binary dimensions');
    const metadata = header.metadata;
    if (!metadata || !Number.isSafeInteger(metadata.seed) || metadata.seed < 0 || metadata.seed > 0xffffffff || !Number.isSafeInteger(metadata.trainingUpdates) || metadata.trainingUpdates < 0)
        throw Error('Invalid legacy metadata');
    const validOptimizer = (v: unknown) => v === undefined || v === 'sgd-v1' || v === 'common-l2-sgd-v1';
    const r = metadata.resume;
    if (r !== undefined && (!r || typeof r !== 'object' || Array.isArray(r))) throw Error('Invalid legacy resume shape');
    if (!validOptimizer(metadata.optimizerVersion) || !validOptimizer(r?.optimizerVersion) ||
        (r && (typeof r.datasetHash !== 'string' || !r.datasetHash || !Number.isFinite(r.learningRate) || r.learningRate <= 0 || !Number.isSafeInteger(r.epoch) || r.epoch < 0 || !Number.isSafeInteger(r.sampleIndex) || r.sampleIndex < 0 || (r.optimizerVersion ?? 'sgd-v1') !== (metadata.optimizerVersion ?? 'sgd-v1'))))
        throw Error('Invalid legacy resume metadata');
    // Read and validate all legacy values before allocating any appended rows.
    let offset = 8 + length;
    const row = () => Array.from({ length: n }, () => {
        const value = view.getFloat64(offset, true); offset += 8;
        if (!Number.isFinite(value)) throw Error('Nonfinite legacy weight');
        return value;
    });
    const inputWeights = Array.from({ length: OLD_COUNT }, row), hiddenBias = row(), outputWeights = row();
    while (inputWeights.length < FULL_FEATURE_COUNT) inputWeights.push(Array(n).fill(0));
    const nextMetadata = { ...metadata }; delete nextMetadata.resume;
    const model: FullPolicyModel = { ...header, featureVersion: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, inputWeights, hiddenBias, outputWeights, metadata: nextMetadata };
    assertFullPolicy(model);
    return model;
}
