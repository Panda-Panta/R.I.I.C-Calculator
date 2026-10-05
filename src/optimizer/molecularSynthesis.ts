import { mainPlanOnly } from './mainPlanOnly'
import { ensureBuiltDormKeepers } from './dormKeepers'
import { configureRunOrder } from './configureRunOrder'
import type { MowerRoomId, RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { type OperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { ATOMIC_UNITS, type AtomicMember, type AtomicUnit, type AtomicUnitConfPolicy } from './riicAtomicUnits'
import { assignBackups, validatePhysicalRoster } from './rosterDraft'
import { applySmartDormitoryPolicy } from '../scheduler/smartDormitoryPolicy'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreSimulationProduction } from './productionObjective'
import { normalizeProductionWeights } from '../domain/productionWeights'
import { rankStaffingCandidates } from './staffingQuality'
import { buildSingletonFallback } from './singletonFallback'
import { applySingletonWorkPolicy } from './productionSingletons'
import { availableCoreVariants, facilityCapacity } from './combinationModel'
import { buildCombinationPool } from './combinationEvaluation'
import { allocateCombinationSkeleton, appliedMainCombinations, completeShiftScore, normalizeProductionShifts, refineCombinationAllocation } from './combinationAllocation'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { compareWorkspacePreference } from './automaticCombinationPreferences'

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
  contact: 'HIRE', meeting: 'MEETING', factory: 'WORKSHOP', train: 'TRAINING',
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
    applySingletonWorkPolicy(ws, room.roomId, slotIndex)
  }
  const missingBackups = () => Object.values(ws.mainPlan.facilities).filter(r => r.level > 0 && r.type !== 'dormitory')
    .flatMap(room => room.slots.flatMap((slot, slotIndex) => {
      if (slot.occupant.kind !== 'operator' || locked.has(`${room.roomId}:${slotIndex}`) ||
        ws.mainPlan.conf.workaholic.some(ref => resolveId(ref) === resolveId(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : '')) ||
        slot.replacements.some(ref => isOrdinaryReplacementCandidate(ref, room.type))) return []
      return [{ roomId: room.roomId, slotIndex, operatorId: resolveId(slot.occupant.operatorId) }]
    }))
  const completeBackups = () => !assignBackups(ws, inventory, missingBackups(), { excludedOperatorIds: [...options.lockedOperators ?? []] }).missingReplacementIds.length
  if (!completeBackups()) return null
  // Auxiliary stations consume only resources left after both productive shifts.
  for (const room of Object.values(ws.mainPlan.facilities)) {
    if (!room.level || !['meeting', 'contact', 'factory', 'train'].includes(room.type)) continue
    for (const [slotIndex, slot] of room.slots.entries()) {
      if (!['empty', 'free'].includes(slot.occupant.kind) || locked.has(`${room.roomId}:${slotIndex}`)) continue
      const pool = candidates(room.roomId)
      if (pool.length < 2) continue
      const best = rankStaffingCandidates(ws, inventory, { roomId: room.roomId, slotIndex }, pool, 'main')[0]
      if (!best) continue
      const before = structuredClone(slot)
      slot.occupant = { kind: 'operator', operatorId: best }
      const assigned = assignBackups(ws, inventory, [{ roomId: room.roomId, slotIndex, operatorId: best }], { excludedOperatorIds: [...options.lockedOperators ?? []] })
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
/** Enumerate first, allocate both shifts, then recombine the completed rosters. */
export function generateMolecularCandidates(base: RosterWorkspace, entries: readonly OwnedOperatorInput[], inventory: OperatorInventory, options: SynthesisOptions = {}): MolecularCandidate[] {
  base = mainPlanOnly(base)
  if (!inventory.valid || !inventory.operators.length) return []
  for (const room of Object.values(base.mainPlan.facilities)) {
    const cap = facilityCapacity(room.type, room.level)
    while (room.slots.length < cap) room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
    room.slots.length = cap
  }
  const pool = buildCombinationPool(base, inventory)
  const allocationOptions = { ...options, enforceRecoveryCapacity: true }
  const count = Math.max(1, options.branchCount ?? 8)
  const candidates: MolecularCandidate[] = [], seen = new Set<string>(), skeletons = new Set<string>()
  const families = new Set(pool.values.filter(v => v.status === 'evaluated').map(v => v.variant.definitionId))
  const attempts = Math.max(count, families.size + 1)
  for (let branch = 0; branch < attempts && candidates.length < count; branch++) {
    const allocation = allocateCombinationSkeleton(base, pool, branch, allocationOptions)
    const fingerprint = JSON.stringify(allocation.workspace.mainPlan)
    if (skeletons.has(fingerprint)) continue
    skeletons.add(fingerprint)
    const completed = finishSkeleton(allocation.workspace, entries, inventory, options)
    if (!completed) continue
    const refined = refineCombinationAllocation(completed, inventory, pool, allocationOptions)
    const ws = finishSkeleton(refined.workspace, entries, inventory, options)
    if (!ws) continue
    const ordering = normalizeProductionShifts(ws, inventory, options)
    if (!configureRunOrder(ws, inventory) || validatePhysicalRoster(ws).length) continue
    // Group labels alone do not create another physical staffing branch.
    const fp = JSON.stringify(Object.values(ws.mainPlan.facilities).map(room => [room.roomId,
      room.slots.map(slot => [slot.occupant.kind === 'operator' ? resolveId(slot.occupant.operatorId) : '', slot.replacements.map(resolveId)])]))
    if (seen.has(fp)) continue
    seen.add(fp)
    const appliedAtoms = appliedMainCombinations(ws, pool)
    candidates.push({ id: `branch_${branch + 1}`, name: `组合候选 ${branch + 1}: ${appliedAtoms.map(key => ATOMIC_UNITS.find(a => a.id === key)?.name ?? key).join(' + ')}`,
      workspace: ws, appliedAtoms, staticScore: completeShiftScore(ws, inventory) ?? 0, simScore: null,
      diagnostics: [`已汇总并评估 ${pool.enumeratedCount} 个组合变体；主替再组合验证 ${refined.evaluated} 次`, ...pool.diagnostics,
        ...refined.diagnostics.filter(d => !d.includes('替班人均较高')), ...ordering],
      confPolicy: { exhaustRequire: ws.mainPlan.conf.exhaust_require, restInFull: ws.mainPlan.conf.rest_in_full, workaholic: ws.mainPlan.conf.workaholic,
        restingPriorityHigh: ws.mainPlan.conf.ope_resting_priority, restingPriorityLow: ws.mainPlan.conf.resting_priority } })
  }
  if (!candidates.length) {
    const fallback = buildSingletonFallback(base, inventory, options.lockedPositions ?? new Set())
    if (fallback) {
      const refined = refineCombinationAllocation(fallback, inventory, pool, allocationOptions)
      const ws = finishSkeleton(refined.workspace, entries, inventory, options)
      const ordering = ws ? normalizeProductionShifts(ws, inventory, options) : []
      if (ws && configureRunOrder(ws, inventory) && !validatePhysicalRoster(ws).length) candidates.push({ id: 'singleton_fallback', name: '实际技能补位及再组合排班', workspace: ws,
        appliedAtoms: appliedMainCombinations(ws, pool), staticScore: completeShiftScore(ws, inventory) ?? 0, simScore: null,
        diagnostics: [...pool.diagnostics, ...refined.diagnostics.filter(d => !d.includes('替班人均较高')), ...ordering], confPolicy: {} })
    }
  }
  return candidates
}
/** Dynamic verification of every distinct physical branch; incomplete is unknown. */
export function evaluateMolecularCandidates(candidates: MolecularCandidate[], entries: readonly OwnedOperatorInput[], options: {
  warmupHours?: number; sampleHours?: number; droneTarget?: 'gold' | 'exp' | 'trading' | 'none'; seed?: number
  onProgress?: (index: number, total: number, bestScore: number) => void
} = {}): MolecularCandidate[] {
  let bestScore = 0
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
    bestScore = Math.max(bestScore, candidate.simScore ?? 0)
    options.onProgress?.(idx + 1, candidates.length, bestScore)
  }
  return candidates.sort((a, b) => Number(b.simScore !== null) - Number(a.simScore !== null) ||
    compareWorkspacePreference(b.workspace, a.workspace) || (b.simScore ?? -Infinity) - (a.simScore ?? -Infinity))
}
