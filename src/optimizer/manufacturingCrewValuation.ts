import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { MOWER_ROOM_IDS, type MowerRoomId, type RosterWorkspace } from '../domain/roster'
import type { AppConfig } from '../domain/types'
import { currentMoraleRates } from '../engine/morale'
import { evaluateDormitoryRecovery } from '../engine/dormitoryRecovery'
import { eligibleSingleRecoveryTargets, hasSingleRecoverySkill } from '../engine/singleRecoveryEligibility'
import { getTemporalSkillBoundaries } from '../engine/timeDependentSkills'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime, type RuntimeConfig } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { initializeMowerAlphaMoodLimits } from '../scheduler/mowerMoodLimits'
import { MowerOperatorState } from '../scheduler/mowerOperatorState'
import { physicalBackupOperatorIds } from './combinationModel'
import { projectRosterConfig } from './rosterProjection'
import { projectControlOutput } from './controlImpact'
import { productionRoomId } from './productionSingletons'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { applyGeneratedRecoveryPolicy } from './generatedRecoveryPolicy'
import type { ManufacturingCrewColumn, ManufacturingCrewDomain } from './manufacturingCrewDomain'
import type { CycleCrewColumn } from './crewAssignmentKernel'

export const MANUFACTURING_CREW_OBJECTIVE = 'finite-isolated-work-rest-v2-prepared'
export interface ManufacturingCrewValuationOptions {
  warmupHours?: number
  sampleHours?: number
  maxIntegrationStepHours?: number
  timeLimitMs?: number
  maxOperations?: number
  maxPhases?: number
  check?: () => boolean
  now?: () => number
  /** Optional audit traces; normal callers need only coefficients and diagnostics. */
  includeDetails?: boolean
}
export type ValuedManufacturingCrewColumn = ManufacturingCrewColumn & CycleCrewColumn
export interface ManufacturingCrewValuationDiagnostic { code: string; message: string; columnId?: string }
export interface ManufacturingCrewValuationResult {
  status: 'complete' | 'incomplete' | 'unsupported' | 'invalid'
  /** False for a budget stop or any unsupported/unquantified column. */
  completeDomain: boolean
  initialColumnsQuantified: boolean
  rows: ValuedManufacturingCrewColumn[]
  diagnostics: ManufacturingCrewValuationDiagnostic[]
  objectiveId: string
  window: { warmupHours: number; sampleHours: number; maxIntegrationStepHours: number }
  stopReason?: 'timeLimit' | 'workLimit' | 'cancelled'
  stats: { inputColumns: number; mainEvaluations: number; backupEvaluations: number; projections: number; exactCycles: number; operations: number; elapsedMs: number }
  mainProfiles?: Record<string, ManufacturingCrewMainProfile>
  proofScope: string
}
interface Actor {
  id: string; lowerLimit: number; upperLimit: number; customMoodLimit: boolean
  exhaustRequire: boolean; restInFull: boolean; workaholic: boolean
  restingPriority: 'high' | 'low' | 'standby'; independentRest: boolean; multiGroup: boolean
}
interface WorkPhase { role: 'main'; start: number; duration: number; initial: Record<string, number>; rates: Record<string, number>; mandatory: string[]; marginMinutes: number | null }
interface RestPhase { role: 'backup'; start: number; duration: number }
export interface ManufacturingCrewMainProfile {
  cycleKey: string; u: number; score: number; restHours: number; mainSampleHours: number
  actors: Actor[]; phases: (WorkPhase | RestPhase)[]; recovery: Record<string, number>
}
type Policy = NonNullable<RuntimeConfig['mowerPolicy']>
const EPS = 1e-8
const MORALE_BOUNDARIES = [0, 4, 8, 12, 16, 18, 20, 24]
const clamp = (mood: number, upper: number) => mood < EPS ? 0 : mood > upper - EPS ? upper : mood
const cellKey = (row: ManufacturingCrewColumn) => JSON.stringify([row.groupOrigin, row.roomId])
class Unsupported extends Error { constructor(readonly code: string, message: string) { super(message) } }
class Interrupted extends Error { constructor(readonly reason: 'timeLimit' | 'workLimit' | 'cancelled') { super(reason) } }
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) throw new Unsupported(code, message) }
function actorState(op: MowerOperatorState): Actor {
  return { id: op.name, lowerLimit: op.lowerLimit, upperLimit: op.upperLimit, customMoodLimit: op.customMoodLimit,
    exhaustRequire: op.exhaustRequire, restInFull: op.restInFull, workaholic: op.workaholic, restingPriority: op.restingPriority,
    independentRest: op.independentRest, multiGroup: op.multiGroup }
}
function exhaustDue(mood: number, lower: number, rate: number, margin: number): number {
  return rate > 0 ? Math.max(0, (mood - lower - 2) / rate, (mood - lower) / rate - margin / 60) : Infinity
}
function normalThreshold(actor: Actor, threshold: number): number {
  const target = actor.lowerLimit + (actor.upperLimit - actor.lowerLimit) * threshold
  return actor.customMoodLimit ? target : Math.min(Math.floor(target), actor.upperLimit - 2)
}
function returnDuration(actors: Actor[], moods: Record<string, number>, rates: Record<string, number>, policy: Policy, groupId: string): number {
  const times = actors.map(actor => Math.max(0, (actor.upperLimit - moods[actor.id]!) / rates[actor.id]!))
  const high = actors.flatMap((actor, i) => actor.restingPriority === 'high' ? [times[i]!] : [])
  const ordinary = Math.max(0, Math.min(...(high.length ? high : times)) - 8 / 60)
  const gap = policy.groupRestInFullOnMoodGap && !policy.groupMoodGapExclusions?.includes(groupId)
    && Math.max(...times) - Math.min(...times) > (policy.groupMoodGapThresholdMinutes ?? 60) / 60 + 1e-10
  let gapDue = gap ? Math.max(...times) : undefined
  if (gapDue !== undefined && (policy.groupMoodGapMaxExtraWaitHours ?? 0) > 0) gapDue = Math.min(gapDue, ordinary + policy.groupMoodGapMaxExtraWaitHours!)
  const strict = [...actors.flatMap((actor, i) => actor.restInFull ? [times[i]!] : []), ...(gapDue === undefined ? [] : [gapDue])]
  return strict.length ? Math.max(...strict) : ordinary
}

/**
 * Conditional finite G coefficients, never a native-simulation or game-income bound.
 * Fixed outside context and reference beds/rates deliberately omit queue competition.
 * Initial pairs are valued first so interruption can retain a real feasible warm start.
 */
export function valueManufacturingCrewColumns(domain: ManufacturingCrewDomain, columns: readonly ManufacturingCrewColumn[], options: ManufacturingCrewValuationOptions = {}): ManufacturingCrewValuationResult {
  const now = options.now ?? (() => performance.now()), started = now()
  const window = { warmupHours: options.warmupHours ?? 24, sampleHours: options.sampleHours ?? 72, maxIntegrationStepHours: options.maxIntegrationStepHours ?? .25 }
  const result: ManufacturingCrewValuationResult = {
    status: 'invalid', completeDomain: false, initialColumnsQuantified: false, rows: [], diagnostics: [], objectiveId: MANUFACTURING_CREW_OBJECTIVE, window,
    stats: { inputColumns: columns.length, mainEvaluations: 0, backupEvaluations: 0, projections: 0, exactCycles: 0, operations: 0, elapsedMs: 0 },
    ...(options.includeDetails ? { mainProfiles: {} } : {}),
    proofScope: 'Finite isolated conditional crew objective with fixed outside context, fixed reference beds/recovery, actual skills and prepared policies. Only quantified supplied columns are covered; no native/F equivalence or F bound.',
  }
  const timeLimit = options.timeLimitMs ?? 30_000, maxOperations = options.maxOperations ?? 2_000_000, maxPhases = options.maxPhases ?? 512
  const limit = (n: number, integer = false) => n === Infinity || Number.isFinite(n) && n >= 0 && (!integer || Number.isInteger(n))
  if (!Number.isFinite(started) || !Number.isFinite(window.warmupHours) || window.warmupHours < 0 || !Number.isFinite(window.sampleHours) || window.sampleHours <= 0 ||
    !Number.isFinite(window.maxIntegrationStepHours) || window.maxIntegrationStepHours <= 0 || !Number.isFinite(window.warmupHours + window.sampleHours) ||
    !limit(timeLimit) || !limit(maxOperations, true) || !Number.isInteger(maxPhases) || maxPhases < 1 || !domain.inventory.valid) {
    result.diagnostics.push({ code: 'CREW_VALUATION_INPUT', message: '有限估值窗口、预算或实际干员库无效。' }); return result
  }
  const tick = () => {
    const elapsed = now() - started
    if (!Number.isFinite(elapsed)) throw new Unsupported('CREW_VALUATION_CLOCK', '估值时钟无效。')
    if (elapsed >= timeLimit) throw new Interrupted('timeLimit')
    if (result.stats.operations >= maxOperations) throw new Interrupted('workLimit')
    if (options.check && !options.check()) throw new Interrupted('cancelled')
    result.stats.operations++
  }
  const values = new Map<string, ValuedManufacturingCrewColumn>(), columnDiagnostics = new Map<string, ManufacturingCrewValuationDiagnostic>()
  try {
    tick()
    const baseline = structuredClone(domain.initial), records = inventoryOperatorRecords(domain.inventory), empty = structuredClone(baseline)
    const groupByOrigin = new Map(domain.groups.map(group => [group.originalRoomId, group]))
    const permanent = new Set(baseline.mainPlan.conf.workaholic.map(resolveId))
    for (const room of Object.values(baseline.mainPlan.facilities)) for (const slot of room.slots) {
      tick()
      requireValue(slot.occupant.kind !== 'current', 'CREW_UNKNOWN_FIXED_CONTEXT', '固定环境仍含未确定在岗位置。')
      if (slot.occupant.kind === 'operator') requireValue(records[resolveId(slot.occupant.operatorId)], 'CREW_UNOWNED_ACTOR', '固定环境缺少实际干员记录。')
    }
    for (const roomId of domain.rooms) for (const slot of empty.mainPlan.facilities[roomId].slots) { slot.occupant = { kind: 'empty' }; slot.replacements = []; slot.groupId = null }
    const dorms = MOWER_ROOM_IDS.filter(roomId => roomId.startsWith('dormitory_')).map(roomId => baseline.mainPlan.facilities[roomId])
    const byDorm = dorms.map(room => room.level > 0 ? room.slots.flatMap((slot, index) => slot.occupant.kind === 'free' ? [{ roomId: room.roomId, index }] : []) : [])
    const freeBeds: { roomId: MowerRoomId; index: number }[] = []
    for (let index = 0; index < Math.max(0, ...byDorm.map(beds => beds.length)); index++) for (const beds of byDorm) if (beds[index]) freeBeds.push(beds[index]!)
    const runtime = (workspace: RosterWorkspace) => {
      tick(); const compiled = compileRosterSchedule(workspace)
      requireValue(!compiled.diagnostics.some(d => d.severity === 'error' || d.code === 'UNKNOWN_POLICY'), 'CREW_COMPILE', '条件参考排班不能完整编译。')
      const config = compiledScheduleToRuntimeConfig(compiled); config.mowerAlpha = true
      return config
    }
    const baseRuntime = runtime(empty), lowData = getMowerSourceRuntime(createRosterRuntime(baseRuntime)).data
    requireValue(baseRuntime.mowerSourceRules && baseRuntime.mowerPolicy, 'CREW_RUNTIME_POLICY', '缺少明确的 Mower 参考策略。')
    const lowActors = new Map<string, Actor>(), templates = new Map<string, RosterWorkspace>(), configs = new Map<string, AppConfig>(), recoveryCache = new Map<string, Record<string, number>>()
    const cycleIds = new Map<string, string>(), profiles = new Set<string>(), byCell = new Map<string, Map<string, ManufacturingCrewMainProfile>>()
    const initialBackups = new Map<string, ManufacturingCrewColumn>()
    const availableBackups = new Map<string, ManufacturingCrewColumn[]>()
    const checkedBackupCycles = new Map<string, Set<string>>()
    const configFor = (workspace: RosterWorkspace): AppConfig => { tick(); const config = projectRosterConfig(workspace); config.operatorRecords = records; return config }
    const switchSupports = (row: ManufacturingCrewColumn) => {
      const group = groupByOrigin.get(row.groupOrigin)
      requireValue(group && group.id === row.groupId, 'CREW_GROUP', '队伍列不属于声明的换班组。')
      return group.support.filter(position => {
        const room = baseline.mainPlan.facilities[position.roomId], slot = room.slots[position.index]
        requireValue(slot?.occupant.kind === 'operator', 'CREW_SUPPORT', '外部支持位置尚未确定。')
        return room.type !== 'dormitory' && !permanent.has(resolveId(slot.occupant.operatorId))
      })
    }
    const supportIds = (row: ManufacturingCrewColumn, role = row.role) => switchSupports(row).map(position => {
      const room = baseline.mainPlan.facilities[position.roomId], slot = room.slots[position.index]!
      if (role === 'main' && slot.occupant.kind === 'operator') return resolveId(slot.occupant.operatorId)
      const backup = physicalBackupOperatorIds(room, slot)
      requireValue(backup.length === 1, 'CREW_SUPPORT', '外部支持需要唯一物理替班。'); return backup[0]!
    })
    const cohortIds = (row: ManufacturingCrewColumn) => [...row.seatOperatorIds, ...supportIds(row)]
    function ensureLow(ids: readonly string[]): void {
      let changed = false
      for (const id of ids) {
        tick(); requireValue(records[id], 'CREW_UNOWNED_ACTOR', `缺少 ${id} 的实际干员记录。`)
        if (lowActors.has(id)) continue
        requireValue(!lowData.operators[id]?.isHigh(), 'CREW_FIXED_PRIMARY_AS_BACKUP', '不能把固定主位当作可自由调用的替班。')
        const rules = baseRuntime.mowerSourceRules!
        lowData.operators[id] ??= new MowerOperatorState({ name: id, nativeName: records[id]!.name, operatorType: 'low', restingPriority: 'low',
          workaholic: rules.workaholic.includes(id), exhaustRequire: rules.exhaustRequire.includes(id), restInFull: rules.restInFull.includes(id) })
        changed = true
      }
      if (changed) {
        // Declare planned LOW membership solely for the shared limit initializer.
        // Free primary slots were cleared before runtime creation. This local plan
        // is never compiled, projected or executed as a physical assignment.
        lowData.plan[domain.rooms[0]!] = [...new Set([...lowActors.keys(), ...ids])]
        initializeMowerAlphaMoodLimits(lowData, baseRuntime.mowerSourceRules!.lingMode, baseRuntime.mowerMoodLimits)
        for (const id of [...lowActors.keys(), ...ids]) lowActors.set(id, actorState(lowData.operators[id]!))
      }
    }
    function background(row: ManufacturingCrewColumn, role = row.role): RosterWorkspace {
      const key = JSON.stringify([row.groupOrigin, role])
      let workspace = templates.get(key)
      if (!workspace) {
        tick(); workspace = structuredClone(empty)
        if (role === 'backup') for (const position of switchSupports(row)) {
          const room = workspace.mainPlan.facilities[position.roomId], slot = room.slots[position.index]!, replacement = physicalBackupOperatorIds(room, slot)[0]
          requireValue(replacement, 'CREW_SUPPORT', '外部替班缺失。'); slot.occupant = { kind: 'operator', operatorId: replacement }
        }
        templates.set(key, workspace)
      }
      return workspace
    }
    function configTemplate(row: ManufacturingCrewColumn, role = row.role): AppConfig {
      const key = JSON.stringify([row.groupOrigin, role]); let config = configs.get(key)
      if (!config) { config = configFor(background(row, role)); configs.set(key, config) }
      return config
    }
    function referenceConfig(row: ManufacturingCrewColumn, moods: Record<string, number>): AppConfig {
      tick(); const template = configTemplate(row), target = productionRoomId(row.roomId)
      const config = { ...template, operatorMorale: { ...template.operatorMorale, ...moods }, rooms: template.rooms.map(room => room.id === target ? { ...room, operatorIds: [...row.seatOperatorIds], operatorCount: row.ids.length } : room) }
      config.zeroMoraleOperatorIds = [...new Set([...template.zeroMoraleOperatorIds, ...Object.entries(moods).filter(([, mood]) => mood <= EPS).map(([id]) => id)])]
      return config
    }
    function recoveryRates(row: ManufacturingCrewColumn, actors: Actor[]): Record<string, number> {
      const key = JSON.stringify([row.groupOrigin, row.role, actors.map(actor => actor.id)])
      const cached = recoveryCache.get(key); if (cached) return cached
      tick(); requireValue(actors.length <= freeBeds.length, 'CREW_REFERENCE_BEDS', '固定参考空床不足以容纳整个换班组。')
      const opposite = row.role === 'main' ? 'backup' : 'main', template = configTemplate(row, opposite), resting = new Set(actors.map(actor => actor.id))
      requireValue(!template.rooms.some(room => room.operatorIds.some(id => resting.has(id))) && !template.controlOperatorIds.some(id => resting.has(id)), 'CREW_RESTING_SUPPORT_ACTIVE', '休息成员仍被参考环境当作在岗支持。')
      const occupants = dorms.map(room => room.slots.map(slot => slot.occupant.kind === 'operator' ? resolveId(slot.occupant.operatorId) : null))
      const beds = actors.map((actor, index) => ({ ...freeBeds[index]!, id: actor.id }))
      for (const bed of beds) occupants[dorms.findIndex(room => room.roomId === bed.roomId)]![bed.index] = bed.id
      const dormitories = occupants.map(ids => ids.filter((id): id is string => id !== null)), config: AppConfig = {
        ...template, facilityOperatorIds: { ...template.facilityOperatorIds, dormitories }, operatorMorale: { ...template.operatorMorale }, dormitoryOccupantCount: dormitories.flat().length,
      }
      for (const actor of actors) config.operatorMorale[actor.id] = 0
      if (row.role === 'main') { const ids = supportIds(row, 'backup'); ensureLow(ids); for (const id of ids) config.operatorMorale[id] = lowActors.get(id)!.upperLimit }
      const moods = new Map(Object.entries(config.operatorMorale)), rates: Record<string, number> = {}
      for (const [index, room] of dorms.entries()) {
        tick(); if (!beds.some(bed => bed.roomId === room.roomId)) continue
        const present = config.facilityOperatorIds.dormitories[index]!.map(id => { requireValue(records[id], 'CREW_UNOWNED_ACTOR', '宿舍成员缺少实际技能。'); return records[id]! }), targets = new Map<string, string>()
        for (const provider of present) if (hasSingleRecoverySkill(provider)) {
          const eligible = eligibleSingleRecoveryTargets(present, provider.charId, id => moods.get(id) ?? 24)
          const selected = [...eligible].sort((a, b) => (moods.get(a.charId) ?? 24) - (moods.get(b.charId) ?? 24))[0]
          if (selected) targets.set(provider.charId, selected.charId)
        }
        const recovery = evaluateDormitoryRecovery(config, index, moods, room.level * 1000, targets, false)
        requireValue(!recovery.unquantified.length, 'CREW_UNQUANTIFIED_RECOVERY', recovery.unquantified.join('；'))
        Object.assign(rates, Object.fromEntries(recovery.rates))
      }
      const selected: Record<string, number> = {}
      for (const actor of actors) { requireValue(Number.isFinite(rates[actor.id]) && rates[actor.id]! > 0, 'CREW_RECOVERY_RATE', '参考恢复率缺失、未量化或非正。'); selected[actor.id] = rates[actor.id]! }
      recoveryCache.set(key, selected); return selected
    }
    function depletion(row: ManufacturingCrewColumn, actors: Actor[], moods: Record<string, number>): Record<string, number> {
      const snapshot = currentMoraleRates(referenceConfig(row, moods))
      requireValue(!snapshot.unquantified.length, 'CREW_UNQUANTIFIED_MORALE', snapshot.unquantified.join('；'))
      const rates: Record<string, number> = {}
      for (const actor of actors) {
        const observed = snapshot.rates[actor.id]
        // The shared engine omits inactive zero-morale people from its rate map.
        // Only that known inactive state has a legitimate zero default; an active
        // missing record remains unquantified and must never imply permanent work.
        if (observed === undefined && moods[actor.id] !== undefined && moods[actor.id]! <= EPS) rates[actor.id] = 0
        else { requireValue(Number.isFinite(observed) && observed! >= 0, 'CREW_DEPLETION_RATE', '消耗率缺失、未量化或为负；不能当成永久在岗。'); rates[actor.id] = observed! }
      }
      return rates
    }
    function pointScore(row: ManufacturingCrewColumn, actors: Actor[], initial: Record<string, number>, rates: Record<string, number>, at: number, temporal: boolean): number {
      tick(); result.stats.projections++
      const moods = Object.fromEntries(actors.map(actor => [actor.id, clamp(initial[actor.id]! - rates[actor.id]! * at, actor.upperLimit)])), target = productionRoomId(row.roomId)
      const output = projectControlOutput(referenceConfig(row, moods), { selectedRoomIds: [target], timeContext: { workHoursByOperator: new Map(actors.map(actor => [actor.id, temporal ? at : 0])), warmupModel: 'continuous' } }).rooms[0]
      requireValue(output && !output.diagnostics.length && Number.isFinite(output.daily.score), 'CREW_UNQUANTIFIED_OUTPUT', output?.diagnostics.join('；') ?? '产出投影缺失。')
      return output.daily.score
    }
    function cuts(actors: Actor[], initial: Record<string, number>, rates: Record<string, number>, end: number, temporal: boolean): number[] {
      const points = [0, end]
      for (const actor of actors) {
        tick(); if (rates[actor.id]! > 0) for (const level of MORALE_BOUNDARIES) { const at = (initial[actor.id]! - level) / rates[actor.id]!; if (at > EPS && at < end - EPS) points.push(at) }
        if (temporal) for (const at of getTemporalSkillBoundaries(actor.id, { operatorRecords: records })) if (at > 0 && at < end) points.push(at)
      }
      return [...new Set(points)].sort((a, b) => a - b)
    }
    function integrate(row: ManufacturingCrewColumn, actors: Actor[], initial: Record<string, number>, rates: Record<string, number>, start: number, end: number, temporal: boolean): number {
      if (end <= start) return 0
      const points = [start, ...cuts(actors, initial, rates, end, temporal).filter(at => at > start && at < end), end]; let value = 0
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!, b = points[i + 1]!, count = temporal ? Math.max(1, Math.ceil((b - a) / window.maxIntegrationStepHours)) : 1
        for (let k = 0; k < count; k++) { tick(); const left = a + (b - a) * k / count, right = a + (b - a) * (k + 1) / count; value += pointScore(row, actors, initial, rates, (left + right) / 2, temporal) * (right - left) }
      }
      return value
    }
    function validate(row: ManufacturingCrewColumn): void {
      tick(); const group = groupByOrigin.get(row.groupOrigin)
      requireValue(group && group.id === row.groupId && domain.rooms.includes(row.roomId), 'CREW_COLUMN_CONTEXT', '队伍列不属于声明的设施和换班组。')
      requireValue(row.ids.length === group.capacity && row.seatOperatorIds.length === group.capacity && new Set(row.ids).size === row.ids.length && new Set(row.seatOperatorIds).size === row.ids.length && row.seatOperatorIds.every(id => row.ids.includes(id)), 'CREW_COLUMN_SEATS', '资源成员和物理工位不一致。')
      requireValue(row.ids.every(id => records[id]), 'CREW_UNOWNED_ACTOR', '队伍列含未持有或无实际技能记录的干员。')
      requireValue(row.ids.every(id => !domain.fixedOperatorIds.has(id) && !domain.lockedOperators.has(id)), 'CREW_FIXED_ACTOR', '队伍列借用了固定或锁定干员。')
      if (row.role === 'backup') requireValue(row.ids.every(id => !isWarmupOperatorInFacility(id, baseline.mainPlan.facilities[row.roomId].type, domain.inventory)), 'CREW_WARMUP_BACKUP', '普通替班会被主班召回，不能保证暖机成员按耗尽休息。')
    }
    function mainProfile(row: ManufacturingCrewColumn): ManufacturingCrewMainProfile {
      result.stats.mainEvaluations++; const workspace = structuredClone(background(row, 'main')), room = workspace.mainPlan.facilities[row.roomId]
      row.seatOperatorIds.forEach((id, index) => {
        const slot = room.slots[index]
        requireValue(slot, 'CREW_COLUMN_SEATS', '物理工位不足。')
        slot.occupant = { kind: 'operator', operatorId: id }; slot.groupId = row.groupId; slot.replacements = []
      })
      const warmup = applyGeneratedWarmupPolicy(workspace, domain.inventory)
      requireValue(warmup.valid, 'CREW_WARMUP_POLICY', warmup.diagnostics.map(d => d.message).join('；'))
      applyGeneratedRecoveryPolicy(workspace)
      const compiled = runtime(workspace), policy = compiled.mowerPolicy!, data = getMowerSourceRuntime(createRosterRuntime(compiled)).data
      const actors = cohortIds(row).map(id => { requireValue(data.operators[id], 'CREW_RUNTIME_ACTOR', '主班成员缺少实际运行时身份。'); return actorState(data.operators[id]!) })
      requireValue(actors.every(actor => !actor.workaholic && !actor.independentRest && !actor.multiGroup && actor.restingPriority !== 'standby'), 'CREW_UNSUPPORTED_REST_COHORT', '此有限模型只量化完整普通换班群体。')
      const groupPeers = Object.values(data.operators).filter(actor => actor.group === row.groupId && !actor.room.startsWith('dorm'))
      requireValue(groupPeers.every(actor => !actor.exhaustRequire || actors.some(member => member.id === actor.name)), 'CREW_FIXED_EXHAUST_ANCHOR', '固定且不随组休息的耗尽锚点不在此孤立周期模型内。')
      const exhaustMargin = groupPeers.some(actor => actor.restInFull) ? 10 : 30
      const recovery = recoveryRates(row, actors), moods = Object.fromEntries(actors.map(actor => [actor.id, actor.upperLimit])), phases: (WorkPhase | RestPhase)[] = []
      const temporal = actors.some(actor => getTemporalSkillBoundaries(actor.id, { operatorRecords: records }).length), end = window.warmupHours + window.sampleHours
      let time = 0, integral = 0, active = 0
      for (let index = 0; time < end - EPS; index++) {
        tick(); requireValue(index < maxPhases, 'CREW_PHASE_LIMIT', '有限参考事件数超过上限；没有假定已经收敛。')
        const initial = { ...moods }, rates = depletion(row, actors, moods), mandatory = actors.filter(actor => actor.exhaustRequire), margin = exhaustMargin
        const due = mandatory.length ? mandatory.map(actor => exhaustDue(moods[actor.id]!, actor.lowerLimit, rates[actor.id]!, margin)) : actors.map(actor => rates[actor.id]! > 0 ? Math.max(0, (moods[actor.id]! - normalThreshold(actor, policy.restingThreshold)) / rates[actor.id]!) : Infinity)
        const duration = Math.min(Math.min(...due), end - time)
        for (const at of cuts(actors, initial, rates, duration, false).slice(0, -1)) {
          const t = Math.min(duration, at + 1e-7), sample = Object.fromEntries(actors.map(actor => [actor.id, clamp(initial[actor.id]! - rates[actor.id]! * t, actor.upperLimit)])), actual = depletion(row, actors, sample)
          requireValue(actors.every(actor => sample[actor.id]! <= EPS || Math.abs(actual[actor.id]! - rates[actor.id]!) < EPS), 'CREW_VARIABLE_DEPLETION', '主段内存在未支持的消耗率变化。')
        }
        const lo = Math.max(0, window.warmupHours - time)
        if (duration > lo) { integral += integrate(row, actors, initial, rates, lo, duration, temporal); active += duration - lo }
        phases.push({ role: 'main', start: time, duration, initial, rates, mandatory: mandatory.map(actor => actor.id), marginMinutes: mandatory.length ? margin : null })
        for (const actor of actors) moods[actor.id] = clamp(moods[actor.id]! - rates[actor.id]! * duration, actor.upperLimit)
        time += duration; if (time >= end - EPS) break
        const rest = Math.min(returnDuration(actors, moods, recovery, policy, row.groupId), end - time)
        requireValue(Number.isFinite(rest) && rest >= 0 && duration + rest > EPS, 'CREW_STALLED_CYCLE', '孤立工作休息轨迹无法继续。')
        phases.push({ role: 'backup', start: time, duration: rest })
        for (const actor of actors) moods[actor.id] = clamp(moods[actor.id]! + recovery[actor.id]! * rest, actor.upperLimit)
        time += rest
      }
      // Exact signature interning avoids crypto and fuzzy merging. Keys are local
      // to this result; no persistence or cross-input cache identity is implied.
      const signature = JSON.stringify([row.groupOrigin, row.roomId, window, phases.map(phase => [phase.role, phase.start, phase.duration])])
      let cycleKey = cycleIds.get(signature); if (!cycleKey) { cycleKey = `cycle_${cycleIds.size + 1}`; cycleIds.set(signature, cycleKey) }
      result.stats.exactCycles = cycleIds.size
      return { cycleKey, u: active / window.sampleHours, score: active ? integral / active : 0, restHours: Math.max(0, ...phases.filter(p => p.role === 'backup').map(p => p.duration)), mainSampleHours: active, actors, phases, recovery }
    }
    function backupValue(row: ManufacturingCrewColumn, choices: ManufacturingCrewMainProfile[]): ValuedManufacturingCrewColumn {
      result.stats.backupEvaluations++; const ids = cohortIds(row); ensureLow(ids)
      const actors = ids.map(id => lowActors.get(id)!)
      requireValue(actors.every(actor => !actor.workaholic && actor.restingPriority !== 'standby'), 'CREW_UNSUPPORTED_BACKUP', '此有限替班模型不包含永久或待命干员。')
      const initial = Object.fromEntries(actors.map(actor => [actor.id, actor.upperLimit])), rates = depletion(row, actors, initial), recovery = recoveryRates(row, actors)
      const maximum = Math.max(0, ...choices.flatMap(p => p.phases.filter(phase => phase.role === 'backup').map(phase => phase.duration))), points = cuts(actors, initial, rates, maximum, false)
      const segments: { start: number; end: number; score: number }[] = []
      for (let i = 0; i < points.length - 1; i++) { tick(); const start = points[i]!, end = points[i + 1]!; segments.push({ start, end, score: pointScore(row, actors, initial, rates, (start + end) / 2, false) }) }
      const cumulative = (at: number) => segments.reduce((sum, segment) => sum + Math.max(0, Math.min(at, segment.end) - segment.start) * segment.score, 0)
      const compatibleCycleKeys: string[] = [], scoreByCycleKey: Record<string, number> = {}
      for (const profile of choices) {
        const moods = { ...initial }; let compatible = true, integral = 0, active = 0
        for (const phase of profile.phases) {
          tick()
          if (phase.role === 'main') { for (const actor of actors) moods[actor.id] = clamp(moods[actor.id]! + recovery[actor.id]! * phase.duration, actor.upperLimit); continue }
          if (actors.some(actor => moods[actor.id]! < actor.upperLimit - EPS)) { compatible = false; break }
          for (const actor of actors) { moods[actor.id]! -= rates[actor.id]! * phase.duration; if (moods[actor.id]! < -EPS) compatible = false }
          if (!compatible) break
          const lo = Math.max(0, window.warmupHours - phase.start)
          if (phase.duration > lo) { integral += cumulative(phase.duration) - cumulative(lo); active += phase.duration - lo }
        }
        if (compatible) { compatibleCycleKeys.push(profile.cycleKey); scoreByCycleKey[profile.cycleKey] = active ? integral / active : 0 }
      }
      return { ...row, role: 'backup', lower: 0, maximumCoverHours: null, compatibleCycleKeys, scoreByCycleKey }
    }
    function rememberError(row: ManufacturingCrewColumn, error: unknown): void {
      columnDiagnostics.set(row.id, { columnId: row.id, code: error instanceof Unsupported ? error.code : 'CREW_VALUATION_ERROR', message: error instanceof Error ? error.message : String(error) })
    }
    function extendBackup(row: ManufacturingCrewColumn, choices: ManufacturingCrewMainProfile[]): void {
      const checked = checkedBackupCycles.get(row.id) ?? new Set<string>(), missing = choices.filter(profile => !checked.has(profile.cycleKey))
      if (missing.length) {
        const update = backupValue(row, missing), old = values.get(row.id)
        // Commit only a fully evaluated clock batch. An interruption leaves the
        // earlier table untouched, including clocks found incompatible already.
        for (const profile of missing) checked.add(profile.cycleKey)
        checkedBackupCycles.set(row.id, checked)
        if (update.role === 'backup' && (update.compatibleCycleKeys.length || old?.role === 'backup')) values.set(row.id, { ...update,
          compatibleCycleKeys: [...new Set([...(old?.role === 'backup' ? old.compatibleCycleKeys : []), ...update.compatibleCycleKeys])],
          scoreByCycleKey: { ...(old?.role === 'backup' ? old.scoreByCycleKey : {}), ...update.scoreByCycleKey },
        })
      }
      requireValue(values.has(row.id), 'CREW_NO_CYCLE_COVERAGE', '替班未满足任何已量化主周期的完整恢复与单次覆盖条件。')
      columnDiagnostics.delete(row.id)
    }
    function evaluate(row: ManufacturingCrewColumn): void {
      try {
        validate(row)
        const copied = { ...row, ids: [...row.ids], seatOperatorIds: [...row.seatOperatorIds], retainedCores: [...row.retainedCores] }
        if (row.role === 'main') {
          if (profiles.has(row.id)) return
          const profile = mainProfile(copied), cell = byCell.get(cellKey(row)) ?? new Map<string, ManufacturingCrewMainProfile>()
          const newCycle = !cell.has(profile.cycleKey)
          cell.set(profile.cycleKey, profile); byCell.set(cellKey(row), cell); profiles.add(row.id)
          values.set(row.id, { ...copied, role: 'main', cycleKey: profile.cycleKey, u: profile.u, score: profile.score, restHours: profile.restHours })
          columnDiagnostics.delete(row.id)
          if (result.mainProfiles) result.mainProfiles[row.id] = profile
          // Close a new clock against the already valid initial cover immediately.
          // A budget stop must not discard its old compatible clock/table values.
          const original = initialBackups.get(cellKey(row))
          const cover = original && original.ids.every(id => !row.ids.includes(id)) ? original
            : availableBackups.get(cellKey(row))?.find(candidate => candidate.ids.every(id => !row.ids.includes(id)))
          if (newCycle && cover && (values.get(cover.id)?.role === 'backup' || availableBackups.size > 0)) {
            try {
              validate(cover)
              extendBackup(cover, [profile])
            } catch (error) {
              if (error instanceof Interrupted) throw error
              // The initial cover need not cover every new main; other actual
              // backup rows may later do so. Never fabricate compatibility.
              if (!(error instanceof Unsupported && error.code === 'CREW_NO_CYCLE_COVERAGE')) rememberError(cover, error)
            }
          }
        } else {
          const choices = [...byCell.get(cellKey(row))?.values() ?? []]
          requireValue(choices.length, 'CREW_NO_MAIN_CYCLE', '没有同组同设施的已量化主周期。')
          extendBackup(copied, choices)
        }
      } catch (error) {
        if (error instanceof Interrupted) throw error
        rememberError(row, error)
      }
    }
    // Domain enumeration emits the exact initial rows first. Find them with a
    // checked scan, then keep their complete coefficients before library growth.
    const initial: ManufacturingCrewColumn[] = []
    for (const expected of domain.initialColumns) for (const row of columns) { tick(); if (row.id === expected.id) { initial.push(row); break } }
    for (const row of initial.filter(row => row.role === 'backup')) initialBackups.set(cellKey(row), row)
    for (const row of initial.filter(row => row.role === 'main')) evaluate(row)
    for (const row of initial.filter(row => row.role === 'backup')) evaluate(row)
    // Index all physical covers, then visit each context's roles in turn. This
    // keeps a main-heavy enumeration from spending the whole budget on mains.
    // No column is pruned or ranked by its value.
    const queues = new Map<string, { main: ManufacturingCrewColumn[]; backup: ManufacturingCrewColumn[]; mainIndex: number; backupIndex: number }>()
    const seen = new Set<string>(), initialIds = new Set(initial.map(row => row.id))
    for (const row of columns) {
      tick(); requireValue(!seen.has(row.id), 'CREW_DUPLICATE_COLUMN', '队伍列 ID 重复。'); seen.add(row.id)
      const key = cellKey(row)
      if (row.role === 'backup') {
        const candidates = availableBackups.get(key) ?? []
        candidates.push(row); availableBackups.set(key, candidates)
      }
      if (initialIds.has(row.id)) continue
      const queue = queues.get(key) ?? { main: [], backup: [], mainIndex: 0, backupIndex: 0 }
      queue[row.role].push(row); queues.set(key, queue)
    }
    let pending = true
    while (pending) {
      pending = false
      for (const queue of queues.values()) for (const role of ['main', 'backup'] as const) {
        const cursor = role === 'main' ? 'mainIndex' : 'backupIndex', row = queue[role][queue[cursor]]
        if (!row) continue
        tick(); queue[cursor]++; pending = true; evaluate(row)
      }
    }
    // Only after every main is known can a backup table be complete. Already
    // tested exact clocks are retained; the final pass evaluates missing ones.
    for (const row of columns) { tick(); if (row.role === 'backup') evaluate(row) }
    result.stats.exactCycles = cycleIds.size
    result.status = values.size ? 'complete' : 'unsupported'; result.completeDomain = columnDiagnostics.size === 0
  } catch (error) {
    if (error instanceof Interrupted) { result.status = 'incomplete'; result.stopReason = error.reason }
    else { result.status = error instanceof Unsupported ? 'unsupported' : 'invalid'; result.diagnostics.push({ code: error instanceof Unsupported ? error.code : 'CREW_VALUATION_ERROR', message: error instanceof Error ? error.message : String(error) }) }
  }
  result.diagnostics.push(...columnDiagnostics.values())
  result.rows = [...values.values()]
  result.initialColumnsQuantified = domain.initialColumns.every(row => values.has(row.id))
  result.stats.elapsedMs = Math.max(0, now() - started)
  return result
}
