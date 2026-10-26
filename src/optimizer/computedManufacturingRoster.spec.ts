import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { validatePhysicalRoster } from './rosterDraft'
import { computeManufacturingRoster } from './computedManufacturingRoster'

function fixture() {
  const initial = createDefaultWorkspace()
  for (const room of Object.values(initial.mainPlan.facilities)) room.slots = []
  initial.mainPlan.facilities.dormitory_1.slots = [
    { occupant: { kind: 'operator', operatorId: id('闪灵') }, replacements: [], groupId: null },
    ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, replacements: [], groupId: null })),
  ]
  const userBase = structuredClone(initial)
  initial.mainPlan.facilities.room_3_2 = { roomId: 'room_3_2', type: 'manufacture', product: 'gold', level: 1,
    slots: [{ occupant: { kind: 'operator', operatorId: id('香草') }, replacements: [id('斑点')], groupId: 'crew', metadata: { preserved: true } }] }
  const wanted = new Set(['香草', '斑点', '砾', '夜烟', '闪灵'].map(id))
  const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => wanted.has(entry.operator)))
  return { initial, userBase, inventory, lockedPositions: new Set<string>(), lockedOperators: new Set<string>() }
}

describe('calculated manufacturing allocation integration', () => {
  it('calculates a physically valid improvement without enumerating whole rosters or mutating the source', () => {
    const input = fixture(), before = structuredClone(input)
    const result = computeManufacturingRoster(input)
    expect(result.calculation.status, JSON.stringify(result.diagnostics)).toBe('complete')
    expect(result.calculation.libraryComplete).toBe(true)
    expect(result.calculation.assignment?.status).toBe('optimal')
    expect(result.calculation.assignment?.objective).toBeGreaterThan(result.calculation.initialObjective!)
    expect(result.workspace).not.toBeNull()
    expect(validatePhysicalRoster(result.workspace!)).toEqual([])
    expect(result.workspace!.mainPlan.facilities.room_3_2.slots[0]!.metadata).toEqual({ preserved: true })
    expect(input).toEqual(before)
    expect(result.calculation.proofScope).toBe('quantified-manufacturing-model-only')
  })

  it('keeps a complete initial assignment when enumeration is interrupted and does not claim full-domain optimality', () => {
    const input = fixture()
    const result = computeManufacturingRoster(input, { enumeration: { maxColumns: 2 } })
    expect(result.calculation.status).toBe('limited')
    expect(result.calculation.libraryComplete).toBe(false)
    expect(result.calculation.assignment?.feasible).toBe(true)
    expect(result.workspace).toBeNull()
    expect(result.diagnostics.some(d => d.code === 'CREW_LIBRARY_LIMIT')).toBe(true)
  })

  it('returns no unevaluated assignment on a valuation deadline and retains the requested sampling window', () => {
    const input = fixture()
    const result = computeManufacturingRoster(input, { warmupHours: 6, sampleHours: 18, valuation: { timeLimitMs: 0 } })
    expect(result.workspace).toBeNull()
    expect(result.calculation.status).toBe('limited')
    expect(result.calculation.quantifiedColumnCount).toBe(0)
    expect(result.calculation.assignment).toBeUndefined()
    expect(result.calculation.valuation?.window).toMatchObject({ warmupHours: 6, sampleHours: 18 })
  })

  it('reports a partial initial prefix as a budget stop rather than an invalid initial assignment', () => {
    const result = computeManufacturingRoster(fixture(), { enumeration: { maxColumns: 1 } })
    expect(result.workspace).toBeNull()
    expect(result.calculation.status).toBe('limited')
    expect(result.calculation.screening).toMatchObject({ complete: true, feasible: false, retainedColumns: 0 })
    expect(result.calculation.valuation).toBeUndefined()
    expect(result.diagnostics.some(d => d.code === 'CREW_CALCULATION_FAILED')).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'CREW_LIBRARY_LIMIT')).toBe(true)
  })

  it('preserves a locked complete group without suggesting a different assignment', () => {
    const input = fixture()
    input.userBase = structuredClone(input.initial)
    input.lockedPositions.add('room_3_2:0')
    const result = computeManufacturingRoster(input)
    expect(result.workspace).toBeNull()
    expect(result.calculation.status).toBe('unsupported')
    expect(result.calculation.frozenComponents.some(block => block.reason === 'user-lock')).toBe(true)
  })
})
