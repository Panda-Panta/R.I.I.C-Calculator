import { mainPlanOnly } from './mainPlanOnly'
import { ensureBuiltDormKeepers } from './dormKeepers'
import { configureRunOrder } from './configureRunOrder'
import type { MowerRoomId, RosterWorkspace } from '../domain/roster'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { compileOperatorInventory, type OperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { ATOMIC_UNITS, type AtomicMember, type AtomicUnit, type AtomicUnitConfPolicy } from './riicAtomicUnits'
import { assignBackups, validatePhysicalRoster } from './rosterDraft'
import { applySmartDormitoryPolicy } from '../scheduler/smartDormitoryPolicy'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreSimulationProduction } from '../simulator/productionScore'
import { normalizeProductionWeights } from '../domain/productionWeights'
import { rankStaffingCandidates } from './staffingQuality'
import { buildSingletonFallback } from './singletonFallback'
import { applySingletonWorkPolicy } from './productionSingletons'
import { availableCoreVariants, facilityCapacity, type CombinationPool, type CombinationVariant } from './combinationModel'
import { buildCombinationPool } from './combinationEvaluation'
import { allocateCombinationSkeleton, appliedMainCombinations, completeShiftScores, hasCompleteRestrictedProduction } from './combinationAllocation'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { compareWorkspacePreference } from './automaticCombinationPreferences'
import { compareProductionEfficiency } from './productionEfficiencyPriority'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'

export interface MolecularCandidate {
  id: string
  name: string
  workspace: RosterWorkspace
  appliedAtoms: string[]
  staticScore: number
  simScore: number | null
  diagnostics: string[]
  confPolicy: AtomicUnitConfPolicy
}
export interface SynthesisOptions {
  seed?: number
  branchCount?: number
  requireWarmupExhaustion?: boolean
  simulationWarmupHours?: number
  simulationSampleHours?: number
  droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
  lockedPositions?: Set<string>
  lockedOperators?: Set<string>
}
/** Ownership admits a core. Actual unlocked skills decide its subsequent ranking. */
export function checkAtomicAvailability(
  atom: AtomicUnit, inventory: OperatorInventory, powerCount: number, product?: 'gold' | 'exp',
): { available: boolean; coreMembers: AtomicMember[]; thirdMemberWhitelist?: string[]; confPolicy?: AtomicUnitConfPolicy } {
  const variant = availableCoreVariants(atom, inventory, powerCount, product)[0]
  return variant ? { available: true, ...variant } : { available: false, coreMembers: [] }
}
const skillTypes: Record<string, string> = {
  manufacture: 'MANUFACTURE', trading: 'TRADING', central: 'CONTROL', power: 'POWER',
  contact: 'HIRE', meeting: 'MEETING', factory: 'WORKSHOP', train: 'TRAINING', recycle: 'RECYCLE',
}

/** Retry different production footprints in measured order when the best footprint cannot be completed. */
export function combinationAllocationAlternatives(base: RosterWorkspace, pool: CombinationPool, definitionId: string): CombinationVariant[] {
  const seen = new Set<string>()
  return pool.values.filter(v => v.status === 'evaluated' && v.variant.definitionId === definitionId && hasCompleteRestrictedProduction(base, v.variant)).flatMap(value => {
    const counts = new Map<string, number>()
    for (const p of value.variant.placements) {
      const room = base.mainPlan.facilities[p.roomId]
      if (room.type === 'manufacture' || room.type === 'trading') counts.set(p.roomId, (counts.get(p.roomId) ?? 0) + 1)
    }
    const footprint = [...counts].map(([roomId, count]) => {
      const room = base.mainPlan.facilities[roomId as MowerRoomId]
      return [room.type, room.product, room.level, count]
    }).sort()
    const preferred = ATOMIC_UNITS.find(u => u.id === definitionId)?.preferredNonCoreMembers ?? []
    const signature = JSON.stringify([footprint, [...value.variant.coreOperatorIds].sort(),
      preferred.filter(n => value.variant.optionalOperatorIds.includes(resolveId(n))),
      value.variant.placements.filter(p => base.mainPlan.facilities[p.roomId].type === 'dormitory').length])
    if (seen.has(signature)) return []
    seen.add(signature)
    return [value.variant]
  })
}
function finishSkeleton(source: RosterWorkspace, entries: readonly OwnedOperatorInput[], inventory: OperatorInventory, options: SynthesisOptions): RosterWorkspace | null {
  const ws = structuredClone(source)
  const locked = options.lockedPositions ?? new Set<string>()
  const reserved = () => new Set([...options.lockedOperators ?? [], ...Object.values(ws.mainPlan.facilities).flatMap(room =>
    room.slots.flatMap(slot => [...(slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : []), ...slot.replacements.map(resolveId)]))])
  const candidates = (roomId: MowerRoomId) => {
    const room = ws.mainPlan.facilities[roomId], used = reserved()
    return inventory.operators.filter(o => !used.has(o.charId) && !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔' &&
      (room.type !== 'trading' || o.name !== '佩佩') && o.skills.some(s => s.roomType === skillTypes[room.type])).map(o => o.charId)
  }
  // Both combination shifts are reserved before independent staffing consumes actors.
  const mandatoryRooms = Object.values(ws.mainPlan.facilities).filter(r => r.level > 0 && ['manufacture', 'trading', 'central', 'power'].includes(r.type))
  for (const room of mandatoryRooms) for (const [slotIndex, slot] of room.slots.entries()) {
    if (slot.occupant.kind === 'operator' || locked.has(`${room.roomId}:${slotIndex}`)) continue
    if (slot.occupant.kind === 'current') return null
    const best = rankStaffingCandidates(ws, inventory, { roomId: room.roomId, slotIndex }, candidates(room.roomId), 'main')[0]
    if (!best) return null
    slot.occupant = { kind: 'operator', operatorId: best }
    if (!options.requireWarmupExhaustion) applySingletonWorkPolicy(ws, room.roomId, slotIndex)
  }
  const missingBackups = () => Object.values(ws.mainPlan.facilities).filter(r => r.level > 0 && r.type !== 'dormitory')
    .flatMap(room => room.slots.flatMap((slot, slotIndex) => {
      if (slot.occupant.kind !== 'operator' || locked.has(`${room.roomId}:${slotIndex}`) ||
        ws.mainPlan.conf.workaholic.some(ref => resolveId(ref) === resolveId(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : '')) ||
        slot.replacements.some(ref => isOrdinaryReplacementCandidate(ref, room.type))) return []
      return [{ roomId: room.roomId, slotIndex, operatorId: resolveId(slot.occupant.operatorId) }]
    }))
  const completeBackups = () => !assignBackups(ws, inventory, missingBackups(), {
    excludedOperatorIds: [...options.lockedOperators ?? []], requireWarmupExhaustion: options.requireWarmupExhaustion,
  }).missingReplacementIds.length
  if (!completeBackups()) return null
  // Auxiliary stations consume only resources left after both productive shifts.
  for (const room of Object.values(ws.mainPlan.facilities)) {
    if (!room.level || !['meeting', 'contact', 'factory', 'train', 'recycle'].includes(room.type)) continue
    for (const [slotIndex, slot] of room.slots.entries()) {
      if (!['empty', 'free'].includes(slot.occupant.kind) || locked.has(`${room.roomId}:${slotIndex}`)) continue
      const pool = candidates(room.roomId)
      if (pool.length < (room.type === 'recycle' ? 1 : 2)) continue
      const best = rankStaffingCandidates(ws, inventory, { roomId: room.roomId, slotIndex }, pool, 'main')[0]
      if (!best) continue
      const before = structuredClone(slot)
      slot.occupant = { kind: 'operator', operatorId: best }
      const assigned = assignBackups(ws, inventory, [{ roomId: room.roomId, slotIndex, operatorId: best }], {
        excludedOperatorIds: [...options.lockedOperators ?? []], requireWarmupExhaustion: options.requireWarmupExhaustion,
      })
      if (assigned.missingReplacementIds.length) Object.assign(slot, before)
    }
  }
  for (const room of Object.values(ws.mainPlan.facilities)) if (room.type === 'dormitory' && room.level) {
    room.slots.forEach((slot, index) => {
      if (slot.occupant.kind === 'empty' && !locked.has(`${room.roomId}:${index}`)) slot.occupant = { kind: 'free' }
    })
  }
  const beforeDorms = structuredClone(ws)
  applySmartDormitoryPolicy(ws, { entries: [...entries], candidateOperatorIds: entries.map(e => e.operator), lockedPositions: locked })
  if ([...locked].some(key => {
    const [room, index] = key.split(':')
    return JSON.stringify(ws.mainPlan.facilities[room as MowerRoomId].slots[Number(index)]) !== JSON.stringify(beforeDorms.mainPlan.facilities[room as MowerRoomId].slots[Number(index)])
  })) Object.assign(ws, beforeDorms)
  if (!ensureBuiltDormKeepers(ws, inventory, locked) || !completeBackups() || !configureRunOrder(ws, inventory) ||
    validatePhysicalRoster(ws).length || recoveryGroupCapacityIssues(ws).length) return null
  return ws
}
export interface MolecularRankingFeatures {
  order: number
  mainScore: number
  meanScore: number
  structure: ReadonlySet<string>
}

/** Keep both output views and different physical teams: neither static view predicts duty cycles. */
export function selectMolecularShortlist<T extends MolecularRankingFeatures>(starts: readonly T[], count: number, anchor?: T): T[] {
  const byMain = (a: T, b: T) => b.mainScore - a.mainScore || b.meanScore - a.meanScore || a.order - b.order
  const byMean = (a: T, b: T) => b.meanScore - a.meanScore || b.mainScore - a.mainScore || a.order - b.order
  const main = [...starts].sort(byMain), mean = [...starts].sort(byMean)
  const selected: T[] = anchor && starts.includes(anchor) && count > 0 ? [anchor] : []
  const seen = new Set(selected)
  const contenders = new Set([...main.slice(0, count * 2), ...mean.slice(0, count * 2)])
  const distance = (a: T, b: T) => {
    let common = 0
    for (const feature of a.structure) if (b.structure.has(feature)) common++
    return 1 - common / Math.max(1, a.structure.size + b.structure.size - common)
  }
  let turn = 0
  while (selected.length < count && seen.size < starts.length) {
    let next: T | undefined
    if (turn % 3 === 2 && selected.length) {
      let greatest = -1
      // Mean-score order gives deterministic, output-aware ties for equal novelty.
      for (const candidate of mean) {
        if (seen.has(candidate) || !contenders.has(candidate)) continue
        const novelty = Math.min(...selected.map(other => distance(candidate, other)))
        if (novelty > greatest) { greatest = novelty; next = candidate }
      }
    }
    next ??= (turn % 3 === 0 ? main : mean).find(candidate => !seen.has(candidate))
    if (!next) break
    selected.push(next); seen.add(next); turn++
  }
  return selected
}

function molecularStructure(ws: RosterWorkspace): Set<string> {
  const structure = new Set<string>(), groups = new Map<string, string[]>()
  for (const room of Object.values(ws.mainPlan.facilities)) for (const [index, slot] of room.slots.entries()) {
    if (slot.occupant.kind === 'operator') structure.add(`${room.roomId}:main:${resolveId(slot.occupant.operatorId)}`)
    for (const ref of slot.replacements) structure.add(`${room.roomId}:backup:${resolveId(ref)}`)
    if (slot.groupId) {
      const members = groups.get(slot.groupId) ?? []
      members.push(`${room.roomId}:${index}`); groups.set(slot.groupId, members)
    }
  }
  for (const group of groups.values()) if (group.length > 1) structure.add(`group:${group.sort().join(',')}`)
  return structure
}

/** Score broad family starts, then staff a small, diverse set before full simulation. */
export function generateMolecularCandidates(base: RosterWorkspace, entries: readonly OwnedOperatorInput[], inventory: OperatorInventory, options: SynthesisOptions = {}): MolecularCandidate[] {
  base = mainPlanOnly(base)
  if (!inventory.valid || !inventory.operators.length) return []
  for (const room of Object.values(base.mainPlan.facilities)) {
    const cap = facilityCapacity(room.type, room.level)
    while (room.slots.length < cap) room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
    room.slots.length = cap
  }
  const pool = buildCombinationPool(base, inventory, options.lockedPositions)
  const allocationOptions = { ...options, enforceRecoveryCapacity: true,
    warmupInventory: options.requireWarmupExhaustion ? inventory : undefined }
  const count = Math.max(1, Math.min(20, Math.floor(options.branchCount ?? 6)))
  const candidates: MolecularCandidate[] = [], seen = new Set<string>(), skeletons = new Set<string>()
  const families = [...new Set(pool.values.filter(v => v.status === 'evaluated').map(v => v.variant.definitionId))]
  const seeds: Array<Array<CombinationVariant | undefined>> = [[undefined], ...families.map(id => combinationAllocationAlternatives(base, pool, id))]
  type Start = MolecularRankingFeatures & { workspace: RosterWorkspace; alternatives: Array<CombinationVariant | undefined> }
  const starts: Start[] = []
  for (const [branch, alternatives] of seeds.entries()) {
    if (!alternatives.length) continue
    const allocation = allocateCombinationSkeleton(base, pool, branch, allocationOptions, alternatives[0])
    const fingerprint = JSON.stringify(allocation.workspace)
    if (skeletons.has(fingerprint)) continue
    skeletons.add(fingerprint)
    const scores = completeShiftScores(allocation.workspace, inventory)
    if (!scores) continue
    starts.push({ order: branch, workspace: allocation.workspace, alternatives: alternatives.slice(1),
      mainScore: scores.main, meanScore: scores.mean, structure: molecularStructure(allocation.workspace) })
  }
  let attempts = 0
  const complete = (source: RosterWorkspace, branch: number): boolean => {
    attempts++
    const ws = finishSkeleton(source, entries, inventory, options)
    if (!ws) return false
    if (options.requireWarmupExhaustion && !applyGeneratedWarmupPolicy(ws, inventory).valid) return false
    // Identical actors can still have different shared rest groups or policies.
    // Deduplicate only the full input that the simulation will receive.
    const fp = JSON.stringify(ws)
    if (seen.has(fp)) return false
    const scores = completeShiftScores(ws, inventory)
    if (!scores) return false
    seen.add(fp)
    const appliedAtoms = appliedMainCombinations(ws, pool)
    candidates.push({ id: branch < 0 ? 'singleton_fallback' : `branch_${branch + 1}`, name: `组合候选 ${branch + 1}: ${appliedAtoms.map(key => ATOMIC_UNITS.find(a => a.id === key)?.name ?? key).join(' + ')}`,
      workspace: ws, appliedAtoms, staticScore: scores.mean, simScore: null,
      diagnostics: [...pool.diagnostics],
      confPolicy: { exhaustRequire: ws.mainPlan.conf.exhaust_require, restInFull: ws.mainPlan.conf.rest_in_full, workaholic: ws.mainPlan.conf.workaholic,
        restingPriorityHigh: ws.mainPlan.conf.ope_resting_priority, restingPriorityLow: ws.mainPlan.conf.resting_priority } })
    return true
  }
  const attemptLimit = count + 2
  const shortlist = selectMolecularShortlist(starts, Math.min(starts.length, attemptLimit), starts.find(start => start.order === 0))
  for (const start of shortlist) {
    if (candidates.length >= count || attempts >= attemptLimit) break
    if (complete(start.workspace, start.order)) continue
    // A different production footprint can rescue a selected family whose
    // highest-ranked footprint consumes too many staff or recovery beds.
    for (const preferred of start.alternatives) {
      if (attempts >= attemptLimit) break
      const allocation = allocateCombinationSkeleton(base, pool, start.order, allocationOptions, preferred)
      const fingerprint = JSON.stringify(allocation.workspace)
      if (skeletons.has(fingerprint)) continue
      skeletons.add(fingerprint)
      if (complete(allocation.workspace, start.order)) break
    }
  }
  if (!candidates.length) {
    // The singleton rescue is independent of the count + 2 skeleton attempts.
    // It adds at most one construction attempt and still returns at most count rosters.
    const fallback = buildSingletonFallback(base, inventory, options.lockedPositions ?? new Set(), {
      requireWarmupExhaustion: options.requireWarmupExhaustion,
    })
    if (fallback) complete(fallback, -1)
  }
  for (const candidate of candidates) candidate.diagnostics.unshift(
    `已评估 ${pool.enumeratedCount} 个组合变体，比较 ${starts.length} 个主替骨架，尝试完成 ${attempts} 案（骨架预算 ${attemptLimit}，全部失败时另试1案散件兜底）；按主班产出、主替均分和结构差异筛选，最终收益由完整模拟比较`)
  return candidates
}
/** Dynamic verification of every distinct physical branch; incomplete is unknown. */
export function evaluateMolecularCandidates(candidates: MolecularCandidate[], entries: readonly OwnedOperatorInput[], options: {
  warmupHours?: number; sampleHours?: number; droneTarget?: 'gold' | 'exp' | 'trading' | 'none'; seed?: number
  onProgress?: (index: number, total: number, bestScore: number) => void
} = {}): MolecularCandidate[] {
  let bestScore = 0
  const inventory = compileOperatorInventory(entries)
  let best: MolecularCandidate | undefined
  for (const [idx, candidate] of candidates.entries()) {
    const response = runScheduleSimulationBridge(candidate.workspace, {
      warmupHours: options.warmupHours ?? 24, sampleHours: options.sampleHours ?? 72, maxStepHours: 0.25,
      productionWeights: normalizeProductionWeights(candidate.workspace.productionWeights),
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: options.droneTarget ?? 'gold', seed: options.seed ?? 42 },
      operatorInventory: [...entries],
    }, { restingThreshold: 0.65, operationDurationHours: 0 })
    const report = response.report
    candidate.simScore = report?.success && report.production?.success && report.production.sample.completed ? scoreSimulationProduction(report).total : null
    if (candidate.simScore === null) {
      if (response.error) candidate.diagnostics.push(response.error)
      candidate.diagnostics.push(...(report?.diagnostics.map(d => `[${d.code}] ${d.message}`) ?? []))
    }
    if (candidate.simScore !== null && (!best || (candidate.simScore - best.simScore! ||
      compareWorkspacePreference(candidate.workspace, best.workspace) || compareProductionEfficiency(candidate.workspace, best.workspace, inventory)) > 0)) {
      best = candidate; bestScore = candidate.simScore
    }
    options.onProgress?.(idx + 1, candidates.length, bestScore)
  }
  return candidates.sort((a, b) => Number(b.simScore !== null) - Number(a.simScore !== null) ||
    (b.simScore ?? -Infinity) - (a.simScore ?? -Infinity) || compareWorkspacePreference(b.workspace, a.workspace) || compareProductionEfficiency(b.workspace, a.workspace, inventory))
}
