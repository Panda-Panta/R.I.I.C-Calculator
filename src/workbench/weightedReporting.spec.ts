import { expect, it } from 'vitest'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson } from './compat/mowerJson'
import { runCalculationBridge } from './calculationBridge'
import { mowerReportMetrics } from './mowerReportMetrics'
import { simulateCandidate } from '../optimizer/candidateSimulation'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { calculate } from '../engine/calculate'
import { projectControlOutput } from '../optimizer/controlImpact'
import { createDefaultWorkspace } from './defaults'

it('shares weights and virtual gold across calculation, log and optimizer scores', () => {
  const roster = structuredClone(sourceRoster)
  roster.backup_plans = []
  roster.plan1.room_1_1.plans[1]!.replacement = ['可露希尔', '能天使']
  const workspace = importMowerJson(JSON.stringify(roster))
  workspace.productionWeights = { exp: 2, gold: .5, orders: .3, fragments: 4, orundum: 5 }
  const options = { sampleHours: 8, warmupHours: 0, production: { outputMode: 'potential' as const, runOrderMode: 'ideal' as const, droneTarget: 'none' as const, seed: 42 } }
  const assumptions = { restingThreshold: .65, freeRoom: false, fiammettaFool: false }
  const result = runCalculationBridge(workspace, { engine: 'simulation', simulationOptions: options, simulationAssumptions: assumptions })
  expect(result.success, result.error).toBe(true)
  const summary = result.report!.summary!
  expect(summary.virtualGoldCount).toBeGreaterThan(0)
  const want = 2 * summary.exp + .5 * (summary.goldValue + summary.virtualGoldValue) + .3 * summary.orderLmd + 4 * summary.fragments + 5 * summary.orundum
  expect(summary.totalScore82).toBeCloseTo(want)
  expect(mowerReportMetrics(result.simulationReport!)!.mower82).toBeCloseTo(want)
  expect(simulateCandidate({ workspace, options, assumptions }).simScore).toBeCloseTo(want)
}, 30000)

it('weights fragment and orundum output in both static projection and calculation', () => {
  const config = createDefaultConfig()
  config.rooms = [createRoom('M', 'manufacture'), createRoom('T', 'trading'), createRoom('P1', 'power'), createRoom('P2', 'power'), createRoom('P3', 'power')]
  config.rooms[0]!.product = 'fragment'
  config.rooms[1]!.strategy = 'orundum'
  config.productionWeights = { exp: 0, gold: 0, orders: 0, fragments: 4, orundum: 5 }
  config.droneTarget = 'none'
  const projection = projectControlOutput(config)
  expect(projection.complete, projection.diagnostics.join(';')).toBe(true)
  expect(projection.daily.score).toBeGreaterThan(0)
  const summary = calculate(config).summary!
  expect(summary.totalScore82).toBeCloseTo(4 * summary.fragments + 5 * summary.orundum)
})

it('uses explicit valid simulation weights instead of invalid stale workspace weights', () => {
  const workspace = createDefaultWorkspace()
  workspace.productionWeights = { exp: -1, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  const result = runCalculationBridge(workspace, { engine: 'simulation', simulationOptions: {
    warmupHours: 0, sampleHours: 2,
    productionWeights: { exp: 1, gold: 0, orders: 0, fragments: 0, orundum: 0 },
    production: { outputMode: 'potential', droneTarget: 'none', seed: 42 },
  } })
  expect(result.success, result.error).toBe(true)
  expect(result.report!.summary!.totalScore82).toBe(result.report!.summary!.exp)
}, 30000)
