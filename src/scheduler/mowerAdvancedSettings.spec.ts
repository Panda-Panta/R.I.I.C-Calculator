import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { MowerDormState, MowerSchedulingData } from './mowerSchedulingData'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from './scheduleAdapter'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { MowerOperatorState, rescueMoodThreshold, restingThresholdFor } from './mowerOperatorState'
import { mowerResting } from './mowerOrdinaryPlanning'
import { MowerTaskQueue, toMowerMicros } from './mowerTaskQueue'
import { mowerOrdinaryCoordinationNeeded } from './mowerExhaustPolicy'
import { nextMowerMoodPlanningWake } from './mowerPlanningWake'
import { createRosterRuntime } from './rosterRuntime'
import { makeMowerSchedulingData } from './mowerSourceRuntime'

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

  it('carries native group threshold ratios from imported JSON through the live scheduler', () => {
    const ws = importMowerJson(JSON.stringify({
      default: 'plan1',
      plan1: {
        room_1_1: {
          name: '制造站',
          product: 'gold',
          plans: [{ agent: '芬', group: '甲', replacement: ['香草'] }],
        },
        room_1_2: {
          name: '制造站',
          product: 'gold',
          plans: [{ agent: '克洛丝', group: '乙', replacement: ['杰西卡'] }],
        },
      },
      advanced_settings: { resting_threshold: .5, group_resting_thresholds: { 甲: .35, 乙: .65 } },
    }))
    const original = structuredClone(ws)
    const schedule = compileRosterSchedule(ws)
    const config = compiledScheduleToRuntimeConfig(schedule)
    const data = makeMowerSchedulingData(createRosterRuntime({ ...config, mowerAlpha: true }))
    expect(schedule.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(config.positions.map(p => p.shiftOffThreshold)).toEqual([8, 15])
    expect(data.policy.groupRestingThresholds).toEqual({ 甲: .35, 乙: .65 })
    expect(data.policy.groupRestingThresholds).not.toBe(config.mowerPolicy?.groupRestingThresholds)
    expect(ws).toEqual(original)
  })

  it('lets explicit group overrides replace the imported mapping without changing the local global range', () => {
    const ws = createDefaultWorkspace()
    ws.compatibility.unrecognizedFields.advanced_settings = {
      resting_threshold: .5, group_resting_thresholds: { 甲: .35, 乙: .65 },
    }
    const schedule = compileRosterSchedule(ws, { restingThreshold: 0, groupRestingThresholds: { 甲: 1 } })
    expect(schedule.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(schedule.assumptions).toMatchObject({ restingThreshold: 0, groupRestingThresholds: { 甲: 1 } })
    expect(schedule.assumptions.groupRestingThresholds).not.toHaveProperty('乙')
  })

  it.each([null, [0.4], { ' ': .5 }, { 甲: .34 }, { 甲: 1.01 }, { 甲: '0.5' }, { 甲: Infinity }])(
    'diagnoses invalid group thresholds %j before scheduling', value => {
      const ws = createDefaultWorkspace()
      ws.compatibility.unrecognizedFields.advanced_settings = { group_resting_thresholds: value }
      expect(compileRosterSchedule(ws).diagnostics).toContainEqual(expect.objectContaining({
        severity: 'error', path: 'assumptions.groupRestingThresholds',
      }))
    },
  )
})

function thresholdFixture(alpha: boolean): MowerSchedulingData {
  const operators: Record<string, MowerOperatorState> = {}
  const plan: Record<string, string[]> = { dormitory_1: Array(5).fill('Free') }
  for (const [index, group] of ['甲', '乙'].entries()) {
    const room = `room_1_${index + 1}`, cover = group + '替班'
    plan[room] = [group]
    operators[group] = new MowerOperatorState({
      name: group, group, room, index: 0, currentRoom: room, currentIndex: 0,
      replacement: [cover], operatorType: 'high', restingPriority: 'high', mood: 10, timeStampMicros: 0,
    })
    operators[cover] = new MowerOperatorState({ name: cover, timeStampMicros: 0 })
  }
  return new MowerSchedulingData({
    alpha, operators, plan, nowMicros: 0,
    dorms: [new MowerDormState(['dormitory_1', 0]), new MowerDormState(['dormitory_1', 1])],
    policy: { restingThreshold: .5, groupRestingThresholds: { 甲: .35, 乙: .65 }, rescueThreshold: .5 },
  })
}

describe('group-specific shift thresholds', () => {
  it.each([true, false])('only rests the group below its own threshold (alpha=%s)', alpha => {
    const data = thresholdFixture(alpha)
    expect(mowerOrdinaryCoordinationNeeded(data, ['甲'])).toBe(false)
    expect(mowerOrdinaryCoordinationNeeded(data, ['乙'])).toBe(true)
    const plan = mowerResting(data, new MowerTaskQueue())
    expect(plan.room_1_1).toBeUndefined()
    expect(plan.room_1_2).toEqual(['乙替班'])
    expect(data.dorms.filter(bed => bed.name).map(bed => bed.name)).toEqual(['乙'])
  })

  it('uses the same ratio in the wake and rescue calculations with global fallback', () => {
    const data = thresholdFixture(true)
    const state = createRosterRuntime({
      positions: [
        { id: 'room_1_1_0', roomId: 'room_1_1', primary: '甲', candidates: [] },
        { id: 'room_1_2_0', roomId: 'room_1_2', primary: '乙', candidates: [] },
      ],
      beds: [], initialMorale: { 甲: 10, 乙: 24 },
    })
    const rates = { workRate: () => 1, recoveryRate: () => 1 }
    expect(nextMowerMoodPlanningWake(state, data, rates)).toEqual({ timeMicros: toMowerMicros(2), names: ['甲'] })
    const op = data.operators.甲!
    op.lowerLimit = 8
    op.upperLimit = 20
    expect(rescueMoodThreshold(op, data.policy)).toBeCloseTo(10.1)
    expect(restingThresholdFor({ group: '甲', multiGroup: true }, data.policy)).toBe(.5)
    expect(restingThresholdFor({ group: 'toString' }, data.policy)).toBe(.5)
  })
})
