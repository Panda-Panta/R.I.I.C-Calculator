import { facilityCapacity } from '../domain/facilities'
import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { MOWER_OUTPUT_ROOM_IDS, type MowerFacility, type MowerRoomId, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { compiledScheduleToRuntimeConfig, isOrdinaryReplacementCandidate as ordinary } from '../scheduler/scheduleAdapter'
import { preservesFormedCombinations } from './combinationIntegrity'
import { physicalBackupOperatorIds, shiftSnapshot } from './combinationModel'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

const OUTPUT_LIMIT = 4, ROOM_PAIR_LIMIT = 6, STATE_LIMIT = 64, STATIC_CALL_LIMIT = STATE_LIMIT * 3
interface Candidate { id: string; workspace: RosterWorkspace }
interface Diagnostic { code: string; message: string }
interface Position { roomId: MowerRoomId; index: number; operatorId: string }
interface RoomPair { left: Position[]; right: Position[] }
interface RankedProposal { workspace: RosterWorkspace; score: number; key: string; order: number; changedRooms: MowerRoomId[]; repairOf?: string }
export interface MainRosterFreeCandidateOptions {
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
  userBase?: RosterWorkspace
  allowFreeCombinations?: boolean
}

/** Arrays, spelling and unknown metadata are significant; object key order is not. */
function fingerprint(value: unknown): string {
  const order = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(order)
    : entry !== null && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, order(child)])) : entry
  return JSON.stringify(order(value))
}
const references = (slot: MowerSlot): string[] => [
  ...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements,
  ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements),
].filter(ref => ref !== 'Free').map(id)
const configured = (slot: MowerSlot): boolean => slot.occupant.kind !== 'empty' || Boolean(slot.groupId) ||
  slot.replacements.length > 0 || Boolean(slot.groupBindings?.length) || Boolean(Object.keys(slot.metadata ?? {}).length) || Boolean(slot.dormitoryResident)

/** Actual owned references and disjoint physical primary/ordinary-relief roles. */
function resourceIssue(workspace: RosterWorkspace, owned: ReadonlySet<string>): string | undefined {
  const occupied = new Set<string>()
  for (const room of Object.values(workspace.mainPlan.facilities)) if (room.level > 0) for (const slot of room.slots) {
    if (references(slot).some(actor => !owned.has(actor))) return `${room.roomId} 含未持有引用；不能用满练度目录补全。`
    const actors = [
      ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, slot),
      ...(room.type === 'dormitory' ? [] : (slot.groupBindings ?? []).flatMap(binding => binding.replacements.filter(ref => ordinary(ref, room.type)).map(id))),
    ]
    for (const actor of actors) {
      if (occupied.has(actor)) return `${actor} 被多个主班或普通实体替班角色占用；本域不支持共享实体角色。`
      occupied.add(actor)
    }
  }
  return undefined
}

/** A seed must still contain user facts before any generated template may be split. */
function userFactsIssue(base: RosterWorkspace, workspace: RosterWorkspace): string | undefined {
  for (const room of Object.values(base.mainPlan.facilities)) for (const [index, slot] of room.slots.entries()) {
    if (!configured(slot)) continue
    const current = workspace.mainPlan.facilities[room.roomId]?.slots[index]
    if (!current || slot.occupant.kind !== 'empty' && fingerprint(slot.occupant) !== fingerprint(current.occupant) ||
      slot.replacements.length > 0 && fingerprint(slot.replacements) !== fingerprint(current.replacements) ||
      slot.groupId && slot.groupId !== current.groupId ||
      slot.groupBindings?.length && fingerprint(slot.groupBindings) !== fingerprint(current.groupBindings) ||
      Object.keys(slot.metadata ?? {}).length > 0 && fingerprint(slot.metadata) !== fingerprint(current.metadata) ||
      slot.dormitoryResident && !current.dormitoryResident) return `${room.roomId} 第 ${index + 1} 位已配置的用户主位、替班或完整槽位已发生变化。`
  }
  return undefined
}

function sharesGroup(workspace: RosterWorkspace, room: MowerFacility): boolean {
  const groups = new Set(room.slots.map(slot => slot.groupId?.trim()).filter(Boolean))
  return Object.values(workspace.mainPlan.facilities).some(other => other.level > 0 && other.roomId !== room.roomId && other.slots.some(slot =>
    [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)].some(group => group?.trim() && groups.has(group.trim()))))
}

/** Probe ungrouped workers as singleton recovery groups, without installing any policy. */
function recoveryIssue(workspace: RosterWorkspace): string | undefined {
  const probe = structuredClone(workspace), groups = new Set(Object.values(probe.mainPlan.facilities)
    .flatMap(room => room.slots.flatMap(slot => [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)])))
  let nextGroup = 0
  for (const room of Object.values(probe.mainPlan.facilities)) if (room.level > 0 && room.type !== 'dormitory') {
    for (const slot of room.slots.slice(0, facilityCapacity(room.type, room.level))) {
      if (slot.occupant.kind !== 'operator' || slot.groupId?.trim()) continue
      let group: string
      do { group = `__main_free_capacity_${nextGroup++}` } while (groups.has(group))
      groups.add(group); slot.groupId = group
    }
  }
  const issues = recoveryGroupCapacityIssues(probe)
  if (issues.length) return issues.map(issue => issue.message).join('；')
  const config = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace))
  config.mowerAlpha = true
  const operators = Object.values(getMowerSourceRuntime(createRosterRuntime(config)).data.operators)
  // Same native mood-window gate as complete shift alternatives: a regrouping
  // that needs rest_in_full must be proposed by a separate policy optimizer.
  for (const actor of operators) {
    if (!actor.isHigh() || !actor.group || actor.room.startsWith('dorm') || actor.lowerLimit <= 0 ||
      actor.workaholic || actor.exhaustRequire || actor.restInFull || actor.restingPriority === 'standby') continue
    if (operators.some(peer => peer.group === actor.group && peer.isHigh() && !peer.room.startsWith('dorm') && !peer.workaholic &&
      (peer.lowerLimit !== actor.lowerLimit || peer.upperLimit !== actor.upperLimit))) return `${actor.name} 的新组需要额外完整恢复策略；本模块保留原 conf。`
  }
  return undefined
}

/** Unknown retained settings may use a group as a value, key or expression. */
function containsGroupReference(value: unknown, group: string): boolean {
  if (typeof value === 'string') return value.includes(group)
  if (Array.isArray(value)) return value.some(entry => containsGroupReference(entry, group))
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, entry]) => key.includes(group) || containsGroupReference(entry, group))
}

/** Only a proven internal, single-binding recovery group may become independent slots. */
function independentRecoveryProposal(
  proposal: RosterWorkspace, changedRooms: readonly MowerRoomId[], userBase: RosterWorkspace,
  protectedPositions: ReadonlySet<string>, locked: ReadonlySet<string>, special: ReadonlySet<string>,
): { workspace?: RosterWorkspace; issue?: string } {
  const positions = Object.values(proposal.mainPlan.facilities).flatMap(room => room.slots.map((slot, index) => ({ room, slot, index })))
  const exhaust = new Set(proposal.mainPlan.conf.exhaust_require.map(id))
  const groups = new Set(positions.filter(({ room, slot }) => changedRooms.includes(room.roomId) && slot.occupant.kind === 'operator' &&
    exhaust.has(id(slot.occupant.operatorId))).map(({ slot }) => slot.groupId?.trim()).filter((group): group is string => Boolean(group)))
  const changed: typeof positions = []
  for (const group of groups) {
    const members = positions.filter(({ slot }) => slot.groupId?.trim() === group || slot.groupBindings?.some(binding => binding.groupId?.trim() === group))
    if (members.length < 2) continue
    const userGroup = Object.values(userBase.mainPlan.facilities).some(room => room.slots.some(slot => slot.groupId?.trim() === group ||
      slot.groupBindings?.some(binding => binding.groupId?.trim() === group)))
    if (userGroup) return { issue: `组「${group}」来自用户原表，不能改为独立恢复。` }
    if (containsGroupReference(proposal.mainPlan.conf, group) || containsGroupReference(proposal.compatibility, group) ||
      positions.some(({ slot }) => containsGroupReference(slot.metadata, group))) {
      return { issue: `组「${group}」有高级恢复排除或保留字段中的外部引用，不能确认独立改组安全。` }
    }
    if (members.some(({ room, slot, index }) => !changedRooms.includes(room.roomId) || room.level <= 0 ||
      room.type !== 'manufacture' && room.type !== 'trading' || slot.groupBindings?.length || slot.occupant.kind !== 'operator' ||
      protectedPositions.has(`${room.roomId}_${index}`) || references(slot).some(actor => locked.has(actor)) ||
      slot.occupant.kind === 'operator' && special.has(id(slot.occupant.operatorId)))) {
      return { issue: `组「${group}」含外部工位、用户锁、特殊策略或额外绑定，不能整体拆成独立恢复。` }
    }
    changed.push(...members)
  }
  if (!changed.length) return {}
  const workspace = structuredClone(proposal)
  for (const { room, index } of changed) workspace.mainPlan.facilities[room.roomId].slots[index]!.groupId = null
  const compiled = compileRosterSchedule(workspace), config = compiledScheduleToRuntimeConfig(compiled)
  config.mowerAlpha = true
  const native = getMowerSourceRuntime(createRosterRuntime(config)).data
  for (const { room, index } of changed) {
    const slot = workspace.mainPlan.facilities[room.roomId].slots[index]!, runtime = config.positions.find(position => position.id === `${room.roomId}_${index}`)
    const actor = slot.occupant.kind === 'operator' ? native.operators[id(slot.occupant.operatorId)] : undefined
    if (!runtime || runtime.group || fingerprint(runtime.candidates) !== fingerprint(physicalBackupOperatorIds(room, slot)) ||
      !actor || actor.group || actor.multiGroup || fingerprint(actor.replacement) !== fingerprint(slot.replacements.map(id))) {
      return { issue: `${room.roomId} 第 ${index + 1} 位未编译为独立工休及原有序替班，拒绝修复提案。` }
    }
  }
  return { workspace }
}

/**
 * A bounded proposal domain, not an optimum or a duty-cycle income estimate.
 * It exchanges one or two primary positions between actual complete rooms.
 * Relief lists, user facts and conf stay exact. Free mode may also propose
 * independent recovery for proven internal exhaust groups, without extra bindings.
 * These are hypotheses for full F verification, not a fatigue-free promise.
 */
export function generateMainRosterFreeCandidates(
  workspace: RosterWorkspace, inventory: OperatorInventory, options: MainRosterFreeCandidateOptions = {},
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const result: { candidates: Candidate[]; diagnostics: Diagnostic[] } = { candidates: [], diagnostics: [] }
  const reports = new Map<string, { message: string; count: number }>()
  const report = (code: string, message: string) => {
    const previous = reports.get(code)
    if (previous) previous.count++
    else if (reports.size < 20) reports.set(code, { message: message.slice(0, 400), count: 1 })
  }
  let states = 0, rawStates = 0, repairStates = 0, staticCalls = 0, pairCount = 0
  const finish = () => {
    result.diagnostics = [...reports].map(([code, entry]) => ({ code, message: entry.message + (entry.count > 1 ? `（共 ${entry.count} 次）` : '') }))
    if (pairCount) result.diagnostics.push({ code: 'MAIN_FREE_BUDGET', message: `有限跨房域：房对 ${pairCount}/${ROOM_PAIR_LIMIT}、提案/探针 ${states}/${STATE_LIMIT}（主位 ${rawStates}、独立恢复尝试 ${repairStates}）、静态调用 ${staticCalls}/${STATIC_CALL_LIMIT}、输出 ${result.candidates.length}/${OUTPUT_LIMIT}；静态值只排序提案，未验证工休收益 F。` })
    return result
  }
  const requested = options.maxCandidates ?? OUTPUT_LIMIT
  if (!Number.isInteger(requested) || requested < 0) { report('MAIN_FREE_INVALID_LIMIT', '候选上限须为非负有限整数。'); return finish() }
  const limit = Math.min(requested, OUTPUT_LIMIT)
  if (!limit) return finish()
  if (requested > OUTPUT_LIMIT) report('MAIN_FREE_LIMIT_CLAMPED', `自由主班候选固定最多 ${OUTPUT_LIMIT} 个。`)
  if (!inventory.valid) { report('MAIN_FREE_INVALID_INVENTORY', '需要有效实际干员库。'); return finish() }
  const repairEnabled = options.allowFreeCombinations === true && options.userBase !== undefined
  const rawLimit = repairEnabled ? STATE_LIMIT - OUTPUT_LIMIT : STATE_LIMIT
  try {
    if (workspace.compatibility.backupPlans.length) { report('MAIN_FREE_NOT_PURE_MAIN', '已有条件副表不能由纯主表自由组合改写。'); return finish() }
    const owned = new Set(inventory.operators.map(operator => id(operator.charId)))
    const physical = validatePhysicalRoster(workspace), compiled = compileRosterSchedule(workspace)
    const resource = resourceIssue(workspace, owned), userIssue = options.userBase && userFactsIssue(options.userBase, workspace)
    if (physical.length || compiled.diagnostics.some(issue => issue.severity === 'error' || issue.code === 'UNKNOWN_OPERATOR') || resource || userIssue) {
      report('MAIN_FREE_INVALID_SOURCE', resource ?? userIssue ?? [...physical, ...compiled.diagnostics].map(issue => issue.message).join('；')); return finish()
    }
    const protectedPositions = new Set([...(options.lockedPositions ?? [])].map(key => key.replace(/:(\d+)$/, '_$1')))
    if (options.userBase) for (const room of Object.values(options.userBase.mainPlan.facilities)) room.slots.forEach((slot, index) => {
      if (configured(slot)) protectedPositions.add(`${room.roomId}_${index}`)
    })
    const locked = new Set([...(options.lockedOperators ?? [])].map(id))
    const special = new Set([...workspace.mainPlan.conf.workaholic, ...(workspace.mainPlan.conf.resting_standby ?? [])].map(id))
    const rooms: Position[][] = []
    for (const roomId of MOWER_OUTPUT_ROOM_IDS) {
      const room = workspace.mainPlan.facilities[roomId]
      if (room.level <= 0 || room.type !== 'manufacture' && room.type !== 'trading') continue
      const capacity = facilityCapacity(room.type, room.level), slots = room.slots.slice(0, capacity)
      if (slots.length !== capacity || slots.some(slot => slot.occupant.kind !== 'operator' || !slot.replacements.some(ref => ordinary(ref, room.type)))) {
        report('MAIN_FREE_INCOMPLETE_ROOM', `${roomId} 缺完整主班或普通替班；不能将不完整生产房作为完整候选。`); return finish()
      }
      if (slots.some(slot => slot.groupBindings?.length) || sharesGroup(workspace, room)) {
        report('MAIN_FREE_UNSUPPORTED_LINK', `${roomId} 有额外绑定或跨房换班组，本有限域无法证明支持其重分配。`); continue
      }
      const positions = slots.flatMap((slot, index): Position[] => slot.occupant.kind !== 'operator' ||
        protectedPositions.has(`${roomId}_${index}`) || references(slot).some(actor => locked.has(actor)) ||
        special.has(id(slot.occupant.operatorId)) || !ordinary(slot.occupant.operatorId, room.type)
        ? [] : [{ roomId, index, operatorId: id(slot.occupant.operatorId) }])
      if (positions.length) rooms.push(positions)
    }
    const pairs: RoomPair[] = []
    for (let left = 0; left < rooms.length; left++) for (let right = left + 1; right < rooms.length; right++) {
      if (pairs.length < ROOM_PAIR_LIMIT) pairs.push({ left: rooms[left]!, right: rooms[right]! })
      else report('MAIN_FREE_PAIR_LIMIT', '跨房对预算已到；未枚举其他房对，不表示它们无解。')
    }
    pairCount = pairs.length
    if (!pairCount) { report('MAIN_FREE_NO_ROOM_PAIR', '没有两个同时可调整的完整独立生产房；保留用户位置和人员锁。'); return finish() }
    const ranked: RankedProposal[] = []
    const seen = new Set([fingerprint(workspace)])
    const supports = (actor: string, roomId: MowerRoomId) => {
      const facility = workspace.mainPlan.facilities[roomId].type === 'manufacture' ? 'MANUFACTURE' : 'TRADING'
      return inventory.operators.find(operator => operator.charId === actor)?.skills.some(skill => skill.roomType === facility)
    }
    const admit = (proposal: RosterWorkspace, changedRooms: MowerRoomId[], order: number, repairOf?: string): RankedProposal | undefined => {
      const key = fingerprint(proposal)
      if (seen.has(key)) return
      seen.add(key)
      if ((!options.allowFreeCombinations && !preservesFormedCombinations(workspace, proposal, inventory)) ||
        options.userBase && !preservesFormedCombinations(options.userBase, proposal, inventory)) {
        report('MAIN_FREE_CORE_PROTECTED', '当前模式保留完整组合，或该组合来自用户原表；自由开关只允许拆内部模板。'); return
      }
      const policyProbe = structuredClone(proposal), warmup = applyGeneratedWarmupPolicy(policyProbe, inventory)
      if (!warmup.valid || fingerprint(policyProbe.mainPlan.conf) !== fingerprint(proposal.mainPlan.conf)) {
        report('MAIN_FREE_WARMUP_POLICY', warmup.diagnostics.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；') ||
          '暖机主班需要补充耗尽策略；保留原 conf 并拒绝该提案。'); return
      }
      const errors = [...validatePhysicalRoster(proposal), ...compileRosterSchedule(proposal).diagnostics.filter(issue => issue.severity === 'error' || issue.code === 'UNKNOWN_OPERATOR')]
      const invalidResource = resourceIssue(proposal, owned), recovery = recoveryIssue(proposal)
      if (errors.length || invalidResource || recovery) {
        report('MAIN_FREE_REJECTED', invalidResource ?? recovery ?? errors.map(issue => issue.message).join('；')); return
      }
      const project = (snapshot: RosterWorkspace): number | undefined => {
        staticCalls++
        try {
          const value = productionWorkspaceHourlyScore(snapshot, inventory)
          return value !== undefined && Number.isFinite(value) ? value : undefined
        } catch { return undefined }
      }
      const score = project(proposal)
      if (score === undefined || changedRooms.some(roomId => project(shiftSnapshot(proposal, 'backup', roomId)) === undefined)) {
        report('MAIN_FREE_UNQUANTIFIED', '实际主班或普通替班上下文不能完整量化，未用零分替代。'); return
      }
      return { workspace: proposal, score, key, order, changedRooms, ...(repairOf ? { repairOf } : {}) }
    }
    const offer = (exchanges: readonly [Position, Position][]): void => {
      if (rawStates >= rawLimit) return
      states++; rawStates++
      if (exchanges.some(([a, b]) => !supports(a.operatorId, b.roomId) || !supports(b.operatorId, a.roomId))) {
        report('MAIN_FREE_SKILL_UNAVAILABLE', '跨房干员缺少目标设施的实际解锁技能；不提升练度。'); return
      }
      const proposal = structuredClone(workspace)
      for (const [a, b] of exchanges) {
        proposal.mainPlan.facilities[a.roomId].slots[a.index]!.occupant = { kind: 'operator', operatorId: b.operatorId }
        proposal.mainPlan.facilities[b.roomId].slots[b.index]!.occupant = { kind: 'operator', operatorId: a.operatorId }
      }
      const row = admit(proposal, [...new Set(exchanges.flatMap(([a, b]) => [a.roomId, b.roomId]))], states)
      if (row) ranked.push(row)
    }
    // Spread singles across room pairs before consuming the bounded repair domain.
    for (const pair of pairs) for (const a of pair.left) for (const b of pair.right) offer([[a, b]])
    for (const pair of pairs) for (let a = 0; a < pair.left.length; a++) for (let b = a + 1; b < pair.left.length; b++) {
      for (let c = 0; c < pair.right.length; c++) for (let d = c + 1; d < pair.right.length; d++) {
        offer([[pair.left[a]!, pair.right[c]!], [pair.left[b]!, pair.right[d]!]])
        offer([[pair.left[a]!, pair.right[d]!], [pair.left[b]!, pair.right[c]!]])
      }
    }
    if (rawStates >= rawLimit) report('MAIN_FREE_STATE_LIMIT', `主位提案预算 ${rawLimit} 已到；未扩大搜索或放宽准入。`)
    const rank = (a: RankedProposal, b: RankedProposal) => b.score - a.score || a.order - b.order || a.key.localeCompare(b.key)
    ranked.sort(rank)
    const repairs: RankedProposal[] = []
    if (repairEnabled) for (const raw of ranked.slice(0, OUTPUT_LIMIT)) {
      states++; repairStates++
      const repair = independentRecoveryProposal(raw.workspace, raw.changedRooms, options.userBase!, protectedPositions, locked, special)
      if (repair.issue) { report('MAIN_FREE_RECOVERY_UNSUPPORTED', repair.issue); continue }
      if (!repair.workspace) continue
      const row = admit(repair.workspace, raw.changedRooms, raw.order, raw.key)
      if (row) repairs.push(row)
    }
    else if (options.allowFreeCombinations) report('MAIN_FREE_RECOVERY_NEEDS_USER_BASE', '缺少原始 userBase，不能证明同步组为内部生成；只保留主位提案。')
    // Reserve up to two output slots for repair hypotheses. Never spend another
    // downstream F slot on the same actor arrangement with its known risky sync.
    repairs.sort(rank)
    const repairedKeys = new Set(repairs.map(row => row.repairOf)), reserved = repairs.slice(0, Math.min(2, limit))
    const merged = [...ranked.filter(row => !repairedKeys.has(row.key)), ...repairs].sort(rank)
    const selected = [...reserved, ...merged.filter(row => !reserved.includes(row))].slice(0, limit).sort(rank)
    result.candidates = selected.map((row, index) => ({ id: `main-free:${row.repairOf ? 'repair:' : ''}${index + 1}`, workspace: row.workspace }))
  } catch (error) { report('MAIN_FREE_INVALID_INPUT', error instanceof Error ? error.message : String(error)) }
  return finish()
}
