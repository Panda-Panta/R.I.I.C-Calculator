import { facilityCapacity } from '../domain/facilities'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { OperatorInventory } from '../domain/operatorInventory'
import type { MowerFacility, MowerSlot, RosterWorkspace } from '../domain/roster'
import { evaluateDormitoryRecovery } from '../engine/dormitoryRecovery'
import { currentMoraleRates } from '../engine/morale'
import { eligibleSingleRecoveryTargets } from '../engine/singleRecoveryEligibility'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { isAoeDormKeeper, isSingleDormKeeper } from '../scheduler/smartDormitoryPolicy'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import { projectRosterConfig } from './rosterProjection'

interface Position { room: MowerFacility; index: number; slot: MowerSlot; operatorId: string }
interface Candidate { id: string; workspace: RosterWorkspace }
interface Diagnostic { code: string; message: string }
interface Options {
  lockedPositions?: ReadonlySet<string>
  lockedOperators?: ReadonlySet<string>
  maxCandidates?: number
  userBase?: RosterWorkspace
  allowFreeCombinations?: boolean
}
const FIA = id('菲亚梅塔')
const MAX_CANDIDATES = 8
const EPS = 1e-8
const groupIds = (slot: MowerSlot): string[] => [...new Set([slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)]
  .flatMap(group => group?.trim() ? [group.trim()] : []))]
const references = (slot: MowerSlot): string[] => [
  ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []),
  ...slot.replacements.map(id), ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements.map(id)),
]
const positions = (workspace: RosterWorkspace): Position[] => Object.values(workspace.mainPlan.facilities)
  .filter(room => room.level > 0).flatMap(room => room.slots.slice(0, facilityCapacity(room.type, room.level))
    .flatMap((slot, index) => slot.occupant.kind === 'operator' ? [{ room, index, slot, operatorId: id(slot.occupant.operatorId) }] : []))
const memberKey = (members: readonly string[]): string => [...new Set(members.map(id))].sort().join('|')

/** Recovery proposals only: static group value, initial consumption and dormitory
 * snapshots are search hints. The caller retains the original anchor and must
 * evaluate every accepted proposal with the unchanged native F/quality checks.
 */
export function generateMainRosterRecoveryCandidates(
  workspace: RosterWorkspace, inventory: OperatorInventory, options: Options = {},
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const candidates: Candidate[] = [], diagnostics: Diagnostic[] = []
  const requested = options.maxCandidates ?? 6
  if (!Number.isInteger(requested) || requested < 0) return { candidates, diagnostics: [{ code: 'RECOVERY_INVALID_LIMIT', message: '恢复候选上限须为非负有限整数。' }] }
  const limit = Math.min(requested, MAX_CANDIDATES)
  if (requested > MAX_CANDIDATES) diagnostics.push({ code: 'RECOVERY_LIMIT_CLAMPED', message: `恢复提案最多 ${MAX_CANDIDATES} 份。` })
  if (!limit) return { candidates, diagnostics }
  if (!inventory.valid) return { candidates, diagnostics: [...diagnostics, { code: 'RECOVERY_INVALID_INVENTORY', message: '实际持有库无效，不生成恢复候选。' }] }

  const all = positions(workspace), owned = new Map(inventory.operators.map(operator => [operator.charId, operator]))
  const records = inventoryOperatorRecords(inventory), lockedOperators = new Set([...(options.lockedOperators ?? [])].map(id))
  const locked = (position: Position): boolean => {
    const original = options.userBase?.mainPlan.facilities[position.room.roomId]?.slots[position.index]
    return Boolean(options.lockedPositions?.has(`${position.room.roomId}:${position.index}`) ||
      [...references(position.slot), ...(original ? references(original) : [])].some(operator => lockedOperators.has(operator)))
  }
  const unowned = Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
    .flatMap(room => room.slots.flatMap(references)).find(operator => !['Free', 'Current', ''].includes(operator) && !owned.has(operator))
  if (unowned) return { candidates, diagnostics: [...diagnostics, { code: 'RECOVERY_UNOWNED_OPERATOR', message: `排班引用未持有干员 ${unowned}，不生成恢复候选。` }] }
  if (new Set(all.map(position => position.operatorId)).size !== all.length || Object.values(workspace.mainPlan.facilities).some(room =>
    room.level > 0 && room.slots.some((slot, index) => slot.occupant.kind === 'current' || index >= facilityCapacity(room.type, room.level) && slot.occupant.kind !== 'empty'))) {
    return { candidates, diagnostics: [...diagnostics, { code: 'RECOVERY_INVALID_OCCUPANCY', message: '存在重复实体、未解析 Current 或越界占位，不生成恢复候选。' }] }
  }
  // A proposal must not propagate a lock that an upstream construction already
  // changed. The recovery module does not repair production or user input.
  const originalLockChanged = options.userBase && Object.values(options.userBase.mainPlan.facilities).some(originalRoom => {
    const room = workspace.mainPlan.facilities[originalRoom.roomId]
    return Array.from({ length: Math.max(room?.slots.length ?? 0, originalRoom.slots.length) }, (_, index) => index).some(index => {
      const current = room?.slots[index], original = originalRoom.slots[index]
      const protectedSlot = options.lockedPositions?.has(`${originalRoom.roomId}:${index}`) ||
        (original ? references(original) : []).some(operator => lockedOperators.has(operator))
      return protectedSlot && (room?.type !== originalRoom.type || room?.level !== originalRoom.level || JSON.stringify(current) !== JSON.stringify(original))
    })
  })
  if (originalLockChanged) {
    return { candidates, diagnostics: [...diagnostics, { code: 'RECOVERY_ORIGINAL_LOCK_CHANGED', message: '输入候选与原始显式锁不一致，交回调用方保留原表。' }] }
  }

  const seen = new Set([JSON.stringify(workspace)])
  const offer = (candidate: Candidate): void => {
    if (candidates.length >= limit) return
    const key = JSON.stringify(candidate.workspace)
    if (!seen.has(key)) { seen.add(key); candidates.push(candidate) }
  }
  const permanent = new Set(workspace.mainPlan.conf.workaholic.map(id))
  const freeBeds = Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory' && room.level > 0)
    .reduce((count, room) => count + room.slots.slice(0, facilityCapacity(room.type, room.level)).filter(slot => slot.occupant.kind === 'free').length, 0)
  const fiaDrafts: Candidate[] = [], fiaResidents = all.filter(position => position.operatorId === FIA && position.room.type === 'dormitory')
  const fia = fiaResidents.length === 1 ? fiaResidents[0] : undefined
  if (fia && (locked(fia) || fia.slot.groupBindings?.length)) {
    diagnostics.push({ code: 'RECOVERY_FIA_PROTECTED', message: '保留原始锁定菲亚及其完整目标列表。' })
  } else if (fia && owned.get(FIA)?.skills.some(skill => skill.roomType === 'DORMITORY' && skill.buffId.startsWith('dorm_exchangeAp['))) {
    const config = projectRosterConfig(workspace)
    config.operatorRecords = records
    let rates: Record<string, number> = {}
    try { rates = currentMoraleRates(config).rates } catch { diagnostics.push({ code: 'RECOVERY_RATES_UNKNOWN', message: '初始工作耗速无法量化，跳过菲亚目标提案。' }) }
    const workers = all.filter(position => !['dormitory', 'gaming', 'factory', 'train'].includes(position.room.type) &&
      position.operatorId !== FIA && !permanent.has(position.operatorId) && !lockedOperators.has(position.operatorId) &&
      Number.isFinite(rates[position.operatorId]) && rates[position.operatorId]! > EPS)
    // Connected explicit groups remain whole, including cross-room supporters.
    // Ungrouped colleagues form a room proposal, rather than being scored alone.
    const components: Position[][] = []
    for (const position of all.filter(position => position.room.type !== 'dormitory')) {
      const labels = groupIds(position.slot)
      const touching = components.filter(component => component.some(peer => labels.length
        ? groupIds(peer.slot).some(group => labels.includes(group))
        : !groupIds(peer.slot).length && peer.room.roomId === position.room.roomId))
      if (!touching.length) components.push([position])
      else {
        const merged = [...touching.flat(), position]
        for (const component of touching) components.splice(components.indexOf(component), 1)
        components.push(merged)
      }
    }
    let baseScore: number | undefined
    try { baseScore = productionWorkspaceHourlyScore(workspace, inventory) } catch { /* Unknown stays unknown. */ }
    const groups = components.flatMap(component => {
      const targets = component.filter(position => workers.includes(position))
        .sort((a, b) => rates[b.operatorId]! - rates[a.operatorId]! || a.operatorId.localeCompare(b.operatorId))
      if (!targets.length || !component.some(position => ['manufacture', 'trading', 'central', 'power'].includes(position.room.type))) return []
      let value: number | null = null
      if (baseScore !== undefined && Number.isFinite(baseScore)) {
        const absent = structuredClone(workspace)
        for (const position of component) absent.mainPlan.facilities[position.room.roomId].slots[position.index]!.occupant = { kind: 'empty' }
        try {
          const score = productionWorkspaceHourlyScore(absent, inventory)
          if (score !== undefined && Number.isFinite(score)) value = baseScore - score
        } catch { /* A recovery proposal is not evidence of a quantified gain. */ }
      }
      const relief = new Set(component.flatMap(position => position.slot.replacements.filter(operator =>
        owned.has(id(operator)) && isOrdinaryReplacementCandidate(id(operator), position.room.type)).map(id)))
      const sumRate = targets.reduce((sum, position) => sum + rates[position.operatorId]!, 0)
      return [{ targets, value, fastest: rates[targets[0]!.operatorId]!,
        pressure: sumRate * targets.length / Math.max(1, freeBeds) / Math.max(1, relief.size) }]
    })
    const tie = (a: typeof groups[number], b: typeof groups[number]) => memberKey(a.targets.map(position => position.operatorId)).localeCompare(memberKey(b.targets.map(position => position.operatorId)))
    const byValue = [...groups].sort((a, b) => a.value === null || b.value === null
      ? Number(b.value !== null) - Number(a.value !== null) || b.pressure - a.pressure || tie(a, b)
      : b.value - a.value || b.pressure - a.pressure || tie(a, b))
    const byPressure = [...groups].sort((a, b) => b.pressure - a.pressure || tie(a, b))
    const byRate = [...groups].sort((a, b) => b.fastest - a.fastest || b.pressure - a.pressure || tie(a, b))
    const targetSets = new Set([memberKey(fia.slot.replacements)])
    const targets = (label: string, members: Position[]): void => {
      const ordered = [...new Set(members.map(position => position.operatorId))], key = memberKey(ordered)
      if (!ordered.length || targetSets.has(key)) return
      targetSets.add(key)
      const draft = structuredClone(workspace)
      draft.mainPlan.facilities[fia.room.roomId].slots[fia.index]!.replacements = ordered
      fiaDrafts.push({ id: `recovery-fia-${label}`, workspace: draft })
    }
    if (byValue[0]) targets('whole-group', byValue[0].targets)
    if (byPressure[0]) targets('recovery-pressure', byPressure[0].targets)
    if (byRate[0]) targets('work-rate', byRate[0].targets)
    if (byValue[1]) targets('alternative-group', byValue[1].targets)
    if (byValue[0]) targets('group-bottleneck', byValue[0].targets.slice(0, 1))
    if (byValue[1]) targets('two-groups', byValue.slice(0, 2).flatMap(group => group.targets))
    if (groups.some(group => group.value === null)) diagnostics.push({ code: 'RECOVERY_GROUP_VALUE_UNKNOWN', message: '部分完整组产出边际未知；保留耗速/床位压力提案，不将未知视为零收益。' })
  }
  for (const draft of fiaDrafts.slice(0, Math.min(5, limit))) offer(draft)
  if (candidates.length >= limit) return { candidates, diagnostics: [...diagnostics, { code: 'RECOVERY_PROPOSALS_ONLY', message: '恢复集合变化仅为提案，须经完整 F 和工休质量验收。' }] }

  const keeper = (operatorId: string): boolean => Boolean(records[operatorId] && (isAoeDormKeeper(records[operatorId]!) || isSingleDormKeeper(records[operatorId]!)))
  const reserved = new Set(Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
    .flatMap(room => room.slots.flatMap(slot => [...slot.replacements, ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements)]).map(id)))
  const movable = all.filter(position => position.room.type === 'dormitory' && position.operatorId !== FIA &&
    keeper(position.operatorId) && !locked(position) && !reserved.has(position.operatorId) && position.slot.dormitoryResident !== false &&
    !groupIds(position.slot).length && !position.slot.groupBindings?.length && !position.slot.replacements.length && !Object.keys(position.slot.metadata ?? {}).length &&
    position.room.slots.slice(0, facilityCapacity(position.room.type, position.room.level)).some(slot => slot.occupant.kind === 'free'))
    .sort((a, b) => b.room.slots.filter(slot => slot.occupant.kind === 'free').length - a.room.slots.filter(slot => slot.occupant.kind === 'free').length || a.room.roomId.localeCompare(b.room.roomId) || a.index - b.index)
    .slice(0, 4)
  const present = new Set(all.map(position => position.operatorId))
  const strength = (operatorId: string): number => owned.get(operatorId)!.skills.filter(skill => skill.roomType === 'DORMITORY')
    .reduce((sum, skill) => sum + Math.max(0, ...[...skill.description.matchAll(/恢复\+([\d.]+)/g)].map(match => Number(match[1]))) * (isAoeDormKeeper(records[operatorId]!) ? 3 : 1), 0)
  const idleKeepers = inventory.operators.filter(operator => keeper(operator.charId) && !present.has(operator.charId) && !reserved.has(operator.charId) &&
    !lockedOperators.has(operator.charId) && !permanent.has(operator.charId))
    .sort((a, b) => strength(b.charId) - strength(a.charId) || a.charId.localeCompare(b.charId)).slice(0, 4)
  const dormDrafts: Candidate[] = []
  for (const [index, position] of movable.entries()) {
    for (const other of movable.slice(index + 1)) {
      if (position.room.roomId === other.room.roomId) continue
      const draft = structuredClone(workspace), first = draft.mainPlan.facilities[position.room.roomId].slots[position.index]!, second = draft.mainPlan.facilities[other.room.roomId].slots[other.index]!
      ;[first.occupant, second.occupant] = [second.occupant, first.occupant]
      dormDrafts.push({ id: `recovery-dorm-swap-${position.room.roomId}-${position.index}-${other.room.roomId}-${other.index}`, workspace: draft })
    }
    for (const operator of idleKeepers) {
      const draft = structuredClone(workspace)
      draft.mainPlan.facilities[position.room.roomId].slots[position.index]!.occupant = { kind: 'operator', operatorId: operator.charId }
      dormDrafts.push({ id: `recovery-dorm-support-${position.room.roomId}-${position.index}-${operator.charId}`, workspace: draft })
    }
  }
  // Rank at most 22 support layouts using actual unlocked skills. Each dorm is
  // a separate hypothetical low-morale recovery snapshot at zero atmosphere;
  // this does not predict native bed allocation or long-term income.
  const dormResidents = new Set(all.filter(position => position.room.type === 'dormitory').map(position => position.operatorId))
  const probes = inventory.operators.filter(operator => !dormResidents.has(operator.charId) && operator.charId !== FIA && !keeper(operator.charId))
    .map(operator => operator.charId).sort().slice(0, 4)
  const supportCapacity = (draft: RosterWorkspace): number | null => {
    let total = 0
    for (const dorm of Object.values(draft.mainPlan.facilities).filter(room => room.type === 'dormitory' && room.level > 0)) {
      const count = dorm.slots.filter(slot => slot.occupant.kind === 'free').length, sample = probes.slice(0, count)
      if (!sample.length) continue
      const config = projectRosterConfig(draft), sampleSet = new Set(sample)
      config.operatorRecords = records
      config.rooms.forEach(room => { room.operatorIds = room.operatorIds.filter(operator => !sampleSet.has(operator)) })
      config.controlOperatorIds = config.controlOperatorIds.filter(operator => !sampleSet.has(operator))
      for (const key of ['reception', 'workshop', 'office', 'training', 'recycle'] as const) config.facilityOperatorIds[key] = config.facilityOperatorIds[key]?.filter(operator => !sampleSet.has(operator)) ?? []
      const roomIndex = Number(dorm.roomId.slice('dormitory_'.length)) - 1
      const residents = dorm.slots.flatMap(slot => slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : [])
      config.facilityOperatorIds.dormitories[roomIndex] = [...residents, ...sample]
      config.dormitoryOccupantCount = config.facilityOperatorIds.dormitories.flat().length
      const moods = new Map([...residents.map(operator => [operator, 24] as const), ...sample.map(operator => [operator, 10] as const)])
      const occupants = [...residents, ...sample].map(operator => records[operator]!)
      const targets = new Map(residents.flatMap(provider => {
        const first = eligibleSingleRecoveryTargets(occupants, provider, operator => moods.get(operator) ?? 24)[0]
        return first ? [[provider, first.charId] as const] : []
      }))
      const recovery = evaluateDormitoryRecovery(config, roomIndex, moods, 0, targets)
      if (recovery.unquantified.length || sample.some(operator => !Number.isFinite(recovery.rates.get(operator)))) return null
      total += sample.reduce((sum, operator) => sum + recovery.rates.get(operator)!, 0)
    }
    return total
  }
  const rankedDorms = dormDrafts.map(candidate => {
    let score: number | null = null
    try { score = supportCapacity(candidate.workspace) } catch { /* Keep the snapshot unknown. */ }
    return { candidate, score }
  }).sort((a, b) => a.score === null || b.score === null ? Number(b.score !== null) - Number(a.score !== null) || a.candidate.id.localeCompare(b.candidate.id)
    : b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
  if (rankedDorms.some(row => row.score === null)) diagnostics.push({ code: 'RECOVERY_SUPPORT_SNAPSHOT_UNKNOWN', message: '部分宿管恢复快照无法量化；保留未知状态，不能视为恢复或收益增益。' })
  for (const row of rankedDorms.slice(0, 2)) offer(row.candidate)
  if (fiaDrafts[0] && rankedDorms[0] && candidates.length < limit && fia) {
    const draft = structuredClone(rankedDorms[0].candidate.workspace)
    draft.mainPlan.facilities[fia.room.roomId].slots[fia.index]!.replacements = [...fiaDrafts[0].workspace.mainPlan.facilities[fia.room.roomId].slots[fia.index]!.replacements]
    offer({ id: 'recovery-fia-and-dorm-support', workspace: draft })
  }
  diagnostics.push({ code: 'RECOVERY_PROPOSALS_ONLY', message: '保留生产主替、组、Free 床位和用户阈值；恢复集合与宿管快照仅为有限提案，须经完整 F 和工休质量验收。' })
  return { candidates, diagnostics }
}
