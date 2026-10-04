import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { generatePrimaryBackupNeighbors } from './primaryBackupNeighborhood'
import { productionTeamTheory } from './productionSingletons'
import { validatePhysicalRoster } from './rosterDraft'
import { runRosterIncomeSearch } from './rosterIncomeSearch'

const mainNames = ['多萝西', '白面鸮']
const backupNames = ['苍苔', '香草']
const maximumInventory = fullCatalogIdleInventory()

function entries(lowNames = [...mainNames, ...backupNames]): OwnedOperatorInput[] {
  return [...mainNames, ...backupNames].map(operator => lowNames.includes(operator)
    ? { operator, elitePhase: 0, level: 1 }
    : { ...maximumInventory.find(entry => entry.operator === id(operator))!, operator })
}

function groupedManufacture() {
  const workspace = createDefaultWorkspace()
  for (const [index, operator] of mainNames.entries()) {
    workspace.mainPlan.facilities.room_1_1.slots[index] = {
      occupant: { kind: 'operator', operatorId: id(operator) },
      groupId: '莱茵制造组',
      replacements: [id(backupNames[index]!)],
    }
  }
  return workspace
}

describe('actual-stage complete primary and backup reversal', () => {
  it.each([
    { stage: 'main', lowNames: mainNames },
    { stage: 'backup', lowNames: backupNames },
    { stage: 'both', lowNames: [...mainNames, ...backupNames] },
  ])('admits an entire group with unlocked non-maximum skills on the $stage side', ({ lowNames }) => {
    const workspace = groupedManufacture(), before = structuredClone(workspace)
    const inventoryEntries = entries(lowNames), inventory = compileOperatorInventory(inventoryEntries)
    expect(inventory.valid).toBe(true)
    expect(inventory.operators.some(operator => !operator.matchesMaximumSkills)).toBe(true)

    const neighbors = generatePrimaryBackupNeighbors(workspace, inventoryEntries)
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0]!.move.positions).toEqual(['room_1_1_0', 'room_1_1_1'])
    expect(neighbors[0]!.workspace.mainPlan.facilities.room_1_1.slots.slice(0, 2)).toEqual([
      { occupant: { kind: 'operator', operatorId: id('苍苔') }, groupId: '莱茵制造组', replacements: [id('多萝西')] },
      { occupant: { kind: 'operator', operatorId: id('香草') }, groupId: '莱茵制造组', replacements: [id('白面鸮')] },
    ])
    expect(validatePhysicalRoster(neighbors[0]!.workspace)).toEqual([])
    expect(workspace).toEqual(before)
  })

  it('evaluates the reversed team using unlocked skills instead of its higher-stage synergy', () => {
    const workspace = groupedManufacture(), inventoryEntries = entries()
    const inventory = compileOperatorInventory(inventoryEntries)
    const neighbor = generatePrimaryBackupNeighbors(workspace, inventoryEntries)[0]!
    // E0 Dorothy contributes 5% beside E0 Ptilopsis (15%); E0 Bryophyta + Vanilla contributes 30% + 25%.
    expect(productionTeamTheory(workspace, inventory, 'room_1_1')).toBe(20)
    expect(productionTeamTheory(neighbor.workspace, inventory, 'room_1_1')).toBe(55)
  })

  it('reverses linked rooms together instead of admitting only the eligible portion', () => {
    const workspace = groupedManufacture()
    workspace.mainPlan.facilities.room_1_2.slots[0] = workspace.mainPlan.facilities.room_1_1.slots[1]!
    workspace.mainPlan.facilities.room_1_1.slots[1] = { occupant: { kind: 'empty' }, groupId: null, replacements: [] }
    const neighbors = generatePrimaryBackupNeighbors(workspace, entries())
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0]!.move.positions).toEqual(['room_1_1_0', 'room_1_2_0'])
    expect(neighbors[0]!.workspace.mainPlan.facilities.room_1_2.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('香草') })
    expect(generatePrimaryBackupNeighbors(workspace, entries(), 20, { lockedPositions: ['room_1_2:0'] })).toEqual([])
  })

  it('rejects the entire group when a replacement has no unlocked facility skill', () => {
    const workspace = groupedManufacture()
    workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements = [id('淬羽赫默')]
    expect(generatePrimaryBackupNeighbors(workspace, [
      ...entries().filter(entry => entry.operator !== '香草'),
      { operator: '淬羽赫默', elitePhase: 0, level: 1 },
    ])).toEqual([])
  })

  it('keeps locked and explicitly protected members out of whole-group reversal', () => {
    const workspace = groupedManufacture()
    expect(generatePrimaryBackupNeighbors(workspace, entries(), 20, { lockedPositions: ['room_1_1:0'] })).toEqual([])
    expect(generatePrimaryBackupNeighbors(workspace, entries(), 20, { protectedIds: ['白面鸮'] })).toEqual([])
  })

  it.each([
    { sampleHours: 1, status: 'unchanged' },
    { sampleHours: 6, status: 'improved' },
  ])('uses complete four-scenario gains to accept or retain a low-stage reversal ($sampleHours hours)', ({ sampleHours, status }) => {
    const workspace = groupedManufacture(), before = structuredClone(workspace)
    const result = runRosterIncomeSearch({
      baseline: workspace, inventory: entries(), mode: 'hill-climb', objective: 'composite',
      includeProductionMains: true, maxCandidates: 2, maxDepth: 3,
      options: { warmupHours: 0, sampleHours, production: { seed: 42, droneTarget: 'none' } },
    })
    expect(result.candidates).toHaveLength(2)
    const candidate = result.candidates[1]!
    expect(candidate.move?.kind).toBe('primary-backup')
    expect(candidate.cases).toHaveLength(4)
    expect(candidate.cases.every(testCase => testCase.eligible)).toBe(true)
    expect(candidate.comparison?.status).toBe(status)
    if (status === 'improved') expect(result.bestCandidateId).toBe(candidate.id)
    else {
      expect(result.bestCandidateId).toBeNull()
      expect(result.bestWorkspace).toEqual(before)
    }
    expect(workspace).toEqual(before)
  })
})
