import type { OperatorInventory, OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import type { RosterWorkspace } from '../domain/roster'
import { isTradeRunOrderOperator } from '../domain/shiftRunPolicy'
import type { MolecularCandidate } from './molecularSynthesis'
import { completeShiftScore, normalizeProductionShifts, type AllocationLocks } from './combinationAllocation'
import { physicalBackupOperatorIds } from './combinationModel'
import { preservesFormedCombinations } from './combinationIntegrity'
import { configureRunOrder } from './configureRunOrder'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

export interface AutomaticRosterCandidateOptions extends AllocationLocks {
  droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
  /** Extra full simulations admitted after the original candidates; zero disables preparation. */
  maxAdditionalCandidates?: number
}

function preservesLockedStaffing(before: RosterWorkspace, after: RosterWorkspace, locks: AllocationLocks): boolean {
  const slotAt = (workspace: RosterWorkspace, position: string) => {
    const [roomId, index] = position.split(':')
    const room = Object.values(workspace.mainPlan.facilities).find(room => room.roomId === roomId)
    const slot = room?.slots[Number(index)]
    // Dedicated ideal runners are selected independently of physical locked staff.
    return room?.type === 'trading' && slot
      ? { ...slot, replacements: slot.replacements.filter(ref => !isTradeRunOrderOperator(ref)) }
      : slot
  }
  if ([...locks.lockedPositions ?? []].some(position =>
    JSON.stringify(slotAt(before, position)) !== JSON.stringify(slotAt(after, position)))) return false
  const positionsOf = (workspace: RosterWorkspace, operator: string) => Object.values(workspace.mainPlan.facilities).flatMap(room =>
    room.slots.flatMap((slot, index) => [
      ...(slot.occupant.kind === 'operator' && resolveId(slot.occupant.operatorId) === operator ? [`${room.roomId}:${index}:main`] : []),
      ...(physicalBackupOperatorIds(room, slot).includes(operator) ? [`${room.roomId}:${index}:backup`] : []),
    ]))
  return [...locks.lockedOperators ?? []].every(operator =>
    JSON.stringify(positionsOf(before, operator)) === JSON.stringify(positionsOf(after, operator)))
}

/**
 * Keep every original, then spend a small extra simulation budget on complete-shift
 * alternatives. Static output only proposes candidates: it never replaces the
 * original's finite-window simulation or claims a daily-income improvement.
 */
export function prepareAutomaticRosterCandidates(
  candidates: readonly MolecularCandidate[],
  entries: readonly OwnedOperatorInput[],
  inventory: OperatorInventory,
  options: AutomaticRosterCandidateOptions = {},
): MolecularCandidate[] {
  const additionalBudget = options.maxAdditionalCandidates ?? 2
  if (!Number.isSafeInteger(additionalBudget) || additionalBudget < 0 || additionalBudget > 10) {
    throw new Error('额外静态候选预算须为 0–10 的整数')
  }
  // Keep policy, grouping, facilities and nested traversal order in the key, just
  // as the simulation does. Equal occupants alone do not mean equal schedules.
  const seen = new Set<string>(), originals: MolecularCandidate[] = []
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.workspace)
    if (seen.has(key)) continue
    seen.add(key)
    originals.push(structuredClone(candidate))
  }
  if (!additionalBudget || !inventory.valid || !entries.length) return originals
  const locks: AllocationLocks = {
    lockedPositions: options.lockedPositions,
    lockedOperators: new Set([...options.lockedOperators ?? []].map(resolveId)),
    requireWarmupExhaustion: options.requireWarmupExhaustion,
    warmupInventory: options.requireWarmupExhaustion ? inventory : undefined,
  }
  const alternatives: Array<{ candidate: MolecularCandidate; gain: number; sourceIndex: number }> = []
  for (const [sourceIndex, original] of originals.entries()) {
    const baseline = productionWorkspaceHourlyScore(original.workspace, inventory)
    if (baseline === undefined || !Number.isFinite(baseline)) continue
    const workspace = structuredClone(original.workspace)
    const ordering = normalizeProductionShifts(workspace, inventory, locks, 'hourly-output')
    if (JSON.stringify(workspace) === JSON.stringify(original.workspace) || !configureRunOrder(workspace, inventory)) continue
    if (workspace.compatibility.backupPlans.length || validatePhysicalRoster(workspace).length || recoveryGroupCapacityIssues(workspace).length ||
      !preservesLockedStaffing(original.workspace, workspace, locks) || !preservesFormedCombinations(original.workspace, workspace, inventory)) continue
    const hourly = productionWorkspaceHourlyScore(workspace, inventory)
    const staticScore = completeShiftScore(workspace, inventory)
    if (hourly === undefined || staticScore === undefined || !Number.isFinite(hourly) || !Number.isFinite(staticScore) || hourly <= baseline + 1e-7) continue
    const key = JSON.stringify(workspace)
    if (seen.has(key)) continue
    seen.add(key)
    alternatives.push({ sourceIndex, gain: hourly - baseline, candidate: {
      ...structuredClone(original),
      id: `${original.id}:hourly-${sourceIndex + 1}`,
      name: `${original.name}（完整主替产出备选）`,
      workspace, staticScore, simScore: null,
      diagnostics: [...original.diagnostics, ...ordering, '完整主替按每小时加权产出生成备选，保留原案并由完整模拟比较日均产出。'],
      confPolicy: {
        exhaustRequire: [...workspace.mainPlan.conf.exhaust_require],
        restInFull: [...workspace.mainPlan.conf.rest_in_full],
        workaholic: [...workspace.mainPlan.conf.workaholic],
        restingPriorityHigh: [...workspace.mainPlan.conf.ope_resting_priority],
        restingPriorityLow: [...workspace.mainPlan.conf.resting_priority],
      },
    } })
  }
  alternatives.sort((a, b) => b.gain - a.gain || a.sourceIndex - b.sourceIndex)
  return [...originals, ...alternatives.slice(0, additionalBudget).map(value => value.candidate)]
}
