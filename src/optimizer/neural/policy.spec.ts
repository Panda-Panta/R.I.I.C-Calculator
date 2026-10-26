import { describe, expect, it } from 'vitest'
import { createPolicyModel, policyLogits, validatePolicyModel } from './policy'

describe('candidate MLP policy', () => {
  it('initializes deterministically with nonzero seed-dependent weights', () => {
    const model = createPolicyModel(2, 3, 42)
    expect(model).toEqual(createPolicyModel(2, 3, 42))
    expect(model.inputWeights.flat().some(x => x !== 0)).toBe(true)
    expect(model).not.toEqual(createPolicyModel(2, 3, 43))
  })
  it('computes a shared tanh hidden layer and preserves candidate order', () => {
    const model = createPolicyModel(2, 1, 1)
    model.inputWeights = [[2, -1]]; model.hiddenBias = [0.2]
    model.outputWeights = [3]; model.outputBias = 0.4
    const rows = [[1, 2], [0, 1]]
    expect(policyLogits(model, rows)[0]).toBeCloseTo(3 * Math.tanh(0.2) + 0.4, 14)
    expect(policyLogits(model, rows)[1]).toBeCloseTo(3 * Math.tanh(-0.8) + 0.4, 14)
    expect(policyLogits(model, rows.slice().reverse())).toEqual(policyLogits(model, rows).reverse())
    expect(policyLogits(model, [])).toEqual([])
  })
  it('roundtrips JSON exactly and returns a detached validated model', () => {
    const model = createPolicyModel(2, 3, 42)
    const restored = validatePolicyModel(JSON.parse(JSON.stringify(model)))
    expect(policyLogits(restored, [[0.2, -0.4]])).toEqual(policyLogits(model, [[0.2, -0.4]]))
    restored.inputWeights[0]![0] = 99
    expect(restored).not.toEqual(model)
  })
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid dimensions %s', value => {
    expect(() => createPolicyModel(value, 2, 1)).toThrow()
    expect(() => createPolicyModel(2, value, 1)).toThrow()
  })
  it('rejects invalid seed, model version, dimensions, metadata and nonfinite parameters', () => {
    expect(() => createPolicyModel(2, 2, NaN)).toThrow()
    const model = createPolicyModel(2, 2, 1)
    for (const invalid of [null, {}, { ...model, version: 2 }, { ...model, inputWeights: [[1]] }, { ...model, outputBias: Infinity }, { ...model, metadata: { seed: 1, trainingUpdates: -1 } }]) {
      expect(() => validatePolicyModel(invalid)).toThrow()
    }
    expect(() => policyLogits({ ...model, outputBias: NaN }, [[1, 2]])).toThrow()
  })
  it('rejects malformed candidates and arithmetic overflow', () => {
    const model = createPolicyModel(2, 2, 1)
    for (const rows of [[[1]], [[NaN, 2]], [[1, Infinity]]]) expect(() => policyLogits(model, rows)).toThrow()
    model.inputWeights[0] = [Number.MAX_VALUE, Number.MAX_VALUE]
    expect(() => policyLogits(model, [[2, 2]])).toThrow()
  })
})
