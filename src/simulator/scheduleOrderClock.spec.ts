import { describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { simulateSchedule } from './scheduleSimulation'

describe('theoretical order-clock calendar admission', () => {
  it('splits at observation-host boundaries and settles at the advanced clock', () => {
    const workspace = createDefaultWorkspace()
    for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
    const advances: number[] = [], settledTimes: number[] = []
    const report = simulateSchedule(compileRosterSchedule(workspace, { operationDurationHours: 0 }),
      { schedulingModel: 'mower-alpha', warmupHours: 0, sampleHours: .1, maxStepHours: .1 }, undefined,
      () => ({ rates: {}, diagnostics: [{ code: 'UNIT_OBSERVATION_HOST', message: 'test only' }],
        advance(hours) { advances.push(hours) }, nextStep(maximum) { return Math.min(maximum, .025) },
        settle(frame) { settledTimes.push(frame.time) } }))
    expect(report.success).toBe(true)
    expect(advances.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...advances)).toBeLessThanOrEqual(.025)
    expect(advances.reduce((sum, hours) => sum + hours, 0)).toBeCloseTo(.1, 9)
    expect(settledTimes[0]).toBe(0)
    expect(settledTimes[settledTimes.length - 1]).toBeCloseTo(.1, 9)
    expect(report.diagnostics).toContainEqual({ code: 'UNIT_OBSERVATION_HOST', message: 'test only' })
    expect(report.diagnostics.some(issue => issue.code === 'DUTY_EXPECTED_ORDER_CALENDAR')).toBe(false)
  })

  it('rejects a calendar host on a full production request before starting either host', () => {
    const schedule = compileRosterSchedule(createDefaultWorkspace()), before = structuredClone(schedule)
    const factory = vi.fn(() => ({ rates: {}, advance: vi.fn() }))
    expect(() => simulateSchedule(schedule, { schedulingModel: 'mower-alpha', production: { droneTarget: 'none' } }, undefined, factory)).toThrow(/production-off/)
    expect(factory).not.toHaveBeenCalled()
    expect(schedule).toEqual(before)
  })

  it('requires explicit alpha for the theoretical observation host', () => {
    const factory = vi.fn(() => ({ rates: {}, advance: vi.fn() }))
    expect(() => simulateSchedule(compileRosterSchedule(createDefaultWorkspace()), { schedulingModel: 'mower-default' }, undefined, factory)).toThrow(/alpha/)
    expect(factory).not.toHaveBeenCalled()
  })
})
