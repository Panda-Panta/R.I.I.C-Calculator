/** Version 1: shared affine -> tanh -> scalar candidate scorer. No roster rules live here. */
export interface PolicySample { candidates: number[][]; targetIndex: number }
export interface PolicyParameters {
  inputWeights: number[][]
  hiddenBias: number[]
  outputWeights: number[]
  outputBias: number
}
export interface PolicyModel extends PolicyParameters {
  version: 1
  featureCount: number
  hiddenSize: number
  metadata: { seed: number; trainingUpdates: number }
}

function integer(value: unknown, minimum: number, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid ${name}`)
}
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Nonfinite ${name}`)
}
function vector(value: unknown, size: number, name: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== size) throw new Error(`Invalid ${name} dimension`)
  // Indexed iteration rejects sparse arrays as well as explicit undefined values.
  for (let i = 0; i < size; i++) finite(value[i], name)
}
function assertModel(value: unknown): asserts value is PolicyModel {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid policy model')
  const m = value as PolicyModel
  if (m.version !== 1) throw new Error('Unsupported policy model version')
  integer(m.featureCount, 1, 'featureCount'); integer(m.hiddenSize, 1, 'hiddenSize')
  if (!Array.isArray(m.inputWeights) || m.inputWeights.length !== m.hiddenSize) throw new Error('Invalid inputWeights dimension')
  for (let h = 0; h < m.hiddenSize; h++) vector(m.inputWeights[h], m.featureCount, 'inputWeights')
  vector(m.hiddenBias, m.hiddenSize, 'hiddenBias'); vector(m.outputWeights, m.hiddenSize, 'outputWeights')
  finite(m.outputBias, 'outputBias')
  if (typeof m.metadata !== 'object' || m.metadata === null) throw new Error('Invalid metadata')
  integer(m.metadata.seed, 0, 'seed')
  if (m.metadata.seed > 0xffffffff) throw new Error('Seed must be uint32')
  integer(m.metadata.trainingUpdates, 0, 'trainingUpdates')
}
/** Reject malformed/version-mismatched JSON and detach all numerical storage. */
export function validatePolicyModel(value: unknown): PolicyModel {
  assertModel(value)
  return {
    version: 1, featureCount: value.featureCount, hiddenSize: value.hiddenSize,
    inputWeights: value.inputWeights.map(row => row.slice()), hiddenBias: value.hiddenBias.slice(),
    outputWeights: value.outputWeights.slice(), outputBias: value.outputBias,
    metadata: { ...value.metadata },
  }
}
export function createPolicyModel(featureCount: number, hiddenSize: number, seed: number): PolicyModel {
  integer(featureCount, 1, 'featureCount'); integer(hiddenSize, 1, 'hiddenSize'); integer(seed, 0, 'seed')
  if (seed > 0xffffffff) throw new Error('Seed must be uint32')
  // Mulberry32; zero is a valid seed. Initialization does not use global RNG state.
  let state = seed
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
  const inputScale = Math.sqrt(6 / (featureCount + hiddenSize))
  const outputScale = Math.sqrt(6 / (hiddenSize + 1))
  return {
    version: 1, featureCount, hiddenSize,
    inputWeights: Array.from({ length: hiddenSize }, () => Array.from({ length: featureCount }, () => (2 * random() - 1) * inputScale)),
    hiddenBias: Array(hiddenSize).fill(0),
    outputWeights: Array.from({ length: hiddenSize }, () => (2 * random() - 1) * outputScale),
    outputBias: 0, metadata: { seed, trainingUpdates: 0 },
  }
}
/** Shared forward path used by inference and differentiation. */
export function policyForward(model: PolicyModel, candidates: number[][]): { logits: number[]; hidden: number[][] } {
  assertModel(model)
  if (!Array.isArray(candidates)) throw new Error('Invalid candidates')
  const hidden: number[][] = []; const logits: number[] = []
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]
    vector(row, model.featureCount, 'candidate')
    const activations: number[] = []
    let logit = model.outputBias
    for (let h = 0; h < model.hiddenSize; h++) {
      let z = model.hiddenBias[h]!
      for (let f = 0; f < model.featureCount; f++) z += model.inputWeights[h]![f]! * row[f]!
      finite(z, 'hidden preactivation')
      const a = Math.tanh(z)
      activations.push(a); logit += model.outputWeights[h]! * a
    }
    finite(logit, 'logit'); hidden.push(activations); logits.push(logit)
  }
  return { logits, hidden }
}
export function policyLogits(model: PolicyModel, candidates: number[][]): number[] {
  return policyForward(model, candidates).logits
}
