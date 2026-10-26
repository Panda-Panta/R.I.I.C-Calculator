import { describe, expect, it } from 'vitest'
import { createPolicyModel, type PolicySample } from './policy'
import { policyLossAndGradient, trainPolicy } from './training'

const samples: PolicySample[] = [
  { candidates: [[1, 0], [-1, 0]], targetIndex: 0 },
  { candidates: [[-0.5, 1], [0, 0], [0.8, -1]], targetIndex: 2 },
]
describe('candidate softmax imitation training', () => {
  it('matches finite differences for every parameter', () => {
    const model = createPolicyModel(2, 2, 4)
    const sample = samples[1]!
    const { gradient, loss } = policyLossAndGradient(model, sample)
    expect(loss).toBeGreaterThan(0)
    const epsilon = 1e-5
    const check = (get: () => number, set: (x: number) => void, expected: number) => {
      const before = get(); set(before + epsilon)
      const plus = policyLossAndGradient(model, sample).loss
      set(before - epsilon)
      const minus = policyLossAndGradient(model, sample).loss
      set(before)
      expect(expected).toBeCloseTo((plus - minus) / (2 * epsilon), 7)
    }
    for (let h = 0; h < model.hiddenSize; h++) {
      for (let f = 0; f < model.featureCount; f++) check(() => model.inputWeights[h]![f]!, x => { model.inputWeights[h]![f] = x }, gradient.inputWeights[h]![f]!)
      check(() => model.hiddenBias[h]!, x => { model.hiddenBias[h] = x }, gradient.hiddenBias[h]!)
      check(() => model.outputWeights[h]!, x => { model.outputWeights[h] = x }, gradient.outputWeights[h]!)
    }
    check(() => model.outputBias, x => { model.outputBias = x }, gradient.outputBias)
  })
  it('learns variable length choices without mutating model or samples, deterministically', () => {
    const model = createPolicyModel(2, 4, 5)
    const before = JSON.stringify({ model, samples })
    const result = trainPolicy(model, samples, { epochs: 150, learningRate: 0.1 })
    expect(result.diagnostics.finalLoss).toBeLessThan(result.diagnostics.initialLoss * 0.1)
    expect(result.model.inputWeights).not.toEqual(model.inputWeights)
    expect(result.diagnostics.updates).toBe(300)
    expect(result.model.metadata.trainingUpdates).toBe(300)
    expect(JSON.stringify({ model, samples })).toBe(before)
    expect(result).toEqual(trainPolicy(model, samples, { epochs: 150, learningRate: 0.1 }))
  })
  it('has zero loss and gradient for a single legal choice', () => {
    const result = policyLossAndGradient(createPolicyModel(2, 2, 1), { candidates: [[1, 2]], targetIndex: 0 })
    expect(result.loss).toBe(0)
    expect(result.gradient.inputWeights.flat().every(x => x === 0)).toBe(true)
  })
  it('honors bounded updates and cancellation before and during training', () => {
    const model = createPolicyModel(2, 2, 1)
    expect(trainPolicy(model, samples, { maxUpdates: 3 }).diagnostics.updates).toBe(3)
    const cancelled = trainPolicy(model, samples, { shouldCancel: () => true })
    expect(cancelled.model).toEqual(model)
    expect(cancelled.diagnostics).toMatchObject({ updates: 0, cancelled: true })
    let calls = 0
    expect(trainPolicy(model, samples, { shouldCancel: () => ++calls > 3 }).diagnostics).toMatchObject({ updates: 3, cancelled: true })
  })
  it('rejects malformed samples and invalid options even when already cancelled', () => {
    const model = createPolicyModel(2, 2, 1)
    for (const invalid of [[], [{ candidates: [], targetIndex: 0 }], [{ candidates: [[1, 2]], targetIndex: 1 }], [{ candidates: [[NaN, 2]], targetIndex: 0 }]]) expect(() => trainPolicy(model, invalid, { shouldCancel: () => true })).toThrow()
    for (const options of [{ epochs: -1 }, { epochs: 1.2 }, { learningRate: 0 }, { learningRate: Infinity }, { maxUpdates: -1 }]) expect(() => trainPolicy(model, samples, options)).toThrow()
  })
  it('allows zero epochs and yields finite stable loss for widely separated logits', () => {
    const model = createPolicyModel(2, 2, 1)
    model.outputWeights = [1000, -1000]
    expect(Number.isFinite(policyLossAndGradient(model, samples[0]!).loss)).toBe(true)
    expect(trainPolicy(model, samples, { epochs: 0 }).model).toEqual(model)
  })
})

describe('serialized continuation and numeric boundaries', () => {
  it('resumes fixed-order SGD exactly at epoch boundaries after JSON restore', () => {
    const model = createPolicyModel(2, 3, 0)
    const first = trainPolicy(model, samples, { epochs: 2 })
    const resumed = trainPolicy(JSON.parse(JSON.stringify(first.model)), samples, { epochs: 3 })
    expect(resumed.model).toEqual(trainPolicy(model, samples, { epochs: 5 }).model)
    expect(resumed.diagnostics.epochsCompleted).toBe(3)
  })
  it('rejects sparse vectors and nonfinite gradients without mutating input', () => {
    const model = createPolicyModel(2, 2, 1)
    expect(() => trainPolicy(model, [{ candidates: [Array(2)], targetIndex: 0 }])).toThrow()
    model.outputWeights = [Number.MAX_VALUE, Number.MAX_VALUE]
    model.inputWeights = [[0, 0], [0, 0]]
    const before = JSON.stringify(model)
    expect(() => trainPolicy(model, [{ candidates: [[Number.MAX_VALUE, 0], [-Number.MAX_VALUE, 0]], targetIndex: 0 }])).toThrow()
    expect(JSON.stringify(model)).toBe(before)
  })
})
