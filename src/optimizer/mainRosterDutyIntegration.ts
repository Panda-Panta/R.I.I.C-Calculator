import { scoreProduction } from '../domain/productionScore'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import { DUTY_RESOURCE_KEYS, type DutyResourceRates, type MainRosterDutyProjection,
  type MainRosterDutyTrajectory, type MainRosterDutyWeights } from './mainRosterDutyTypes'

class CompensatedSum {
  value = 0
  private correction = 0

  add(term: number): boolean {
    const adjusted = term - this.correction, next = this.value + adjusted
    if (!Number.isFinite(term) || !Number.isFinite(next)) return false
    this.correction = (next - this.value) - adjusted
    this.value = next
    return true
  }
}

/** Integrates already quantified simultaneous whole-base mean rates; does not advance a schedule. */
export function integrateMainRosterDutyOutput(
  trajectory: MainRosterDutyTrajectory, weights?: MainRosterDutyWeights,
): MainRosterDutyProjection {
  const started = performance.now()
  const result: MainRosterDutyProjection = {
    status: 'invalid', amounts: null, score: null, coverageHours: 0, operatorDuty: [], jointStateHours: {},
    predictionEligible: false, nativeScheduleParity: trajectory.nativeScheduleParity,
    diagnostics: [...trajectory.diagnostics], assumptions: [...trajectory.assumptions], integrationElapsedMs: 0,
  }
  const finish = (status: MainRosterDutyProjection['status'], diagnostic?: string) => {
    result.status = status
    if (diagnostic) result.diagnostics.push(diagnostic)
    result.diagnostics = [...new Set(result.diagnostics)]
    result.assumptions = [...new Set(result.assumptions)]
    result.predictionEligible = status === 'estimated' && trajectory.sourceKind === 'predicted-schedule'
    result.integrationElapsedMs = performance.now() - started
    return result
  }
  const { warmupHours, sampleHours, maxStepHours } = trajectory.window
  const end = warmupHours + sampleHours
  if (!Number.isFinite(warmupHours) || warmupHours < 0 || !Number.isFinite(sampleHours) || sampleHours <= 0
    || !Number.isFinite(maxStepHours) || maxStepHours <= 0 || !Number.isFinite(end) || end <= warmupHours
    || Math.abs((end - warmupHours) - sampleHours) > 64 * Number.EPSILON * sampleHours) {
    return finish('invalid', 'DUTY_INVALID_SAMPLE_WINDOW')
  }
  const totals = { exp: new CompensatedSum(), gold: new CompensatedSum(), orderLmd: new CompensatedSum(),
    virtualGold: new CompensatedSum(), fragments: new CompensatedSum(), orundum: new CompensatedSum() }
  const coverage = new CompensatedSum(), states = new Map<string, CompensatedSum>()
  let unquantified = false
  let previousEnd = 0, cursor = warmupHours, gap = false
  // These frames already carry rates and absolute times. Sorting never reconstructs scheduling causality.
  const phases = [...trajectory.phases].sort((left, right) => left.start - right.start)
  for (const phase of phases) {
    if (!Number.isFinite(phase.start) || phase.start < 0 || !Number.isFinite(phase.end) || phase.end <= phase.start) {
      return finish('invalid', 'DUTY_INVALID_PHASE_INTERVAL')
    }
    if (phase.start < previousEnd) return finish('invalid', 'DUTY_OVERLAPPING_PHASES')
    previousEnd = phase.end
    const start = Math.max(phase.start, warmupHours), stop = Math.min(phase.end, end)
    const hours = Math.max(0, stop - start)
    if (!hours) continue
    if (start > cursor) gap = true
    cursor = stop
    if (!coverage.add(hours)) return finish('invalid', 'DUTY_COVERAGE_OVERFLOW')
    result.coverageHours = coverage.value
    const stateHours = states.get(phase.jointStateKey) ?? new CompensatedSum()
    if (!stateHours.add(hours)) return finish('invalid', 'DUTY_STATE_HOURS_OVERFLOW')
    states.set(phase.jointStateKey, stateHours)
    result.diagnostics.push(...phase.output.diagnostics)
    result.assumptions.push(...phase.output.assumptions)
    if (phase.output.status === 'unquantified') {
      unquantified = true
      result.diagnostics.push(`DUTY_UNQUANTIFIED_PHASE:${phase.jointStateKey}`)
    }
    for (const key of DUTY_RESOURCE_KEYS) {
      const rate = phase.output.rates[key]
      if (rate === null || rate === undefined) {
        unquantified = true
        result.diagnostics.push(`DUTY_UNKNOWN_RESOURCE:${key}`)
      } else if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        return finish('invalid', `DUTY_INVALID_RESOURCE_RATE:${key}`)
      } else if (!totals[key].add(rate * hours)) {
        return finish('invalid', `DUTY_RESOURCE_AMOUNT_OVERFLOW:${key}`)
      }
    }
  }
  result.jointStateHours = Object.fromEntries([...states].map(([key, hours]) => [key, hours.value]))
  const operatorDuty: MainRosterDutyProjection['operatorDuty'] = [], operatorIds = new Set<string>()
  // Allow conservative upstream summation roundoff, without normalizing or inventing any duration.
  const timeTolerance = 64 * Number.EPSILON * sampleHours * Math.max(1, phases.length)
  for (const operator of trajectory.operators) {
    if (typeof operator.operatorId !== 'string' || !operator.operatorId.trim()) return finish('invalid', 'DUTY_MISSING_OPERATOR_ID')
    const canonicalId = resolveOperatorCharId(operator.operatorId.trim())
    if (operatorIds.has(canonicalId)) return finish('invalid', `DUTY_DUPLICATE_OPERATOR:${canonicalId}`)
    operatorIds.add(canonicalId)
    const durations = [operator.mainWorkHours, operator.substituteWorkHours, operator.workHours,
      operator.exhaustedHours, operator.restHours, operator.idleHours]
    if (durations.some(value => !Number.isFinite(value) || value < 0)) return finish('invalid', `DUTY_INVALID_OPERATOR_TIME:${canonicalId}`)
    const total = new CompensatedSum(), work = new CompensatedSum()
    if (![operator.workHours, operator.exhaustedHours, operator.restHours, operator.idleHours].every(value => total.add(value))
      || !work.add(operator.mainWorkHours) || !work.add(operator.substituteWorkHours)
      || Math.abs(total.value - sampleHours) > timeTolerance || Math.abs(work.value - operator.workHours) > timeTolerance) {
      return finish('invalid', `DUTY_NONCONSERVED_OPERATOR_TIME:${canonicalId}`)
    }
    const physicalWorkHours = operator.workHours + operator.exhaustedHours
    const workRestRatio = operator.restHours === 0 ? null : operator.workHours / operator.restHours
    const workFraction = operator.workHours / sampleHours, physicalWorkFraction = physicalWorkHours / sampleHours
    if (!Number.isFinite(physicalWorkHours) || (workRestRatio !== null && !Number.isFinite(workRestRatio))
      || !Number.isFinite(workFraction) || !Number.isFinite(physicalWorkFraction)) {
      return finish('invalid', `DUTY_OPERATOR_RATIO_OVERFLOW:${canonicalId}`)
    }
    operatorDuty.push({ ...operator, physicalWorkHours, workRestRatio, workFraction, physicalWorkFraction,
      noRestObserved: operator.restHours === 0 })
  }
  result.operatorDuty = operatorDuty
  if (gap || cursor < end || trajectory.status === 'incomplete') return finish('incomplete', 'DUTY_INCOMPLETE_SAMPLE_COVERAGE')
  if (trajectory.status === 'unsupported') return finish('unquantified', 'DUTY_UNSUPPORTED_TRAJECTORY')
  if (unquantified) return finish('unquantified')
  const amounts: Record<keyof DutyResourceRates, number> = {
    exp: totals.exp.value, gold: totals.gold.value, orderLmd: totals.orderLmd.value,
    virtualGold: totals.virtualGold.value, fragments: totals.fragments.value, orundum: totals.orundum.value,
  }
  try {
    result.score = scoreProduction(amounts, sampleHours, weights)
  } catch (error) {
    return finish('invalid', `DUTY_INVALID_SCORE:${error instanceof Error ? error.message : String(error)}`)
  }
  result.amounts = amounts
  return finish('estimated')
}
