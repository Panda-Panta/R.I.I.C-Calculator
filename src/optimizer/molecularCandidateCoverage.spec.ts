import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as bridge from '../workbench/scheduleSimulationBridge'
import * as scoring from '../simulator/productionScore'
import { evaluateMolecularCandidates, generateMolecularCandidates, selectMolecularShortlist, type MolecularCandidate } from './molecularSynthesis'
import { validatePhysicalRoster } from './rosterDraft'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import * as allocation from './combinationAllocation'

afterEach(() => vi.restoreAllMocks())

describe('automatic candidate coverage and completed production ranking', () => {
  it('retains primary-output and balanced-output leaders alongside a structurally different team', () => {
    const anchor = { order: 0, mainScore: 70, meanScore: 70, structure: new Set(['shared']) }
    const primary = { order: 9, mainScore: 150, meanScore: 60, structure: new Set(['shared', 'primary']) }
    const balanced = { order: 1, mainScore: 90, meanScore: 110, structure: new Set(['shared', 'balanced']) }
    const different = { order: 8, mainScore: 85, meanScore: 90, structure: new Set(['other-team']) }
    const similar = Array.from({ length: 6 }, (_, index) => ({
      order: index + 2, mainScore: 80, meanScore: 100 - index, structure: new Set(['shared', 'balanced']),
    }))
    const starts = [anchor, balanced, ...similar, different, primary]
    const selected = selectMolecularShortlist(starts, 6, anchor)
    expect(selected).toHaveLength(6)
    expect(new Set(selected).size).toBe(6)
    expect(selected).toEqual(expect.arrayContaining([anchor, primary, balanced, different]))
    expect(selectMolecularShortlist(starts, 6, anchor)).toEqual(selected)
    expect(starts).toEqual([anchor, balanced, ...similar, different, primary])
  })

  it('completes bounded diverse candidates while preserving locked seats, recovery capacity and the input', async ({ annotate }) => {
    await annotate('真实组合生成：固定工位、主替完整、恢复容量、有界候选和无逐支精修')
    const workspace = createDefaultWorkspace(), entries = fullCatalogIdleInventory(), inventory = compileOperatorInventory(entries)
    for (const room of Object.values(workspace.mainPlan.facilities)) {
      if (!['room_1_1', 'room_1_3', 'room_2_3', 'central', 'dormitory_1'].includes(room.roomId)) {
        room.level = 0; room.slots = []
      }
    }
    const locked = workspace.mainPlan.facilities.room_1_1.slots[0]!
    locked.occupant = { kind: 'operator', operatorId: id('苍苔') }
    const before = structuredClone(workspace), refine = vi.spyOn(allocation, 'refineCombinationAllocation')
    const result = generateMolecularCandidates(workspace, entries, inventory, {
      branchCount: 3, lockedPositions: new Set(['room_1_1:0']), lockedOperators: new Set([id('苍苔')]),
    })
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(3)
    expect(result.every(candidate => validatePhysicalRoster(candidate.workspace).length === 0)).toBe(true)
    expect(result.every(candidate => recoveryGroupCapacityIssues(candidate.workspace).length === 0)).toBe(true)
    expect(result.every(candidate => JSON.stringify(candidate.workspace.mainPlan.facilities.room_1_1.slots[0]) === JSON.stringify(locked))).toBe(true)
    expect(new Set(result.map(candidate => candidate.id)).size).toBe(result.length)
    expect(new Set(result.map(candidate => JSON.stringify(candidate.workspace))).size).toBe(result.length)
    expect(refine).not.toHaveBeenCalled()
    expect(workspace).toEqual(before)
  }, 30000)

  it('ranks completed simulations by weighted daily production before a preferred static system', () => {
    const preferred = createDefaultWorkspace(), productive = createDefaultWorkspace()
    preferred.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('迷迭香') }
    preferred.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'operator', operatorId: id('絮雨') }
    const report = { success: true, production: { success: true, sample: { completed: true } }, diagnostics: [] }
    vi.spyOn(bridge, 'runScheduleSimulationBridge').mockReturnValue({ report } as unknown as ReturnType<typeof bridge.runScheduleSimulationBridge>)
    vi.spyOn(scoring, 'scoreSimulationProduction').mockReturnValueOnce({ total: 10 } as ReturnType<typeof scoring.scoreSimulationProduction>)
      .mockReturnValueOnce({ total: 20 } as ReturnType<typeof scoring.scoreSimulationProduction>)
    const candidate = (candidateId: string, workspace: typeof preferred): MolecularCandidate => ({
      id: candidateId, name: candidateId, workspace, appliedAtoms: [], staticScore: 0, simScore: null, diagnostics: [], confPolicy: {},
    })
    const progress: number[] = []
    const result = evaluateMolecularCandidates([candidate('preferred', preferred), candidate('productive', productive)], fullCatalogIdleInventory(), {
      onProgress: (_index, _total, score) => progress.push(score),
    })
    expect(result.map(value => value.id)).toEqual(['productive', 'preferred'])
    expect(progress).toEqual([10, 20])
  })

})
