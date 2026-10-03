import { OPERATOR_MAP, OPERATORS, type OperatorRecord } from '../domain/operators'
import { compileOperatorInventory, type OwnedOperatorInput, type OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { hasRiicTag } from '../domain/riicTags'
import type { MowerRoomId, RosterWorkspace } from '../workbench/model'

export interface SmartDormitoryOptions {
  /** Available operator IDs or names from pool/inventory. If omitted, uses all recognized operators. */
  candidateOperatorIds?: string[]
  /** Owned operator inventory entries with elite and level information. */
  entries?: readonly OwnedOperatorInput[]
  /** Force run even if disable_auto_dorm_keeper is enabled. */
  force?: boolean
}

export interface DormitoryAssignmentReport {
  applied: boolean
  fiammettaRoomId: MowerRoomId | null
  dormitoryKeepers: Record<string, { aoe?: string; single?: string }>
  synergyPlaced: Array<{ operatorId: string; roomId: MowerRoomId; slotIndex: number }>
}

/** Check if operator has an AOE dormitory recovery skill. */
export function isAoeDormKeeper(op: OperatorRecord): boolean {
  return op.skills.some(
    (s) =>
      s.roomType === 'DORMITORY' &&
      (/(?:该宿舍内|宿舍内)(?:所有|除自身以外所有)干员/.test(s.description) ||
        s.buffId.startsWith('dorm_rec_all') ||
        s.buffId.startsWith('dorm_powToRecAll') ||
        s.buffId.startsWith('dorm_hireToRecAll')),
  )
}

/** Check if operator has a single-target dormitory recovery skill. */
export function isSingleDormKeeper(op: OperatorRecord): boolean {
  return op.skills.some(
    (s) =>
      s.roomType === 'DORMITORY' &&
      (/(?:某个干员|指定干员|一名干员)(?:的心情)?每小时恢复/.test(s.description) ||
        s.buffId.startsWith('dorm_rec_single') ||
        s.buffId === 'dorm_rec_toone[000]'),
  )
}

/** Check if operator has any dormitory recovery skill (AOE, single, or self). */
export function hasDormRecoverySkill(op: OperatorRecord): boolean {
  return op.skills.some(
    (s) => s.roomType === 'DORMITORY' && (/恢复/.test(s.description) || s.buffId.includes('dorm_rec')),
  )
}

/**
 * Calculate the estimated mood recovery rate of a specific slot in a dormitory.
 * Factors in base level, atmosphere, AOE dorm keeper bonuses,
 * and single-target dorm keeper bonuses directed at this slot.
 */
export function calculateSlotRecoveryRate(
  workspace: RosterWorkspace,
  roomId: MowerRoomId,
  slotIndex: number,
): number {
  const fac = workspace.mainPlan.facilities[roomId]
  if (!fac || fac.type !== 'dormitory') return 0

  const slot = fac.slots[slotIndex]
  if (slot?.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === 'char_300_phenxi') {
    return 2.0
  }

  const level = fac.level ?? 1
  const atmosphere = level * 1000
  const base = 1.5 + level * 0.1 + Math.min(level * 1000, atmosphere) * 0.0004

  let maxAoe = 0
  let singleBonus = 0

  for (let idx = 0; idx < fac.slots.length; idx++) {
    const s = fac.slots[idx]
    if (s?.occupant.kind !== 'operator') continue
    const opId = resolveId(s.occupant.operatorId)
    const op = OPERATOR_MAP.get(opId)
    if (!op) continue

    for (const skill of op.skills) {
      if (skill.roomType !== 'DORMITORY') continue
      const desc = skill.description
      // AOE bonus
      const allMatch = desc.match(/(?:该宿舍内|宿舍内)(?:所有|除自身以外所有)干员的心情每小时恢复\+([\d.]+)/)
      if (allMatch) {
        if (desc.includes('除自身以外所有') && idx === slotIndex) {
          // Excludes self
        } else {
          maxAoe = Math.max(maxAoe, Number(allMatch[1]) || 0)
        }
      } else if (skill.buffId.startsWith('dorm_rec_all')) {
        maxAoe = Math.max(maxAoe, 0.15)
      }

      // Single bonus
      const singleMatch = desc.match(/某个干员(?:的心情)?每小时恢复\+([\d.]+)/)
      if (singleMatch) {
        const hasFiam = fac.slots.some(
          (sl) => sl?.occupant.kind === 'operator' && resolveId(sl.occupant.operatorId) === 'char_300_phenxi',
        )
        const targetSlotIdx = hasFiam ? 2 : 0
        if (slotIndex === targetSlotIdx && idx !== slotIndex) {
          singleBonus = Math.max(singleBonus, Number(singleMatch[1]) || 0.55)
        }
      }
    }
  }

  return base + maxAoe + singleBonus
}

/**
 * Locate the available dormitory slot across all dormitories with the lowest recovery rate.
 */
export function findLowestRecoveryDormitorySlot(
  workspace: RosterWorkspace,
  excludeOccupied = true,
): { roomId: MowerRoomId; slotIndex: number; rate: number } | null {
  const dormIds = (['dormitory_1', 'dormitory_2', 'dormitory_3', 'dormitory_4'] as MowerRoomId[])
    .filter(id => (workspace.mainPlan.facilities[id]?.level ?? 0) > 0)
  const candidates: { roomId: MowerRoomId; slotIndex: number; rate: number }[] = []

  for (const dId of dormIds) {
    const fac = workspace.mainPlan.facilities[dId]
    if (!fac) continue
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      const slot = fac.slots[sIdx]
      if (!slot) continue
      if (excludeOccupied && slot.occupant.kind === 'operator') continue
      if (slot.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === 'char_300_phenxi') continue

      const rate = calculateSlotRecoveryRate(workspace, dId, sIdx)
      candidates.push({ roomId: dId, slotIndex: sIdx, rate })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.rate - b.rate)
  return candidates[0]!
}

/**
 * Place a pendant operator into non-production facilities:
 * 1. Factory (Workshop), with replacement if available
 * 2. Train (Training Room), with replacement if available
 * 3. Dormitory slot with the LOWEST mood recovery rate
 */
export function placePendantOperator(
  workspace: RosterWorkspace,
  operatorName: string,
  groupId: string = '挂件干员',
  inventory?: OperatorInventory,
): { placed: boolean; roomId?: MowerRoomId; slotIndex?: number } {
  const charId = resolveId(operatorName)
  const facs = workspace.mainPlan.facilities
  const reserved = new Set(Object.values(facs).flatMap(room => room.slots.flatMap(slot => [
    ...(slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : []), ...slot.replacements.map(resolveId),
  ])))

  // 1. Try factory (Workshop)
  const factory = facs.factory
  if (factory && factory.slots.length > 0 && factory.slots[0]!.occupant.kind !== 'operator') {
    const slot = factory.slots[0]!
    slot.occupant = { kind: 'operator', operatorId: charId }
    slot.groupId = null
    const backup = inventory?.operators.find(
      (o) => o.matchesMaximumSkills && !reserved.has(o.charId) && o.name !== operatorName && (o.name === '特克诺' || o.name === '年' || o.name === '锡兰'),
    )
    if (backup) {
      slot.replacements = [backup.charId]
    }
    return { placed: true, roomId: 'factory', slotIndex: 0 }
  }

  // 2. Try train (Training Room)
  const train = facs.train
  if (train && train.slots.length > 0) {
    const emptySlotIdx = train.slots.findIndex((s) => s.occupant.kind !== 'operator')
    if (emptySlotIdx !== -1) {
      const slot = train.slots[emptySlotIdx]!
      slot.occupant = { kind: 'operator', operatorId: charId }
      slot.groupId = null
      const backup = inventory?.operators.find(
        (o) => o.matchesMaximumSkills && !reserved.has(o.charId) && o.name !== operatorName && (o.name === '达利尔' || o.name === '艾丽妮' || o.name === '左乐'),
      )
      if (backup) {
        slot.replacements = [backup.charId]
      }
      return { placed: true, roomId: 'train', slotIndex: emptySlotIdx }
    }
  }

  // 3. Dormitory slot with LOWEST recovery rate
  const lowest = findLowestRecoveryDormitorySlot(workspace, true)
  if (lowest) {
    const targetRoom = facs[lowest.roomId]!
    const targetSlot = targetRoom.slots[lowest.slotIndex]!
    targetSlot.occupant = { kind: 'operator', operatorId: charId }
    targetSlot.groupId = groupId
    targetSlot.replacements = []
    return { placed: true, roomId: lowest.roomId, slotIndex: lowest.slotIndex }
  }

  return { placed: false }
}

/**
 * Automatically applies smart dormitory keepers and synergy placements:
 * 1. Default 2 dorm keepers per dormitory: 1 AOE + 1 Single.
 * 2. If Fiammetta is in roster, places her in the slowest recovery dormitory.
 * 3. Synergy operators without recovery skills (e.g. Durin race) placed in Workshop/Training first, then Dormitory.
 * 4. Honors user override: if conf.disable_auto_dorm_keeper is true and not force, skips auto assignment.
 * 5. Fills remaining unassigned slots in dormitories with 'free' so resting operators can rest.
 */
function removeOperatorEverywhere(
  workspace: RosterWorkspace,
  charIdOrName: string,
  excludeRoomId?: MowerRoomId,
  excludeSlotIndex?: number,
): void {
  const targetId = resolveId(charIdOrName)
  for (const [rId, fac] of Object.entries(workspace.mainPlan.facilities)) {
    fac.slots.forEach((slot, sIdx) => {
      if (rId === excludeRoomId && sIdx === excludeSlotIndex) return
      if (slot.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === targetId) {
        slot.occupant = rId.startsWith('dormitory') ? { kind: 'free' } : { kind: 'empty' }
        if (rId.startsWith('dormitory')) {
          slot.replacements = []
        }
      }
      // Also remove from replacements if present (except if slot is Fiammetta swap targets in dorm)
      if (slot.replacements.length > 0) {
        const isFiam = slot.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === 'char_300_phenxi'
        if (!(rId.startsWith('dormitory') && isFiam)) {
          slot.replacements = slot.replacements.filter((rep) => resolveId(rep) !== targetId)
        }
      }
    })
  }
}

/**
 * Automatically applies smart dormitory keepers and synergy placements:
 * 1. Default 2 dorm keepers per dormitory: 1 AOE + 1 Single.
 * 2. If Fiammetta is in roster, places her in the slowest recovery dormitory.
 * 3. Synergy operators without recovery skills (e.g. Durin race) placed in Workshop/Training first, then Dormitory.
 * 4. Honors user override: if conf.disable_auto_dorm_keeper is true and not force, skips auto assignment.
 * 5. Fills remaining unassigned slots in dormitories with 'free' so resting operators can rest.
 */
/**
 * Find the top working operators in production rooms (manufacture & trading)
 * belonging to the highest per-capita output combinations (e.g. Aroma+WaaiFu, Red+Dionysus+Christine).
 */
export function findTopPerCapitaProductionOperators(
  workspace: RosterWorkspace,
  targetCount = 3,
  ownedOps?: Map<string, { matchesMaximumSkills: boolean }> | null,
): string[] {
  const productionRooms = Object.values(workspace.mainPlan.facilities).filter(
    (r) => r.type === 'manufacture' || r.type === 'trading',
  )

  const groupMembers = new Map<string, string[]>()
  for (const room of productionRooms) {
    for (const slot of room.slots) {
      if (slot.occupant.kind === 'operator') {
        const opId = resolveId(slot.occupant.operatorId)
        if (ownedOps && (!ownedOps.has(opId) || !ownedOps.get(opId)!.matchesMaximumSkills)) continue
        const grp = slot.groupId ?? `solo_${room.roomId}_${opId}`
        if (!groupMembers.has(grp)) groupMembers.set(grp, [])
        groupMembers.get(grp)!.push(opId)
      }
    }
  }

  const priorityWeights: Record<string, number> = {
    '阿罗玛槐琥组': 100,
    '红云酒神猫猫组': 90,
    '感知信息+鸿雪组': 85,
    '自动化组': 80,
    '深海骑士替班组': 75,
    '拉特兰商道': 70,
    '泡泡容量组': 65,
    '企鹅物流': 60,
  }

  const sortedGroups = Array.from(groupMembers.entries()).sort((a, b) => {
    const weightA = priorityWeights[a[0]] ?? 50
    const weightB = priorityWeights[b[0]] ?? 50
    return weightB - weightA
  })

  const targets: string[] = []
  for (const [_grp, members] of sortedGroups) {
    for (const m of members) {
      if (!targets.includes(m)) {
        targets.push(m)
        if (targets.length >= targetCount) return targets
      }
    }
  }

  // Fallback: any working production operator
  if (targets.length < targetCount) {
    for (const room of productionRooms) {
      for (const slot of room.slots) {
        if (slot.occupant.kind === 'operator') {
          const id = resolveId(slot.occupant.operatorId)
          if (ownedOps && (!ownedOps.has(id) || !ownedOps.get(id)!.matchesMaximumSkills)) continue
          if (!targets.includes(id)) {
            targets.push(id)
            if (targets.length >= targetCount) return targets
          }
        }
      }
    }
  }

  return targets
}

export function applySmartDormitoryPolicy(
  workspace: RosterWorkspace,
  options: SmartDormitoryOptions = {},
): DormitoryAssignmentReport {
  const conf = workspace.mainPlan.conf
  if (conf.disable_auto_dorm_keeper && !options.force) {
    return {
      applied: false,
      fiammettaRoomId: null,
      dormitoryKeepers: {},
      synergyPlaced: [],
    }
  }

  const facilities = workspace.mainPlan.facilities
  const dormIds = (['dormitory_1', 'dormitory_2', 'dormitory_3', 'dormitory_4'] as MowerRoomId[])
    .filter(id => (facilities[id]?.level ?? 0) > 0)

  // Find if Fiammetta exists in the incoming workspace (and capture her replacement swap targets)
  let existingFiamSlot: { roomId: MowerRoomId; slotIndex: number; replacements: string[] } | null = null
  for (const [rId, fac] of Object.entries(facilities)) {
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      const slot = fac.slots[sIdx]
      if (slot?.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === 'char_300_phenxi') {
        existingFiamSlot = { roomId: rId as MowerRoomId, slotIndex: sIdx, replacements: [...slot.replacements] }
        break
      }
    }
    if (existingFiamSlot) break
  }

  // If owned entries are provided, compile them to check actually unlocked skills
  const ownedMap = options.entries ? compileOperatorInventory(options.entries) : null
  const ownedOps = ownedMap && ownedMap.valid ? new Map(ownedMap.operators.map(o => [o.charId, o])) : null
  const isOpMaxSkill = (id: string) => !ownedOps || Boolean(ownedOps.get(id)?.matchesMaximumSkills)

  // 1. Determine Fiammetta placement if present in incoming workspace or candidates
  const fiamOp = ownedOps?.get('char_300_phenxi')
  const fiamValid = !ownedOps || (fiamOp && fiamOp.matchesMaximumSkills)
  const hasFiammetta = Boolean(fiamValid) && (
    Boolean(existingFiamSlot) ||
    Boolean(options.candidateOperatorIds?.some((id) => resolveId(id) === 'char_300_phenxi')) ||
    Boolean(options.entries?.some((e) => resolveId(e.operator) === 'char_300_phenxi'))
  )

  let fiammettaRoomId: MowerRoomId | null = null
  if (hasFiammetta && dormIds.length) {
    // Find slowest dormitory (lowest level, or dormitory_4 as tie-breaker)
    let slowestRoom: MowerRoomId = 'dormitory_4'
    let lowestLevel = 999
    for (const dId of dormIds) {
      const lvl = facilities[dId]?.level ?? 1
      if (lvl <= lowestLevel) {
        lowestLevel = lvl
        slowestRoom = dId
      }
    }
    fiammettaRoomId = slowestRoom

    // Clear Fiammetta from everywhere else in the base
    removeOperatorEverywhere(workspace, 'char_300_phenxi', slowestRoom, 0)

    // Place Fiammetta in slowest room slot 0 with her replacements transferred or computed
    const targetRoom = facilities[slowestRoom]
    if (targetRoom && targetRoom.slots.length > 0 && targetRoom.slots[0]) {
      targetRoom.slots[0].occupant = { kind: 'operator', operatorId: 'char_300_phenxi' }
      const topOps = findTopPerCapitaProductionOperators(workspace, 3, ownedOps)
      const validExistingReps = existingFiamSlot ? existingFiamSlot.replacements.filter(isOpMaxSkill) : []
      if (topOps.length >= 3 && (!existingFiamSlot || validExistingReps.length < 3 || options.force)) {
        targetRoom.slots[0].replacements = topOps
      } else if (validExistingReps.length >= 3) {
        targetRoom.slots[0].replacements = validExistingReps
      } else {
        targetRoom.slots[0].replacements = topOps
      }
    }
  }

  // Reset any non-Fiammetta unpinned or invalid dormitory slots to clean free state before re-assignment
  for (const dId of dormIds) {
    const fac = facilities[dId]
    if (!fac) continue
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      if (dId === fiammettaRoomId && sIdx === 0) continue
      const slot = fac.slots[sIdx]
      if (slot && (!slot.groupId || (slot.occupant.kind === 'operator' && !isOpMaxSkill(resolveId(slot.occupant.operatorId))))) {
        slot.occupant = { kind: 'free' }
        slot.replacements = []
        slot.groupId = null
      }
    }
  }

  // Collect operators already assigned to output rooms, control center, Fiammetta, or pinned dorm slots
  const assignedWorkingIds = new Set<string>()
  for (const [rId, fac] of Object.entries(facilities)) {
    if (rId.startsWith('dormitory')) {
      for (const slot of fac.slots) {
        if (slot.occupant.kind === 'operator' && slot.groupId) {
          assignedWorkingIds.add(resolveId(slot.occupant.operatorId))
        }
      }
      continue
    }
    for (const slot of fac.slots) {
      if (slot.occupant.kind === 'operator') {
        assignedWorkingIds.add(resolveId(slot.occupant.operatorId))
      }
      for (const rep of slot.replacements) {
        assignedWorkingIds.add(resolveId(rep))
      }
    }
  }
  if (fiammettaRoomId) {
    assignedWorkingIds.add('char_300_phenxi')
  }

  // Operator pool: candidates if provided, else all operators excluding working operators
  const poolIds = (options.candidateOperatorIds && options.candidateOperatorIds.length > 0)
    ? options.candidateOperatorIds.map(resolveId).filter((id) => !assignedWorkingIds.has(id) && isOpMaxSkill(id))
    : (options.entries && options.entries.length > 0)
      ? options.entries.map(e => resolveId(e.operator)).filter((id) => !assignedWorkingIds.has(id) && isOpMaxSkill(id))
      : OPERATORS.map((o) => o.charId).filter((id) => !assignedWorkingIds.has(id) && isOpMaxSkill(id))

  const uniquePoolIds = Array.from(new Set(poolIds))
  const poolOps = uniquePoolIds.map((id) => OPERATOR_MAP.get(id)).filter((o): o is OperatorRecord => Boolean(o))

  // Find AOE and Single dorm keepers considering unlocked skills if owned inventory was supplied
  const isCandidateAoe = (op: OperatorRecord): boolean => {
    if (ownedOps) {
      const owned = ownedOps.get(op.charId)
      if (!owned || !owned.matchesMaximumSkills) return false
      return owned.skills.some(
        (s) =>
          s.roomType === 'DORMITORY' &&
          (/(?:该宿舍内|宿舍内)(?:所有|除自身以外所有)干员/.test(s.description) ||
            s.buffId.startsWith('dorm_rec_all') ||
            s.buffId.startsWith('dorm_powToRecAll') ||
            s.buffId.startsWith('dorm_hireToRecAll')),
      )
    }
    return isAoeDormKeeper(op)
  }

  const isCandidateSingle = (op: OperatorRecord): boolean => {
    if (ownedOps) {
      const owned = ownedOps.get(op.charId)
      if (!owned || !owned.matchesMaximumSkills) return false
      return owned.skills.some(
        (s) =>
          s.roomType === 'DORMITORY' &&
          (/(?:某个干员|指定干员|一名干员)(?:的心情)?每小时恢复/.test(s.description) ||
            s.buffId.startsWith('dorm_rec_single') ||
            s.buffId === 'dorm_rec_toone[000]'),
      )
    }
    return isSingleDormKeeper(op)
  }

  const aoeCandidates = poolOps.filter(isCandidateAoe)
  const singleCandidates = poolOps.filter(isCandidateSingle)

  // When Pozëmka is in base, prioritize Durin race (Durin, Myrtle) as dorm keepers (Requirement 4)
  const hasPozemka = Object.values(facilities).some((f) =>
    f.slots.some((s) => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === resolveId('鸿雪')),
  )
  if (hasPozemka) {
    aoeCandidates.sort((a, b) => (hasRiicTag(b, 'durin') ? 1 : 0) - (hasRiicTag(a, 'durin') ? 1 : 0))
    singleCandidates.sort((a, b) => (hasRiicTag(b, 'durin') ? 1 : 0) - (hasRiicTag(a, 'durin') ? 1 : 0))
  }

  const usedKeepers = new Set<string>()
  if (fiammettaRoomId) {
    usedKeepers.add('char_300_phenxi')
  }
  const keeperReport: Record<string, { aoe?: string; single?: string }> = {}

  // Calculate maxGroupSize and required Free beds
  const groupSizes = new Map<string, number>()
  for (const [rId, fac] of Object.entries(facilities)) {
    if (rId.startsWith('dormitory')) continue
    for (const slot of fac.slots) {
      if (slot.occupant.kind === 'operator' && slot.groupId) {
        groupSizes.set(slot.groupId, (groupSizes.get(slot.groupId) ?? 0) + 1)
      }
    }
  }
  const maxGroupSize = Math.max(0, ...groupSizes.values(), 1)
  const minRequiredFreeBeds = maxGroupSize + 1

  let totalDormBeds = 0
  for (const dId of dormIds) {
    totalDormBeds += facilities[dId]?.slots.length ?? 0
  }
  const maxPermanentAllowed = Math.max(0, totalDormBeds - minRequiredFreeBeds)

  let currentPermanentCount = fiammettaRoomId ? 1 : 0
  for (const dId of dormIds) {
    const fac = facilities[dId]
    if (!fac) continue
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      if (dId === fiammettaRoomId && sIdx === 0) continue
      const slot = fac.slots[sIdx]
      if (slot?.occupant.kind === 'operator' && slot.groupId) {
        currentPermanentCount++
      }
    }
  }

  // 2. Assign dorm keepers while preserving required free beds for largest group
  for (const dId of dormIds) {
    const fac = facilities[dId]
    keeperReport[dId] = {}

    // Check if fac already has an assigned AOE keeper
    const existingAoeSlot = fac.slots.find(
      (s) => s.occupant.kind === 'operator' && isCandidateAoe(OPERATOR_MAP.get(resolveId(s.occupant.operatorId))!),
    )
    if (existingAoeSlot && existingAoeSlot.occupant.kind === 'operator') {
      const opId = resolveId(existingAoeSlot.occupant.operatorId)
      usedKeepers.add(opId)
      assignedWorkingIds.add(opId)
      keeperReport[dId].aoe = opId
    } else {
      // Find available AOE keeper
      const aoeOp = aoeCandidates.find((o) => !usedKeepers.has(o.charId) && !assignedWorkingIds.has(o.charId))
      const isFiamRoom = dId === fiammettaRoomId
      const aoeSlotIndex = isFiamRoom ? 1 : 0

      if (currentPermanentCount < maxPermanentAllowed && aoeOp) {
        let targetIdx = -1
        if (fac.slots[aoeSlotIndex] && fac.slots[aoeSlotIndex]!.occupant.kind !== 'operator') {
          targetIdx = aoeSlotIndex
        } else {
          targetIdx = fac.slots.findIndex((s, idx) => idx !== (isFiamRoom ? 0 : -1) && s.occupant.kind !== 'operator')
        }
        if (targetIdx !== -1 && fac.slots[targetIdx]) {
          removeOperatorEverywhere(workspace, aoeOp.charId, dId, targetIdx)
          fac.slots[targetIdx]!.occupant = { kind: 'operator', operatorId: aoeOp.charId }
          fac.slots[targetIdx]!.replacements = []
          fac.slots[targetIdx]!.groupId = fac.slots[targetIdx]!.groupId || (hasRiicTag(aoeOp, 'durin') ? 'durin_synergy' : 'dorm_keeper')
          usedKeepers.add(aoeOp.charId)
          assignedWorkingIds.add(aoeOp.charId)
          keeperReport[dId].aoe = aoeOp.charId
          currentPermanentCount++
        }
      }
    }

    // Check if fac already has an assigned Single keeper
    const existingSingleSlot = fac.slots.find(
      (s) =>
        s.occupant.kind === 'operator' &&
        isCandidateSingle(OPERATOR_MAP.get(resolveId(s.occupant.operatorId))!) &&
        resolveId(s.occupant.operatorId) !== keeperReport[dId]?.aoe,
    )
    if (existingSingleSlot && existingSingleSlot.occupant.kind === 'operator') {
      const opId = resolveId(existingSingleSlot.occupant.operatorId)
      usedKeepers.add(opId)
      assignedWorkingIds.add(opId)
      keeperReport[dId].single = opId
    } else {
      // Find available Single keeper
      const singleOp = singleCandidates.find(
        (o) => !usedKeepers.has(o.charId) && !assignedWorkingIds.has(o.charId) && o.charId !== keeperReport[dId]?.aoe,
      )
      const isFiamRoom = dId === fiammettaRoomId
      const singleSlotIndex = isFiamRoom ? 2 : 1

      if (currentPermanentCount < maxPermanentAllowed && singleOp) {
        let targetIdx = -1
        if (fac.slots[singleSlotIndex] && fac.slots[singleSlotIndex]!.occupant.kind !== 'operator') {
          targetIdx = singleSlotIndex
        } else {
          targetIdx = fac.slots.findIndex((s, idx) => idx !== (isFiamRoom ? 0 : -1) && s.occupant.kind !== 'operator')
        }
        if (targetIdx !== -1 && fac.slots[targetIdx]) {
          removeOperatorEverywhere(workspace, singleOp.charId, dId, targetIdx)
          fac.slots[targetIdx]!.occupant = { kind: 'operator', operatorId: singleOp.charId }
          fac.slots[targetIdx]!.replacements = []
          fac.slots[targetIdx]!.groupId = fac.slots[targetIdx]!.groupId || (hasRiicTag(singleOp, 'durin') ? 'durin_synergy' : 'dorm_keeper')
          usedKeepers.add(singleOp.charId)
          assignedWorkingIds.add(singleOp.charId)
          keeperReport[dId].single = singleOp.charId
          currentPermanentCount++
        }
      }
    }

    // Fill remaining unassigned slots in dormitory with 'free' so resting workers have beds
    for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
      const slot = fac.slots[sIdx]
      if (slot && slot.occupant.kind === 'empty') {
        slot.occupant = { kind: 'free' }
      }
    }
  }

  // 3. Synergy operators needing base presence (Durin race capped at 4 in base)
  const synergyReport: Array<{ operatorId: string; roomId: MowerRoomId; slotIndex: number }> = []
  let durinCountInBase = 0
  for (const fac of Object.values(facilities)) {
    for (const slot of fac.slots) {
      if (slot.occupant.kind === 'operator') {
        const op = OPERATOR_MAP.get(resolveId(slot.occupant.operatorId))
        if (op && hasRiicTag(op, 'durin')) {
          durinCountInBase++
        }
      }
    }
  }

  if (hasPozemka) {
    const durinSynergyOps = poolOps.filter((o) => {
      if (!hasRiicTag(o, 'durin')) return false
      const id = resolveId(o.charId)
      for (const fac of Object.values(facilities)) {
        if (fac.slots.some((s) => s.occupant.kind === 'operator' && resolveId(s.occupant.operatorId) === id)) {
          return false
        }
      }
      return true
    })

    // Auxiliary rooms: contact (office), factory (workshop), train (training)
    const auxiliaryRooms: MowerRoomId[] = ['contact', 'factory', 'train']
    for (const op of durinSynergyOps) {
      if (durinCountInBase >= 4) break
      let placed = false

      // Try auxiliary rooms first
      for (const auxId of auxiliaryRooms) {
        const fac = facilities[auxId]
        if (!fac) continue
        for (let sIdx = 0; sIdx < fac.slots.length; sIdx++) {
          const slot = fac.slots[sIdx]
          if (slot && (slot.occupant.kind === 'empty' || slot.occupant.kind === 'free')) {
            removeOperatorEverywhere(workspace, op.charId, auxId, sIdx)
            slot.occupant = { kind: 'operator', operatorId: op.charId }
            slot.groupId = slot.groupId || 'durin_synergy'
            usedKeepers.add(op.charId)
            assignedWorkingIds.add(op.charId)
            synergyReport.push({ operatorId: op.charId, roomId: auxId, slotIndex: sIdx })
            durinCountInBase++
            placed = true
            break
          }
        }
        if (placed) break
      }

      // If auxiliary rooms full, place into dormitory slot with LOWEST recovery rate
      if (!placed && currentPermanentCount < maxPermanentAllowed) {
        const lowestSlot = findLowestRecoveryDormitorySlot(workspace, true)
        if (lowestSlot) {
          const fac = facilities[lowestSlot.roomId]
          if (fac) {
            const slot = fac.slots[lowestSlot.slotIndex]
            if (slot && (slot.occupant.kind === 'empty' || slot.occupant.kind === 'free')) {
              removeOperatorEverywhere(workspace, op.charId, lowestSlot.roomId, lowestSlot.slotIndex)
              slot.occupant = { kind: 'operator', operatorId: op.charId }
              slot.groupId = slot.groupId || 'durin_synergy'
              usedKeepers.add(op.charId)
              assignedWorkingIds.add(op.charId)
              synergyReport.push({ operatorId: op.charId, roomId: lowestSlot.roomId, slotIndex: lowestSlot.slotIndex })
              currentPermanentCount++
              durinCountInBase++
              placed = true
            }
          }
        }
      }

      if (!placed) {
        continue
      }
    }
  }

  // Final invariant enforcement across all dormitories:
  // Any slot that is not a recognized keeper/Fiammetta/synergy operator should be a valid free bed
  for (const dId of dormIds) {
    const fac = facilities[dId]
    if (!fac) continue
    for (const slot of fac.slots) {
      if (slot.occupant.kind === 'empty') {
        slot.occupant = { kind: 'free' }
      }
    }
  }

  return {
    applied: true,
    fiammettaRoomId,
    dormitoryKeepers: keeperReport,
    synergyPlaced: synergyReport,
  }
}
