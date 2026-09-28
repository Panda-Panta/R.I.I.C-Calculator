import { it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { mowerReportMetrics } from '../workbench/mowerReportMetrics'

const root = new URL('../../validation/mower-backup-2026-09-22/', import.meta.url)
const workspace = importMowerJson(readFileSync(new URL('roster.json', root), 'utf8'))
const summaries: unknown[] = []
const scenarios = process.env.MOWER_PARITY_CONFIRMED
  ? (process.env.MOWER_PARITY_LONG ? [.65] : [.65,.675,.7]).map(restingThreshold=>({droneTarget:'exp' as const,assumptions:{restingThreshold,fiammettaFool:false}}))
  : (['none','gold','exp'] as const).map(droneTarget=>({droneTarget,assumptions:{}}))

it.each(scenarios)('records screenshot steady-window scenario: $droneTarget / $assumptions', async ({droneTarget, assumptions}) => {
  // Vitest throttles task updates by 100ms. Drain their RPC before the long
  // synchronous calculation; keep each scenario a separate reported test.
  await new Promise(resolve => setTimeout(resolve, 150))
  const result = runScheduleSimulationBridge(workspace, { warmupHours: 168, sampleHours: process.env.MOWER_PARITY_LONG ? 672 : 168, recordSegments: false, production: { outputMode: 'potential', runOrderMode: 'grandet', droneTarget, seed: Number(process.env.MOWER_PARITY_SEED ?? 42) } }, assumptions)
  if (!result.report?.success) writeFileSync(new URL('screenshot-failure.json',root),JSON.stringify(result,null,2))
  expect(result.report?.success, result.error ?? JSON.stringify(result.report?.diagnostics)).toBe(true)
  const r = result.report!
  summaries.push({ droneTarget, configuredAssumptions: assumptions, assumptions: r.assumptions, metrics: mowerReportMetrics(r), operators: r.operators, rooms: r.rooms, production: r.production, rosterEvents: r.events, diagnostics: r.diagnostics })
  writeFileSync(new URL(process.env.MOWER_PARITY_OUTPUT ?? 'screenshot-scenarios.json', root), JSON.stringify(summaries, null, 2))
}, 600000)
