import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { importMowerJson, exportMowerJson } from './mowerJson'
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../../scheduler/scheduleAdapter'
import { validateRosterWorkspace } from '../validate'
import { runScheduleSimulationBridge } from '../scheduleSimulationBridge'

// Characterizes current limitations; this is not acceptance of backup execution.
// Decoded from the user's 3012 x 1236 Mower JPEG on 2026-09-22.
const decoded = readFileSync(new URL('../../../validation/mower-backup-2026-09-22/roster.json', import.meta.url), 'utf8')
const raw = JSON.parse(decoded)

describe('supplied nine-backup Mower roster', () => {
  it('imports nine plans and preserves main policies', () => {
    const workspace = importMowerJson(decoded)
    expect(workspace.compatibility.backupPlans).toHaveLength(9)
    expect(JSON.parse(exportMowerJson(workspace)).conf).toEqual(raw.conf)
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
  })
  it.each(Array.from({ length: 9 }, (_, i) => i))('preserves backup index %i including all policies and tasks', (index) => {
    const exported = JSON.parse(exportMowerJson(importMowerJson(decoded)))
    expect(exported.backup_plans[index]).toEqual(raw.backup_plans[index])
  })
  it('starts from the unchanged main plan before evaluating triggers', () => {
    const workspace = importMowerJson(decoded)
    const runtime = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace))
    workspace.compatibility.backupPlans = []
    expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace))).toEqual(runtime)
  })
  it('executes backup decisions and recovers the original alpha preview cycle', async () => {
    await new Promise(resolve=>setTimeout(resolve,150))
    const workspace = importMowerJson(decoded)
    const options = { sampleHours: 24, warmupHours: 0, maxEvents: 10000, recordSegments: true,production:{runOrderMode:'ideal' as const,outputMode:'potential' as const,droneTarget:'gold' as const,seed:42} }
    const result = runScheduleSimulationBridge(workspace, options)
    writeFileSync('validation/mower-backup-2026-09-22/implementation-evidence.json',JSON.stringify(result,null,2))
    expect(result.error).toBeUndefined()
    expect(result.report?.success).toBe(true)
    expect(result.report?.production?.success).toBe(true)
    expect(result.report?.diagnostics).toContainEqual(expect.objectContaining({code:'mower-task-exception',message:expect.stringContaining('循环')}))
    expect(result.report?.diagnostics.some(d=>d.code==='BACKUP_EXECUTION_FAILED')).toBe(false)
    expect(result.report?.elapsedHours).toBeCloseTo(24,7)
    expect(result.report?.events.some(e=>e.type==='backup-plan'&&e.active)).toBe(true)
    for(const segment of result.report!.segments){
      const ids=[...Object.values(segment.occupants),...Object.values(segment.bedOccupants)]
      expect(new Set(ids).size).toBe(ids.length)
      expect(Object.values(segment.morale).every(m=>Number.isFinite(m)&&m>=0&&m<=24)).toBe(true)
    }
    expect(result.report?.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'BACKUP_PLANS_NOT_EXECUTED' }))
    workspace.compatibility.backupPlans = []
    const baseline = runScheduleSimulationBridge(workspace, options)
    expect(baseline.report?.success).toBe(true)
    expect(result.report?.events).not.toEqual(baseline.report?.events)
    expect(result.report?.segments).not.toEqual(baseline.report?.segments)
    expect(result.report?.operators).not.toEqual(baseline.report?.operators)
    expect(result.report?.rooms).not.toEqual(baseline.report?.rooms)
  }, 300000)
})
