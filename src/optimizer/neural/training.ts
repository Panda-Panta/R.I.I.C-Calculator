import { policyForward, validatePolicyModel, type PolicyModel, type PolicyParameters, type PolicySample } from './policy'

export type PolicyGradient = PolicyParameters
export interface TrainPolicyOptions {
  /** Fixed dataset order. Defaults to 100; hard ceiling 100000. */
  epochs?: number
  learningRate?: number
  /** Defaults to 1000000, also the hard ceiling. */
  maxUpdates?: number
  /** Synchronous polling before each update (e.g. a shared cancellation flag). */
  shouldCancel?: () => boolean
}
export interface TrainPolicyResult {
  model: PolicyModel
  diagnostics: { updates: number; epochsCompleted: number; initialLoss: number; finalLoss: number; cancelled: boolean }
}

/** Variable-length softmax CE over supplied legal candidates only; no implicit unmasking. */
export function policyLossAndGradient(model: PolicyModel, sample: PolicySample): { loss: number; gradient: PolicyGradient } {
  if (!sample || !Array.isArray(sample.candidates) || sample.candidates.length === 0) throw new Error('Training sample requires legal candidates')
  if (!Number.isSafeInteger(sample.targetIndex) || sample.targetIndex < 0 || sample.targetIndex >= sample.candidates.length) throw new Error('Invalid teacher targetIndex')
  const { logits, hidden } = policyForward(model, sample.candidates)
  let maximum = -Infinity
  for (const logit of logits) maximum = Math.max(maximum, logit)
  const exps = logits.map(logit => Math.exp(logit - maximum))
  const sum = exps.reduce((a, b) => a + b, 0)
  const loss = (maximum - logits[sample.targetIndex]!) + Math.log(sum)
  if (!Number.isFinite(loss)) throw new Error('Nonfinite cross-entropy')
  const gradient: PolicyGradient = {
    inputWeights: Array.from({ length: model.hiddenSize }, () => Array(model.featureCount).fill(0)),
    hiddenBias: Array(model.hiddenSize).fill(0), outputWeights: Array(model.hiddenSize).fill(0), outputBias: 0,
  }
  for (let i = 0; i < logits.length; i++) {
    const delta = exps[i]! / sum - (i === sample.targetIndex ? 1 : 0)
    for (let h = 0; h < model.hiddenSize; h++) {
      const a = hidden[i]![h]!
      gradient.outputWeights[h]! += delta * a
      const dz = delta * model.outputWeights[h]! * (1 - a * a)
      gradient.hiddenBias[h]! += dz
      for (let f = 0; f < model.featureCount; f++) gradient.inputWeights[h]![f]! += dz * sample.candidates[i]![f]!
    }
  }
  // A shared scalar output bias cancels identically in softmax. Its exact gradient is zero.
  for (const x of [...gradient.inputWeights.flat(), ...gradient.hiddenBias, ...gradient.outputWeights]) {
    if (!Number.isFinite(x)) throw new Error('Nonfinite policy gradient')
  }
  return { loss, gradient }
}

export function trainPolicy(input: PolicyModel, samples: PolicySample[], options: TrainPolicyOptions = {}): TrainPolicyResult {
  const model = validatePolicyModel(input)
  const epochs = options.epochs ?? 100
  const learningRate = options.learningRate ?? 0.03
  const maxUpdates = options.maxUpdates ?? 1000000
  if (!Number.isSafeInteger(epochs) || epochs < 0 || epochs > 100000) throw new Error('Invalid epochs (0..100000)')
  if (!Number.isSafeInteger(maxUpdates) || maxUpdates < 0 || maxUpdates > 1000000) throw new Error('Invalid maxUpdates (0..1000000)')
  if (!Number.isFinite(learningRate) || learningRate <= 0) throw new Error('Invalid learningRate')
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== 'function') throw new Error('Invalid cancellation callback')
  if (!Array.isArray(samples) || !samples.length) throw new Error('Training requires samples')
  const meanLoss = () => {
    let mean = 0
    for (let i = 0; i < samples.length; i++) mean += (policyLossAndGradient(model, samples[i]!).loss - mean) / (i + 1)
    return mean
  }
  // Validate the entire dataset before cancellation or any updates; no hidden partial acceptance.
  const initialLoss = meanLoss()
  let updates = 0; let epochsCompleted = 0; let cancelled = false
  outer: for (let epoch = 0; epoch < epochs; epoch++) {
    for (const sample of samples) {
      if (options.shouldCancel?.()) { cancelled = true; break outer }
      if (updates >= maxUpdates) break outer
      const { gradient } = policyLossAndGradient(model, sample)
      for (let h = 0; h < model.hiddenSize; h++) {
        for (let f = 0; f < model.featureCount; f++) model.inputWeights[h]![f]! -= learningRate * gradient.inputWeights[h]![f]!
        model.hiddenBias[h]! -= learningRate * gradient.hiddenBias[h]!
        model.outputWeights[h]! -= learningRate * gradient.outputWeights[h]!
      }
      model.metadata.trainingUpdates++; updates++
    }
    epochsCompleted++
  }
  const finalLoss = meanLoss() // Also rejects numeric overflow in the last update.
  return { model: validatePolicyModel(model), diagnostics: { updates, epochsCompleted, initialLoss, finalLoss, cancelled } }
}
