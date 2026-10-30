import { describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { simulateSchedule } from './scheduleSimulation'

describe('theoretical order-clock calendar admission', () => {
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
