import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { MOWER_OUTPUT_ROOM_IDS, type MowerFacility, type MowerRoomId, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, isOrdinaryReplacementCandidate as ordinary } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { physicalBackupOperatorIds, shiftSnapshot } from './combinationModel'
import { preservesFormedCombinations } from './combinationIntegrity'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

const ROOM_LIMIT = 2, POOL_LIMIT = 8, IDLE_SCAN_LIMIT = 48, SCORE_LIMIT = 512, OUTPUT_LIMIT = 4, ADMISSION_LIMIT = 32
type Candidate = { id: string; workspace: RosterWorkspace }
type Diagnostic = { code: string; message: string }
type Team = { actors: string[]; score: number; order: number }
type Pair = { main: Team; relief: Team; order: number }

export interface MainRosterCrewCandidateOptions {
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
  userBase?: RosterWorkspace
  allowFreeCombinations?: boolean
}

const fingerprint = (value: unknown): string => {
  const order = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(order)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, order(child)])) : entry
  return JSON.stringify(order(value))
}
const references = (slot: MowerSlot) => [
  ...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements,
  ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements),
].filter(ref => ref !== 'Free').map(id)
const physical = (room: MowerFacility, slot: MowerSlot) => [
  ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, slot),
  ...(room.type === 'dormitory' ? [] : (slot.groupBindings ?? []).flatMap(binding => binding.replacements.filter(ref => ordinary(ref, room.type)).map(id))),
]
const configured = (slot: MowerSlot) => slot.occupant.kind !== 'empty' || Boolean(slot.groupId) || slot.replacements.length > 0 ||
  Boolean(slot.groupBindings?.length) || Boolean(Object.keys(slot.metadata ?? {}).length) || Boolean(slot.dormitoryResident)

function resourceIssue(workspace: RosterWorkspace, owned: ReadonlySet<string>): string | undefined {
  const claimed = new Set<string>()
  for (const room of Object.values(workspace.mainPlan.facilities)) if (room.level > 0) for (const slot of room.slots) {
    if (references(slot).some(actor => !owned.has(actor))) return `${room.roomId} 含未持有的在岗或候补引用。`
    for (const actor of physical(room, slot)) {
      if (claimed.has(actor)) return `${actor} 重复占用主班或普通替班角色。`
      claimed.add(actor)
    }
  }
  return undefined
}

function userFactsIssue(original: RosterWorkspace, current: RosterWorkspace): boolean {
  return Object.values(original.mainPlan.facilities).some(room => room.slots.some((slot, index) => {
    if (!configured(slot)) return false
    const actualRoom = current.mainPlan.facilities[room.roomId], actual = actualRoom?.slots[index]
    return !actual || actualRoom.type !== room.type || actualRoom.level !== room.level || actualRoom.product !== room.product ||
      slot.occupant.kind !== 'empty' && fingerprint(slot.occupant) !== fingerprint(actual.occupant) ||
      slot.replacements.length > 0 && fingerprint(slot.replacements) !== fingerprint(actual.replacements) ||
      Boolean(slot.groupId) && slot.groupId !== actual.groupId ||
      Boolean(slot.groupBindings?.length) && fingerprint(slot.groupBindings) !== fingerprint(actual.groupBindings) ||
      Boolean(Object.keys(slot.metadata ?? {}).length) && fingerprint(slot.metadata) !== fingerprint(actual.metadata) ||
      Boolean(slot.dormitoryResident) && !actual.dormitoryResident
  }))
}

function sharesGroup(workspace: RosterWorkspace, room: MowerFacility): boolean {
  const groups = new Set(room.slots.map(slot => slot.groupId?.trim()).filter(Boolean))
  return Object.values(workspace.mainPlan.facilities).some(other => other.roomId !== room.roomId && other.level > 0 && other.slots.some(slot =>
    [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)].some(group => group?.trim() && groups.has(group.trim()))))
}

function containsReference(value: unknown, reference: string): boolean {
  if (typeof value === 'string') return value.includes(reference)
  if (Array.isArray(value)) return value.some(entry => containsReference(entry, reference))
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) => key.includes(reference) || containsReference(child, reference))
}

/** Preserve virtual references and their order; this finite domain has one ordinary relief per slot. */
function install(workspace: RosterWorkspace, roomId: MowerRoomId, main: readonly string[], relief?: readonly string[]) {
  workspace.mainPlan.facilities[roomId].slots.forEach((slot, index) => {
    slot.occupant = { kind: 'operator', operatorId: main[index]! }
    slot.replacements = slot.replacements.flatMap(ref => ordinary(ref, 'manufacture') ? relief ? [relief[index]!] : [] : [ref])
  })
}

function recoveryIssue(workspace: RosterWorkspace): string | undefined {
  // The existing capacity rule only counts named groups. Give independent
  // positions singleton names in this disposable probe, never in the candidate.
  const capacityProbe = structuredClone(workspace), used = new Set(Object.values(workspace.mainPlan.facilities).flatMap(room => room.slots.map(slot => slot.groupId)))
  let next = 0
  for (const room of Object.values(capacityProbe.mainPlan.facilities)) if (room.level > 0 && room.type !== 'dormitory') for (const slot of room.slots) {
    if (slot.occupant.kind !== 'operator' || slot.groupId?.trim()) continue
    let group: string
    do { group = `__main_crew_capacity_${next++}` } while (used.has(group))
    used.add(group); slot.groupId = group
  }
  const capacity = recoveryGroupCapacityIssues(capacityProbe)
  if (capacity.length) return capacity[0]!.message
  const config = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace))
  config.mowerAlpha = true
  const operators = Object.values(getMowerSourceRuntime(createRosterRuntime(config)).data.operators)
  // Reuse the Native runtime's actual per-person windows, without installing a
  // new rest_in_full policy to make an otherwise incompatible crew admissible.
  for (const actor of operators) {
    if (!actor.isHigh() || !actor.group || actor.room.startsWith('dorm') || actor.lowerLimit <= 0 || actor.workaholic ||
      actor.exhaustRequire || actor.restInFull || actor.restingPriority === 'standby') continue
    if (operators.some(peer => peer.group === actor.group && peer.isHigh() && !peer.room.startsWith('dorm') && !peer.workaholic &&
      (peer.lowerLimit !== actor.lowerLimit || peer.upperLimit !== actor.upperLimit))) return `${actor.name} 的新队伍需要额外恢复策略；保留原 conf。`
  }
  return undefined
}

/** Joint sets in a finite proposal domain, never an F estimate or optimum proof.
 * Static primary/relief extremes and a worst-static-shift proposal retain
 * diversity without assigning either team an invented work/rest fraction.
 */
export function generateMainRosterCrewCandidates(
  workspace: RosterWorkspace, inventory: OperatorInventory, options: MainRosterCrewCandidateOptions = {},
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const result: { candidates: Candidate[]; diagnostics: Diagnostic[] } = { candidates: [], diagnostics: [] }
  const messages = new Map<string, { message: string; count: number }>()
  const report = (code: string, message: string) => {
    const previous = messages.get(code)
    if (previous) previous.count++
    else if (messages.size < 20) messages.set(code, { message: message.slice(0, 400), count: 1 })
  }
  let rooms = 0, calls = 0, unknown = 0
  const domains: { roomId: MowerRoomId; available: number; scannedIdle: number; pool: number; teams: number; quantified: number; pairs: number; admissions: number }[] = []
  const finish = () => {
    result.diagnostics = [...messages].map(([code, entry]) => ({ code, message: entry.message + (entry.count > 1 ? `（共 ${entry.count} 次）` : '') }))
    if (unknown) result.diagnostics.push({ code: 'MAIN_CREW_UNQUANTIFIED', message: `${unknown} 个静态上下文未量化，不以零值排名。` })
    if (domains.length) result.diagnostics.push({ code: 'MAIN_CREW_BUDGET', message: `有限整队域：房间 ${rooms}/${ROOM_LIMIT}，全基地静态调用 ${calls}/${SCORE_LIMIT}，输出 ${result.candidates.length}/${OUTPUT_LIMIT}；${domains.map(d => `${d.roomId} 可用${d.available}、闲置探针${d.scannedIdle}/${IDLE_SCAN_LIMIT}、池${d.pool}/${POOL_LIMIT}、队${d.teams}/56、量化${d.quantified}、有向主替对${d.pairs}/560、准入${d.admissions}/${ADMISSION_LIMIT}`).join('；')}。队内槽序固定，未穷尽全库或实际工休 F。` })
    return result
  }
  const requested = options.maxCandidates ?? OUTPUT_LIMIT
  if (!Number.isInteger(requested) || requested < 0) { report('MAIN_CREW_INVALID_LIMIT', '整队提案上限须为非负有限整数。'); return finish() }
  const limit = Math.min(requested, OUTPUT_LIMIT)
  if (!limit || options.allowFreeCombinations !== true) return finish()
  if (requested > OUTPUT_LIMIT) report('MAIN_CREW_LIMIT_CLAMPED', '整队候选最多四份，不扩大实际 F 预算。')
  if (!inventory.valid) { report('MAIN_CREW_INVALID_INVENTORY', '需要有效的实际库存与已解锁技能。'); return finish() }
  try {
    if (workspace.compatibility.backupPlans.length) { report('MAIN_CREW_NOT_PURE_MAIN', '整队提案不改已有条件副表。'); return finish() }
    const original = options.userBase ?? workspace, owned = new Set(inventory.operators.map(operator => operator.charId))
    const sourceIssue = resourceIssue(workspace, owned)
    if (validatePhysicalRoster(workspace).length || sourceIssue || userFactsIssue(original, workspace) ||
      compileRosterSchedule(workspace).diagnostics.some(issue => issue.severity === 'error' || issue.code === 'UNKNOWN_OPERATOR')) {
      report('MAIN_CREW_INVALID_SOURCE', sourceIssue ?? '输入的实体、编译或原用户事实不完整。'); return finish()
    }
    const locked = new Set([...(options.lockedOperators ?? [])].map(id))
    const protectedPositions = new Set([...(options.lockedPositions ?? [])].map(key => key.replace(/:(\d+)$/, '_$1')))
    for (const room of Object.values(original.mainPlan.facilities)) room.slots.forEach((slot, index) => {
      if (configured(slot)) protectedPositions.add(`${room.roomId}_${index}`)
    })
    const special = new Set([...workspace.mainPlan.conf.workaholic, ...(workspace.mainPlan.conf.resting_standby ?? [])].map(id))
    const score = (probe: RosterWorkspace): number | undefined => {
      if (calls >= SCORE_LIMIT) return undefined
      calls++
      try {
        const value = productionWorkspaceHourlyScore(probe, inventory)
        if (value !== undefined && Number.isFinite(value)) return value
      } catch { /* Unsupported static context remains unknown. */ }
      unknown++; return undefined
    }
    const perRoom: Candidate[][] = [], seen = new Set([fingerprint(workspace)])
    for (const roomId of MOWER_OUTPUT_ROOM_IDS) {
      const room = workspace.mainPlan.facilities[roomId]
      if (room.type !== 'manufacture' || room.level !== 3) continue
      const slots = room.slots, actors = slots.flatMap(slot => physical(room, slot))
      const simple = slots.length === 3 && slots.every(slot => slot.occupant.kind === 'operator' && !slot.groupBindings?.length &&
        slot.replacements.filter(ref => ordinary(ref, room.type)).length === 1)
      const groupKinds = new Set(slots.map(slot => slot.groupId?.trim() || ''))
      if (!simple || groupKinds.size !== 1 || sharesGroup(workspace, room) || slots.some((slot, index) =>
        protectedPositions.has(`${roomId}_${index}`) || references(slot).some(actor => locked.has(actor))) || actors.some(actor => special.has(actor))) {
        report('MAIN_CREW_UNSUPPORTED_ROOM', `${roomId} 须为未锁、无跨房或额外绑定、单一普通替班的简单完整三工位制造房。`); continue
      }
      const group = slots[0]!.groupId?.trim()
      if (group && (containsReference(workspace.mainPlan.conf, group) || containsReference(workspace.compatibility, group) ||
        Object.values(workspace.mainPlan.facilities).some(other => other.slots.some(slot => containsReference(slot.metadata, group))))) {
        report('MAIN_CREW_EXTERNAL_REFERENCE', `${roomId} 的恢复组有高级或未知字段外部引用，无法确认自由整队改写安全。`); continue
      }
      if (rooms >= ROOM_LIMIT) { report('MAIN_CREW_ROOM_LIMIT', '已到两房有限域，未搜索的房间不代表无更优队伍。'); break }
      rooms++
      const outside = new Set(Object.values(workspace.mainPlan.facilities).filter(other => other.level > 0 && other.roomId !== roomId)
        .flatMap(other => other.slots.flatMap(slot => physical(other, slot))))
      const originalActors = new Set(actors)
      const available = inventory.operators.filter(operator => !outside.has(operator.charId) && !locked.has(operator.charId) && !special.has(operator.charId) &&
        ordinary(operator.charId, room.type) && operator.skills.some(skill => skill.roomType === 'MANUFACTURE') && !isWarmupOperatorInFacility(operator.charId, room.type, inventory))
      const resident = actors.filter(actor => available.some(operator => operator.charId === actor))
      const idle = available.filter(operator => !originalActors.has(operator.charId))
      const idleScores: { actor: string; score: number; order: number }[] = []
      const domain = { roomId, available: available.length, scannedIdle: 0, pool: 0, teams: 0, quantified: 0, pairs: 0, admissions: 0 }
      domains.push(domain)
      for (const [order, operator] of idle.slice(0, IDLE_SCAN_LIMIT).entries()) {
        if (calls >= SCORE_LIMIT) break
        const probe = structuredClone(workspace)
        probe.mainPlan.facilities[roomId].slots[0]!.occupant = { kind: 'operator', operatorId: operator.charId }
        const value = score(probe); domain.scannedIdle++
        if (value !== undefined) idleScores.push({ actor: operator.charId, score: value, order })
      }
      const pool = [...resident, ...idleScores.sort((a, b) => b.score - a.score || a.order - b.order).map(row => row.actor)].slice(0, POOL_LIMIT)
      domain.pool = pool.length
      if (pool.length < 6) { report('MAIN_CREW_INSUFFICIENT_POOL', `${roomId} 有限域不足六名实际可用的独立普通制造干员。`); continue }
      const teams: Team[] = []
      for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) for (let c = b + 1; c < pool.length; c++) {
        domain.teams++
        if (calls >= SCORE_LIMIT) continue
        const crew = [pool[a]!, pool[b]!, pool[c]!], probe = structuredClone(workspace)
        install(probe, roomId, crew)
        const value = score(probe)
        if (value !== undefined) teams.push({ actors: crew, score: value, order: domain.teams })
      }
      domain.quantified = teams.length
      const pairs: Pair[] = []
      for (const main of teams) for (const relief of teams) if (relief.actors.every(actor => !main.actors.includes(actor))) pairs.push({ main, relief, order: pairs.length })
      domain.pairs = pairs.length
      if (!pairs.length) { report('MAIN_CREW_NO_QUANTIFIED_PAIR', `${roomId} 未找到两个均可量化的独立三人队。`); continue }
      const queues = [
        [...pairs].sort((a, b) => b.main.score - a.main.score || b.relief.score - a.relief.score || a.order - b.order),
        [...pairs].sort((a, b) => Math.min(b.main.score, b.relief.score) - Math.min(a.main.score, a.relief.score) || b.main.score - a.main.score || a.order - b.order),
        [...pairs].sort((a, b) => b.relief.score - a.relief.score || b.main.score - a.main.score || a.order - b.order),
      ]
      const selected: Candidate[] = [], attempted = new Set<string>()
      for (let index = 0; index < pairs.length && selected.length < OUTPUT_LIMIT && domain.admissions < ADMISSION_LIMIT; index++) {
        for (const [family, queue] of queues.entries()) {
          if (domain.admissions >= ADMISSION_LIMIT) break
          const pair = queue[index]!
          const key = JSON.stringify([pair.main.actors, pair.relief.actors])
          if (attempted.has(key)) continue
          attempted.add(key); domain.admissions++
          const proposal = structuredClone(workspace)
          install(proposal, roomId, pair.main.actors, pair.relief.actors)
          const candidateKey = fingerprint(proposal)
          if (seen.has(candidateKey)) continue
          const policy = structuredClone(proposal), warmup = applyGeneratedWarmupPolicy(policy, inventory)
          if (!warmup.valid || fingerprint(policy.mainPlan.conf) !== fingerprint(proposal.mainPlan.conf) ||
            !preservesFormedCombinations(original, proposal, inventory) || validatePhysicalRoster(proposal).length ||
            compileRosterSchedule(proposal).diagnostics.some(issue => issue.severity === 'error' || issue.code === 'UNKNOWN_OPERATOR') ||
            resourceIssue(proposal, owned) || recoveryIssue(proposal)) continue
          // Recheck the returned complete primary and its ordinary-relief snapshot;
          // neither half inherits a score if the exact combination is unknown.
          if (calls + 2 > SCORE_LIMIT) break
          if (score(proposal) === undefined || score(shiftSnapshot(proposal, 'backup', roomId)) === undefined) continue
          seen.add(candidateKey)
          selected.push({ id: `main-crew:${roomId}:${['primary', 'balanced', 'relief'][family]}:${index + 1}`, workspace: proposal })
          if (selected.length >= OUTPUT_LIMIT || domain.admissions >= ADMISSION_LIMIT) break
        }
      }
      if (domain.admissions >= ADMISSION_LIMIT) report('MAIN_CREW_ADMISSION_LIMIT', `${roomId} 已到32次实体/恢复准入上限，未搜索全部主替组合。`)
      if (!selected.length) report('MAIN_CREW_NO_ADMISSIBLE_PAIR', `${roomId} 的已尝试主替队未通过原表、暖机或恢复门禁；不改策略放宽约束。`)
      perRoom.push(selected)
    }
    for (let index = 0; result.candidates.length < limit && perRoom.some(rows => rows[index]); index++) for (const rows of perRoom) {
      if (rows[index] && result.candidates.length < limit) result.candidates.push(rows[index]!)
    }
    if (calls >= SCORE_LIMIT) report('MAIN_CREW_STATIC_LIMIT', '全调用512次静态评分预算已到，未把剩余组合当作无解。')
  } catch (error) { report('MAIN_CREW_INVALID_INPUT', error instanceof Error ? error.message : String(error)) }
  return finish()
}
