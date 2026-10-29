import { compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import type { MowerFacility, MowerSlot, RosterWorkspace } from '../domain/roster'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { formedCombinations } from './combinationIntegrity'
import { ATOMIC_UNITS } from './riicAtomicUnits'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import type { MainRosterHybridInput, MainRosterHybridVariable } from './mainRosterHybridTypes'

export interface MainRosterHybridPolicyDecode {
  status: 'ready' | 'rejected' | 'unknown'
  workspace?: RosterWorkspace
  diagnostics: string[]
  gCalls: number
}
export interface MainRosterHybridPolicyBuilder {
  variables: MainRosterHybridVariable[]
  diagnostics: string[]
  gCalls: number
  decode(workspace: RosterWorkspace, vector: readonly number[]): MainRosterHybridPolicyDecode
}
interface Position { room: MowerFacility; index: number; slot: MowerSlot; operatorId: string }
const EPS = 1e-9
const skillRoom: Record<string, string> = { manufacture: 'MANUFACTURE', trading: 'TRADING', central: 'CONTROL', power: 'POWER', contact: 'HIRE', meeting: 'MEETING' }
const positions = (workspace: RosterWorkspace): Position[] => Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
  .flatMap(room => room.slots.flatMap((slot, index) => index < facilityCapacity(room.type, room.level) && slot.occupant.kind === 'operator'
    ? [{ room, index, slot, operatorId: id(slot.occupant.operatorId) }] : []))
const groupIds = (slot: MowerSlot) => [slot.groupId, ...(slot.groupBindings ?? []).map(binding => binding.groupId)]
  .filter((group): group is string => Boolean(group?.trim())).map(group => group.trim())

/** Research-only policies; static target contributions do not predict native F. */
export function buildMainRosterHybridPolicyVariables(input: MainRosterHybridInput, constructions: readonly RosterWorkspace[]): MainRosterHybridPolicyBuilder {
  const inventory = compileOperatorInventory(input.entries), owned = new Map(inventory.operators.map(operator => [operator.charId, operator]))
  const lockedPositions = new Set(input.lockedPositions ?? []), lockedOperators = new Set((input.lockedOperators ?? []).map(id))
  const userGroups = new Set(Object.values(input.userBase.mainPlan.facilities).flatMap(room => room.slots.flatMap(groupIds)))
  const fiaId = id('菲亚梅塔'), variables: MainRosterHybridVariable[] = [], diagnostics: string[] = []
  const userFiaProtected = positions(input.userBase).some(position => position.operatorId === fiaId &&
    (position.slot.replacements.length > 0 || groupIds(position.slot).length > 0))
  const locked = (position: Position) => lockedPositions.has(`${position.room.roomId}:${position.index}`) ||
    [position.operatorId, ...position.slot.replacements.map(id)].some(operator => lockedOperators.has(operator))
  const name = (operatorId: string) => owned.get(operatorId)?.name ?? operatorId

  const detachable = (workspace: RosterWorkspace) => {
    const all = positions(workspace)
    const protectedGroups = new Set(userGroups)
    for (const position of all) if (locked(position) || position.slot.groupBindings?.length) groupIds(position.slot).forEach(group => protectedGroups.add(group))
    const candidates = inventory.valid ? all.filter(position => {
      const { room, slot, operatorId } = position, group = slot.groupId?.trim()
      if (!group || protectedGroups.has(group) || locked(position) || slot.groupBindings?.length ||
        ['dormitory', 'gaming', 'factory', 'train', 'recycle'].includes(room.type) || workspace.mainPlan.conf.workaholic.map(id).includes(operatorId)) return false
      const original = input.userBase.mainPlan.facilities[room.roomId]?.slots[position.index]
      if (original && groupIds(original).length) return false
      const operator = owned.get(operatorId)
      if (!operator?.skills.some(skill => skill.roomType === skillRoom[room.type])) return false
      // Do not split a same-room team, a shared primary replacement, or a group
      // that has no actual independent ordinary relief for this worker.
      if (all.filter(peer => peer.room.roomId === room.roomId && peer.slot.groupId?.trim() === group).length !== 1) return false
      const relief = slot.replacements.map(id).filter(ref => isOrdinaryReplacementCandidate(ref, room.type))
      return relief.length > 0 && !relief.some(ref => !owned.has(ref) || all.some(peer => peer.operatorId === ref))
    }) : []
    return { all, candidates }
  }
  const independentSupports = (workspace: RosterWorkspace): Position[] => {
    const { all, candidates } = detachable(workspace), formed = formedCombinations(workspace, inventory)
    const cores = new Set(formed.flatMap(combination => combination.coreOperatorIds))
    return candidates.filter(position => {
      const { room, operatorId } = position, group = position.slot.groupId!.trim()
      if (cores.has(operatorId)) return false
      return formed.filter(combination => combination.role === 'main').some(combination => {
        const atom = ATOMIC_UNITS.find(unit => unit.id === combination.definitionId)
        const optional = atom?.nonCoreMembers?.some(member => id(member.name) === operatorId && (member.roomType === 'office' ? 'contact' : member.roomType) === room.type)
        return optional && all.some(peer => peer.room.roomId !== room.roomId && peer.slot.groupId?.trim() === group && combination.coreOperatorIds.includes(peer.operatorId))
      })
    })
  }

  type Providers = { positions: Position[]; unknown: boolean; diagnostics: string[] }
  const providerCache = new Map<string, Providers>()
  const globalProviders = (workspace: RosterWorkspace): Providers & { gCalls: number } => {
    const key = JSON.stringify(workspace), cached = providerCache.get(key)
    if (cached) return { ...cached, gCalls: 0 }
    const { candidates } = detachable(workspace), formed = formedCombinations(workspace, inventory)
    // The pinned source contract explicitly requires actual CONTROL duty, not
    // synchronized recovery. Other global-provider skills remain unsupported.
    const potential = candidates.filter(position => position.room.type === 'central' && owned.get(position.operatorId)?.skills.some(skill =>
      skill.roomType === 'CONTROL' && ['control_mp_aegir2[000]', 'control_mp_aegir2[010]'].includes(skill.buffId)) &&
      formed.some(combination => combination.role === 'main' && combination.definitionId === 'abyssal_hunters' && combination.coreOperatorIds.includes(position.operatorId)))
    const result: Providers = { positions: [], unknown: false, diagnostics: [] }; let gCalls = 0
    if (potential.length) {
      try {
        gCalls++; const baseline = productionWorkspaceHourlyScore(workspace, inventory)
        if (baseline === undefined || !Number.isFinite(baseline)) throw new Error('unquantified global-provider baseline')
        for (const provider of potential) {
          const absent = structuredClone(workspace)
          absent.mainPlan.facilities[provider.room.roomId].slots[provider.index]!.occupant = { kind: 'empty' }
          gCalls++; const counterfactual = productionWorkspaceHourlyScore(absent, inventory)
          if (counterfactual === undefined || !Number.isFinite(counterfactual)) throw new Error(`unquantified global provider ${name(provider.operatorId)}`)
          // Suppressed/absent production recipients do not justify this option.
          if (baseline - counterfactual > EPS) result.positions.push(provider)
        }
      } catch (error) {
        result.unknown = true; result.positions = []
        result.diagnostics.push('Global-provider policy is unknown / 无法量化: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    providerCache.set(key, result); return { ...result, gCalls }
  }

  const fiam = (workspace: RosterWorkspace) => {
    if (!inventory.valid || userFiaProtected || lockedOperators.has(fiaId) || !owned.get(fiaId)?.skills.some(skill => skill.buffId.startsWith('dorm_exchangeAp['))) return undefined
    const all = positions(workspace), residents = all.filter(position => position.operatorId === fiaId)
    if (residents.length !== 1) return undefined
    const resident = residents[0]!
    if (resident.room.type !== 'dormitory' || locked(resident) || resident.slot.groupBindings?.length) return undefined
    const permanent = new Set(workspace.mainPlan.conf.workaholic.map(id))
    const targets = all.filter(position => !['dormitory', 'gaming', 'factory', 'train'].includes(position.room.type) &&
      position.operatorId !== fiaId && owned.has(position.operatorId) && !permanent.has(position.operatorId))
    const unique = [...new Map(targets.map(position => [position.operatorId, position])).values()]
    const limit = Math.min(3, unique.length, Math.max(1, resident.slot.replacements.length || 3))
    return limit ? { resident, targets: unique, limit } : undefined
  }

  if (!inventory.valid) diagnostics.push('Actual inventory is invalid; optional policies are not applicable: ' + inventory.diagnostics.map(issue => issue.code).join(', '))
  const restOptions = [{ id: 'keep', label: 'Preserve exact groups' }]
  if (constructions.some(workspace => independentSupports(workspace).length)) restOptions.push({ id: 'independent-support', label: 'Independent optional cross-room support' })
  const providers = constructions.map(globalProviders), initializationGCalls = providers.reduce((sum, value) => sum + value.gCalls, 0)
  diagnostics.push(...providers.flatMap(value => value.diagnostics))
  if (providers.some(value => value.positions.length)) restOptions.push({ id: 'independent-global-provider', label: 'Independent verified cross-room global provider' })
  if (restOptions.length > 1) variables.push({ id: 'independent-global-rest', family: 'rest-policy', options: restOptions })
  const fiamConstructions = constructions.flatMap(workspace => { const value = fiam(workspace); return value ? [value] : [] })
  if (fiamConstructions.length) {
    const options = [{ id: 'keep', label: 'Preserve exact target order' }, { id: 'global-marginal', label: 'Whole-base marginal G targets' }]
    if (fiamConstructions.some(value => value.limit >= 2)) options.push({ id: 'global-marginal-reverse', label: 'Reverse marginal target order' })
    if (fiamConstructions.some(value => value.limit >= 3)) options.push({ id: 'global-marginal-rotate', label: 'Rotate marginal target order' })
    variables.push({ id: 'fiammetta-target-order', family: 'fiammetta-policy', options })
  }
  diagnostics.push('Policy 0 is exact identity; rest and charge-order alternatives require native F and remain independent of static-G optimality.')
  type Ranked = { status: 'ready' | 'unknown'; targets?: string[]; diagnostics: string[] }
  const rankings = new Map<string, Ranked>()
  const rank = (workspace: RosterWorkspace, policy: NonNullable<ReturnType<typeof fiam>>): Ranked & { gCalls: number } => {
    const key = JSON.stringify(workspace), cached = rankings.get(key)
    if (cached) return { ...cached, gCalls: 0 }
    let calls = 0
    const unknown = (message: string): Ranked & { gCalls: number } => {
      const result: Ranked = { status: 'unknown', diagnostics: [message] }; rankings.set(key, result); return { ...result, gCalls: calls }
    }
    try {
      calls++; const base = productionWorkspaceHourlyScore(workspace, inventory)
      if (base === undefined || !Number.isFinite(base)) return unknown('Fiam global contribution baseline is unknown / 无法量化。')
      const rows: { operatorId: string; value: number }[] = []
      for (const target of policy.targets) {
        const counterfactual = structuredClone(workspace)
        counterfactual.mainPlan.facilities[target.room.roomId].slots[target.index]!.occupant = { kind: 'empty' }
        calls++; const value = productionWorkspaceHourlyScore(counterfactual, inventory)
        if (value === undefined || !Number.isFinite(value)) return unknown(`Fiam global contribution for ${name(target.operatorId)} is unknown / 无法量化。`)
        rows.push({ operatorId: target.operatorId, value: base - value })
      }
      rows.sort((a, b) => Math.abs(b.value - a.value) > EPS ? b.value - a.value : a.operatorId.localeCompare(b.operatorId))
      const result: Ranked = { status: 'ready', targets: rows.slice(0, policy.limit).map(row => row.operatorId),
        diagnostics: ['Fiam ranks counterfactual whole-base primary G; this is not a charge gain or F prediction.'] }
      rankings.set(key, result); return { ...result, gCalls: calls }
    } catch (error) { return unknown('Fiam global contribution is unknown / 无法量化: ' + (error instanceof Error ? error.message : String(error))) }
  }

  return { variables, diagnostics, gCalls: initializationGCalls, decode: (workspace, vector) => {
    const rejected = (message: string, gCalls = 0): MainRosterHybridPolicyDecode => ({ status: 'rejected', diagnostics: [message], gCalls })
    if (vector.length !== variables.length || vector.some((value, index) => !Number.isInteger(value) || value < 0 || value >= variables[index]!.options.length)) return rejected('Policy vector is outside the declared domains.')
    if (vector.every(value => value === 0)) return { status: 'ready', workspace, diagnostics: [], gCalls: 0 }
    if (!inventory.valid) return { status: 'unknown', diagnostics: ['Actual inventory cannot be quantified for optional policies.'], gCalls: 0 }
    const draft = structuredClone(workspace), messages: string[] = []; let gCalls = 0
    for (const [index, value] of vector.entries()) {
      if (!value) continue
      const variable = variables[index]!, option = variable.options[value]!.id
      if (variable.family === 'rest-policy') {
        const selected = option === 'independent-global-provider' ? globalProviders(draft) : { positions: independentSupports(draft), unknown: false, diagnostics: [], gCalls: 0 }
        gCalls += selected.gCalls
        if (selected.unknown) return { status: 'unknown', diagnostics: selected.diagnostics, gCalls }
        const supports = selected.positions
        if (!supports.length) return rejected('Independent rest policy is not applicable to this construction.', gCalls)
        for (const support of supports) draft.mainPlan.facilities[support.room.roomId].slots[support.index]!.groupId = null
        messages.push((option === 'independent-global-provider' ? 'Independent verified global providers: ' : 'Independent optional supports: ') + supports.map(support => name(support.operatorId)).join(', '))
      } else {
        const policy = fiam(draft)
        if (!policy || option === 'global-marginal-reverse' && policy.limit < 2 || option === 'global-marginal-rotate' && policy.limit < 3) return rejected('Fiam target policy is not applicable to this construction.')
        const ranked = rank(draft, policy); gCalls += ranked.gCalls
        if (ranked.status === 'unknown') return { status: 'unknown', diagnostics: [...messages, ...ranked.diagnostics], gCalls }
        let targets = [...ranked.targets!]
        if (option === 'global-marginal-reverse') targets.reverse()
        if (option === 'global-marginal-rotate') targets = [...targets.slice(1), targets[0]!]
        draft.mainPlan.facilities[policy.resident.room.roomId].slots[policy.resident.index]!.replacements = targets
        messages.push(...ranked.diagnostics)
      }
    }
    return { status: 'ready', workspace: draft, diagnostics: messages, gCalls }
  } }
}
