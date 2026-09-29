import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson } from './compat/mowerJson'
import { runScheduleSimulationBridge } from './scheduleSimulationBridge'
import { mowerReportMetrics } from './mowerReportMetrics'

it('reconstructs the screenshot seven-day total from its labelled components', () => {
  const observations = JSON.parse(readFileSync(new URL('../../validation/mower-backup-2026-09-22/screenshot-observations.json', import.meta.url), 'utf8'))
  const rows = observations.dailyRows.filter((row: [string, ...number[]]) => row[0] >= observations.sevenDayWindow[0]) as [string, number, number, number, number][]
  expect(rows).toHaveLength(7)
  const mean = rows.reduce((n, [, exp, gold, orders, tequila]) => n + exp + .8 * (gold + tequila) + .2 * orders, 0) / 7
  expect(Number((mean / 10000).toFixed(2))).toBe(observations.displayedSevenDayScoreWan)
})

it('matches Mower 82 arithmetic without adding virtual gold to the ledger', () => {
  const roster = structuredClone(sourceRoster)
  roster.plan1.room_1_1.plans[1]!.agent = '绮良'
  roster.plan1.room_1_1.plans[1]!.replacement = ['龙舌兰', '能天使']
  roster.plan1.room_1_1.plans[2]!.replacement = ['蕾缪安']
  const report = runScheduleSimulationBridge(importMowerJson(JSON.stringify(roster)), {
    sampleHours: 8, warmupHours: 0,
    production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
  }, { restingThreshold: .65, freeRoom: false, fiammettaFool: false }).report!
  expect(report.success).toBe(true)
  const before = JSON.stringify(report)
  const value = mowerReportMetrics(report)!
  const premium = report.production!.events.filter(e => e.type === 'order-completed' && e.order?.kind === 'tequila').reduce((n, e) => n + e.order!.lmdReward - e.order!.goldCost * 500, 0)
  expect(premium).toBeGreaterThan(0)
  expect(value.mower82).toBeCloseTo(value.exp + .8 * (value.goldValue + value.virtualGoldValue) + .2 * value.orderLmd)
  expect(value.virtualGoldValue).toBeCloseTo(premium * 24 / report.observedHours)
  expect(JSON.stringify(report)).toBe(before)
  report.assumptions.warmupHours = report.elapsedHours
  expect(mowerReportMetrics(report)!.virtualGoldValue).toBe(0)
  report.success = false
  expect(mowerReportMetrics(report)).toBeNull()
})
