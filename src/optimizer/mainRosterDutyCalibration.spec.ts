import { describe, expect, it } from 'vitest'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'
import { createLedger } from '../simulator/resourceLedger'
import { createDroneState } from '../simulator/droneTimeline'
import { resolveDroneCapacity } from '../domain/droneCapacity'
import { captureOrder, getOrderDistribution } from '../rules/orderRules'
import type { CandidateSimulationJob } from './candidateSimulation'
import { integrateMainRosterDutyOutput } from './mainRosterDutyIntegration'
import type { MainRosterDutyTrajectory } from './mainRosterDutyTypes'
import { compareMainRosterDutyPrediction } from './mainRosterDutyCalibration'

function fixture() {
  const workspace = createDefaultWorkspace(), operatorId = 'char_002_amiya'
  workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId }
  const job: CandidateSimulationJob = { workspace, assumptions: { idleOperators: [] }, options: {
    schedulingModel: 'mower-alpha', sampleHours: 24, warmupHours: 0, maxStepHours: .25,
    production: { outputMode: 'potential', droneTarget: 'none', seed: 42 },
  } }
  const calendar: ScheduleSimulationReport = {
    schemaVersion: 1, engine: 'mower-morale-v1', success: true, observedHours: 24, elapsedHours: 24,
    inputs: { schedule: compileRosterSchedule(workspace, job.assumptions), options: { ...job.options, recordSegments: true } },
    assumptions: { schedulingModel: 'mower-alpha', warmupHours: 0, sampleHours: 24, maxStepHours: .25,
      warmupModel: 'continuous', restingThreshold: .65, operationDurationHours: 0, dormAtmosphere: 'fixture', singleRecoveryTarget: 'fixture' },
    operators: [{ operatorId, operatorName: '阿米娅', mainWorkHours: 12, substituteWorkHours: 0,
      workHours: 12, restHours: 6, idleHours: 6, exhaustedHours: 0, workFraction: .5,
      workRestRatio: 2, initialMorale: 24, finalMorale: 24 }],
    rooms: [], events: [], segments: [], diagnostics: [], shiftDeferrals: [],
  }
  calendar.inputs.schedule.sourceWorkspace.droneCapacity = resolveDroneCapacity(workspace)
  calendar.inputs.schedule.assumptions.droneRoom = null
  calendar.inputs.schedule.assumptions.runOrderSimulationMode = 'ideal'
  calendar.inputs.schedule.assumptions.idealRunOrderWakeOnly = true
  delete calendar.inputs.options.production
  const native = structuredClone(calendar)
  native.inputs.options = { ...structuredClone(job.options), recordSegments: false }
  Object.assign(native.operators[0]!, { mainWorkHours: 10, workHours: 10, idleHours: 8, workFraction: 10 / 24, workRestRatio: 10 / 6 })
  native.production = { success: true, ledger: createLedger({}), sample: {
    completed: { exp: 0, gold: 10, orderLmd: 0 }, opening: {}, closing: {}, inflows: {}, outflows: {}, net: {},
  }, materialsConsumed: {}, drones: createDroneState(0, 200), manufacturing: [], trading: [], events: [],
  assumptions: { outputMode: 'potential', inventoryMode: 'unlimited', seed: 42, runOrderMode: 'ideal',
    droneTarget: 'none', droneReserve: 0, collectionIntervalHours: 0, orderSnapshotPolicy: 'fixture' } }
  const trajectory: MainRosterDutyTrajectory = { status: 'complete', window: { warmupHours: 0, sampleHours: 24, maxStepHours: .25 },
    sourceKind: 'predicted-schedule', nativeScheduleParity: 'not-established', operators: calendar.operators,
    phases: [{ start: 0, end: 24, jointStateKey: 'fixture', output: { status: 'quantified',
      rates: { exp: 0, gold: .5, orderLmd: 0, virtualGold: 0, fragments: 0, orundum: 0 }, diagnostics: [], assumptions: [] } }],
    diagnostics: [], assumptions: [], cost: { scheduleOnlyCalls: 0, elapsedMs: 0, cpuMs: null, phaseEvaluations: 1 } }
  return { job, calendar, native, projection: integrateMainRosterDutyOutput(trajectory) }
}

describe('paired theoretical duty calibration', () => {
  it.each(['wrong', 'missing', 'duplicate', 'projection'] as const)('rejects %s seed evidence for a sampled calendar without running H/F', kind => {
    const f = fixture()
    const model = { code: 'DUTY_SAMPLED_OBSERVATION_CALENDAR', message: 'fixture sampled observation host' }
    f.calendar.diagnostics.push(model)
    if (kind !== 'missing') f.calendar.diagnostics.push({ code: 'DUTY_OBSERVATION_SEED', message: kind === 'wrong' ? '17' : '42' })
    if (kind === 'duplicate') f.calendar.diagnostics.push({ code: 'DUTY_OBSERVATION_SEED', message: '42' })
    f.projection.diagnostics.push(`${model.code}: ${model.message}`, `DUTY_OBSERVATION_SEED: ${kind === 'projection' ? 17 : 42}`)
    expect(compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection).status).toBe('mismatch')
  })

  it('compares a sampled calendar only when the calendar and projection bind the original seed', () => {
    const f = fixture()
    f.calendar.diagnostics.push({ code: 'DUTY_SAMPLED_OBSERVATION_CALENDAR', message: 'fixture sampled observation host' },
      { code: 'DUTY_OBSERVATION_SEED', message: '42' })
    f.projection.diagnostics.push('DUTY_SAMPLED_OBSERVATION_CALENDAR: fixture sampled observation host', 'DUTY_OBSERVATION_SEED: 42')
    expect(compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection).status).toBe('comparable')
  })

  it('separates waiting, work share, work/rest ratio and resource errors', () => {
    const f = fixture(), before = structuredClone(f)
    const result = compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection)
    expect(result.status).toBe('comparable')
    expect(result.operators[0]!.hours.workHours.difference).toBe(2)
    expect(result.operators[0]!.hours.idleHours.difference).toBe(-2)
    expect(result.operators[0]!.workFractionPercentagePoints).toBeCloseTo(100 * 2 / 24)
    expect(result.resources.gold!.relative).toBeCloseTo(.2)
    expect(result.resources.orderLmd!.relative).toBeNull()
    expect(result.crossRoomJointParity).toBe('not-observed')
    expect(result.nativeScheduleParity).toBe('not-established')
    expect(f).toEqual(before)
  })

  it.each(['seed', 'inventory', 'policy', 'options', 'window'] as const)('rejects a mismatched %s reference instead of reporting accuracy', kind => {
    const f = fixture()
    if (kind === 'seed') f.native.inputs.options.production!.seed = 43
    if (kind === 'inventory') f.native.inputs.options.operatorInventory = [{ operator: '阿米娅', elitePhase: 2, level: 80 }]
    if (kind === 'policy') f.native.inputs.schedule.runOrderPolicies = [{ roomId: 'room_1_1', orderedOperatorIds: ['但书'] }]
    if (kind === 'options') f.native.inputs.options.recoveryOverrides = { 阿米娅: 9 }
    if (kind === 'window') f.native.observedHours = 23
    const result = compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection)
    expect(result.status).not.toBe('comparable')
    expect(result.operators).toEqual([])
    expect(result.resources).toEqual({})
  })

  it('does not turn an observed replay into a prediction benchmark', () => {
    const f = fixture()
    f.projection.predictionEligible = false
    expect(compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection).status).toBe('invalid')
  })

  it('uses completed-order virtual gold from the shared Native output contract', () => {
    const f = fixture()
    f.native.production!.sample.completed.orderLmd = 1200
    f.native.production!.events.push({ type: 'order-completed', time: 12, roomId: 'room_1_1',
      order: { ...captureOrder(getOrderDistribution(1, 'normal', 'closure')[0]!, { closure: true }, 12), id: 'fixture-order', startedAt: 1 } })
    const result = compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection)
    expect(result.resources.virtualGold!.observed).toBe(.4)
    expect(result.score!.observed).toBe(4400)
  })

  it('rejects nonconserved operator hours and retains no-rest as unknown', () => {
    const f = fixture()
    Object.assign(f.native.operators[0]!, { restHours: 0, idleHours: 14, workRestRatio: null })
    const result = compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection)
    expect(result.status).toBe('comparable')
    expect(result.operators[0]!.workRestRatio.observed).toBeNull()
    f.native.operators[0]!.idleHours = 15
    expect(compareMainRosterDutyPrediction(f.job, f.calendar, f.native, f.projection).status).toBe('invalid')
  })
})
