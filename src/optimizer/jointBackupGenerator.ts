import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import { MOWER_ROOM_IDS, type MowerFacility, type MowerRoomId, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { exportMowerJson } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compileBackupExpression } from '../scheduler/backupExpression'
import { readBackupGroups } from '../scheduler/backupGroups'
import { validatePhysicalRoster } from './rosterDraft'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import {
  GENERATED_BACKUP_PLAN_NAME, GENERATED_BACKUP_TIMING, generatedBackupTriggerExpression,
  type GeneratedBackupDescriptor, type GeneratedBackupTrigger,
} from './generatedBackupTypes'

export interface JointBackupMainCandidate { id: string; workspace: RosterWorkspace }
export interface GeneratedJointBackupCandidate {
  id: string
  workspace: RosterWorkspace
  generatedBackup: GeneratedBackupDescriptor
  mainId: string
  overlayId: string
}
export interface JointBackupGeneratorOptions {
  triggers: readonly GeneratedBackupTrigger[]
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
}
export interface JointBackupGeneratorResult {
  candidates: GeneratedJointBackupCandidate[]
  diagnostics: { code: string; message: string }[]
}

const canonical = (value: unknown): string => {
  const ordered = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(ordered)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]))
      : entry
  return JSON.stringify(ordered(value)) ?? 'undefined'
}
const participants = (slot: MowerSlot): string[] => [
  ...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []),
  ...slot.replacements,
  ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements),
].filter(value => value !== 'Free').map(resolveId)
const groups = (slot: MowerSlot): string[] => [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)]
  .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
const positionKey = (roomId: MowerRoomId, index: number): string => `${roomId}_${index}`
const slots = (workspace: RosterWorkspace) => Object.values(workspace.mainPlan.facilities)
  .flatMap(room => room.slots.map((slot, index) => ({ roomId: room.roomId, index, slot })))

/** Every occurrence matters for a locked operator, including its replacement role. */
function lockedProfile(workspace: RosterWorkspace, operator: string): string {
  return canonical(slots(workspace).filter(position => participants(position.slot).includes(operator))
    .map(position => [positionKey(position.roomId, position.index), position.slot]))
}

/** A changed group's replacement links can reach an otherwise external observer. */
function migrationClosure(a: RosterWorkspace, b: RosterWorkspace, rooms: readonly MowerRoomId[]): Set<string> {
  const positions = [...slots(a), ...slots(b)]
  const operators = new Set<string>(), shiftGroups = new Set<string>()
  const include = (slot: MowerSlot): void => {
    participants(slot).forEach(operator => operators.add(operator))
    groups(slot).forEach(group => shiftGroups.add(group))
  }
  positions.filter(position => rooms.includes(position.roomId)).forEach(position => include(position.slot))
  let changed = true
  while (changed) {
    const size = operators.size + shiftGroups.size
    for (const position of positions) {
      if (participants(position.slot).some(operator => operators.has(operator)) || groups(position.slot).some(group => shiftGroups.has(group))) include(position.slot)
    }
    changed = size !== operators.size + shiftGroups.size
  }
  return operators
}

function primaryPosition(workspace: RosterWorkspace, operator: string) {
  return slots(workspace).find(position => position.slot.occupant.kind === 'operator'
    && resolveId(position.slot.occupant.operatorId) === operator)
}

function commonState(workspace: RosterWorkspace): string {
  return canonical({ ...workspace, name: undefined,
    mainPlan: { ...workspace.mainPlan, id: undefined, name: undefined, facilities: undefined } })
}

/** Generate one ordinary conditional room overlay, never a task or a new policy.
 * The caller retains/evaluates pure main candidates separately with its F budget.
 */
export function generateJointBackupCandidates(
  mainCandidates: readonly JointBackupMainCandidate[], entries: readonly OwnedOperatorInput[], options: JointBackupGeneratorOptions,
): JointBackupGeneratorResult {
  const result: JointBackupGeneratorResult = { candidates: [], diagnostics: [] }
  const counts = new Map<string, { message: string; count: number }>()
  const reject = (code: string, message: string): void => {
    const previous = counts.get(code)
    if (previous) previous.count++
    else if (counts.size < 16) counts.set(code, { message: message.slice(0, 384), count: 1 })
  }
  const finish = (): JointBackupGeneratorResult => {
    result.diagnostics = [...counts].map(([code, detail]) => ({ code, message: detail.message + (detail.count > 1 ? `（共${detail.count}次）` : '') }))
    return result
  }
  const limit = options.maxCandidates ?? 16
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) {
    reject('INVALID_CANDIDATE_BUDGET', '自动副表候选上限须为0–64的整数')
    return finish()
  }
  if (!limit || mainCandidates.length < 2 || !options.triggers.length) return finish()
  const inventory = compileOperatorInventory(entries)
  if (!inventory.valid) {
    reject('INVALID_INVENTORY', '自动副表需要有效的实际持有干员与精英阶段/等级')
    return finish()
  }
  const owned = new Set(inventory.operators.map(operator => operator.charId))
  const lockedPositions = new Set([...(options.lockedPositions ?? [])].map(key => key.replace(/:(\d+)$/, '_$1')))
  const lockedOperators = new Set([...(options.lockedOperators ?? [])].map(resolveId))
  const triggers: { trigger: GeneratedBackupTrigger; expression: string; index: number }[] = []
  for (const [index, source] of options.triggers.entries()) {
    try {
      const expression = generatedBackupTriggerExpression(source)
      const trigger: GeneratedBackupTrigger = {
        activeWhen: source.activeWhen,
        observers: source.observers.map(observer => ({ operatorId: resolveId(observer.operatorId), roomId: observer.roomId,
          ...(observer.requirePositiveMood === undefined ? {} : { requirePositiveMood: observer.requirePositiveMood }) })),
      }
      if (trigger.observers.some(observer => !owned.has(observer.operatorId))) {
        reject('UNOWNED_OBSERVER', '自动副表观察者必须属于实际库存')
        continue
      }
      compileBackupExpression(expression, new Set())
      triggers.push({ trigger, expression, index })
    } catch (error) { reject('INVALID_TRIGGER', error instanceof Error ? error.message : '自动副表观察条件无效') }
  }
  if (!triggers.length) return finish()
  type Prepared = JointBackupMainCandidate & { exported: Record<string, unknown> }
  const prepared: Prepared[] = [], inputFingerprints = new Set<string>()
  for (const candidate of mainCandidates) {
    try {
      const workspace = candidate.workspace
      if (!candidate.id || workspace.compatibility.backupPlans.length) {
        reject('EXISTING_BACKUPS', '只对合法纯主表构造一个新副表；保留已有副表不改写')
        continue
      }
      if (readBackupGroups(workspace).some(group => group.id !== 'default')) {
        reject('NONDEFAULT_BACKUP_GROUPS', '首版不修改或接管已有非默认副表分组')
        continue
      }
      const physicalIssues = validatePhysicalRoster(workspace)
      if (physicalIssues.length) {
        reject('INVALID_MAIN', `主表${candidate.id}未通过实体排班验证：${physicalIssues[0]!.message}`)
        continue
      }
      if (slots(workspace).some(position => participants(position.slot).some(operator => !owned.has(operator)))) {
        reject('UNOWNED_MAIN_PARTICIPANT', `主表${candidate.id}的主班或候补不属于实际库存`)
        continue
      }
      const compiled = compileRosterSchedule(workspace)
      if (compiled.diagnostics.some(diagnostic => diagnostic.severity === 'error' || diagnostic.code === 'UNKNOWN_OPERATOR')) {
        reject('INVALID_MAIN_COMPILATION', `主表${candidate.id}含无法编译的岗位或人员`)
        continue
      }
      const fingerprint = canonical(workspace)
      if (inputFingerprints.has(fingerprint)) continue
      const document = JSON.parse(exportMowerJson(workspace)) as Record<string, unknown>
      const exported = document[workspace.compatibility.defaultPlanKey]
      if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
        reject('UNEXPORTABLE_MAIN', `主表${candidate.id}缺少可导出的完整计划`)
        continue
      }
      inputFingerprints.add(fingerprint)
      prepared.push({ ...candidate, exported: exported as Record<string, unknown> })
    } catch (error) { reject('INVALID_MAIN', error instanceof Error ? error.message : '主表格式无效') }
  }
  const fingerprints = new Set<string>()
  const changedRoomsFor = (a: Prepared, b: Prepared): MowerRoomId[] | undefined => {
    if (commonState(a.workspace) !== commonState(b.workspace)) {
      reject('INCOMPATIBLE_MAIN_CONFIGURATION', '主副输入的策略或兼容元数据不同，不能丢弃或改写未知配置')
      return
    }
    const changedRooms: MowerRoomId[] = []
    for (const roomId of MOWER_ROOM_IDS) {
      const left = a.workspace.mainPlan.facilities[roomId], right = b.workspace.mainPlan.facilities[roomId]
      if (canonical(left) === canonical(right)) continue
      if (!left || !right || !['manufacture', 'trading'].includes(left.type) || left.type !== right.type) {
        reject('UNSUPPORTED_NONPRODUCTION_DIFFERENCE', '仅支持完整制造/贸易房间的差异，不改外部岗位')
        return
      }
      const layout = (room: MowerFacility) => canonical({ ...room, product: undefined, slots: undefined })
      if (layout(left) !== layout(right) || left.slots.length !== right.slots.length) {
        reject('UNSUPPORTED_LAYOUT_DIFFERENCE', '自动副表不改变建筑、等级或工位数量')
        return
      }
      if ([left, right].some(room => room.level <= 0 || room.slots.length !== facilityCapacity(room.type, room.level)
        || room.slots.some(slot => slot.occupant.kind !== 'operator'))) {
        reject('INCOMPLETE_PRODUCTION_ROOM', '变化生产房间必须包含全部明确干员列，不使用Current/Free或空列')
        return
      }
      if ([...left.slots, ...right.slots].some(slot => slot.groupBindings?.length || slot.metadata && Object.keys(slot.metadata).length)) {
        reject('UNSUPPORTED_COMPLEX_SLOT', '首版不重写含复杂绑定或未知槽元数据的变化房间')
        return
      }
      if (![a, b].every(candidate => {
        const raw = candidate.exported[roomId]
        return raw && typeof raw === 'object' && !Array.isArray(raw)
          && Array.isArray((raw as { plans?: unknown }).plans)
          && (raw as { plans: unknown[] }).plans.length === left.slots.length
      })) {
        reject('UNEXPORTABLE_PRODUCTION_ROOM', '变化生产房间没有完整的原生导出片段，不能生成缺失覆盖')
        return
      }
      if (left.slots.some((slot, index) => lockedPositions.has(positionKey(roomId, index)) && canonical(slot) !== canonical(right.slots[index]))) {
        reject('LOCKED_POSITION_CHANGED', '主副差异会修改用户锁定岗位')
        return
      }
      changedRooms.push(roomId)
    }
    if (!changedRooms.length) return
    if ([...lockedOperators].some(operator => lockedProfile(a.workspace, operator) !== lockedProfile(b.workspace, operator))) {
      reject('LOCKED_OPERATOR_CHANGED', '主副差异会改变用户锁定干员的位置或主替角色')
      return
    }
    return changedRooms
  }
  type LegalPair = { a: Prepared; b: Prepared; changedRooms: MowerRoomId[]; closure: Set<string> }
  const pairs: LegalPair[] = []
  for (let left = 0; left < prepared.length; left++) for (let right = left + 1; right < prepared.length; right++) {
    const a = prepared[left]!, b = prepared[right]!
    const changedRooms = changedRoomsFor(a, b)
    if (!changedRooms) continue
    pairs.push({ a, b, changedRooms, closure: migrationClosure(a.workspace, b.workspace, changedRooms) })
  }
  // Ranking is G-only, never a bound on F. In the formal four-main/eight-trigger
  // domain this has at most 4 on + 4*8*(2**2-1) off projections = 100 calls.
  // Outside those bounds, or if any peer is unquantified, use stable fair order.
  const canRank = prepared.length <= 4 && triggers.length <= 8
  const scoreCache = new Map<Prepared, Map<string, number | undefined>>()
  let projections = 0
  const score = (main: Prepared, absent: readonly string[]): number | undefined => {
    const key = canonical([...absent].sort()), cached = scoreCache.get(main) ?? new Map<string, number | undefined>()
    scoreCache.set(main, cached)
    if (cached.has(key)) return cached.get(key)
    let value: number | undefined
    if (projections < 100) {
      const projected = structuredClone(main.workspace)
      for (const actor of absent) {
        const position = primaryPosition(projected, actor)!
        position.slot.occupant = { kind: 'empty' }
      }
      projections++
      try { value = productionWorkspaceHourlyScore(projected, inventory) } catch { value = undefined }
    }
    if (value !== undefined && !Number.isFinite(value)) value = undefined
    cached.set(key, value)
    return value
  }
  const rankPairs = (eligible: LegalPair[], trigger: GeneratedBackupTrigger): LegalPair[] => {
    if (!canRank || eligible.length < 2) return eligible
    const ranked: { pair: LegalPair; crossover: number; order: number }[] = []
    for (const [order, pair] of eligible.entries()) {
      const a = score(pair.a, []), b = score(pair.b, [])
      if (a === undefined || b === undefined) return eligible
      const onGap = a - b
      let crossover = 0
      // For an AND trigger, each nonempty absence subset is a possible false
      // state. These hypothetical copies are not admitted plans or F queries.
      for (let mask = 1; mask < 2 ** trigger.observers.length; mask++) {
        const absent = trigger.observers.filter((_observer, index) => mask & 2 ** index).map(observer => observer.operatorId)
        const offA = score(pair.a, absent), offB = score(pair.b, absent)
        if (offA === undefined || offB === undefined) return eligible
        const offGap = offA - offB
        if (onGap > 1e-7 && offGap < -1e-7 || onGap < -1e-7 && offGap > 1e-7) {
          crossover = Math.max(crossover, Math.min(Math.abs(onGap), Math.abs(offGap)))
        }
      }
      ranked.push({ pair, crossover, order })
    }
    return ranked.sort((a, b) => b.crossover - a.crossover || a.order - b.order).map(item => item.pair)
  }
  // Fair across pairs before spending another trigger polarity on the same pair.
  for (const { trigger, expression, index } of triggers) {
    const eligible = pairs.filter(({ a, b, closure }) => {
      if (trigger.observers.some(observer => {
        const first = primaryPosition(a.workspace, observer.operatorId), second = primaryPosition(b.workspace, observer.operatorId)
        return !first || !second || first.roomId !== observer.roomId || second.roomId !== observer.roomId
          || first.index !== second.index || closure.has(observer.operatorId)
      })) {
        reject('OBSERVER_NOT_EXTERNAL', '观察者须在两输入的同一外部主班岗位，且不能落入副表主替/组绑定迁移闭包')
        return false
      }
      return true
    })
    for (const { a, b, changedRooms } of rankPairs(eligible, trigger)) {
      for (const [main, overlay] of [[a, b], [b, a]] as const) {
        const plan = Object.fromEntries(changedRooms.map(room => [room, structuredClone(overlay.exported[room])]))
        const workspace = structuredClone(main.workspace)
        workspace.compatibility.backupPlans = [{
          name: GENERATED_BACKUP_PLAN_NAME, trigger: expression,
          trigger_timing: GENERATED_BACKUP_TIMING, exit_trigger_timing: GENERATED_BACKUP_TIMING, plan,
        }]
        // This known presence bit must be promoted before fingerprint/F: an
        // imported document without backup_plans otherwise drops the new plan.
        workspace.compatibility.importedHasBackupPlans = true
        const fingerprint = canonical(workspace)
        if (fingerprints.has(fingerprint)) continue
        fingerprints.add(fingerprint)
        result.candidates.push({
          id: `generated-backup:${main.id}:${overlay.id}:${index + 1}`,
          workspace, mainId: main.id, overlayId: overlay.id,
          generatedBackup: { version: 'joint-production-v1', trigger: structuredClone(trigger) },
        })
        if (result.candidates.length >= limit) return finish()
      }
    }
  }
  return finish()
}
