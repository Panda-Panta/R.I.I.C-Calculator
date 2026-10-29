import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { MOWER_OUTPUT_ROOM_IDS, type MowerRoomId, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { isOrdinaryReplacementCandidate as ordinary } from '../scheduler/scheduleAdapter'
import { physicalBackupOperatorIds } from './combinationModel'
import { preservesFormedCombinations } from './combinationIntegrity'
import { isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { generateProductionShiftAlternatives } from './jointBackupMainAlternatives'
import { productionTeamHourlyOutput, productionWorkspaceHourlyScore } from './productionSingletons'
import { validatePhysicalRoster } from './rosterDraft'

const POOL_LIMIT = 8, OBSERVER_LIMIT = 8, STATIC_CALL_LIMIT = 256, OUTPUT_LIMIT = 2
type Candidate = { id: string; workspace: RosterWorkspace }
type Diagnostic = { code: string; message: string }
interface Projection { score: number; output: number }
interface Observer { roomId: MowerRoomId; index: number }

export interface ContextualCrewOptions {
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
}

const fingerprint = (workspace: RosterWorkspace): string => {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : value
  return JSON.stringify(ordered(JSON.parse(JSON.stringify(workspace))))
}
const references = (position: MowerSlot): string[] => [
  ...(position.occupant.kind === 'operator' ? [position.occupant.operatorId] : []),
  ...position.replacements, ...(position.groupBindings ?? []).flatMap(binding => binding.replacements),
].filter(ref => ref !== 'Free').map(id)
const physical = (workspace: RosterWorkspace, roomId: MowerRoomId, position: MowerSlot): string[] => [
  ...(position.occupant.kind === 'operator' ? [id(position.occupant.operatorId)] : []),
  ...physicalBackupOperatorIds(workspace.mainPlan.facilities[roomId], position),
  ...(workspace.mainPlan.facilities[roomId].type === 'dormitory' ? [] : (position.groupBindings ?? []).flatMap(binding =>
    binding.replacements.filter(ref => ordinary(ref, workspace.mainPlan.facilities[roomId].type)).map(id))),
]

/** Preserve the first ordinary reference's place and every nonordinary reference verbatim. */
function install(workspace: RosterWorkspace, roomId: MowerRoomId, primary: readonly string[], relief?: readonly string[]): void {
  workspace.mainPlan.facilities[roomId].slots.slice(0, 3).forEach((position, index) => {
    position.occupant = { kind: 'operator', operatorId: primary[index]! }
    let installed = false
    position.replacements = position.replacements.flatMap(ref => {
      if (!ordinary(ref, 'manufacture')) return [ref]
      if (installed || !relief) return []
      installed = true
      return [relief[index]!]
    })
    if (relief && !installed) position.replacements.push(relief[index]!)
  })
}

/**
 * Experimental static proposal domain: one three-seat factory, at most 56 teams.
 * Empty-observer probes are sensitivity contexts, never returned executable tables.
 * All final modes keep the original conf and pass the existing reversible swap gate.
 */
export function generateContextualCrewCandidates(
  mainCandidates: readonly Candidate[], inventory: OperatorInventory, options: ContextualCrewOptions = {},
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const result: { candidates: Candidate[]; diagnostics: Diagnostic[] } = { candidates: [], diagnostics: [] }
  const counts = new Map<string, { message: string; count: number }>()
  const report = (code: string, message: string): void => {
    const previous = counts.get(code)
    if (previous) previous.count++
    else if (counts.size < 16) counts.set(code, { message: message.slice(0, 400), count: 1 })
  }
  let staticCalls = 0, teamCount = 0, poolSize = 0
  const finish = () => {
    result.diagnostics = [...counts].map(([code, entry]) => ({ code, message: entry.message + (entry.count > 1 ? `（共 ${entry.count} 次）` : '') }))
    if (teamCount) result.diagnostics.push({ code: 'CONTEXTUAL_CREW_BUDGET', message: `有限静态域：池 ${poolSize}/${POOL_LIMIT} 人、${teamCount}/56 队、投影调用 ${staticCalls}/${STATIC_CALL_LIMIT}；不是完整工休收益 F。` })
    return result
  }
  const requested = options.maxCandidates ?? OUTPUT_LIMIT
  if (!Number.isInteger(requested) || requested < 0) { report('CONTEXTUAL_CREW_INVALID_LIMIT', '候选上限须为非负有限整数。'); return finish() }
  const limit = Math.min(requested, OUTPUT_LIMIT)
  if (!limit) return finish()
  if (requested > OUTPUT_LIMIT) report('CONTEXTUAL_CREW_LIMIT_CLAMPED', '整队互补候选固定最多两个。')
  if (!inventory.valid) { report('CONTEXTUAL_CREW_INVALID_INVENTORY', '需要有效实际干员库。'); return finish() }
  const owned = new Set(inventory.operators.map(operator => id(operator.charId)))
  const lockedOperators = new Set([...(options.lockedOperators ?? [])].map(id))
  const lockedPositions = new Set([...(options.lockedPositions ?? [])].map(key => key.replace(/:(\d+)$/, '_$1')))
  const seen = new Set<string>()
  for (const candidate of mainCandidates) try { seen.add(fingerprint(candidate.workspace)) } catch { /* Diagnose this source below. */ }
  for (const source of mainCandidates) try {
    const base = source.workspace
    if (base.compatibility.backupPlans.length || validatePhysicalRoster(base).length || compileRosterSchedule(base).diagnostics.some(issue => issue.severity === 'error')) {
      report('CONTEXTUAL_CREW_INVALID_SOURCE', `${source.id} 不是合法纯主表。`); continue
    }
    const occupied = new Set<string>()
    let invalidSource = false
    for (const room of Object.values(base.mainPlan.facilities)) if (room.level > 0) for (const position of room.slots) {
      if (references(position).some(actor => !owned.has(actor))) invalidSource = true
      for (const actor of physical(base, room.roomId, position)) {
        if (occupied.has(actor)) invalidSource = true
        occupied.add(actor)
      }
    }
    if (invalidSource) { report('CONTEXTUAL_CREW_INVALID_PHYSICAL', `${source.id} 有未持有引用或重复实体角色。`); continue }
    const special = new Set([...base.mainPlan.conf.workaholic, ...(base.mainPlan.conf.resting_standby ?? [])].map(id))
    for (const roomId of MOWER_OUTPUT_ROOM_IDS) {
      const room = base.mainPlan.facilities[roomId]
      if (room.type !== 'manufacture' || room.level !== 3) continue
      const positions = room.slots.slice(0, 3), groups = new Set(positions.map(position => position.groupId?.trim()).filter(Boolean))
      const original = new Set(positions.flatMap(position => physical(base, roomId, position)))
      const crossRoom = Object.values(base.mainPlan.facilities).some(other => other.level > 0 && other.roomId !== roomId && other.slots.some(position =>
        [position.groupId, ...(position.groupBindings ?? []).map(binding => binding.groupId)].some(group => group?.trim() && groups.has(group.trim()))))
      if (positions.length !== 3 || positions.some(position => position.occupant.kind !== 'operator' || position.groupBindings?.length) || crossRoom ||
        positions.some((_, index) => lockedPositions.has(`${roomId}_${index}`)) || [...original].some(actor => lockedOperators.has(actor) || special.has(actor))) {
        report('CONTEXTUAL_CREW_UNSUPPORTED_ROOM', `${source.id}/${roomId} 须为未锁定、无跨房组或额外绑定的完整普通三工位制造房。`); continue
      }
      // One eligible room consumes this invocation's domain, including a failed domain.
      const outside = new Set(Object.values(base.mainPlan.facilities).filter(other => other.level > 0 && other.roomId !== roomId)
        .flatMap(other => other.slots.flatMap(position => physical(base, other.roomId, position))))
      const available = inventory.operators.filter(operator => !outside.has(id(operator.charId)) && !lockedOperators.has(id(operator.charId)) && !special.has(id(operator.charId)) &&
        ordinary(operator.charId, 'manufacture') && operator.skills.some(skill => skill.roomType === 'MANUFACTURE') && !isWarmupOperatorInFacility(operator.charId, 'manufacture', inventory))
      const pool = [...available.filter(operator => original.has(id(operator.charId))), ...available.filter(operator => !original.has(id(operator.charId)))].slice(0, POOL_LIMIT).map(operator => id(operator.charId))
      poolSize = pool.length
      if (pool.length < 6) { report('CONTEXTUAL_CREW_INSUFFICIENT_POOL', `${source.id}/${roomId} 不足六名独立实际非暖机制造干员。`); return finish() }
      const crews: string[][] = []
      for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) for (let c = b + 1; c < pool.length; c++) crews.push([pool[a]!, pool[b]!, pool[c]!])
      teamCount = crews.length
      const observers: Observer[] = Object.values(base.mainPlan.facilities).filter(other => other.level > 0 && other.roomId !== roomId && other.type !== 'dormitory')
        .flatMap(other => other.slots.flatMap((position, index) => position.occupant.kind === 'operator' && !special.has(id(position.occupant.operatorId)) ? [{ roomId: other.roomId, index }] : [])).slice(0, OBSERVER_LIMIT)
      const cache = new Map<string, Projection | undefined>()
      const project = (crew: readonly string[], observer?: Observer): Projection | undefined => {
        const key = JSON.stringify([crew, observer?.roomId, observer?.index])
        if (cache.has(key)) return cache.get(key)
        if (staticCalls + 2 > STATIC_CALL_LIMIT) return undefined
        const probe = structuredClone(base)
        install(probe, roomId, crew)
        if (observer) probe.mainPlan.facilities[observer.roomId].slots[observer.index]!.occupant = { kind: 'empty' }
        staticCalls += 2
        let value: Projection | undefined
        try {
          const score = productionWorkspaceHourlyScore(probe, inventory), output = productionTeamHourlyOutput(probe, inventory, roomId)
          if (score !== undefined && output !== undefined && Number.isFinite(score) && Number.isFinite(output)) value = { score, output }
        } catch { /* An unsupported projection is unquantified, never a zero score. */ }
        cache.set(key, value)
        return value
      }
      const rank = (rows: { crew: string[]; value: Projection }[]) => rows.sort((a, b) => b.value.score - a.value.score || b.value.output - a.value.output)
      const ranked = rank(crews.flatMap(crew => { const value = project(crew); return value ? [{ crew, value }] : [] }))
      // Freeze every external position for the gate: another valid trading-room
      // alternative must not be mistaken for target-room reversibility.
      const validationLocks = new Set([...lockedPositions, ...Object.values(base.mainPlan.facilities).filter(other => other.roomId !== roomId)
        .flatMap(other => other.slots.map((_, index) => `${other.roomId}_${index}`))])
      for (const best of ranked) {
        const sensitivity = observers.flatMap(observer => {
          const value = project(best.crew, observer)
          return value ? [{ observer, change: Math.abs(best.value.output - value.output), total: Math.abs(best.value.score - value.score) }] : []
        }).sort((a, b) => b.change - a.change || b.total - a.total)
        const context = sensitivity[0]?.change ? sensitivity[0].observer : undefined
        const disjoint = rank(crews.filter(crew => crew.every(actor => !best.crew.includes(actor))).flatMap(crew => {
          const value = project(crew, context); return value ? [{ crew, value }] : []
        }))
        for (const backup of disjoint) {
          const proposal = structuredClone(base)
          install(proposal, roomId, best.crew, backup.crew)
          if (!preservesFormedCombinations(base, proposal, inventory)) { report('CONTEXTUAL_CREW_CORE_REQUIRED', '整队重分配不能丢失原有完整组合。'); continue }
          const first = { id: `${source.id}:contextual-crew:${roomId}:on`, workspace: proposal }
          const gateOptions = { ...options, lockedPositions: validationLocks, maxCandidates: 1 }
          const reverse = generateProductionShiftAlternatives([first], inventory, gateOptions)
          const second = reverse.candidates[0]
          if (!second || !preservesFormedCombinations(base, second.workspace, inventory)) {
            report('CONTEXTUAL_CREW_MODE_REJECTED', reverse.diagnostics.map(issue => issue.message).join('；') || '反向模式不能保留原有完整组合。'); continue
          }
          const forward = generateProductionShiftAlternatives([second], inventory, gateOptions)
          if (!forward.candidates.some(candidate => fingerprint(candidate.workspace) === fingerprint(proposal))) {
            report('CONTEXTUAL_CREW_MODE_REJECTED', forward.diagnostics.map(issue => issue.message).join('；') || '正向模式未通过完整可逆校验。'); continue
          }
          for (const [index, candidate] of [first, second].entries()) {
            const key = fingerprint(candidate.workspace)
            if (!seen.has(key) && result.candidates.length < limit) {
              seen.add(key)
              result.candidates.push({ id: `${source.id}:contextual-crew:${roomId}:${index === 0 ? 'on' : 'off'}`, workspace: candidate.workspace })
            }
          }
          return finish()
        }
        if (staticCalls >= STATIC_CALL_LIMIT) { report('CONTEXTUAL_CREW_STATIC_LIMIT', '静态投影预算已到；不扩大域或放宽校验。'); break }
      }
      if (!ranked.length) report('CONTEXTUAL_CREW_UNQUANTIFIED', '没有完整量化的整队静态投影。')
      else report('CONTEXTUAL_CREW_NO_PAIR', '有限域内未找到同时合法的独立主替互补队。')
      return finish()
    }
  } catch (error) { report('CONTEXTUAL_CREW_INVALID_INPUT', `${source.id}：${error instanceof Error ? error.message : String(error)}`) }
  return finish()
}
