import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { MowerSchedulingData } from './mowerSchedulingData'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from './scheduleAdapter'

describe('alpha exported scheduling settings', () => {
  it('applies imported settings through compilation to runtime without mutating the document', () => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = {
      resting_threshold: .5, free_room: true, group_mood_gap_threshold_minutes: 75,
      group_mood_gap_max_extra_wait_hours: 2, group_mood_gap_exclusions: ['主班', '主班', 'saved'], drone_count_limit: 30,
      fia_fool: false, fia_threshold: .8,
    }
    const before = structuredClone(ws)
    const schedule = compileRosterSchedule(ws)
    const config = compiledScheduleToRuntimeConfig(schedule)
    expect(config.mowerPolicy).toMatchObject({ restingThreshold: .5, freeRoom: true, groupMoodGapThresholdMinutes: 75, groupMoodGapMaxExtraWaitHours: 2, groupMoodGapExclusions: ['主班', 'saved'] })
    expect(config.mowerDroneCountLimit).toBe(30)
    expect(ws).toEqual(before)
  })
  it('preserves an explicitly saved sixty-minute threshold', () => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_threshold_minutes: 60 }
    const config = compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))
    expect(config.mowerPolicy?.groupMoodGapThresholdMinutes).toBe(60)
  })
  it('lets explicit simulator assumptions override imported values', () => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: .5 }
    expect(compileRosterSchedule(ws, { restingThreshold: .8 }).assumptions.restingThreshold).toBe(.8)
  })
  it.each([0, 1441, 1.5, '60', null])('rejects invalid recovery gap %s', value => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_threshold_minutes: value }
    expect(compileRosterSchedule(ws).diagnostics.some(d => d.path === 'assumptions.groupMoodGapThresholdMinutes' && d.severity === 'error')).toBe(true)
  })
  it.each([null, 'G', [''], [' '], [1]])('rejects invalid gap exclusions %j', value => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_exclusions: value }
    expect(compileRosterSchedule(ws).diagnostics.some(d => d.path === 'assumptions.groupMoodGapExclusions' && d.severity === 'error')).toBe(true)
  })
  it('defaults the recovery spread to sixty minutes', () => {
    expect(compileRosterSchedule(createDefaultWorkspace()).assumptions.groupMoodGapThresholdMinutes).toBe(60)
    expect(new MowerSchedulingData({ plan: {}, operators: {}, dorms: [], nowMicros: 0 }).groupMoodGapThresholdMinutes).toBe(60)
    expect(new MowerSchedulingData({ plan: {}, operators: {}, dorms: [], nowMicros: 0, groupMoodGapThresholdMinutes: 75 }).groupMoodGapThresholdMinutes).toBe(75)
  })
})
