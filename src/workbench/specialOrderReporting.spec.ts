import { describe, expect, it } from 'vitest'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson } from './compat/mowerJson'
import { runCalculationBridge } from './calculationBridge'
import { mowerReportMetrics } from './mowerReportMetrics'
import { virtualGoldEquivalent } from '../rules/orderValue'

describe('main calculation reports special orders from trading replacements', () => {
  it.each([
    { runner: '可露希尔', kind: 'closure', each: .4 },
    { runner: '佩佩', kind: 'pepe', each: 2 },
    { runner: '龙舌兰', kind: 'tequila', each: 1 },
  ])('$runner', ({ runner, kind, each }) => {
    const roster = structuredClone(sourceRoster)
    const slots = roster.plan1.room_1_1.plans
    slots[1]!.agent = '绮良'
    slots[1]!.replacement = ['能天使', runner]
    slots[2]!.replacement = ['蕾缪安']
    const result = runCalculationBridge(importMowerJson(JSON.stringify(roster)), {
      engine: 'simulation',
      simulationOptions: {
        warmupHours: 0, sampleHours: 8, recordSegments: true,
        production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
      },
      simulationAssumptions: { restingThreshold: .65, freeRoom: false, fiammettaFool: false },
    })
    expect(result.success, result.error).toBe(true)
    const sim = result.simulationReport!
    const completed = sim.production!.events.filter(event => event.type === 'order-completed' && event.time > 0 && event.time <= 8)
    const special = completed.filter(event => event.order?.kind === kind)
    expect(special.length).toBeGreaterThan(0)
    expect(special.every(event => virtualGoldEquivalent(event.order!) === each)).toBe(true)

    const days = sim.observedHours / 24
    const expectedVirtual = completed.reduce((sum, event) => sum + (event.order ? virtualGoldEquivalent(event.order) : 0), 0) / days
    expect(result.report!.summary!.virtualGoldCount).toBeCloseTo(expectedVirtual)
    expect(result.report!.summary!.virtualGoldValue).toBeCloseTo(expectedVirtual * 500)
    expect(result.report!.summary!.goldCount).toBeCloseTo(sim.production!.sample.completed.gold / days)
    expect(mowerReportMetrics(sim)!.virtualGoldCount).toBeCloseTo(expectedVirtual)
    expect(mowerReportMetrics(sim)!.orderDistribution[kind]?.count).toBe(special.length)
  }, 30000)
})
