import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import { MOWER_OUTPUT_ROOM_IDS, type MowerFacility, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { preservesFormedCombinations } from './combinationIntegrity'
import { physicalBackupOperatorIds } from './combinationModel'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

const DEFAULT_CANDIDATES = 2
const HARD_CANDIDATE_LIMIT = 8

export interface ProductionShiftAlternativeOptions {
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
}
export interface ProductionShiftAlternativeResult {
  candidates: { id: string; workspace: RosterWorkspace }[]
  diagnostics: { code: string; message: string }[]
}

/** Full serialized payload, including conf, compatibility, ordered references and unknown metadata. */
function fingerprint(workspace: RosterWorkspace): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, sort(entry)]))
      : value
  return JSON.stringify(sort(JSON.parse(JSON.stringify(workspace))))
}

/** Dormitory targets and ideal run-order lists are references, not simultaneous physical relief roles. */
function physicalResources(workspace: RosterWorkspace, owned: ReadonlySet<string>): string | undefined {
  const physical = new Set<string>()
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.level <= 0) continue
    for (const slot of room.slots) {
      const refs = [
        ...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []),
        ...slot.replacements, ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements),
      ]
      if (refs.some(ref => !(room.type === 'dormitory' && ref === 'Free') && !owned.has(resolveId(ref)))) {
        return `${room.roomId} 含未持有的在岗者或候补引用，不能用目录练度补全。`
      }
      const actors = [
        ...(slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : []),
        ...physicalBackupOperatorIds(room, slot),
        ...(room.type === 'dormitory' ? [] : (slot.groupBindings ?? []).flatMap(binding =>
          binding.replacements.filter(ref => isOrdinaryReplacementCandidate(ref, room.type)).map(resolveId))),
      ]
      for (const actor of actors) {
        if (physical.has(actor)) return `${actor} 被多个在岗或普通实体替班角色占用，本版不扩展共享实体角色。`
        physical.add(actor)
      }
    }
  }
  return undefined
}

function sharedGroup(workspace: RosterWorkspace, room: MowerFacility, slots: readonly MowerSlot[]): boolean {
  const groups = new Set(slots.map(slot => slot.groupId?.trim()).filter((group): group is string => Boolean(group)))
  return Object.values(workspace.mainPlan.facilities).some(other => other.level > 0 && other.roomId !== room.roomId && other.slots.some(slot =>
    [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)].some(group => Boolean(group?.trim()) && groups.has(group!.trim()))))
}

/** Give otherwise ungrouped workers singleton names only in this disposable capacity probe. */
function capacityIssues(workspace: RosterWorkspace): ReturnType<typeof recoveryGroupCapacityIssues> {
  const probe = structuredClone(workspace)
  const groups = new Set(Object.values(probe.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot =>
    [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)].filter((group): group is string => Boolean(group)))))
  let nextGroup = 0
  for (const room of Object.values(probe.mainPlan.facilities)) {
    if (room.level <= 0 || room.type === 'dormitory') continue
    for (const slot of room.slots.slice(0, facilityCapacity(room.type, room.level))) {
      if (slot.occupant.kind !== 'operator' || slot.groupId?.trim()) continue
      let group: string
      do { group = `__production_shift_capacity_${nextGroup++}` } while (groups.has(group))
      groups.add(group)
      slot.groupId = group
    }
  }
  return recoveryGroupCapacityIssues(probe)
}

/** Initialize the same custom/native mood windows used by the production alpha runtime. */
function normalizeRecoveryProbe(workspace: RosterWorkspace): void {
  const schedule = compileRosterSchedule(workspace)
  if (schedule.diagnostics.some(issue => issue.severity === 'error')) return
  const config = compiledScheduleToRuntimeConfig(schedule)
  config.mowerAlpha = true
  const operators = Object.values(getMowerSourceRuntime(createRosterRuntime(config)).data.operators)
  const resting = new Set(workspace.mainPlan.conf.rest_in_full)
  for (const op of operators) {
    if (!op.isHigh() || !op.group || op.room.startsWith('dorm') || op.lowerLimit <= 0 || op.workaholic || op.exhaustRequire || op.restInFull || op.restingPriority === 'standby') continue
    if (operators.some(peer => peer.group === op.group && peer.isHigh() && !peer.room.startsWith('dorm') && !peer.workaholic &&
      (peer.lowerLimit !== op.lowerLimit || peer.upperLimit !== op.upperLimit))) resting.add(op.name)
  }
  workspace.mainPlan.conf.rest_in_full = [...resting]
}

/**
 * Bounded whole-room complements, not an income search or a native scheduling proof.
 * Only main/ordinary-relief roles change; all policies and virtual references remain exact.
 * Unsupported structures are diagnosed and retained in the caller's original candidate pool.
 */
export function generateProductionShiftAlternatives(
  mainCandidates: readonly { id: string; workspace: RosterWorkspace }[],
  inventory: OperatorInventory,
  options: ProductionShiftAlternativeOptions = {},
): ProductionShiftAlternativeResult {
  const result: ProductionShiftAlternativeResult = { candidates: [], diagnostics: [] }
  const report = (code: string, message: string) => result.diagnostics.push({ code, message })
  const requested = options.maxCandidates ?? DEFAULT_CANDIDATES
  if (!Number.isInteger(requested) || requested < 0) {
    report('SHIFT_ALTERNATIVE_INVALID_LIMIT', '主替互补候选上限必须是非负有限整数。')
    return result
  }
  const limit = Math.min(requested, HARD_CANDIDATE_LIMIT)
  if (!limit) return result
  if (requested > HARD_CANDIDATE_LIMIT) report('SHIFT_ALTERNATIVE_LIMIT_CLAMPED', `主替互补候选固定最多 ${HARD_CANDIDATE_LIMIT} 个。`)
  if (!inventory.valid) {
    report('SHIFT_ALTERNATIVE_INVALID_INVENTORY', '需要有效实际干员库才能生成主替互补模式。')
    return result
  }
  const owned = new Set(inventory.operators.map(operator => resolveId(operator.charId)))
  const locked = new Set([...(options.lockedOperators ?? [])].map(resolveId))
  const lockedPositions = new Set([...(options.lockedPositions ?? [])].map(key => key.replace(/:(\d+)$/, '_$1')))
  const seen = new Set<string>()
  for (const { workspace } of mainCandidates) {
    try { seen.add(fingerprint(workspace)) } catch { /* The source-specific diagnostic is recorded below. */ }
  }
  for (const source of mainCandidates) {
    try {
      const base = source.workspace
      // Conditional overrides are not pure-main inputs and cannot be rewritten by this room-only helper.
      if (base.compatibility.backupPlans.length) {
        report('SHIFT_ALTERNATIVE_NOT_PURE_MAIN', `${source.id} 含已有副表，本模块只接收纯主表候选。`)
        continue
      }
      const initialIssues = validatePhysicalRoster(base)
      const resourceIssue = physicalResources(base, owned)
      if (initialIssues.length || resourceIssue) {
        report('SHIFT_ALTERNATIVE_INVALID_PHYSICAL', `${source.id}：${resourceIssue ?? initialIssues.map(issue => issue.message).join('；')}`)
        continue
      }
      const specialPolicies = new Set([...base.mainPlan.conf.workaholic, ...(base.mainPlan.conf.resting_standby ?? [])].map(resolveId))
      for (const roomId of MOWER_OUTPUT_ROOM_IDS) {
        const room = base.mainPlan.facilities[roomId]
        if (room.level <= 0 || room.type !== 'manufacture' && room.type !== 'trading') continue
        const capacity = facilityCapacity(room.type, room.level), slots = room.slots.slice(0, capacity)
        const context = `${source.id}/${roomId}`
        if (slots.length !== capacity || slots.some(slot => slot.occupant.kind !== 'operator') || slots.some(slot => slot.groupBindings?.length) || sharedGroup(base, room, slots)) {
          report('SHIFT_ALTERNATIVE_UNSUPPORTED_ROOM', `${context} 不是可独立对调的完整单绑定生产房，保留原表。`)
          continue
        }
        const ordinaryIndices = slots.map(slot => slot.replacements.flatMap((ref, index) => isOrdinaryReplacementCandidate(ref, room.type) ? [index] : []))
        if (ordinaryIndices.some(indices => indices.length !== 1) || slots.some(slot => slot.occupant.kind !== 'operator' || !isOrdinaryReplacementCandidate(slot.occupant.operatorId, room.type))) {
          report('SHIFT_ALTERNATIVE_UNSUPPORTED_RELIEF', `${context} 每个有效工位须恰有一个普通实体替班，主班也须可担任普通替班。`)
          continue
        }
        const participants = slots.flatMap((slot, index) => slot.occupant.kind === 'operator'
          ? [resolveId(slot.occupant.operatorId), resolveId(slot.replacements[ordinaryIndices[index]![0]!]!)] : [])
        if (slots.some((_, index) => lockedPositions.has(`${roomId}_${index}`)) || participants.some(actor => locked.has(actor))) {
          report('SHIFT_ALTERNATIVE_LOCKED_ROOM', `${context} 涉及用户锁定位置或主替干员，整房保持不变。`)
          continue
        }
        if (participants.some(actor => specialPolicies.has(actor))) {
          report('SHIFT_ALTERNATIVE_UNSUPPORTED_POLICY', `${context} 含常驻或待命策略成员，不属于本版普通主替整房互补范围。`)
          continue
        }
        const workspace = structuredClone(base), changed = workspace.mainPlan.facilities[roomId]
        slots.forEach((slot, index) => {
          if (slot.occupant.kind !== 'operator') return
          const replacementIndex = ordinaryIndices[index]![0]!
          changed.slots[index]!.occupant = { kind: 'operator', operatorId: resolveId(slot.replacements[replacementIndex]!) }
          changed.slots[index]!.replacements[replacementIndex] = resolveId(slot.occupant.operatorId)
        })
        if (!preservesFormedCombinations(base, workspace, inventory)) {
          report('SHIFT_ALTERNATIVE_CORE_SPLIT', `${context} 对调会拆开跨房或外部支持的完整组合，保留原表。`)
          continue
        }
        // These mutating helpers operate only on a throwaway copy. A new flag,
        // deduplication or reordered conf is not silently installed into the proposal.
        const policyProbe = structuredClone(workspace), originalConf = JSON.stringify(workspace.mainPlan.conf)
        const warmup = applyGeneratedWarmupPolicy(policyProbe, inventory)
        if (!warmup.valid) {
          report('SHIFT_ALTERNATIVE_WARMUP_UNSUPPORTED', `${context}：${warmup.diagnostics.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；')}`)
          continue
        }
        normalizeRecoveryProbe(policyProbe)
        if (JSON.stringify(policyProbe.mainPlan.conf) !== originalConf) {
          report('SHIFT_ALTERNATIVE_CONF_REQUIRED', `${context} 暖机耗尽或完整恢复需要调整 conf，房间覆盖版不能接纳。`)
          continue
        }
        const errors = [...validatePhysicalRoster(workspace), ...capacityIssues(workspace),
          ...compileRosterSchedule(workspace).diagnostics.filter(issue => issue.severity === 'error')]
        const physicalIssue = physicalResources(workspace, owned)
        if (errors.length || physicalIssue) {
          report('SHIFT_ALTERNATIVE_INVALID_RESULT', `${context}：${physicalIssue ?? errors.map(issue => issue.message).join('；')}`)
          continue
        }
        const key = fingerprint(workspace)
        if (seen.has(key)) continue
        seen.add(key)
        result.candidates.push({ id: `${source.id}:production-shift:${roomId}:${result.candidates.length + 1}`, workspace })
        if (result.candidates.length >= limit) return result
      }
    } catch (error) {
      report('SHIFT_ALTERNATIVE_INVALID_INPUT', `${source.id}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
