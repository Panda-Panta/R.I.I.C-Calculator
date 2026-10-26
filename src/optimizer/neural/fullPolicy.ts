import { FULL_FEATURE_COUNT, FULL_FEATURE_VERSION, FULL_FEATURE_MANIFEST_HASH, validateFullDecision, type FullEncodedDecision } from './fullFeatures';
export type FullOptimizerVersion = 'sgd-v1' | 'common-l2-sgd-v1';
export interface FullPolicyModel {
    version: 2;
    featureVersion: typeof FULL_FEATURE_VERSION;
    manifestHash: string;
    featureCount: number;
    hiddenSize: number;
    /** Feature-major layout: only touched rows are read or differentiated. */
    inputWeights: number[][];
    hiddenBias: number[];
    outputWeights: number[];
    metadata: {
        seed: number;
        trainingUpdates: number;
        optimizerVersion?: FullOptimizerVersion;
        resume?: {
            datasetHash: string;
            optimizerVersion?: FullOptimizerVersion;
            learningRate: number;
            epoch: number;
            sampleIndex: number;
        };
    };
}
function vector(x: unknown, n: number) {
    if (!Array.isArray(x) || x.length !== n)
        throw Error('Invalid weight dimension');
    for (let i = 0; i < n; i++)
        if (typeof x[i] !== 'number' || !Number.isFinite(x[i]))
            throw Error('Nonfinite weight');
}
export function assertFullPolicy(value: unknown): asserts value is FullPolicyModel {
    if (!value || typeof value !== 'object')
        throw Error('Invalid full policy');
    const m = value as FullPolicyModel;
    if (m.version !== 2 || m.featureVersion !== FULL_FEATURE_VERSION || m.manifestHash !== FULL_FEATURE_MANIFEST_HASH || m.featureCount !== FULL_FEATURE_COUNT)
        throw Error('Full policy contract mismatch');
    if (!Number.isSafeInteger(m.hiddenSize) || m.hiddenSize < 1 || m.hiddenSize > 256)
        throw Error('Invalid hiddenSize');
    if (!Array.isArray(m.inputWeights) || m.inputWeights.length !== m.featureCount)
        throw Error('Invalid input weights');
    for (const row of m.inputWeights)
        vector(row, m.hiddenSize);
    vector(m.hiddenBias, m.hiddenSize);
    vector(m.outputWeights, m.hiddenSize);
    if (!m.metadata || !Number.isSafeInteger(m.metadata.seed) || m.metadata.seed < 0 || m.metadata.seed > 0xffffffff || !Number.isSafeInteger(m.metadata.trainingUpdates) || m.metadata.trainingUpdates < 0)
        throw Error('Invalid model metadata');
    const validOptimizer = (v: unknown) => v === undefined || v === 'sgd-v1' || v === 'common-l2-sgd-v1';
    if (!validOptimizer(m.metadata.optimizerVersion) || !validOptimizer(m.metadata.resume?.optimizerVersion))
        throw Error('Invalid optimizer version');
    const r = m.metadata.resume;
    if (r && (!r.datasetHash || !Number.isFinite(r.learningRate) || r.learningRate <= 0 || !Number.isSafeInteger(r.epoch) || r.epoch < 0 || !Number.isSafeInteger(r.sampleIndex) || r.sampleIndex < 0))
        throw Error('Invalid resume metadata');
    if (r && (r.optimizerVersion ?? 'sgd-v1') !== (m.metadata.optimizerVersion ?? 'sgd-v1'))
        throw Error('Inconsistent optimizer metadata');
}
export function validateFullPolicy(value: unknown): FullPolicyModel {
    assertFullPolicy(value);
    return structuredClone(value);
}
export function createFullPolicy(options: {
    hiddenSize?: number;
    seed?: number;
} = {}): FullPolicyModel {
    const hiddenSize = options.hiddenSize ?? 64, seed = options.seed ?? 1;
    if (!Number.isSafeInteger(hiddenSize) || hiddenSize < 1 || hiddenSize > 256 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
        throw Error('Invalid model options');
    let state = seed;
    const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let x = Math.imul(state ^ (state >>> 15), 1 | state);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    // Sparse fan-in, rather than the enormous mostly-zero vocabulary dimension.
    return {
        version: 2, featureVersion: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, hiddenSize, inputWeights: Array.from({ length: FULL_FEATURE_COUNT }, () => Array.from({ length: hiddenSize }, () => (random() * 2 - 1) * .08)), hiddenBias: Array(hiddenSize).fill(0), outputWeights: Array.from({ length: hiddenSize }, () => (random() * 2 - 1) * Math.sqrt(6 / (hiddenSize + 1))), metadata: {
            seed, trainingUpdates: 0
        }
    };
}
/** Internal hot path: caller validates model once; encoded data is validated per decision. */
export function fullPolicyForwardUnchecked(m: FullPolicyModel, d: FullEncodedDecision): {
    logits: number[];
    hidden: number[][];
} {
    validateFullDecision(d);
    const base = m.hiddenBias.slice(), n = m.hiddenSize;
    for (const [f, v] of d.common) {
        const row = m.inputWeights[f]!;
        for (let h = 0; h < n; h++)
            base[h]! += v * row[h]!;
    }
    const hidden = d.candidates.map(c => {
        const z = base.slice();
        for (const [f, v] of c) {
            const row = m.inputWeights[f]!;
            for (let h = 0; h < n; h++)
                z[h]! += v * row[h]!;
        }
        if (!z.every(Number.isFinite))
            throw Error('Nonfinite hidden preactivation');
        return z.map(Math.tanh);
    });
    const logits = hidden.map(z => z.reduce((sum, x, h) => sum + x * m.outputWeights[h]!, 0));
    if (!logits.every(Number.isFinite))
        throw Error('Nonfinite policy logits');
    return {
        logits, hidden
    };
}
export function fullPolicyLogits(model: FullPolicyModel, decision: FullEncodedDecision): number[] {
    assertFullPolicy(model);
    return fullPolicyForwardUnchecked(model, decision).logits;
}
/** Own detached validated snapshot; safe fast decoder closure without per-step dense validation. */
export function createFullPolicyScorer(input: unknown): (decision: FullEncodedDecision) => number[] {
    const model = validateFullPolicy(input);
    return d => fullPolicyForwardUnchecked(model, d).logits;
}
/** Lossless little-endian float64 artifact; JSON header carries the version/source/cursor contract. */
export function serializeFullPolicy(model: FullPolicyModel): Uint8Array {
    assertFullPolicy(model);
    const { inputWeights, hiddenBias, outputWeights, ...metadata } = model, header = new TextEncoder().encode(JSON.stringify(metadata));
    const bytes = new Uint8Array(8 + header.length + 8 * (model.featureCount + 2) * model.hiddenSize), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46503242, true);
    view.setUint32(4, header.length, true);
    bytes.set(header, 8);
    let offset = 8 + header.length;
    for (const row of [...inputWeights, hiddenBias, outputWeights])
        for (const v of row) {
            view.setFloat64(offset, v, true);
            offset += 8;
        }
    return bytes;
}
export function deserializeFullPolicy(bytes: Uint8Array): FullPolicyModel {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8)
        throw Error('Invalid binary policy');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46503242)
        throw Error('Invalid binary magic');
    const length = view.getUint32(4, true);
    if (length > 65536 || length + 8 > bytes.length)
        throw Error('Invalid binary header');
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as FullPolicyModel;
    const n = header.hiddenSize;
    if (header.featureCount !== FULL_FEATURE_COUNT || !Number.isSafeInteger(n) || n < 1 || n > 256 || bytes.length !== 8 + length + 8 * (FULL_FEATURE_COUNT + 2) * n)
        throw Error('Invalid binary dimensions');
    let offset = 8 + length;
    const row = () => Array.from({ length: n }, () => {
        const v = view.getFloat64(offset, true);
        offset += 8;
        return v;
    });
    const model = {
        ...header, inputWeights: Array.from({ length: FULL_FEATURE_COUNT }, row), hiddenBias: row(), outputWeights: row()
    };
    assertFullPolicy(model);
    return model;
}
