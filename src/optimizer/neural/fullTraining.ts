import { fullFingerprint, validateFullDecision, type FullEncodedDecision } from './fullFeatures';
import { assertFullPolicy, validateFullPolicy, fullPolicyForwardUnchecked, type FullPolicyModel, type FullOptimizerVersion } from './fullPolicy';
export interface FullPolicySample {
    decision: FullEncodedDecision;
    targetIndex: number;
}
export interface FullPolicyGradient {
    inputWeights: Map<number, number[]>;
    hiddenBias: number[];
    outputWeights: number[];
}
function sampleCheck(s: FullPolicySample) {
    validateFullDecision(s.decision);
    if (!Number.isSafeInteger(s.targetIndex) || s.targetIndex < 0 || s.targetIndex >= s.decision.candidates.length)
        throw Error('Invalid targetIndex');
}
/** Sparse backprop: common projection differentiated only once per decision. */
export function fullPolicyLossAndGradient(m: FullPolicyModel, s: FullPolicySample): {
    loss: number;
    gradient: FullPolicyGradient;
} {
    assertFullPolicy(m);
    return lossAndGradientUnchecked(m, s);
}
function lossAndGradientUnchecked(m: FullPolicyModel, s: FullPolicySample): {
    loss: number;
    gradient: FullPolicyGradient;
} {
    sampleCheck(s);
    const { logits, hidden } = fullPolicyForwardUnchecked(m, s.decision), max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max)), sum = exps.reduce((a, b) => a + b, 0), loss = max - logits[s.targetIndex]! + Math.log(sum), n = m.hiddenSize;
    const gradient: FullPolicyGradient = {
        inputWeights: new Map(), hiddenBias: Array(n).fill(0), outputWeights: Array(n).fill(0)
    };
    const add = (f: number, v: number, dz: number[]) => {
        let row = gradient.inputWeights.get(f);
        if (!row) {
            row = Array(n).fill(0);
            gradient.inputWeights.set(f, row);
        }
        for (let h = 0; h < n; h++)
            row[h]! += v * dz[h]!;
    };
    for (let i = 0; i < logits.length; i++) {
        const delta = exps[i]! / sum - Number(i === s.targetIndex), a = hidden[i]!, dz = Array<number>(n);
        for (let h = 0; h < n; h++) {
            gradient.outputWeights[h]! += delta * a[h]!;
            dz[h] = delta * m.outputWeights[h]! * (1 - a[h]! * a[h]!);
            gradient.hiddenBias[h]! += dz[h]!;
        }
        for (const [f, v] of s.decision.candidates[i]!)
            add(f, v, dz);
    }
    for (const [f, v] of s.decision.common)
        add(f, v, gradient.hiddenBias);
    if (!Number.isFinite(loss) || ![...gradient.inputWeights.values(), gradient.hiddenBias, gradient.outputWeights].every(row => row.every(Number.isFinite)))
        throw Error('Nonfinite gradient');
    return {
        loss, gradient
    };
}
export interface TrainFullPolicyOptions {
    epochs?: number;
    learningRate?: number;
    /** Update geometry only; the exported CE derivative remains the exact raw gradient. */
    optimizer?: FullOptimizerVersion;
    maxUpdates?: number;
    shouldCancel?: () => boolean; /** Explicitly start a fresh cursor for a new curriculum. */
    resetCursor?: boolean;
}
export function trainFullPolicy(input: FullPolicyModel, samples: FullPolicySample[], options: TrainFullPolicyOptions = {}) {
    const model = validateFullPolicy(input), epochs = options.epochs ?? 100, lr = options.learningRate ?? .03, maxUpdates = options.maxUpdates ?? 1000000;
    if (!Number.isSafeInteger(epochs) || epochs < 0 || epochs > 100000 || !Number.isSafeInteger(maxUpdates) || maxUpdates < 0 || maxUpdates > 1000000 || !Number.isFinite(lr) || lr <= 0 || lr > 10 || (options.shouldCancel !== undefined && typeof options.shouldCancel !== 'function'))
        throw Error('Invalid training bounds');
    if (!Array.isArray(samples) || !samples.length)
        throw Error('No training samples');
    for (const s of samples)
        sampleCheck(s);
    const optimizer = options.optimizer ?? model.metadata.optimizerVersion ?? 'sgd-v1';
    if (optimizer !== 'sgd-v1' && optimizer !== 'common-l2-sgd-v1') throw Error('Invalid optimizer');
    const datasetHash = fullFingerprint(samples.map(fullFingerprint)), previous = options.resetCursor ? undefined : model.metadata.resume;
    if (previous && (previous.datasetHash !== datasetHash || previous.learningRate !== lr || (previous.optimizerVersion ?? 'sgd-v1') !== optimizer || previous.sampleIndex >= samples.length))
        throw Error('Resume dataset/optimizer mismatch');
    let epoch = previous?.epoch ?? 0, sampleIndex = previous?.sampleIndex ?? 0, updates = 0, cancelled = false;
    const meanLoss = () => {
        let sum = 0;
        for (const s of samples) {
            if (options.shouldCancel?.()) {
                cancelled = true;
                return null;
            }
            const z = fullPolicyForwardUnchecked(model, s.decision).logits, max = Math.max(...z);
            sum += max - z[s.targetIndex]! + Math.log(z.reduce((a, x) => a + Math.exp(x - max), 0));
        }
        return sum / samples.length;
    };
    // Poll before expensive loss passes too: cancelled calls perform no numerical training work.
    if (options.shouldCancel?.())
        return {
            model, diagnostics: {
                updates, epochsCompleted: epoch, initialLoss: null, finalLoss: null, cancelled: true, datasetHash
            }
        };
    const initialLoss = meanLoss();
    if (cancelled)
        return {
            model, diagnostics: {
                updates, epochsCompleted: epoch, initialLoss, finalLoss: null, cancelled, datasetHash
            }
        };
    while (epoch < epochs && updates < maxUpdates) {
        if (options.shouldCancel?.()) {
            cancelled = true;
            break;
        }
        const sample = samples[sampleIndex]!;
        const { gradient } = lossAndGradientUnchecked(model, sample);
        // A shared context of norm ~20 amplifies vanilla SGD's common projection
        // step by ~400. Scale only its contribution, retaining candidate gradients.
        const common = new Map(sample.decision.common);
        const commonScale = optimizer === 'common-l2-sgd-v1'
            ? 1 / Math.sqrt(1 + sample.decision.common.reduce((sum, [, value]) => sum + value * value, 0))
            : 1;
        for (const [f, row] of gradient.inputWeights) {
            const correction = (commonScale - 1) * (common.get(f) ?? 0);
            for (let h = 0; h < model.hiddenSize; h++)
                model.inputWeights[f]![h]! -= lr * (row[h]! + correction * gradient.hiddenBias[h]!);
        }
        for (let h = 0; h < model.hiddenSize; h++) {
            model.hiddenBias[h]! -= lr * commonScale * gradient.hiddenBias[h]!;
            model.outputWeights[h]! -= lr * gradient.outputWeights[h]!;
        }
        updates++;
        model.metadata.trainingUpdates++;
        sampleIndex++;
        if (sampleIndex === samples.length) {
            sampleIndex = 0;
            epoch++;
        }
    }
    model.metadata.optimizerVersion = optimizer;
    model.metadata.resume = {
        datasetHash, optimizerVersion: optimizer, learningRate: lr, epoch, sampleIndex
    };
    const finalLoss = meanLoss();
    if (finalLoss !== null && !Number.isFinite(finalLoss))
        throw Error('Nonfinite final loss');
    assertFullPolicy(model);
    return {
        model, diagnostics: {
            updates, epochsCompleted: epoch, initialLoss, finalLoss, cancelled, datasetHash
        }
    };
}
