import { resolveDroneCapacity } from '../domain/droneCapacity'
import { compileOperatorInventory, type OperatorInventory } from '../domain/operatorInventory'
import { normalizeProductionWeights } from '../domain/productionWeights'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { validateScheduleInventory } from '../scheduler/inventoryValidation'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import type { CompiledSchedule } from '../scheduler/types'
import { projectScheduleState, simulateSchedule, type ScheduleSimulationOptions, type ScheduleSimulationReport } from '../simulator/scheduleSimulation'
import { createMainRosterDutyRateProjector } from './mainRosterDutyRates'
import { createMainRosterDutyOrderClock } from './mainRosterDutyOrderClock'
import { validatePhysicalRoster } from './rosterDraft'
import type { MainRosterDutyModelInput, MainRosterDutyTrajectory } from './mainRosterDutyTypes'

/** Prior calendar cost, when converting a saved H report. Conversion itself starts no H call. */
export interface MainRosterDutyTraceEvidence {
  sourceKind?: MainRosterDutyTrajectory['sourceKind']
  scheduleOnlyCalls?: number
  elapsedMs?: number
  cpuMs?: number | null
}
type Window = MainRosterDutyTrajectory['window']
interface Prepared {
  window: Window
  compiled: CompiledSchedule
  inventory: OperatorInventory
  options: ScheduleSimulationOptions
}
const EPS = 1e-5
const PARITY = 'DUTY_NATIVE_PARITY_NOT_ESTABLISHED: production-off omits ProductionIO and ClueIO and disables independentMoraleClock; native task timing and output parity are not established.'
const EXPECTED_PARITY = 'DUTY_NATIVE_PARITY_NOT_ESTABLISHED: expected-order calendar supplies mean-order observations and an independent morale clock; full ProductionIO, ClueIO, notifications, capacity and Native parity remain unavailable.'
const ASSUMPTIONS = [
  'One simultaneous whole-base schedule state is projected for each segment; marginal operator times are not multiplied to reconstruct a joint roster.',
  'Segment efficiencyPercent is the H scheduler\'s actual joint-state evaluation, including its internal session/warmup calculation. Missing workAge is not filled with zero or static caps.',
  'Segments normally cover the sample window only and do not export full task/Fiammetta/order state. This trace is not a native-state continuation or cycle certificate.',
  'Production RNG is absent in H. Original seed, windows, weights, inventory, groups, replacements and Fiammetta policy are preserved as inputs; a production-off calendar is not a full F label.',
]
const finite = (value: number) => Number.isFinite(value)
const readCpu = () => typeof process !== 'undefined' && typeof process.cpuUsage === 'function' ? process.cpuUsage() : null
const cpuSince = (started: ReturnType<typeof readCpu>): number | null => {
  if (!started || typeof process === 'undefined') return null
  const value = process.cpuUsage(started)
  return (value.user + value.system) / 1000
}
const windowFor = (input: MainRosterDutyModelInput): Window => ({ warmupHours: input.job.options?.warmupHours ?? 0,
  sampleHours: input.job.options?.sampleHours ?? 336, maxStepHours: input.job.options?.maxStepHours ?? .25 })
function empty(window: Window, status: MainRosterDutyTrajectory['status'], diagnostics: string[], sourceKind: MainRosterDutyTrajectory['sourceKind'], model: MainRosterDutyModelInput['calendarModel'] = 'production-off'): MainRosterDutyTrajectory {
  return { status, window, phases: [], operators: [], sourceKind, nativeScheduleParity: 'not-established', diagnostics: [model === 'expected-orders' ? EXPECTED_PARITY : PARITY, ...diagnostics],
    assumptions: [...ASSUMPTIONS], cost: { scheduleOnlyCalls: 0, elapsedMs: 0, cpuMs: null, phaseEvaluations: 0 } }
}
function prepare(input: MainRosterDutyModelInput): { value?: Prepared; status: 'unsupported' | 'incomplete'; diagnostics: string[] } {
  const window = windowFor(input), source = input.job.options ?? {}, production = source.production
  const fail = (message: string) => ({ status: 'unsupported' as const, diagnostics: [message] })
  if (input.calendarModel !== undefined && !['production-off', 'expected-orders'].includes(input.calendarModel)) return fail('DUTY_UNKNOWN_CALENDAR_MODEL')
  if (!finite(window.warmupHours) || window.warmupHours < 0 || !finite(window.sampleHours) || window.sampleHours <= 0 || !finite(window.warmupHours + window.sampleHours) || !finite(window.maxStepHours) || window.maxStepHours <= 0) return fail('DUTY_INVALID_WINDOW: finite nonnegative warmup and positive sample/step are required.')
  if (!production || production.outputMode !== 'potential' || production.inventoryMode === 'finite' || production.droneTarget !== 'none') return fail('DUTY_UNSUPPORTED_PRODUCTION_SCOPE: only potential, infinite-material, none-drone input jobs are supported.')
  if (source.schedulingModel && source.schedulingModel !== 'mower-alpha') return fail('DUTY_UNSUPPORTED_SCHEDULER: this H wrapper supports explicit alpha only.')
  if (input.job.generatedBackup !== undefined || input.job.workspace.compatibility.backupPlans.length) return fail('DUTY_UNSUPPORTED_SIDE_PLANS: inventory/product-dependent side plans require the native production host.')
  if (Object.values(input.job.workspace.mainPlan.facilities).some(room => room.slots.some(slot => slot.occupant.kind === 'current'))) return fail('DUTY_CURRENT_UNSUPPORTED: Current cannot be resolved by a predicted duty trace.')
  if (!source.operatorInventory?.length) return fail('DUTY_ACTUAL_INVENTORY_REQUIRED: no catalog ownership or skill stage is inferred.')
  for (const [name, value] of Object.entries(input.limits ?? {})) {
    if (!(name === 'maxPhases' && value === Infinity) && (!Number.isSafeInteger(value) || value < 0)) return fail('DUTY_INVALID_BUDGET: limits must be nonnegative integer work budgets.')
  }
  if (input.limits?.maxEvents === 0 || input.limits?.maxPhases === 0) return { status: 'incomplete', diagnostics: ['DUTY_BUDGET_EXHAUSTED: no H calendar is started for a zero work budget.'] }
  const inventory = compileOperatorInventory(source.operatorInventory)
  if (!inventory.valid) return fail('DUTY_INVALID_INVENTORY: ' + inventory.diagnostics.map(issue => issue.message).join('; '))
  const compiled = compileRosterSchedule(input.job.workspace, input.job.assumptions)
  if (compiled.assumptions.operationDurationHours !== 0) return fail('DUTY_OPERATION_DURATION_UNSUPPORTED: the shared calendar supports zero modeled operation duration only.')
  if (compiled.diagnostics.some(issue => issue.severity === 'error')) return fail('DUTY_COMPILE_UNSUPPORTED: ' + compiled.diagnostics.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; '))
  const ownership = validateScheduleInventory(compiled, inventory, source.efficiencyResources, 'efficiency-resources')
  if (!ownership.valid || validatePhysicalRoster(input.job.workspace).length) return fail('DUTY_PHYSICAL_OR_OWNERSHIP_UNSUPPORTED: original physical actors and actual inventory must be valid.')
  const options = structuredClone(source)
  delete options.production
  options.schedulingModel = 'mower-alpha'; options.recordSegments = true
  if (input.limits?.maxEvents !== undefined) options.maxEvents = Math.min(options.maxEvents ?? 200000, input.limits.maxEvents)
  // Original none-drone semantics, independent of any measured F trajectory.
  compiled.assumptions.droneRoom = null
  return { status: 'unsupported', diagnostics: [], value: { window, compiled, inventory, options } }
}

function convert(input: MainRosterDutyModelInput, report: ScheduleSimulationReport, prepared: Prepared,
  evidence: MainRosterDutyTraceEvidence, started: number, cpuStarted: ReturnType<typeof readCpu>): MainRosterDutyTrajectory {
  const sourceKind = evidence.sourceKind ?? 'predicted-schedule'
  const model = report.diagnostics.some(issue => issue.code === 'DUTY_EXPECTED_ORDER_CALENDAR') ? 'expected-orders' : 'production-off'
  const result = empty(prepared.window, 'complete', report.diagnostics.map(issue => `${issue.code}: ${issue.message}`), sourceKind, model)
  const finish = () => {
    const conversionCpu = cpuSince(cpuStarted), priorCpu = evidence.cpuMs === undefined ? ((evidence.scheduleOnlyCalls ?? 0) ? null : 0) : evidence.cpuMs
    result.cost = { ...result.cost, scheduleOnlyCalls: evidence.scheduleOnlyCalls ?? 0, elapsedMs: (evidence.elapsedMs ?? 0) + performance.now() - started,
      cpuMs: priorCpu === null || conversionCpu === null ? null : priorCpu + conversionCpu }
    return result
  }
  if (input.calendarModel !== undefined && input.calendarModel !== model) {
    result.status = 'unsupported'; result.diagnostics.push('DUTY_CALENDAR_MODEL_MISMATCH: saved calendar lacks the requested observation-host evidence.')
    return finish()
  }
  if (report.production !== undefined && sourceKind === 'predicted-schedule') {
    result.status = 'unsupported'; result.diagnostics.push('DUTY_OBSERVED_PRODUCTION_NOT_PREDICTION: an F report may only be converted with explicit observed-replay provenance.')
    return finish()
  }
  const expectedSchedule = structuredClone(prepared.compiled), expectedOptions = structuredClone(prepared.options)
  const capacity = input.job.options?.efficiencyResources?.droneCapacity ?? resolveDroneCapacity(input.job.workspace)
  // Match exactly the documented pre-run normalization performed by simulateSchedule.
  expectedSchedule.sourceWorkspace.droneCapacity = capacity
  expectedSchedule.assumptions.runOrderSimulationMode = 'ideal'
  expectedSchedule.assumptions.idealRunOrderWakeOnly = !expectedOptions.experimentalDisableIdealWake
  expectedOptions.efficiencyResources = { ...expectedOptions.efficiencyResources, droneCapacity: capacity }
  const sameSchedule = JSON.stringify(report.inputs.schedule) === JSON.stringify(expectedSchedule)
  const samePredictedOptions = sourceKind !== 'predicted-schedule' || JSON.stringify(report.inputs.options) === JSON.stringify(expectedOptions)
  if (!sameSchedule || !samePredictedOptions) {
    result.status = 'unsupported'; result.diagnostics.push('DUTY_REPORT_JOB_MISMATCH: the supplied report belongs to a different original roster/group/policy input.')
    return finish()
  }
  const { warmupHours, sampleHours, maxStepHours } = prepared.window
  if (!report.success || !finite(report.observedHours) || !finite(report.elapsedHours) || Math.abs(report.observedHours - sampleHours) > EPS || Math.abs(report.elapsedHours - warmupHours - sampleHours) > EPS
    || report.assumptions.warmupHours !== warmupHours || report.assumptions.sampleHours !== sampleHours || report.assumptions.maxStepHours !== maxStepHours) {
    result.status = 'incomplete'; result.diagnostics.push('DUTY_INCOMPLETE_WINDOW: calendar success, warmup and the full sample window must be measured.')
  }
  result.operators = report.operators.map(operator => ({ operatorId: operator.operatorId, mainWorkHours: operator.mainWorkHours,
    substituteWorkHours: operator.substituteWorkHours, workHours: operator.workHours, exhaustedHours: operator.exhaustedHours,
    restHours: operator.restHours, idleHours: operator.idleHours }))
  try {
    const config = compiledScheduleToRuntimeConfig(prepared.compiled)
    config.mowerAlpha = true
    const baseRuntime = createRosterRuntime(config)
    const projectRate = createMainRosterDutyRateProjector(prepared.inventory)
    const ledger = new Map<string, string>(), maximum = input.limits?.maxPhases ?? Infinity
    let covered = 0, previousEnd = -Infinity
    for (const segment of report.segments) {
      if (result.phases.length >= maximum) { result.status = 'incomplete'; result.diagnostics.push('DUTY_PHASE_BUDGET: remaining joint phases were not evaluated.'); break }
      if (!finite(segment.start) || !finite(segment.end) || segment.end <= segment.start || segment.start < previousEnd - EPS) {
        result.status = 'incomplete'; result.diagnostics.push('DUTY_INVALID_PHASE: ordered positive non-overlapping intervals are required.'); continue
      }
      previousEnd = segment.end
      const jointState = { occupants: { ...segment.occupants }, bedOccupants: { ...segment.bedOccupants }, morale: { ...segment.morale }, efficiencyPercent: { ...segment.efficiencyPercent } }
      // Occupancy ledger only. Mood/actual efficiency remain separate and rates are evaluated every phase.
      const signature = JSON.stringify([Object.entries(jointState.occupants), Object.entries(jointState.bedOccupants)])
      let jointStateKey = ledger.get(signature)
      if (!jointStateKey) { jointStateKey = `joint-${ledger.size + 1}`; ledger.set(signature, jointStateKey) }
      const state = { ...baseRuntime, time: segment.start, occupants: jointState.occupants, bedOccupants: jointState.bedOccupants, morale: jointState.morale }
      const projected = projectScheduleState(prepared.compiled, state)
      projected.productionWeights = normalizeProductionWeights(input.job.options?.productionWeights ?? input.job.workspace.productionWeights)
      projected.jayeElite0 = input.job.options?.jayeElite0
      Object.assign(projected.efficiencyResources, input.job.options?.efficiencyResources)
      projected.efficiencyResources.droneCapacity = input.job.options?.efficiencyResources?.droneCapacity ?? resolveDroneCapacity(input.job.workspace)
      const output = projectRate({ config: projected, efficiencyPercentByRoom: jointState.efficiencyPercent,
        runOrderPolicies: prepared.compiled.runOrderPolicies,
        outputMode: 'potential', inventoryMode: 'infinite', droneTarget: 'none' })
      result.phases.push({ start: segment.start, end: segment.end, jointStateKey, jointState, output })
      result.cost.phaseEvaluations++
      covered += Math.max(0, Math.min(segment.end, warmupHours + sampleHours) - Math.max(segment.start, warmupHours))
    }
    if (!result.phases.length || Math.abs(covered - sampleHours) > EPS) { result.status = 'incomplete'; result.diagnostics.push('DUTY_SAMPLE_PHASE_COVERAGE: exported joint phases do not cover the entire sample.') }
  } catch (error) {
    result.status = 'unsupported'; result.diagnostics.push('DUTY_TRACE_PROJECTION_UNSUPPORTED: ' + (error instanceof Error ? error.message : String(error)))
  }
  return finish()
}

/** Pure report conversion. Predicted H by default; explicit observed replay is never a prediction. */
export function dutyTrajectoryFromReport(input: MainRosterDutyModelInput, report: ScheduleSimulationReport,
  evidence: MainRosterDutyTraceEvidence = {}): MainRosterDutyTrajectory {
  const started = performance.now(), cpuStarted = readCpu(), prepared = prepare(input)
  if (!prepared.value) {
    const result = empty(windowFor(input), prepared.status, prepared.diagnostics, evidence.sourceKind ?? 'predicted-schedule', input.calendarModel)
    const spent = cpuSince(cpuStarted), prior = evidence.cpuMs === undefined ? ((evidence.scheduleOnlyCalls ?? 0) ? null : 0) : evidence.cpuMs
    result.cost = { scheduleOnlyCalls: evidence.scheduleOnlyCalls ?? 0, elapsedMs: (evidence.elapsedMs ?? 0) + performance.now() - started,
      cpuMs: prior === null || spent === null ? null : prior + spent, phaseEvaluations: 0 }
    return result
  }
  return convert(input, report, prepared.value, evidence, started, cpuStarted)
}

/** Starts exactly one production-off H calendar, not a free static G or native F call. */
export function buildMainRosterDutyTrajectory(input: MainRosterDutyModelInput): MainRosterDutyTrajectory {
  const started = performance.now(), cpuStarted = readCpu(), prepared = prepare(input)
  if (!prepared.value) {
    const result = empty(windowFor(input), prepared.status, prepared.diagnostics, 'predicted-schedule', input.calendarModel)
    result.cost.elapsedMs = performance.now() - started; result.cost.cpuMs = cpuSince(cpuStarted)
    return result
  }
  try {
    const report = input.calendarModel === 'expected-orders'
      ? simulateSchedule(prepared.value.compiled, prepared.value.options, undefined, createMainRosterDutyOrderClock)
      : simulateSchedule(prepared.value.compiled, prepared.value.options)
    return convert(input, report, prepared.value, { scheduleOnlyCalls: 1, elapsedMs: 0, cpuMs: 0 }, started, cpuStarted)
  } catch (error) {
    const result = empty(prepared.value.window, 'incomplete', ['DUTY_CALENDAR_FAILED: ' + (error instanceof Error ? error.message : String(error))], 'predicted-schedule', input.calendarModel)
    result.cost = { scheduleOnlyCalls: 1, elapsedMs: performance.now() - started, cpuMs: cpuSince(cpuStarted), phaseEvaluations: 0 }
    return result
  }
}
