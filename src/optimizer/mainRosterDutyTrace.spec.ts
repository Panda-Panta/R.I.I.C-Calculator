import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDroneCapacity } from '../domain/droneCapacity'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import * as runtime from '../scheduler/rosterRuntime'
import * as simulation from '../simulator/scheduleSimulation'
import type { ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as rates from './mainRosterDutyRates'
import { createMainRosterDutyOrderClock } from './mainRosterDutyOrderClock'
import { buildMainRosterDutyTrajectory, dutyTrajectoryFromReport } from './mainRosterDutyTrace'
import type { MainRosterDutyModelInput } from './mainRosterDutyTypes'

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.spyOn(simulation, 'simulateSchedule').mockImplementation(() => { throw new Error('No actual H is authorized in this test') })
})

const slot = (name: string, replacement?: string): MowerSlot => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null,
  replacements: replacement ? [id(replacement)] : [] })
function input(): MainRosterDutyModelInput {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(workspace.mainPlan.facilities.room_1_1, { level: 1, type: 'manufacture', product: 'gold', slots: [slot('砾', '夜烟')] })
  Object.assign(workspace.mainPlan.facilities.room_1_3, { level: 3, type: 'power', slots: [slot('Lancet-2')] })
  Object.assign(workspace.mainPlan.facilities.central, { level: 1, slots: [slot('临光', '玫兰莎')] })
  Object.assign(workspace.mainPlan.facilities.dormitory_1, { level: 1, slots: [slot('薇薇安娜'), ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))] })
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  return { job: { workspace, assumptions: { restingThreshold: .65, operationDurationHours: 0 }, options: {
    warmupHours: 1, sampleHours: 2, maxStepHours: .25, productionWeights: { exp: 2, gold: 1.5, orders: .2, fragments: 0, orundum: 0 },
    production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
    efficiencyResources: { droneCapacity: 250 }, operatorInventory: [
      { operator: '砾', elitePhase: 2, level: 70 }, { operator: '夜烟', elitePhase: 2, level: 70 },
      { operator: 'Lancet-2', elitePhase: 0, level: 30 }, { operator: '临光', elitePhase: 2, level: 80 },
      { operator: '玫兰莎', elitePhase: 1, level: 55 }, { operator: '薇薇安娜', elitePhase: 2, level: 90 },
    ],
  } } }
}

function report(scene = input()): ScheduleSimulationReport {
  const schedule = compileRosterSchedule(scene.job.workspace, scene.job.assumptions)
  schedule.sourceWorkspace.droneCapacity = scene.job.options?.efficiencyResources?.droneCapacity ?? resolveDroneCapacity(scene.job.workspace)
  schedule.assumptions.droneRoom = null; schedule.assumptions.runOrderSimulationMode = 'ideal'
  schedule.assumptions.idealRunOrderWakeOnly = !scene.job.options?.experimentalDisableIdealWake
  const options = structuredClone(scene.job.options ?? {}); delete options.production
  options.schedulingModel = 'mower-alpha'; options.recordSegments = true
  options.efficiencyResources = { ...options.efficiencyResources, droneCapacity: schedule.sourceWorkspace.droneCapacity }
  const occupants = { room_1_1_0: id('砾'), room_1_3_0: id('Lancet-2'), central_0: id('临光'), dormitory_1_0: id('薇薇安娜') }
  const morale = { [id('砾')]: 18, [id('夜烟')]: 6, [id('Lancet-2')]: 0, [id('临光')]: 12, [id('薇薇安娜')]: 8 }
  return { schemaVersion: 1, engine: 'mower-morale-v1', success: true, elapsedHours: 3, observedHours: 2,
    inputs: { schedule, options }, assumptions: { sampleHours: 2, warmupHours: 1, maxStepHours: .25, warmupModel: 'continuous',
      restingThreshold: .65, operationDurationHours: 0, dormAtmosphere: 'synthetic', singleRecoveryTarget: 'synthetic' },
    operators: [{ operatorId: id('砾'), operatorName: '砾', mainWorkHours: 1, substituteWorkHours: 0, workHours: 1,
      exhaustedHours: 0, restHours: 1, idleHours: 0, initialMorale: 24, finalMorale: 18, workFraction: .5, workRestRatio: 1 }],
    rooms: [], events: [], diagnostics: [], shiftDeferrals: [], segments: [
      { start: 1, end: 2, occupants, bedOccupants: { dormitory_1_1: id('夜烟') }, morale, efficiencyPercent: { room_1_1: 135, room_1_3: 100 } },
      { start: 2, end: 3, occupants: { ...occupants, room_1_1_0: id('夜烟') }, bedOccupants: { dormitory_1_1: id('砾') },
        morale: { ...morale, [id('砾')]: 5, [id('夜烟')]: 20 }, efficiencyPercent: { room_1_1: 115, room_1_3: 100 } },
    ] }
}

describe('joint H schedule trace adapter (0 actual H/F)', () => {
  it('admits an explicit sampled observation calendar without starting full production', () => {
    const scene = input()
    Object.assign(scene, { calendarModel: 'sampled-observations' })
    const saved = report(scene)
    saved.diagnostics.push({ code: 'DUTY_SAMPLED_OBSERVATION_CALENDAR', message: 'synthetic sampled observations' },
      { code: 'DUTY_OBSERVATION_SEED', message: '42' })
    vi.mocked(simulation.simulateSchedule).mockReturnValue(saved)
    const trajectory = buildMainRosterDutyTrajectory(scene)
    expect(trajectory.status).toBe('complete')
    expect(simulation.simulateSchedule).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ production: expect.anything() }), undefined, expect.any(Function))
    expect(trajectory.nativeScheduleParity).toBe('not-established')
    expect(trajectory.assumptions.join(' ')).toMatch(/sampled/i)
  })

  it('rejects saved sampled observations from a different production seed', () => {
    const scene = input(), saved = report(scene)
    Object.assign(scene, { calendarModel: 'sampled-observations' })
    saved.diagnostics.push({ code: 'DUTY_SAMPLED_OBSERVATION_CALENDAR', message: 'synthetic sampled observations' },
      { code: 'DUTY_OBSERVATION_SEED', message: '17' })
    const trajectory = dutyTrajectoryFromReport(scene, saved)
    expect(trajectory.status).toBe('unsupported')
    expect(trajectory.diagnostics.join(' ')).toMatch(/SEED_MISMATCH/)
  })

  it('passes the expected-order clock only on explicit opt-in and retains its approximation boundary', () => {
    const scene = input()
    Object.assign(scene, { calendarModel: 'expected-orders' })
    const saved = report(scene)
    saved.diagnostics.push({ code: 'DUTY_EXPECTED_ORDER_CALENDAR', message: 'synthetic expected-order calendar' })
    vi.mocked(simulation.simulateSchedule).mockReturnValue(saved)
    const before = structuredClone(scene), trajectory = buildMainRosterDutyTrajectory(scene)
    expect(simulation.simulateSchedule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recordSegments: true }), undefined, createMainRosterDutyOrderClock)
    expect(trajectory.status).toBe('complete')
    expect(trajectory.nativeScheduleParity).toBe('not-established')
    expect(trajectory.diagnostics.join(' ')).toMatch(/mean-order/)
    expect(scene).toEqual(before)
  })

  it('refuses an unknown calendar mode or a falsely attributed saved calendar before claiming a prediction', () => {
    const scene = input(), saved = report(scene)
    Object.assign(scene, { calendarModel: 'unsupported-mode' })
    expect(buildMainRosterDutyTrajectory(scene).status).toBe('unsupported')
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
    Object.assign(scene, { calendarModel: 'expected-orders' })
    expect(dutyTrajectoryFromReport(scene, saved).status).toBe('unsupported')
    delete scene.calendarModel
    saved.diagnostics.push({ code: 'DUTY_EXPECTED_ORDER_CALENDAR', message: 'synthetic expected-order calendar' })
    expect(dutyTrajectoryFromReport(scene, saved).diagnostics.join(' ')).toMatch(/mean-order/)
  })

  it('passes the original ordered ideal-run policies to every joint state without moving policy references into occupancy', () => {
    const scene = input()
    Object.assign(scene.job.workspace.mainPlan.facilities.room_2_1, {
      level: 1, type: 'trading', product: 'money', slots: [slot('梓兰', '但书')],
    })
    Object.assign(scene.job.workspace.mainPlan.facilities.room_3_1, {
      level: 1, type: 'trading', product: 'money', slots: [slot('月见夜', '龙舌兰')],
    })
    // Runners remain ordered policy references, not on-duty segment occupants.
    scene.job.workspace.mainPlan.facilities.room_2_1.slots[0]!.replacements.push(id('龙舌兰'))
    scene.job.workspace.mainPlan.facilities.room_3_1.slots[0]!.replacements.push(id('但书'))
    scene.job.options!.operatorInventory!.push({ operator: '但书', elitePhase: 2, level: 80 }, { operator: '龙舌兰', elitePhase: 2, level: 80 },
      { operator: '梓兰', elitePhase: 1, level: 55 }, { operator: '月见夜', elitePhase: 1, level: 55 })
    const saved = report(scene)
    for (const segment of saved.segments) {
      Object.assign(segment.occupants, { room_2_1_0: id('梓兰'), room_3_1_0: id('月见夜') })
      Object.assign(segment.efficiencyPercent, { room_2_1: 100, room_3_1: 100 })
    }
    const before = structuredClone({ scene, saved })
    const expected = structuredClone(saved.inputs.schedule.runOrderPolicies)
    expect(expected).toHaveLength(2)
    expect(expected.find(policy => policy.roomId === 'room_2_1')?.orderedOperatorIds).toEqual([id('但书'), id('龙舌兰')])
    expect(expected.find(policy => policy.roomId === 'room_3_1')?.orderedOperatorIds).toEqual([id('龙舌兰'), id('但书')])
    const captured: Parameters<ReturnType<typeof rates.createMainRosterDutyRateProjector>>[0][] = []
    vi.spyOn(rates, 'createMainRosterDutyRateProjector').mockImplementation(() => frame => {
      captured.push(frame)
      return { status: 'quantified', rates: { exp: 0, gold: 1, orderLmd: 2, virtualGold: 0, fragments: 0, orundum: 0 }, diagnostics: [], assumptions: [] }
    })
    const trajectory = dutyTrajectoryFromReport(scene, saved)
    expect(trajectory.status).toBe('complete')
    expect(captured).toHaveLength(2)
    expect(captured[0]!.runOrderPolicies).toBe(captured[1]!.runOrderPolicies)
    for (const frame of captured) {
      expect(frame.runOrderPolicies).toEqual(expected)
      const occupied = frame.config.rooms.flatMap(room => room.operatorIds)
      expect(occupied).not.toContain(id('但书'))
      expect(occupied).not.toContain(id('龙舌兰'))
    }
    expect(trajectory.phases[0]!.jointState?.occupants).toEqual(saved.segments[0]!.occupants)
    expect(trajectory.phases[1]!.jointState?.occupants).toEqual(saved.segments[1]!.occupants)
    expect({ scene, saved }).toEqual(before)
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })

  it('converts lossless joint main/backup/bed/morale state once per report, retaining actual warmup efficiency and cost', () => {
    const scene = input(), saved = report(scene), before = JSON.stringify({ scene, saved })
    const create = vi.spyOn(runtime, 'createRosterRuntime'), originalFactory = rates.createMainRosterDutyRateProjector
    const captured: Parameters<ReturnType<typeof rates.createMainRosterDutyRateProjector>>[0][] = []
    const factory = vi.spyOn(rates, 'createMainRosterDutyRateProjector').mockImplementation(inventory => {
      const project = originalFactory(inventory)
      return frame => { captured.push(frame); return project(frame) }
    })
    const trajectory = dutyTrajectoryFromReport(scene, saved, { scheduleOnlyCalls: 1, elapsedMs: 30, cpuMs: 20 })
    expect(trajectory.status).toBe('complete'); expect(trajectory.sourceKind).toBe('predicted-schedule')
    expect(trajectory.nativeScheduleParity).toBe('not-established')
    expect(create).toHaveBeenCalledTimes(1); expect(factory).toHaveBeenCalledTimes(1); expect(captured).toHaveLength(2)
    expect(captured[0]!.config.rooms.find(room => room.id === 'room_1_1')?.operatorIds).toEqual([id('砾')])
    expect(captured[1]!.config.rooms.find(room => room.id === 'room_1_1')?.operatorIds).toEqual([id('夜烟')])
    expect(captured[0]!.config.facilityOperatorIds.dormitories[0]).toContain(id('夜烟'))
    expect(captured[1]!.config.operatorMorale[id('夜烟')]).toBe(20)
    expect(captured[0]!.config.productionWeights?.gold).toBe(1.5)
    expect(captured[0]!.config.efficiencyResources.droneCapacity).toBe(250)
    expect(captured[0]!.efficiencyPercentByRoom.room_1_1).toBe(135)
    expect(trajectory.phases[0]!.jointState?.morale).toEqual(saved.segments[0]!.morale)
    expect(trajectory.phases[0]!.jointState?.efficiencyPercent).toEqual(saved.segments[0]!.efficiencyPercent)
    expect(trajectory.operators[0]).toMatchObject({ workHours: 1, restHours: 1, mainWorkHours: 1 })
    expect(trajectory.cost.scheduleOnlyCalls).toBe(1); expect(trajectory.cost.elapsedMs).toBeGreaterThanOrEqual(30)
    expect(trajectory.cost.phaseEvaluations).toBe(2)
    expect(trajectory.diagnostics.join(' ')).toMatch(/ProductionIO/)
    expect(trajectory.diagnostics.join(' ')).toMatch(/ClueIO/)
    expect(trajectory.diagnostics.join(' ')).toMatch(/independentMoraleClock/)
    expect(JSON.stringify({ scene, saved })).toBe(before)
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })

  it('reuses only the occupancy ledger identity, never caches rates by occupancy while morale/actual efficiency changes', () => {
    const scene = input(), saved = report(scene)
    saved.segments[1]!.occupants = structuredClone(saved.segments[0]!.occupants)
    saved.segments[1]!.bedOccupants = structuredClone(saved.segments[0]!.bedOccupants)
    const trajectory = dutyTrajectoryFromReport(scene, saved)
    expect(trajectory.phases[0]!.jointStateKey).toBe(trajectory.phases[1]!.jointStateKey)
    expect(trajectory.phases[0]!.jointStateKey.length).toBeLessThan(80)
    expect(trajectory.phases[0]!.output.rates.gold).not.toBe(trajectory.phases[1]!.output.rates.gold)
    expect(trajectory.cost.phaseEvaluations).toBe(2)
  })

  it('build entry invokes one mocked calendar with production removed and alpha/trace enabled; source job is unchanged', () => {
    const scene = input(), saved = report(scene), before = JSON.stringify(scene)
    vi.mocked(simulation.simulateSchedule).mockReturnValue(saved)
    const trajectory = buildMainRosterDutyTrajectory(scene)
    expect(trajectory.status).toBe('complete'); expect(trajectory.cost.scheduleOnlyCalls).toBe(1)
    expect(simulation.simulateSchedule).toHaveBeenCalledTimes(1)
    expect(vi.mocked(simulation.simulateSchedule).mock.calls[0]![1]).toMatchObject({ schedulingModel: 'mower-alpha', recordSegments: true })
    expect(vi.mocked(simulation.simulateSchedule).mock.calls[0]![1]?.production).toBeUndefined()
    expect(JSON.stringify(scene)).toBe(before)
  })

  it.each(['Current', 'side-plan', 'finite', 'drones', 'settled', 'operation-time'] as const)('refuses unsupported %s before any calendar or runtime', kind => {
    const scene = input()
    if (kind === 'Current') scene.job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'current' }
    if (kind === 'side-plan') Object.assign(scene.job.workspace.compatibility, { backupPlans: [{}] })
    if (kind === 'finite') Object.assign(scene.job.options?.production ?? {}, { inventoryMode: 'finite' })
    if (kind === 'drones') Object.assign(scene.job.options?.production ?? {}, { droneTarget: 'gold' })
    if (kind === 'settled') Object.assign(scene.job.options?.production ?? {}, { outputMode: 'settled' })
    if (kind === 'operation-time') Object.assign(scene.job.assumptions ?? {}, { operationDurationHours: .01 })
    const create = vi.spyOn(runtime, 'createRosterRuntime')
    expect(buildMainRosterDutyTrajectory(scene).status).toBe('unsupported')
    expect(simulation.simulateSchedule).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })

  it('rejects production reports as predictions and permits explicit observed replay without relabelling it', () => {
    const scene = input(), saved = report(scene)
    Object.assign(saved, { production: { syntheticPresenceOnly: true } })
    expect(dutyTrajectoryFromReport(scene, saved).status).toBe('unsupported')
    const replay = dutyTrajectoryFromReport(scene, saved, { sourceKind: 'observed-replay' })
    expect(replay.sourceKind).toBe('observed-replay'); expect(replay.nativeScheduleParity).toBe('not-established')
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })

  it('keeps failed, mismatched-window and absent-phase reports incomplete without manufacturing zero rates', () => {
    const scene = input(), failed = report(scene); failed.success = false
    expect(dutyTrajectoryFromReport(scene, failed).status).toBe('incomplete')
    const wrong = report(scene); wrong.observedHours = 1
    expect(dutyTrajectoryFromReport(scene, wrong).status).toBe('incomplete')
    const empty = report(scene); empty.segments = []
    expect(dutyTrajectoryFromReport(scene, empty).status).toBe('incomplete')
    expect(dutyTrajectoryFromReport(scene, empty).phases).toEqual([])
    const invalid = report(scene); invalid.observedHours = NaN
    expect(dutyTrajectoryFromReport(scene, invalid).status).toBe('incomplete')
  })

  it.each(['inventory', 'recovery', 'resource', 'assumptions', 'compiled-slots'] as const)('refuses a saved H report with different %s instead of silently projecting it against this input', kind => {
    const scene = input(), saved = report(scene)
    if (kind === 'inventory') saved.inputs.options.operatorInventory![0]!.elitePhase = 0
    if (kind === 'recovery') saved.inputs.options.recoveryOverrides = { [id('砾')]: 99 }
    if (kind === 'resource') saved.inputs.options.efficiencyResources!.droneCapacity = 249
    if (kind === 'assumptions') saved.inputs.schedule.assumptions.restingThreshold = .5
    if (kind === 'compiled-slots') saved.inputs.schedule.rooms.find(room => room.roomId === 'room_1_1')!.slots[0]!.primaryOperatorId = id('夜烟')
    const create = vi.spyOn(runtime, 'createRosterRuntime')
    const trajectory = dutyTrajectoryFromReport(scene, saved)
    expect(trajectory.status).toBe('unsupported')
    expect(trajectory.diagnostics.join(' ')).toMatch(/DUTY_REPORT_JOB_MISMATCH/)
    expect(create).not.toHaveBeenCalled(); expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })

  it('honors post-calendar phase budget as an incomplete trajectory and never runs an extra calendar', () => {
    const scene = input(); scene.limits = { maxPhases: 1 }
    const trajectory = dutyTrajectoryFromReport(scene, report(scene))
    expect(trajectory.status).toBe('incomplete'); expect(trajectory.phases).toHaveLength(1)
    expect(trajectory.cost.phaseEvaluations).toBe(1)
    expect(simulation.simulateSchedule).not.toHaveBeenCalled()
  })
})
