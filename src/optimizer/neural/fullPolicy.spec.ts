import { it, expect } from 'vitest';
import { FULL_FEATURE_COUNT, FULL_FEATURE_VERSION, FULL_FEATURE_MANIFEST_HASH, type FullEncodedDecision } from './fullFeatures';
import { createFullPolicy, fullPolicyLogits, validateFullPolicy } from './fullPolicy';
import { fullPolicyLossAndGradient, trainFullPolicy } from './fullTraining';
const decision: FullEncodedDecision = {
    version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: [[0, .5]], candidates: [[[1, 1]], [[2, 1]]]
};
it('validates versions, dimensions, finite values and serialization parity', () => {
    const m = createFullPolicy({
        hiddenSize: 4, seed: 7
    });
    expect(fullPolicyLogits(validateFullPolicy(JSON.parse(JSON.stringify(m))), decision)).toEqual(fullPolicyLogits(m, decision));
    expect(() => validateFullPolicy({
        ...m, version: 1
    })).toThrow();
    expect(() => fullPolicyLogits(m, {
        ...decision, manifestHash: 'bad'
    })).toThrow();
    expect(() => fullPolicyLogits(m, {
        ...decision, common: [[0, NaN]]
    })).toThrow();
});
it('differentiates both common and candidate projections', () => {
    const m = createFullPolicy({
        hiddenSize: 3, seed: 3
    }), sample = {
        decision, targetIndex: 1
    }, g = fullPolicyLossAndGradient(m, sample);
    for (const f of [0, 1, 2]) {
        const old = m.inputWeights[f]![0]!, eps = 1e-5;
        m.inputWeights[f]![0] = old + eps;
        const plus = fullPolicyLossAndGradient(m, sample).loss;
        m.inputWeights[f]![0] = old - eps;
        const minus = fullPolicyLossAndGradient(m, sample).loss;
        m.inputWeights[f]![0] = old;
        expect(g.gradient.inputWeights.get(f)![0]).toBeCloseTo((plus - minus) / (2 * eps), 7);
    }
});
it('learns, remains immutable and resumes exactly after bounded cancellation', () => {
    const m = createFullPolicy({
        hiddenSize: 4, seed: 2
    }), before = JSON.stringify(m), samples = [{
            decision, targetIndex: 1
        }, {
            decision, targetIndex: 1
        }];
    const all = trainFullPolicy(m, samples, {
        epochs: 20, learningRate: .1
    });
    expect(all.diagnostics.finalLoss).toBeLessThan(all.diagnostics.initialLoss!);
    expect(JSON.stringify(m)).toBe(before);
    const part = trainFullPolicy(m, samples, {
        epochs: 20, maxUpdates: 7, learningRate: .1
    });
    const resumed = trainFullPolicy(part.model, samples, {
        epochs: 20, learningRate: .1
    });
    expect(resumed.model).toEqual(all.model);
    const cancelled = trainFullPolicy(m, samples, { shouldCancel: () => true });
    expect(cancelled.diagnostics.updates).toBe(0);
    expect(cancelled.diagnostics.cancelled).toBe(true);
    expect(() => trainFullPolicy(part.model, [{
            decision, targetIndex: 0
        }], {
        epochs: 20, learningRate: .1
    })).toThrow();
});
it('lossless binary serialization and corruption rejection', async () => {
    const { serializeFullPolicy, deserializeFullPolicy } = await import('./fullPolicy');
    const m = createFullPolicy({
        hiddenSize: 2, seed: 9
    }), bytes = serializeFullPolicy(m);
    expect(deserializeFullPolicy(bytes)).toEqual(m);
    expect(() => deserializeFullPolicy(bytes.slice(0, -1))).toThrow();
});
