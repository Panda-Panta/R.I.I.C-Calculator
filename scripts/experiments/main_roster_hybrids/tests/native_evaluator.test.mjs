// Synthetic harness tests only. No RIIC engine import and no real native F.
import test from 'node:test'
import assert from 'node:assert/strict'
import { orderedJobIdentity, makeTrainingJob, runObservedSimulation, nativeMetadata, NATIVE_EVIDENCE_SCHEMA } from '../native_evaluator.mjs'

const engine = { source_sha256: 'source-a', bundle_sha256: 'bundle-a' }
const job = () => ({ workspace: { mainPlan: { facilities: { a: { slots: ['a', 'b'] }, b: { slots: ['c'] } } }, compatibility: { backupPlans: [] } },
  options: { warmupHours: 24, sampleHours: 72, maxStepHours: .25, production: { seed: 42, droneTarget: 'none' }, operatorInventory: [] },
  assumptions: { restingThreshold: .65, operationDurationHours: 0 } })

test('native facility/property and member order are cache identity, never canonical sorted', () => {
  const original = job(), altered = job()
  altered.workspace.mainPlan.facilities = { b: altered.workspace.mainPlan.facilities.b, a: altered.workspace.mainPlan.facilities.a }
  assert.notEqual(orderedJobIdentity(original, engine).cache_key, orderedJobIdentity(altered, engine).cache_key)
  const reorderedMembers = job(); reorderedMembers.workspace.mainPlan.facilities.a.slots.reverse()
  assert.notEqual(orderedJobIdentity(original, engine).cache_key, orderedJobIdentity(reorderedMembers, engine).cache_key)
  assert.equal(orderedJobIdentity(original, engine).jobJson, JSON.stringify(original))
})

test('window, seed, weights, assumptions and engine source isolate private cache', () => {
  const original = job(), key = orderedJobIdentity(original, engine).cache_key
  for (const alter of [value => { value.options.sampleHours = 18 }, value => { value.options.production.seed = 73 },
    value => { value.options.productionWeights = { gold: 2 } }, value => { value.assumptions.restingThreshold = .7 }]) {
    const other = job(); alter(other); assert.notEqual(key, orderedJobIdentity(other, engine).cache_key)
  }
  assert.notEqual(key, orderedJobIdentity(original, { ...engine, source_sha256: 'other-native-source' }).cache_key)
})

test('full preserves the actual ordered job; short changes actual window and remains distinct', () => {
  const template = job(), input = { fullJob: template }
  const full = makeTrainingJob(input, template.workspace, 'full', 42), short = makeTrainingJob(input, template.workspace, 'short', 42)
  assert.equal(full.status, 'ready'); assert.equal(JSON.stringify(full.job), JSON.stringify(template))
  assert.equal(short.job.options.warmupHours, 6); assert.equal(short.job.options.sampleHours, 18)
  assert.notEqual(orderedJobIdentity(full.job, engine).cache_key, orderedJobIdentity(short.job, engine).cache_key)
  assert.equal(template.options.sampleHours, 72)
})

test('unsupported seeds remain unknown without clamping; side-plan/strict flag additions rejected', () => {
  assert.deepEqual(makeTrainingJob({ fullJob: job() }, job().workspace, 'full', 43), { status: 'unsupported', reason: 'unsupported-seed', requested_seed: 43 })
  const strict = job(); strict.incomeComparison = true
  assert.equal(makeTrainingJob({ fullJob: strict }, strict.workspace).status, 'rejected')
  const wrongSeed = job(); wrongSeed.options.production.seed = 73
  assert.equal(makeTrainingJob({ fullJob: wrongSeed }, wrongSeed.workspace).reason, 'case-template-seed-is-not-42')
})

test('raw observer is same single invocation, preserves raw reference and restores previous hooks', () => {
  const raw = { report: { success: true } }, compact = { completed: true, simScore: 17 }
  let calls = 0
  const previous = () => {}; globalThis.__fullLayoutObserveResponse = previous
  const result = runObservedSimulation(value => { calls++;
    globalThis.__fullLayoutObserveCandidate(value)
    globalThis.__fullLayoutObserveBridge({ workspace: value.workspace })
    globalThis.__fullLayoutObserveEffectiveBridge({ workspace: value.workspace })
    globalThis.__fullLayoutObserveResponse(raw)
    return compact
  }, job())
  assert.equal(calls, 1); assert.equal(result.result, compact); assert.equal(result.captures.responses[0], raw)
  assert.equal(result.captures.effectiveInputs.length, 1); assert.equal(globalThis.__fullLayoutObserveResponse, previous)
  delete globalThis.__fullLayoutObserveResponse
})

test('only measured permanent primary occupancy can exempt configured workaholic fatigue', () => {
  const operator = { operatorId: 'permanent', workHours: 8, exhaustedHours: 64, restHours: 0, idleHours: 0,
    permanentPrimaryOccupancyHours: 72 }
  const report = { success: true, production: { success: true }, observedHours: 72, elapsedHours: 96,
    assumptions: { warmupHours: 24, sampleHours: 72 }, inputs: { schedule: { policies: { workaholic: ['permanent'] },
      rooms: [{ type: 'power', slots: [{ primaryOperatorId: 'permanent' }] }] } }, operators: [operator], shiftDeferrals: [] }
  const summarize = () => ({ eligible: true, issues: [] })
  assert.equal(nativeMetadata(report, summarize).ordinaryFatiguedHours, 0)
  operator.permanentPrimaryOccupancyHours = 8
  assert.equal(nativeMetadata(report, summarize).ordinaryFatiguedHours, 64)
  operator.permanentPrimaryOccupancyHours = 72
  report.inputs.schedule.rooms.push({ type: 'central', slots: [{ primaryOperatorId: 'permanent' }] })
  assert.equal(nativeMetadata(report, summarize).ordinaryFatiguedHours, 64)
})

test('analysis version isolates cached metrics while preserving the ordered native job', () => {
  const value = job()
  const old = orderedJobIdentity(value, { ...engine, analysis_schema: 'v1' })
  const current = orderedJobIdentity(value, { ...engine, analysis_schema: NATIVE_EVIDENCE_SCHEMA })
  assert.equal(old.job_json_sha256, current.job_json_sha256)
  assert.notEqual(old.cache_key, current.cache_key)
})
