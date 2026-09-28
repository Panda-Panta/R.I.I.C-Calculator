import { it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'

it('replays physical Mower task decisions and production exactly for the same order seed', async ({ annotate }) => {
  await annotate('Checking exact replay of the same order observations and scheduler inputs')
  const root = new URL('../../validation/mower-backup-2026-09-22/', import.meta.url)
  const workspace = importMowerJson(readFileSync(new URL('roster.json', root), 'utf8'))
  const reports = [42, 42].map(seed => runScheduleSimulationBridge(workspace,
    { warmupHours: 0, sampleHours: Number(process.env.MOWER_DETERMINISM_HOURS ?? 168), production: { runOrderMode: 'grandet', outputMode: 'potential', droneTarget: 'exp', seed } },
    { restingThreshold: .65, fiammettaFool: false }).report!)
  expect(reports.every(r => r.success)).toBe(true)
  const events = reports.map(r => r.events)
  writeFileSync(new URL('roster-seed-events.json', root), JSON.stringify(events, null, 2))
  expect(reports[0]!.operators).toEqual(reports[1]!.operators)
  expect(reports[0]!.production).toEqual(reports[1]!.production)
  const mismatch = Array.from({ length: Math.max(events[0]!.length, events[1]!.length) }, (_, i) => i)
    .find(i => JSON.stringify(events[0]![i]) !== JSON.stringify(events[1]![i]))
  expect(mismatch, JSON.stringify({ mismatch, pair: events.map(es => es.slice(Math.max(0,(mismatch ?? 0)-1), (mismatch ?? 0)+2)) })).toBeUndefined()
}, 360000)
