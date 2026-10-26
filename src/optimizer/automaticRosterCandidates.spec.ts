import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultWorkspace } from '../workbench/defaults'
import { prepareAutomaticRosterCandidates } from './automaticRosterCandidates'
import type { MolecularCandidate } from './molecularSynthesis'
import * as production from './productionSingletons'
import * as bridge from '../workbench/scheduleSimulationBridge'
import { validatePhysicalRoster } from './rosterDraft'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { preservesFormedCombinations } from './combinationIntegrity'

const entries: OwnedOperatorInput[] = [
  { operator: '芬', elitePhase: 0, level: 1 },
  { operator: '砾', elitePhase: 1, level: 60 },
  { operator: 'Lancet-2', elitePhase: 0, level: 30 },
  { operator: '杜林', elitePhase: 0, level: 30 },
  { operator: '菲亚梅塔', elitePhase: 2, level: 90 },
]
const inventory = compileOperatorInventory(entries)

function candidate(name = 'baseline'): MolecularCandidate {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    room.level = 0; room.slots = []
  }
  const factory = workspace.mainPlan.facilities.room_1_1
  factory.level = 1; factory.type = 'manufacture'; factory.product = 'gold'
  factory.slots = [{ occupant: { kind: 'operator', operatorId: id('芬') }, groupId: null, replacements: [id('砾')] }]
  const power = workspace.mainPlan.facilities.room_1_3
  power.level = 3; power.type = 'power'
  power.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  const dorm = workspace.mainPlan.facilities.dormitory_1
  dorm.level = 1
  dorm.slots = Array.from({ length: 5 }, (_, i) => ({
    occupant: i ? { kind: 'free' as const } : { kind: 'operator' as const, operatorId: id('杜林') },
    groupId: null, replacements: [],
  }))
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  workspace.mainPlan.conf.disable_auto_dorm_keeper = true
  return { id: name, name, workspace, appliedAtoms: [], staticScore: 123, simScore: null, diagnostics: [], confPolicy: {} }
}

afterEach(() => vi.restoreAllMocks())

describe('bounded preparation before automatic roster simulation', () => {
  it('retains the original and adds its higher-output complete shift before any simulation', () => {
    const source = candidate(), before = structuredClone(source)
    expect(validatePhysicalRoster(source.workspace)).toEqual([])
    const simulate = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    const prepared = prepareAutomaticRosterCandidates([source], entries, inventory)
    expect(prepared).toHaveLength(2)
    expect(prepared[0]).toEqual(before)
    expect(source).toEqual(before)
    const alternate = prepared[1]!.workspace
    expect(alternate.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(alternate.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual([id('芬')])
    expect(production.productionWorkspaceHourlyScore(alternate, inventory)!).toBeGreaterThan(production.productionWorkspaceHourlyScore(source.workspace, inventory)!)
    expect(validatePhysicalRoster(alternate)).toEqual([])
    expect(recoveryGroupCapacityIssues(alternate)).toEqual([])
    expect(preservesFormedCombinations(source.workspace, alternate, inventory)).toBe(true)
    expect(simulate).not.toHaveBeenCalled()
    expect(prepared[1]!.simScore).toBeNull()
  })

  it.each(['position', 'primary', 'backup', 'refresh'] as const)('preserves a locked %s instead of forcing an ordering change', kind => {
    const source = candidate()
    if (kind === 'refresh') {
      const slot = source.workspace.mainPlan.facilities.dormitory_1.slots[1]!
      slot.occupant = { kind: 'operator', operatorId: id('菲亚梅塔') }; slot.replacements = [id('芬')]
    }
    const options = kind === 'position' ? { lockedPositions: new Set(['room_1_1:0']) }
      : kind === 'refresh' ? { lockedPositions: new Set(['dormitory_1:1']) }
      : { lockedOperators: new Set([id(kind === 'primary' ? '芬' : '砾')]) }
    expect(prepareAutomaticRosterCandidates([source], entries, inventory, options)).toEqual([source])
  })

  it('updates an unlocked Fiammetta target with the complete shift without changing the source', () => {
    const source = candidate(), slot = source.workspace.mainPlan.facilities.dormitory_1.slots[1]!
    slot.occupant = { kind: 'operator', operatorId: id('菲亚梅塔') }; slot.replacements = [id('芬')]
    const prepared = prepareAutomaticRosterCandidates([source], entries, inventory)
    expect(prepared).toHaveLength(2)
    expect(prepared[1]!.workspace.mainPlan.facilities.dormitory_1.slots[1]!.replacements).toEqual([id('砾')])
    expect(slot.replacements).toEqual([id('芬')])
  })

  it('moves a linked manufacture and trading group together when their individual preferences disagree', () => {
    const source = candidate(), ws = source.workspace, factory = ws.mainPlan.facilities.room_1_1
    factory.level = 3; factory.product = 'exp'
    const low = ['香草', '杰西卡', '克洛丝'], high = ['酒神', '裂响', '机械师']
    factory.slots = low.map((name, i) => ({ occupant: { kind: 'operator', operatorId: id(name) },
      replacements: [id(high[i]!)], groupId: 'linked' }))
    ws.mainPlan.facilities.room_1_2 = { roomId: 'room_1_2', type: 'trading', product: 'money', level: 1,
      slots: [{ occupant: { kind: 'operator', operatorId: id('能天使') }, replacements: [id('梓兰')], groupId: 'linked' }] }
    const names = [...low, ...high, '能天使', '梓兰', 'Lancet-2', '杜林'].map(id)
    const owned = fullCatalogIdleInventory().filter(entry => names.includes(entry.operator)), context = compileOperatorInventory(owned)
    const prepared = prepareAutomaticRosterCandidates([source], owned, context)
    expect(prepared).toHaveLength(2)
    const alternate = prepared[1]!.workspace
    expect(alternate.mainPlan.facilities.room_1_1.slots.map(slot => slot.occupant)).toEqual(high.map(name => ({ kind: 'operator', operatorId: id(name) })))
    expect(alternate.mainPlan.facilities.room_1_2.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('梓兰') })
    expect(alternate.mainPlan.facilities.room_1_1.slots.every(slot => slot.groupId === 'linked')).toBe(true)
    expect(alternate.mainPlan.facilities.room_1_2.slots[0]!.groupId).toBe('linked')
    expect(production.productionWorkspaceHourlyScore(alternate, context)!).toBeGreaterThan(production.productionWorkspaceHourlyScore(ws, context)!)
    expect(validatePhysicalRoster(alternate)).toEqual([])
    expect(recoveryGroupCapacityIssues(alternate)).toEqual([])
    expect(preservesFormedCombinations(ws, alternate, context)).toBe(true)
  })

  it('keeps policy-distinct originals while deduplicating identical full workspaces', () => {
    const first = candidate('first'), duplicate = candidate('duplicate'), policy = candidate('policy')
    policy.workspace.mainPlan.conf.rest_in_full = [id('芬')]
    const prepared = prepareAutomaticRosterCandidates([first, duplicate, policy], entries, inventory, { maxAdditionalCandidates: 0 })
    expect(prepared.map(c => c.id)).toEqual(['first', 'policy'])
    expect(prepared[1]!.workspace.mainPlan.conf.rest_in_full).toEqual([id('芬')])
  })

  it('adds at most two variants by default and never removes an original to meet that budget', () => {
    const sources = [1, 2, 3, 4].map(weight => {
      const source = candidate(`weight-${weight}`)
      source.workspace.productionWeights = { exp: 0, gold: weight, orders: 0, fragments: 0, orundum: 0 }
      return source
    })
    const prepared = prepareAutomaticRosterCandidates(sources, entries, inventory)
    expect(prepared).toHaveLength(6)
    expect(prepared.slice(0, 4)).toEqual(sources)
    expect(prepared.slice(4).map(c => c.workspace.productionWeights?.gold)).toEqual([4, 3])
    expect(prepareAutomaticRosterCandidates(sources, entries, inventory, { maxAdditionalCandidates: 1 })).toHaveLength(5)
  })

  it('does not turn an unquantified hourly projection into a zero-score improvement', () => {
    const source = candidate()
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    expect(prepareAutomaticRosterCandidates([source], entries, inventory)).toEqual([source])
  })

  it('does not borrow Gravel\'s locked higher-stage skill to propose a faster main', () => {
    const source = candidate(), owned = entries.map(entry => entry.operator === '砾' ? { ...entry, elitePhase: 0, level: 1 } : entry)
    expect(prepareAutomaticRosterCandidates([source], owned, compileOperatorInventory(owned))).toEqual([source])
  })

  it('rejects a newly ordered group that cannot fit in its recovery beds', () => {
    const source = candidate(), factory = source.workspace.mainPlan.facilities.room_1_1
    factory.slots[0]!.groupId = 'production'
    for (const slot of source.workspace.mainPlan.facilities.dormitory_1.slots) if (slot.occupant.kind === 'free') slot.occupant = { kind: 'empty' }
    expect(recoveryGroupCapacityIssues(source.workspace)).not.toEqual([])
    expect(prepareAutomaticRosterCandidates([source], entries, inventory)).toEqual([source])
  })
})
