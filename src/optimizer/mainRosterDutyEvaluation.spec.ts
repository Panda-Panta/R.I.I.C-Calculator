import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import * as simulation from '../simulator/scheduleSimulation'
import type { ScheduleSimulationReport, SimulatedOperator } from '../simulator/scheduleSimulation'
import { scoreSimulationProduction } from '../simulator/productionScore'
import { createLedger } from '../simulator/resourceLedger'
import { createDroneState } from '../simulator/droneTimeline'
import { summarizeIncome } from './incomeComparison'
import { evaluateMainRosterDuty } from './mainRosterDutyEvaluation'

const operatorId = 'char_002_amiya'

/** A report-shaped fixture; constructing it never executes a roster or production calendar. */
function report(): ScheduleSimulationReport {
  const workspace = createDefaultWorkspace()
  workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId }
  const schedule = compileRosterSchedule(workspace, { idleOperators: [] })
  return {
    schemaVersion: 1, engine: 'mower-morale-v1', success: true, elapsedHours: 96, observedHours: 72,
    inputs: { schedule, options: { schedulingModel: 'mower-alpha', warmupHours: 24, sampleHours: 72,
      production: { seed: 42, droneTarget: 'none', outputMode: 'potential' },
      productionWeights: { exp: 3, gold: 4, orders: 5, fragments: 6, orundum: 7 } } },
    assumptions: { schedulingModel: 'mower-alpha', warmupHours: 24, sampleHours: 72,
      maxStepHours: .25, warmupModel: 'continuous', restingThreshold: .65, operationDurationHours: 0,
      dormAtmosphere: 'fixture', singleRecoveryTarget: 'fixture' },
    operators: [{ operatorId, operatorName: '阿米娅', initialMorale: 24, finalMorale: 12,
      mainWorkHours: 30, substituteWorkHours: 6, workHours: 36, exhaustedHours: 0, restHours: 12,
      idleHours: 24, permanentPrimaryOccupancyHours: 0, workFraction: .5, workRestRatio: 3 }],
    rooms: [], events: [], segments: [], diagnostics: [], shiftDeferrals: [],
    production: { success: true, ledger: createLedger({}),
      sample: { completed: { exp: 9000, gold: 12, orderLmd: 30000 },
        opening: {}, closing: {}, inflows: {}, outflows: {}, net: {} },
      materialsConsumed: {}, drones: createDroneState(0, 200), manufacturing: [], trading: [], events: [],
      assumptions: { outputMode: 'potential', inventoryMode: 'unlimited', seed: 42, runOrderMode: 'ideal',
        droneTarget: 'none', droneReserve: 0, collectionIntervalHours: 0, orderSnapshotPolicy: 'fixture' } },
  }
}

function exhausted(value: ScheduleSimulationReport): SimulatedOperator {
  const op = value.operators[0]!
  Object.assign(op, { mainWorkHours: 0, substituteWorkHours: 0, workHours: 0, exhaustedHours: 72,
    restHours: 0, idleHours: 0, workFraction: 0, workRestRatio: null, initialMorale: 0, finalMorale: 0 })
  return op
}

afterEach(() => vi.restoreAllMocks())

describe('same-run native main-roster duty evaluation', () => {
  it('uses measured effective work, physical occupancy and distinct W/R and W/T with the shared score', () => {
    const value = report(), before = structuredClone(value)
    const calendar = vi.spyOn(simulation, 'simulateSchedule').mockImplementation(() => { throw new Error('no new F or H') })
    const result = evaluateMainRosterDuty(value, value.inputs.schedule.sourceWorkspace)
    expect(result).toMatchObject({ eligible: true, strict: true, ordinaryExhaustedHours: 0,
      pendingDeferrals: 0, observedHours: 72, windowCompleted: true, issues: [] })
    expect(result.operators[0]).toMatchObject({ operatorId, effectiveWorkHours: 36, physicalDutyHours: 36,
      exhaustedHours: 0, restHours: 12, idleHours: 24, workRestRatio: 3, workFraction: .5,
      permanent: false, permanentExhaustionExempt: false })
    expect(result.incomeCase?.output?.daily).toEqual(scoreSimulationProduction(value))
    expect(result.incomeCase).toEqual(summarizeIncome(value))
    expect(value).toEqual(before)
    expect(calendar).not.toHaveBeenCalled()
  })

  it('requires measured permanent occupancy rather than a workaholic name or a zero-morale initial state', () => {
    const ordinary = report(); exhausted(ordinary).operatorName = 'Lancet-2'
    expect(evaluateMainRosterDuty(ordinary)).toMatchObject({ eligible: false, strict: false, ordinaryExhaustedHours: 72 })
    const configured = report(); exhausted(configured)
    configured.inputs.schedule.policies.workaholic = [operatorId]
    expect(evaluateMainRosterDuty(configured)).toMatchObject({ eligible: false, ordinaryExhaustedHours: 72 })
    const permanent = structuredClone(configured)
    permanent.operators[0]!.permanentPrimaryOccupancyHours = 72
    expect(evaluateMainRosterDuty(permanent)).toMatchObject({ eligible: true, strict: true, ordinaryExhaustedHours: 0 })
    expect(evaluateMainRosterDuty(permanent).operators[0]).toMatchObject({ effectiveWorkHours: 0,
      physicalDutyHours: 72, workFraction: 0, workRestRatio: null, permanent: true, permanentExhaustionExempt: true })
    permanent.operators[0]!.permanentPrimaryOccupancyHours = 71
    expect(evaluateMainRosterDuty(permanent)).toMatchObject({ eligible: false, ordinaryExhaustedHours: 72 })
  })

  it('recognizes measured workaholic primary duty when the group also leaves the operator idle', () => {
    const value = report(), op = exhausted(value)
    value.inputs.schedule.policies.workaholic = [operatorId]
    Object.assign(op, { mainWorkHours: 24, workHours: 24, exhaustedHours: 36,
      restHours: 0, idleHours: 12, permanentPrimaryOccupancyHours: 60, workFraction: 1 / 3 })
    const result = evaluateMainRosterDuty(value)
    expect(result.ordinaryExhaustedHours).toBe(0)
    expect(result.operators[0]!.permanentExhaustionExempt).toBe(true)
    op.permanentPrimaryOccupancyHours = 59
    expect(evaluateMainRosterDuty(value).ordinaryExhaustedHours).toBe(36)
  })

  it('accepts an uninterrupted global name policy independently of partial primary coverage', () => {
    const value = report(), workspace = value.inputs.schedule.sourceWorkspace
    workspace.mainPlan.conf.workaholic = [operatorId]
    workspace.compatibility.backupPlans = [{ name: 'additive-empty-policy', trigger: 'True', plan: {}, task: {},
      conf: { workaholic: '', removed_operators: {} } }]
    value.inputs.schedule = compileRosterSchedule(workspace, { idleOperators: [] })
    const op = exhausted(value)
    Object.assign(op, { mainWorkHours: 24, workHours: 24, exhaustedHours: 36, idleHours: 12,
      workFraction: 1 / 3, permanentPrimaryOccupancyHours: 60 - 22 / 3600 })
    const before = structuredClone(value)
    expect(evaluateMainRosterDuty(value)).toMatchObject({ eligible: true, strict: true, ordinaryExhaustedHours: 0 })
    expect(evaluateMainRosterDuty(value).operators[0]?.permanentExhaustionExempt).toBe(true)
    expect(value).toEqual(before)
  })

  it('does not infer uninterrupted permission when a backup can revoke the original workaholic name', () => {
    const value = report(), workspace = value.inputs.schedule.sourceWorkspace
    workspace.mainPlan.conf.workaholic = [operatorId]
    workspace.compatibility.backupPlans = [{ name: 'possible-revocation', trigger: 'True', plan: {}, task: {},
      conf: { removed_operators: { workaholic: [operatorId] } } }]
    value.inputs.schedule = compileRosterSchedule(workspace, { idleOperators: [] })
    const op = exhausted(value)
    op.permanentPrimaryOccupancyHours = 72 - 22 / 3600
    const result = evaluateMainRosterDuty(value)
    expect(result).toMatchObject({ eligible: false, strict: false, ordinaryExhaustedHours: 72 })
    expect(result.operators[0]?.permanentExhaustionExempt).toBe(false)
  })

  it('uses the actual passive auxiliary permanent policy while preserving the stricter income verdict', () => {
    const value = report(), op = exhausted(value)
    const room = value.inputs.schedule.rooms.find(room => room.roomId === 'room_1_1')!
    const auxiliary = value.inputs.schedule.rooms.find(room => room.roomId === 'factory')!
    auxiliary.slots[0] = { ...room.slots[0]!, roomId: 'factory' }
    room.slots[0] = { ...room.slots[0]!, primaryOperatorId: null, occupant: { kind: 'empty' } }
    op.permanentPrimaryOccupancyHours = 72
    const result = evaluateMainRosterDuty(value)
    expect(result).toMatchObject({ eligible: false, strict: false, ordinaryExhaustedHours: 0 })
    expect(result.operators[0]).toMatchObject({ permanent: true, permanentExhaustionExempt: true })
    expect(result.issues).toContain('存在疲劳占岗')
    auxiliary.slots[0]!.groupId = 'real-recovery-group'
    expect(evaluateMainRosterDuty(value).ordinaryExhaustedHours).toBe(72)
  })

  it('never exempts duplicate primary bindings even with a full-window permanent counter', () => {
    const value = report(), op = exhausted(value), room = value.inputs.schedule.rooms.find(room => room.roomId === 'room_1_1')!
    value.inputs.schedule.policies.workaholic = [operatorId]
    op.permanentPrimaryOccupancyHours = 72
    room.slots[1] = { ...room.slots[0]!, slotIndex: 1 }
    expect(evaluateMainRosterDuty(value)).toMatchObject({ eligible: false, ordinaryExhaustedHours: 72 })
  })

  it('separates terminal deferrals from ordinary fatigue and never erases strict=false', () => {
    const value = report()
    value.shiftDeferrals = [{ key: 'group:automation', operatorIds: [operatorId], blockedAt: 95.99 }]
    value.diagnostics.push({ code: 'group-blocked', message: 'group:automation: insufficient available candidates or beds; original occupants retained' })
    const result = evaluateMainRosterDuty(value)
    expect(result).toMatchObject({ eligible: false, strict: false, ordinaryExhaustedHours: 0, pendingDeferrals: 1 })
    expect(result.issues.some(issue => issue.includes('group-blocked'))).toBe(true)
    expect(result.issues.some(issue => issue.includes('期末尚未确认恢复'))).toBe(true)
    value.diagnostics = []
    expect(evaluateMainRosterDuty(value)).toMatchObject({ eligible: false, pendingDeferrals: 1 })
  })

  it('accepts complete resolved episodes without requiring sample-only events to prove warmup history', () => {
    const value = report()
    value.shiftDeferrals = [{ key: 'group:resolved', operatorIds: [operatorId], blockedAt: 4, resolvedAt: 8 }]
    value.diagnostics.push({ code: 'SHIFT_DEFERRED_RECOVERED', message: 'group:resolved: recovered' })
    expect(evaluateMainRosterDuty(value)).toMatchObject({ eligible: true, strict: true, pendingDeferrals: 0 })
    for (const resolvedAt of [NaN, Infinity, 4, 97]) {
      value.shiftDeferrals[0]!.resolvedAt = resolvedAt
      expect(evaluateMainRosterDuty(value).eligible).toBe(false)
    }
  })

  it('rejects incomplete, mismatched and nonfinite request windows while accepting a complete explicitly short request', () => {
    const mutations: ((value: ScheduleSimulationReport) => void)[] = [
      value => { value.observedHours = 71 }, value => { value.elapsedHours = 95 },
      value => { value.observedHours = NaN }, value => { value.assumptions.sampleHours = Infinity },
      value => { value.assumptions.warmupHours = NaN }, value => { value.inputs.options.sampleHours = 168 },
      value => { value.inputs.options.warmupHours = 0 }, value => { value.success = false },
      value => { value.production!.success = false },
    ]
    for (const mutate of mutations) { const value = report(); mutate(value); expect(evaluateMainRosterDuty(value).eligible).toBe(false) }
    expect(evaluateMainRosterDuty(report(), undefined, { sampleHours: 168, warmupHours: 24 }).eligible).toBe(false)
    const short = report()
    short.inputs.options = { ...short.inputs.options, sampleHours: 1, warmupHours: 0 }
    short.assumptions = { ...short.assumptions, sampleHours: 1, warmupHours: 0 }
    short.observedHours = short.elapsedHours = 1
    Object.assign(short.operators[0]!, { mainWorkHours: 1, substituteWorkHours: 0, workHours: 1,
      restHours: 0, idleHours: 0, workFraction: 1, workRestRatio: null })
    expect(evaluateMainRosterDuty(short)).toMatchObject({ eligible: true, windowCompleted: true })
    expect(evaluateMainRosterDuty(short, undefined, { sampleHours: 72, warmupHours: 24 }).eligible).toBe(false)
  })

  it('keeps missing, duplicated, nonfinite and nonconserving operator data unknown instead of inventing zero', () => {
    const mutations: ((value: ScheduleSimulationReport) => void)[] = [
      value => { value.operators = [] }, value => { value.operators.push({ ...value.operators[0]! }) },
      value => { value.operators[0]!.workHours = NaN }, value => { value.operators[0]!.exhaustedHours = Infinity },
      value => { value.operators[0]!.idleHours = 0 }, value => { value.operators[0]!.substituteWorkHours = 7 },
    ]
    for (const mutate of mutations) {
      const value = report(); mutate(value)
      expect(evaluateMainRosterDuty(value)).toMatchObject({ eligible: false, ordinaryExhaustedHours: null })
    }
    const missing = report()
    Reflect.deleteProperty(missing.operators[0]!, 'exhaustedHours')
    expect(evaluateMainRosterDuty(missing)).toMatchObject({ eligible: false, ordinaryExhaustedHours: null })
  })

  it('rejects missing deferral evidence, absent production quantities, invalid ledgers and unquantified skills', () => {
    const mutations: ((value: ScheduleSimulationReport) => void)[] = [
      value => { delete value.shiftDeferrals }, value => { delete value.production },
      value => { Reflect.set(value, 'shiftDeferrals', {}) },
      value => { value.shiftDeferrals = [{ key: 'group:unknown', operatorIds: ['missing'], blockedAt: 4, resolvedAt: 8 }] },
      value => { Reflect.deleteProperty(value.production!.sample, 'completed') },
      value => { Reflect.deleteProperty(value.production!.sample.completed, 'orderLmd') },
      value => { value.production!.sample.completed.gold = NaN },
      value => { value.production!.ledger.balances.gold = NaN },
      value => { value.diagnostics.push({ code: 'UNQUANTIFIED_EFFICIENCY', message: 'unknown skill' }) },
      value => { value.diagnostics.push({ code: 'MOWER_BACKUP_CONDITION_ERROR', message: 'condition failed' }) },
    ]
    for (const mutate of mutations) { const value = report(); mutate(value); expect(evaluateMainRosterDuty(value).eligible).toBe(false) }
  })

  it('binds optional workspace evidence to the actual main plan', () => {
    const value = report(), workspace = structuredClone(value.inputs.schedule.sourceWorkspace)
    workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'empty' }
    expect(evaluateMainRosterDuty(value, workspace).eligible).toBe(false)
  })
})
