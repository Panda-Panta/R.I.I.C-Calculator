/** Independent read-only float64 byte authentication. Never executes migration or inference.
 * Callers must separately authenticate the actual old/new manifests, source transition and TRAIN ancestry.
 */
import { digest } from './state.mjs';
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const equal = (a, b, message) => requireThat(digest(a) === digest(b), message + ' mismatch');
export function inspectPolicyBinary(bytes, featureContract) {
    requireThat(bytes instanceof Uint8Array && bytes.length >= 8, 'Missing binary policy bytes');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    requireThat(view.getUint32(0, true) === 0x46503242, 'Invalid binary policy magic');
    const headerLength = view.getUint32(4, true), dataStart = 8 + headerLength;
    requireThat(headerLength <= 65536 && dataStart <= bytes.length, 'Invalid binary policy header length');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, dataStart)));
    requireThat(header && header.version === 2 && header.featureVersion === featureContract.version && header.manifestHash === featureContract.manifestHash && header.featureCount === featureContract.featureCount, 'Binary feature contract mismatch');
    const { hiddenSize, featureCount, metadata } = header;
    requireThat(Number.isSafeInteger(featureCount) && featureCount > 0 && featureCount <= 100000 && Number.isSafeInteger(hiddenSize) && hiddenSize >= 1 && hiddenSize <= 256, 'Invalid binary policy dimensions');
    requireThat(bytes.length === dataStart + (featureCount + 2) * hiddenSize * 8, 'Invalid binary policy byte length');
    requireThat(metadata && !Array.isArray(metadata) && Number.isSafeInteger(metadata.seed) && metadata.seed >= 0 && metadata.seed <= 0xffffffff && Number.isSafeInteger(metadata.trainingUpdates) && metadata.trainingUpdates >= 0, 'Invalid binary policy metadata');
    const validOptimizer = value => value === undefined || value === 'sgd-v1' || value === 'common-l2-sgd-v1', resume = metadata.resume;
    requireThat(validOptimizer(metadata.optimizerVersion), 'Invalid binary optimizer');
    if (resume !== undefined) {
        requireThat(resume && typeof resume === 'object' && !Array.isArray(resume) && typeof resume.datasetHash === 'string' && resume.datasetHash.length && Number.isFinite(resume.learningRate) && resume.learningRate > 0 && Number.isSafeInteger(resume.epoch) && resume.epoch >= 0 && Number.isSafeInteger(resume.sampleIndex) && resume.sampleIndex >= 0, 'Invalid binary resume metadata');
        requireThat(validOptimizer(resume.optimizerVersion) && (resume.optimizerVersion ?? 'sgd-v1') === (metadata.optimizerVersion ?? 'sgd-v1'), 'Invalid binary resume optimizer');
    }
    for (let offset = dataStart; offset < bytes.length; offset += 8) requireThat(Number.isFinite(view.getFloat64(offset, true)), 'Nonfinite binary policy parameter');
    return { header, dataStart, inputEnd: dataStart + featureCount * hiddenSize * 8, modelHash: digest(Buffer.from(bytes)) };
}
export function verifyAppendOnlyPolicyMigration({ initialBytes, migratedBytes, oldManifest, newManifest, oldHash, newHash }) {
    requireThat(Array.isArray(oldManifest.featureKeys) && Array.isArray(newManifest.featureKeys) && oldManifest.featureKeys.length === oldManifest.featureCount && newManifest.featureKeys.length === newManifest.featureCount && newManifest.featureCount > oldManifest.featureCount, 'Invalid append-only feature manifests');
    equal(newManifest.featureKeys.slice(0, oldManifest.featureCount), oldManifest.featureKeys, 'Original feature index prefix');
    requireThat(new Set(newManifest.featureKeys).size === newManifest.featureKeys.length, 'Duplicate feature index');
    const old = inspectPolicyBinary(initialBytes, { ...oldManifest, manifestHash: oldHash }), next = inspectPolicyBinary(migratedBytes, { ...newManifest, manifestHash: newHash });
    const metadata = { ...old.header.metadata }; delete metadata.resume;
    equal(next.header, { ...old.header, featureVersion: newManifest.version, featureCount: newManifest.featureCount, manifestHash: newHash, metadata }, 'Exact migration header and preserved metadata');
    const prefixEnd = next.dataStart + oldManifest.featureCount * old.header.hiddenSize * 8;
    const oldInput = Buffer.from(initialBytes.subarray(old.dataStart, old.inputEnd)), newPrefix = Buffer.from(migratedBytes.subarray(next.dataStart, prefixEnd));
    const appended = Buffer.from(migratedBytes.subarray(prefixEnd, next.inputEnd)), oldTail = Buffer.from(initialBytes.subarray(old.inputEnd)), newTail = Buffer.from(migratedBytes.subarray(next.inputEnd));
    requireThat(oldInput.equals(newPrefix), 'Migration altered old input parameter bits');
    requireThat(oldTail.equals(newTail), 'Migration altered hidden bias or output parameter bits');
    requireThat(appended.every(byte => byte === 0), 'Migration appended rows are not exact positive zero');
    return { originalModelHash: old.modelHash, migratedModelHash: next.modelHash, oldFeatureCount: oldManifest.featureCount, newFeatureCount: newManifest.featureCount,
        appendedRowCount: newManifest.featureCount - oldManifest.featureCount, hiddenSize: old.header.hiddenSize, inheritedTrainingUpdates: old.header.metadata.trainingUpdates,
        oldInputBytesHash: digest(oldInput), newPrefixBytesHash: digest(newPrefix), appendedBytesHash: digest(appended), oldTailBytesHash: digest(oldTail), newTailBytesHash: digest(newTail),
        originalHeaderHash: digest(old.header), migratedHeaderHash: digest(next.header), resumeRemoved: !Object.hasOwn(next.header.metadata, 'resume') };
}
/** Reconstruct the producer receipt from independently inspected raw ranges, not its own verifier. */
export function reconstructMigrationByteReceipt(options, contract) {
    const checked = verifyAppendOnlyPolicyMigration(options), { initialBytes, migratedBytes, oldManifest, newManifest, oldHash, newHash } = options;
    requireThat(contract.oldHash === oldHash && contract.newHash === newHash && contract.oldCount === oldManifest.featureCount && contract.newCount === newManifest.featureCount && contract.oldVersion === oldManifest.version && contract.newVersion === newManifest.version, 'Named migration feature contract mismatch');
    equal(contract.oldManifestSha256, digest(oldManifest), 'Named old full feature manifest'); equal(contract.newManifestSha256, digest(newManifest), 'Named new full feature manifest');
    const old = inspectPolicyBinary(initialBytes, { ...oldManifest, manifestHash: oldHash }), next = inspectPolicyBinary(migratedBytes, { ...newManifest, manifestHash: newHash }), rowBytes = 8 * old.header.hiddenSize;
    const ranges = [['inputWeights', old.dataStart, next.dataStart, oldManifest.featureCount * rowBytes], ['hiddenBias', old.inputEnd, next.inputEnd, rowBytes], ['outputWeights', old.inputEnd + rowBytes, next.inputEnd + rowBytes, rowBytes]];
    const tensors = ranges.map(([name, oldOffset, newOffset, byteLength]) => ({ name, oldOffset, newOffset, byteLength, oldHash: digest(initialBytes.subarray(oldOffset, oldOffset + byteLength)), newHash: digest(migratedBytes.subarray(newOffset, newOffset + byteLength)), bitwiseEqual: true }));
    tensors.push({ name: 'appendedInputRows', oldOffset: null, newOffset: next.dataStart + oldManifest.featureCount * rowBytes, byteLength: (newManifest.featureCount - oldManifest.featureCount) * rowBytes, newHash: checked.appendedBytesHash, allZero: true });
    return { schemaVersion: 1, kind: contract.id, contract, oldModelHash: checked.originalModelHash, newModelHash: checked.migratedModelHash, oldHeaderHash: checked.originalHeaderHash, newHeaderHash: checked.migratedHeaderHash, hiddenSize: checked.hiddenSize, addedRows: checked.appendedRowCount, metadata: next.header.metadata, resumeReset: true, newTrainingUpdates: 0, tensors };
}
