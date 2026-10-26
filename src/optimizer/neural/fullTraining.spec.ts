import { expect, it } from 'vitest';
import { FULL_FEATURE_COUNT, FULL_FEATURE_VERSION, FULL_FEATURE_MANIFEST_HASH, type FullEncodedDecision } from './fullFeatures';
import { createFullPolicy } from './fullPolicy';
import { fullPolicyLossAndGradient, trainFullPolicy } from './fullTraining';
const decision: FullEncodedDecision = {
    version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: [[0, .25]], candidates: [[[1, .5]], [[2, .75]]]
};
it('rejects malformed gradient models and sparse duplicate/out-of-range features', () => {
    const model = createFullPolicy({ hiddenSize: 2 });
    expect(() => fullPolicyLossAndGradient({
        ...model, version: 1
    } as never, {
        decision, targetIndex: 1
    })).toThrow();
    for (const common of [[[0, 1], [0, 2]], [[FULL_FEATURE_COUNT, 1]], [[-1, 1]]])
        expect(() => fullPolicyLossAndGradient(model, {
            decision: {
                ...decision, common: common as [
                    number,
                    number
                ][]
            }, targetIndex: 1
        })).toThrow();
});
it('polls cancellation during dataset loss pass without modifying weights', () => {
    const model = createFullPolicy({ hiddenSize: 2 }), sample = {
        decision, targetIndex: 1
    };
    let checks = 0;
    const r = trainFullPolicy(model, Array(100).fill(sample), { shouldCancel: () => ++checks === 3 });
    expect(r.diagnostics.cancelled).toBe(true);
    expect(r.diagnostics.updates).toBe(0);
    expect(checks).toBe(3);
    expect(r.model).toEqual(model);
});
it('finite-differences output weights and bias and rejects bounds', () => {
    const model = createFullPolicy({ hiddenSize: 2 }), sample = {
        decision, targetIndex: 1
    }, g = fullPolicyLossAndGradient(model, sample);
    for (const key of ['hiddenBias', 'outputWeights'] as const) {
        const v = model[key][0]!, e = 1e-5;
        model[key][0] = v + e;
        const p = fullPolicyLossAndGradient(model, sample).loss;
        model[key][0] = v - e;
        const n = fullPolicyLossAndGradient(model, sample).loss;
        model[key][0] = v;
        expect(g.gradient[key][0]).toBeCloseTo((p - n) / (2 * e), 7);
    }
    for (const options of [{ epochs: Infinity }, { maxUpdates: -1 }, { learningRate: NaN }])
        expect(() => trainFullPolicy(model, [sample], options)).toThrow();
});
it('explicit new curriculum resets only cursor and preserves cumulative updates', () => {
    const model = createFullPolicy({ hiddenSize: 2 });
    const a = trainFullPolicy(model, [{
            decision, targetIndex: 0
        }], { epochs: 2 });
    const b = trainFullPolicy(a.model, [{
            decision, targetIndex: 1
        }], {
        epochs: 1, resetCursor: true
    });
    expect(b.model.metadata.trainingUpdates).toBe(3);
    expect(b.model.metadata.resume!.epoch).toBe(1);
    expect(b.model.metadata.resume!.datasetHash).not.toBe(a.model.metadata.resume!.datasetHash);
});
it('preconditions common projection updates without changing the raw CE derivative', () => {
    const model = createFullPolicy({ hiddenSize: 2, seed: 7 });
    const sample = { decision: { ...decision, common: [[0, 20]] as [number, number][] }, targetIndex: 1 };
    const { gradient } = fullPolicyLossAndGradient(model, sample), lr = .03, scale = 1 / Math.sqrt(401);
    const result = trainFullPolicy(model, [sample], { epochs: 1, learningRate: lr, optimizer: 'common-l2-sgd-v1' });
    expect(result.model.inputWeights[0]![0]).toBeCloseTo(model.inputWeights[0]![0]! - lr * scale * gradient.inputWeights.get(0)![0]!, 14);
    expect(result.model.inputWeights[1]![0]).toBeCloseTo(model.inputWeights[1]![0]! - lr * gradient.inputWeights.get(1)![0]!, 14);
    expect(result.model.hiddenBias[0]).toBeCloseTo(model.hiddenBias[0]! - lr * scale * gradient.hiddenBias[0]!, 14);
    expect(result.model.outputWeights[0]).toBeCloseTo(model.outputWeights[0]! - lr * gradient.outputWeights[0]!, 14);
    expect(result.model.metadata.optimizerVersion).toBe('common-l2-sgd-v1');
});
it('resumes the selected optimizer exactly and rejects an implicit rule change', () => {
    const model = createFullPolicy({ hiddenSize: 2 }), samples = [{ decision, targetIndex: 1 }];
    const options = { epochs: 8, optimizer: 'common-l2-sgd-v1' } as const;
    const full = trainFullPolicy(model, samples, options);
    const part = trainFullPolicy(model, samples, { ...options, maxUpdates: 3 });
    const resumed = trainFullPolicy(part.model, samples, { epochs: 8 });
    expect(resumed.model).toEqual(full.model);
    expect(() => trainFullPolicy(part.model, samples, { epochs: 8, optimizer: 'sgd-v1' })).toThrow(/optimizer/);
    expect(() => trainFullPolicy(model, samples, { optimizer: 'unknown' } as never)).toThrow(/optimizer/);
});
