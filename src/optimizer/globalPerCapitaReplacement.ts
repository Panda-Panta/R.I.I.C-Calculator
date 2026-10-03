import { configureRunOrder } from './configureRunOrder'
import type { MowerRoomId, RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { type OperatorInventory } from '../domain/operatorInventory'
import {
  ATOMIC_UNITS,
  type AtomicUnit,
} from './riicAtomicUnits'
import { placePendantOperator } from '../scheduler/smartDormitoryPolicy'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { isTradeRunOrderOperator } from '../domain/shiftRunPolicy'
import { assignBackups, validatePhysicalRoster } from './rosterDraft'
import { rankStaffingCandidates } from './staffingQuality'
import { applySingletonWorkPolicy, productionColleagueBonus, productionTeamTheory } from './productionSingletons'
import { getRoomDisplayName } from '../workbench/operatorHelpers'

export interface ReplacementResult {
  workspace: RosterWorkspace
  swappedCount: number
  score?: number
  logs: string[]
}

export interface ReplacementOptions {
  powerCount?: number
  lockedPositions?: Set<string>
  lockedOperators?: Set<string>
  baselineScore?: number
  evaluator?: (workspace: RosterWorkspace) => number
  /** Automatic generation must reconsider runners even when no runner was initially profitable. */
  configureRunOrderCandidates?: boolean
}

function isPendantOperator(name: string, ws: RosterWorkspace): boolean {
  const allFacs = Object.values(ws.mainPlan.facilities)
  const hasPozemka = allFacs.some((f) =>
    f.slots.some((s) => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === resolveId('鸿雪')),
  )
  if (hasPozemka && ['至简', '褐果', '杜林', '桃金娘', '黑', '绮良'].includes(name)) {
    return true
  }

  const hasRosmontis = allFacs.some((f) =>
    f.slots.some((s) => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === resolveId('迷迭香')),
  )
  if (hasRosmontis && ['絮雨', '爱丽丝', '车尔尼', '琴柳', '黑键'].includes(name)) {
    return true
  }

  const hasWeedy = allFacs.some((f) =>
    f.slots.some((s) => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === resolveId('温蒂')),
  )
  if (hasWeedy && ['Lancet-2', '承曦格雷伊', '森蚺'].includes(name)) {
    return true
  }

  return false
}

/**
 * Stage 3 Global Optimization (Rules 1, 2, 3, 5, 6):
 * 1. Check powerCount: if powerCount <= 2, Minimalist (至简) is strictly prohibited from manufacture.
 * 2. Globally inspect all units and singletons in production rooms (manufacture, trading).
 * 3. Match candidate replacements of the EXACT SAME HEADCOUNT (1-to-1, 2-to-2, 3-to-3).
 * 4. If any operator being swapped out is a pendant, relocate them to non-production facilities
 *    (factory -> train -> lowest-recovery dorm position).
 * 5. Verify dynamic simulation: only accept swaps where newScore > currentScore.
 *    If score degrades or does not improve, rollback immediately to guarantee monotonicity!
 * 6. Rebuild candidates after each accepted swap within the bounded search budget.
 */
export function runGlobalPerCapitaReplacement(
  base: RosterWorkspace,
  inventory: OperatorInventory,
  options: ReplacementOptions = {},
): ReplacementResult {
  let ws = structuredClone(base)
  const maintainRunOrder = options.configureRunOrderCandidates ?? Object.values(base.mainPlan.facilities).some(r => r.type === 'trading' && r.slots.some(s => s.replacements.some(isTradeRunOrderOperator)))
  const logs: string[] = []
  let swappedCount = 0
  const repairPositions = new Set<string>()

  const lockedPositions = options.lockedPositions ?? new Set<string>()
  const lockedOperators = options.lockedOperators ?? new Set<string>()

  const powerRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'power')
  const powerCount = options.powerCount ?? powerRooms.length

  let currentScore = options.baselineScore ?? (options.evaluator ? options.evaluator(ws) : 0)

  const baselineScore = currentScore
  const lockedSlotFingerprint = (target: RosterWorkspace, key: string) => {
    const [roomId, index] = key.split(':')
    const room = target.mainPlan.facilities[roomId as MowerRoomId]
    const slot = room?.slots[Number(index)]
    // Automatic runner selection is independent of locked physical staffing.
    // A Closure/Pepe backup outside trading remains an ordinary locked backup.
    return JSON.stringify(options.configureRunOrderCandidates === true && room?.type === 'trading' && slot
      ? { ...slot, replacements: slot.replacements.filter(id => !isTradeRunOrderOperator(id)) }
      : slot)
  }
  const preservesLocks = (target: RosterWorkspace) => [...lockedPositions].every(key =>
    lockedSlotFingerprint(target, key) === lockedSlotFingerprint(base, key))

  const ownedNames = new Set(
    inventory.operators.filter((o) => o.matchesMaximumSkills).map((o) => o.name),
  )

  // ----------------------------------------------------
  // Step 1: Detect and Relocate Misplaced Pendants
  // ----------------------------------------------------
  if (powerCount <= 2) {
    for (const [rId, fac] of Object.entries(ws.mainPlan.facilities)) {
      if (fac.type !== 'manufacture') continue
      for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
        const slot = fac.slots[sIdx]!
        if (
          slot.occupant.kind === 'operator' &&
          resolveId(slot.occupant.operatorId) === resolveId('至简') &&
          !lockedPositions.has(`${rId}:${sIdx}`) &&
          !lockedOperators.has(resolveId('至简'))
        ) {
          slot.occupant = { kind: 'empty' }
          slot.groupId = null
          slot.replacements = []
          repairPositions.add(`${rId}:${sIdx}`)
          logs.push(`[挂件移位] 2电站限制：检测到至简入驻制造站 ${getRoomDisplayName(rId)}，移出制造站并安置于非生产设施。`)
          const pendantResult = placePendantOperator(ws, '至简', '感知信息挂件', inventory)
          if (pendantResult.placed) {
            logs.push(`[挂件落位] 至简成功安置于 ${getRoomDisplayName(pendantResult.roomId!)} 槽位 ${pendantResult.slotIndex}。`)
          }
          swappedCount++
        }
      }
    }
  }

  // Detect and resolve Abyssal Hunter room concentration (> 2 hunters in a single manufacture room)
  const abyssalNames = ['斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨']
  for (const [rId, fac] of Object.entries(ws.mainPlan.facilities)) {
    if (fac.type !== 'manufacture') continue
    const hunterSlots: number[] = []
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      const slot = fac.slots[sIdx]!
      if (
        slot.occupant.kind === 'operator' &&
        abyssalNames.some((n) => resolveId((slot.occupant as { kind: 'operator'; operatorId: string }).operatorId) === resolveId(n)) &&
        !lockedPositions.has(`${rId}:${sIdx}`)
      ) {
        hunterSlots.push(sIdx)
      }
    }

    // If more than 2 hunters in this manufacture room, remove the 3rd+ hunter so the room does not hit the 90% cap and waste capacity
    while (hunterSlots.length > 2) {
      const sIdxToRemove = hunterSlots.pop()!
      const slot = fac.slots[sIdxToRemove]!
      const opId = slot.occupant.kind === 'operator' ? slot.occupant.operatorId : ''
      const removedName = abyssalNames.find((n) => resolveId(opId) === resolveId(n)) ?? '深海猎人'
      slot.occupant = { kind: 'empty' }
      slot.groupId = null
      slot.replacements = []
      repairPositions.add(`${rId}:${sIdxToRemove}`)
      logs.push(`[深海猎人防溢出] 检测到制造站 ${getRoomDisplayName(rId)} 进驻超过2名深海猎人（受歌蕾蒂娅90%上限影响），已将第3人 ${removedName} 移出该站以释放高收益工位。`)
      swappedCount++
    }
  }

  function ensureValidBackups(targetWs: RosterWorkspace): boolean {
    const positions = Object.values(targetWs.mainPlan.facilities).filter(room => ['manufacture', 'trading', 'power', 'central', 'meeting', 'contact', 'factory', 'train'].includes(room.type))
      .flatMap(room => room.slots.flatMap((slot, slotIndex) => {
        if (slot.occupant.kind !== 'operator' || lockedPositions.has(`${room.roomId}:${slotIndex}`) ||
          slot.replacements.some(id => isOrdinaryReplacementCandidate(id, room.type)) ||
          targetWs.mainPlan.conf.workaholic.some(id => resolveId(id) === resolveId(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : ''))) return []
        return [{ roomId: room.roomId, slotIndex, operatorId: resolveId(slot.occupant.operatorId) }]
      }))
    const resources = assignBackups(targetWs, inventory, positions, { excludedOperatorIds: [...lockedOperators] })
    return !resources.missingReplacementIds.length && !validatePhysicalRoster(targetWs).length && preservesLocks(targetWs)
  }

  // ----------------------------------------------------
  // Step 2: Global Per-Capita Detection & Swap Loop (Rule 6)
  // ----------------------------------------------------
  const MAX_ITERATIONS = 3
  const triedSwaps = new Set<string>()

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false

    const occupied = new Set<string>()
    for (const fac of Object.values(ws.mainPlan.facilities)) {
      for (const slot of fac.slots) {
        if (slot.occupant.kind === 'operator') {
          occupied.add(resolveId(slot.occupant.operatorId))
        }
        slot.replacements.forEach(id => occupied.add(resolveId(id)))
      }
    }

    const productionRooms = Object.values(ws.mainPlan.facilities).filter(
      (r) => r.type === 'manufacture' || r.type === 'trading',
    )

    interface ProposedSwap {
      roomId: MowerRoomId
      slotIndices: number[]
      oldOps: { name: string; id: string; groupId: string | null }[]
      oldPerCapita: number
      candidate: AtomicUnit
      independent: boolean
      candidatePerCapita: number
      gain: number
    }

    const swapProposals: ProposedSwap[] = []

    for (const room of productionRooms) {
      const isManufacture = room.type === 'manufacture'
      const product = isManufacture ? room.product : 'money'
      const cap = room.slots.length

      const currentOps: { slotIdx: number; name: string; id: string; groupId: string | null }[] = []
      for (let idx = 0; idx < cap; idx++) {
        const slot = room.slots[idx]!
        if (slot.occupant.kind === 'operator') {
          const charId = resolveId(slot.occupant.operatorId)
          const opRecord = inventory.operators.find((o) => o.charId === charId)
          currentOps.push({ slotIdx: idx, name: opRecord?.name ?? charId, id: charId, groupId: slot.groupId })
        }
      }

      if (currentOps.length === 0) continue

      const currentTheory = productionTeamTheory(ws, inventory, room.roomId)
      if (currentTheory === undefined) continue

      // Include single seats and every pair as well as entire rooms. Never split a
      // real shift group; legacy groups labelled 散件 are ordinary independent seats.
      for (let mask = 1; mask < 2 ** currentOps.length; mask++) {
        const targetOps = currentOps.filter((_, index) => mask & (1 << index))
        const slotIndices = targetOps.map(op => op.slotIdx)
        const targetIds = new Set(targetOps.map(op => op.id))
        if (targetOps.some(op => lockedPositions.has(`${room.roomId}:${op.slotIdx}`) || lockedOperators.has(op.id))) continue
        if (targetOps.some(op => op.groupId && !op.groupId.includes('散件') &&
          Object.values(ws.mainPlan.facilities).some(f => f.slots.some(slot => slot.groupId === op.groupId &&
            slot.occupant.kind === 'operator' && !targetIds.has(resolveId(slot.occupant.operatorId)))))) continue
        const K = targetOps.length
        const availableOperator = (id: string) => !lockedOperators.has(id) && (!occupied.has(id) || targetIds.has(id))
        const available = (name: string) => ownedNames.has(name) && availableOperator(resolveId(name))

        const candidates: { unit: AtomicUnit; independent: boolean }[] = ATOMIC_UNITS.flatMap(unit => {
          const adapted = unit.adaptToPowerCount?.(powerCount, product === 'exp' ? 'exp' : 'gold')
          const u = adapted ? { ...unit, coreMembers: adapted.coreMembers, confPolicy: { ...unit.confPolicy, ...adapted.confPolicy } } : unit
          if (u.coreMembers.length !== K || u.preferredFacilityType !== room.type || u.coreMembers.some(m => m.roomType !== room.type)) return []
          if (isManufacture && u.preferredProduct && u.preferredProduct !== 'any' && u.preferredProduct !== product) return []
          if (u.coreMembers.some(m => !available(m.name) || (m.minLevel !== undefined && room.level < m.minLevel))) return []
          if (powerCount <= 2 && isManufacture && u.coreMembers.some(m => m.name === '至简')) return []
          // A prerequisite must be actually stationed, not merely owned or reserved as backup.
          const stationed = new Set(Object.values(ws.mainPlan.facilities).flatMap(f => f.slots.flatMap(slot =>
            slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : [])))
          if (u.externalRequirements?.some(req => req.pool.filter(name => stationed.has(resolveId(name))).length < req.count)) return []
          return [{ unit: u, independent: false }]
        })

        // The strongest unused singletons enter before simulation budgets are spent.
        // A small frontier also admits alternative bundles when their best members are scarce backups.
        const unused = inventory.operators.filter(o => availableOperator(o.charId) && !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔' &&
          (!options.configureRunOrderCandidates || room.type !== 'trading' || o.name !== '佩佩'))
        const singletonPreview = structuredClone(ws)
        for (const index of slotIndices) {
          const slot = singletonPreview.mainPlan.facilities[room.roomId].slots[index]!
          slot.occupant = { kind: 'empty' }; slot.groupId = null; slot.replacements = []
        }
        // Remove the outgoing team's suppression before ranking its replacements.
        const ranked = rankStaffingCandidates(singletonPreview, inventory, { roomId: room.roomId, slotIndex: slotIndices[0]! },
          unused.map(o => o.charId), 'main')
        const frontier = ranked.slice(0, Math.max(6, K))
        // 吉星 needs colleagues. An empty-team probe must not eliminate her before
        // a complete two/three-person bundle can be evaluated below.
        const colleagueCounter = unused.filter(o => productionColleagueBonus(o.skills) > 0)
          .sort((a, b) => productionColleagueBonus(b.skills) - productionColleagueBonus(a.skills))[0]
        if (!isManufacture && currentOps.length > 1 && colleagueCounter && !frontier.includes(colleagueCounter.charId)) frontier.push(colleagueCounter.charId)
        const bundles: string[][] = []
        const choose = (start: number, ids: string[]) => {
          if (ids.length === K) { bundles.push(ids); return }
          for (let index = start; index <= frontier.length - (K - ids.length); index++) choose(index + 1, [...ids, frontier[index]!])
        }
        choose(0, [])
        for (const ids of bundles) {
          const names = ids.map(id => inventory.operators.find(o => o.charId === id)!.name)
          candidates.push({ independent: true, unit: {
            id: `singletons:${ids.join('+')}`, name: names.join('+'), description: '已解锁散件技能效率比较',
            preferredFacilityType: isManufacture ? 'manufacture' : 'trading',
            coreMembers: names.map(name => ({ name, roomType: isManufacture ? 'manufacture' : 'trading' })),
          } })
        }

        for (const { unit: cand, independent } of candidates) {
          if (cand.coreMembers.every(m => targetIds.has(resolveId(m.name)))) continue
          const swapKey = `${room.roomId}:${targetOps.map(o => o.name).sort().join('+')}->${cand.id}`
          if (triedSwaps.has(swapKey)) continue
          const preview = structuredClone(ws)
          cand.coreMembers.forEach((m, index) => {
            preview.mainPlan.facilities[room.roomId].slots[slotIndices[index]!]!.occupant = { kind: 'operator', operatorId: resolveId(m.name) }
          })
          const candidateTheory = productionTeamTheory(preview, inventory, room.roomId)
          if (candidateTheory === undefined || candidateTheory <= currentTheory) continue
          swapProposals.push({ roomId: room.roomId, slotIndices, oldOps: targetOps, independent,
            oldPerCapita: currentTheory / currentOps.length, candidate: cand,
            candidatePerCapita: candidateTheory / currentOps.length, gain: (candidateTheory - currentTheory) / currentOps.length })
        }
      }
    }

    if (swapProposals.length === 0) break

    swapProposals.sort((a, b) => b.candidatePerCapita - a.candidatePerCapita || b.gain - a.gain)
    let evaluatedCount = 0

    for (const proposal of swapProposals) {
      if (options.evaluator && evaluatedCount >= 3) break
      const swapKey = `${proposal.roomId}:${proposal.oldOps.map((o) => o.name).sort().join('+')}->${proposal.candidate.id}`
      if (triedSwaps.has(swapKey)) continue

      const draftWs = structuredClone(ws)
      const targetRoom = draftWs.mainPlan.facilities[proposal.roomId]!

      const pendantNames = proposal.oldOps.filter(oldOp =>
        !proposal.candidate.coreMembers.some(member => resolveId(member.name) === oldOp.id) &&
        (isPendantOperator(oldOp.name, ws) || oldOp.groupId?.includes('挂件'))).map(op => op.name)
      const pendantLogs: string[] = []

      // 2. Clear old slots
      for (const sIdx of proposal.slotIndices) {
        targetRoom.slots[sIdx]!.occupant = { kind: 'empty' }
        targetRoom.slots[sIdx]!.groupId = null
        targetRoom.slots[sIdx]!.replacements = []
      }

      // 3. Place new candidate core members
      const newGroupId = `优化_${proposal.candidate.name}`
      proposal.candidate.coreMembers.forEach((m, idx) => {
        const slotIdx = proposal.slotIndices[idx]!
        const mId = resolveId(m.name)
        targetRoom.slots[slotIdx]!.occupant = { kind: 'operator', operatorId: mId }
        targetRoom.slots[slotIdx]!.groupId = proposal.independent ? null : newGroupId
        if (proposal.independent) applySingletonWorkPolicy(draftWs, proposal.roomId, slotIdx)
      })

      // Relocate only after clearing the previous assignment; otherwise the helper
      // sees an already-stationed pendant and the subsequent clear loses that support.
      for (const name of pendantNames) {
        const result = placePendantOperator(draftWs, name, `${name}_挂件`, inventory)
        if (result.placed) pendantLogs.push(`[挂件转移] ${name} 已安置于 ${getRoomDisplayName(result.roomId!)}。`)
      }

      // 4. Apply unit conf policy
      if (proposal.candidate.confPolicy) {
        if (proposal.candidate.confPolicy.exhaustRequire) {
          for (const n of proposal.candidate.confPolicy.exhaustRequire) {
            if (!draftWs.mainPlan.conf.exhaust_require.includes(n)) draftWs.mainPlan.conf.exhaust_require.push(n)
          }
        }
        if (proposal.candidate.confPolicy.restInFull) {
          for (const n of proposal.candidate.confPolicy.restInFull) {
            if (!draftWs.mainPlan.conf.rest_in_full.includes(n)) draftWs.mainPlan.conf.rest_in_full.push(n)
          }
        }
      }

      // 5. Ensure valid backups across draftWs
      if (!ensureValidBackups(draftWs)) continue
      if (maintainRunOrder && !configureRunOrder(draftWs, inventory)) continue

      // 6. Dynamic simulation check (Requirement 1 & Monotonicity)
      if (options.evaluator) {
        evaluatedCount++
        const simScore = options.evaluator(draftWs)
        if (simScore > currentScore) {
          logs.push(...pendantLogs)
          logs.push(
            `[全局置换] 设施 ${getRoomDisplayName(proposal.roomId)}：当前全站理论人均 ${proposal.oldPerCapita.toFixed(1)}% 成功替换为 ${proposal.candidate.name} (全站理论人均 ${proposal.candidatePerCapita.toFixed(1)}%)，动态拟真评分从 ${currentScore.toFixed(1)} 提升至 ${simScore.toFixed(1)} 分/日`,
          )
          ws = draftWs
          currentScore = simScore
          swappedCount++
          changed = true
          triedSwaps.clear() // Conditional efficiencies must be reconsidered after an accepted change.
          break
        } else {
          logs.push(
            `[置换放弃] 设施 ${getRoomDisplayName(proposal.roomId)} 尝试置换为 ${proposal.candidate.name} 后动态拟真评分未提升 (${simScore.toFixed(1)} <= ${currentScore.toFixed(1)})，已回滚保持原状。`,
          )
          triedSwaps.add(swapKey)
        }
      } else {
        logs.push(...pendantLogs)
        logs.push(
          `[全局置换] 设施 ${getRoomDisplayName(proposal.roomId)}：当前全站理论人均 ${proposal.oldPerCapita.toFixed(1)}% 替换为 ${proposal.candidate.name} (全站理论人均 ${proposal.candidatePerCapita.toFixed(1)}%)`,
        )
        ws = draftWs
        swappedCount++
        changed = true
        triedSwaps.clear()
        break
      }
    }

    if (!changed) break
  }

  // Ensure all production slots are filled
  const occupiedAll = new Set<string>()
  for (const fac of Object.values(ws.mainPlan.facilities)) {
    for (const slot of fac.slots) {
      if (slot.occupant.kind === 'operator') {
        occupiedAll.add(resolveId(slot.occupant.operatorId))
      }
      slot.replacements.forEach(id => occupiedAll.add(resolveId(id)))
    }
  }

  const productionRoomsAll = Object.values(ws.mainPlan.facilities).filter(
    (r) => r.type === 'manufacture' || r.type === 'trading',
  )
  for (const room of productionRoomsAll) {
    const cap = room.slots.length
    for (let sIdx = 0; sIdx < cap; sIdx++) {
      const slot = room.slots[sIdx]!
      if (slot.occupant.kind !== 'operator' && repairPositions.has(`${room.roomId}:${sIdx}`) && !lockedPositions.has(`${room.roomId}:${sIdx}`)) {
        const pool = inventory.operators.filter(o => !occupiedAll.has(o.charId) && !lockedOperators.has(o.charId) && !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔' &&
          (!options.configureRunOrderCandidates || room.type !== 'trading' || o.name !== '佩佩'))
        const freeSingleton = rankStaffingCandidates(ws, inventory, { roomId: room.roomId, slotIndex: sIdx }, pool.map(o => o.charId), 'main')[0]
        if (freeSingleton) {
          const sId = resolveId(freeSingleton)
          slot.occupant = { kind: 'operator', operatorId: sId }
          slot.groupId = null
          applySingletonWorkPolicy(ws, room.roomId, sIdx)
          occupiedAll.add(sId)
        }
      }
    }
  }

  if (!ensureValidBackups(ws) || (maintainRunOrder && !configureRunOrder(ws, inventory)) || !preservesLocks(ws)) {
    return { workspace: structuredClone(base), swappedCount: 0, score: baselineScore, logs: [...logs, '最终置换未通过占位、候补或锁定工位检查，保留原排班。'] }
  }
  if (options.evaluator && JSON.stringify(ws) !== JSON.stringify(base)) {
    const finalScore = options.evaluator(ws)
    if (!(finalScore > baselineScore)) return { workspace: structuredClone(base), swappedCount: 0, score: baselineScore, logs: [...logs, '最终补位后的完整排班未提高评分，保留原排班。'] }
    currentScore = finalScore
  }

  return { workspace: ws, swappedCount, score: currentScore, logs }
}
