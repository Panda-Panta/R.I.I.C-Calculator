import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import * as output from './productionSingletons'
import { selectHighOutputMainCandidates } from './mainRosterSelection'

afterEach(() => vi.restoreAllMocks())

function linkedScene() {
  const anchor = createDefaultWorkspace()
  for (const room of Object.values(anchor.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const production = anchor.mainPlan.facilities.room_1_1
  production.level = 1; production.type = 'manufacture'; production.product = 'gold'
  production.slots = [{ occupant: { kind: 'operator', operatorId: id('砾') }, groupId: null, replacements: [id('夜烟')] }]
  const power = anchor.mainPlan.facilities.room_1_3
  power.level = 3; power.type = 'power'
  power.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  anchor.mainPlan.conf.workaholic = [id('Lancet-2')]
  const central = anchor.mainPlan.facilities.central
  central.level = 5
  central.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'empty' as const }, groupId: null, replacements: [] }))
  central.slots[0] = { occupant: { kind: 'operator', operatorId: id('临光') }, groupId: null, replacements: [] } as typeof central.slots[number]
  const dorm = anchor.mainPlan.facilities.dormitory_1
  dorm.level = 1
  dorm.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  dorm.slots[0] = { occupant: { kind: 'operator', operatorId: id('薇薇安娜') }, groupId: null, replacements: [] } as typeof dorm.slots[number]
  const stronger = structuredClone(anchor)
  // Official-name aliases and catalog IDs identify the same actually owned actor.
  stronger.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: '砾' }
  stronger.mainPlan.facilities.central.slots[0]!.occupant = { kind: 'operator', operatorId: id('薇薇安娜') }
  stronger.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('临光') }
  const inventory = compileOperatorInventory([
    { operator: '砾', elitePhase: 2, level: 70 }, { operator: '夜烟', elitePhase: 2, level: 70 },
    { operator: '薇薇安娜', elitePhase: 2, level: 90 }, { operator: '临光', elitePhase: 2, level: 80 },
    { operator: 'Lancet-2', elitePhase: 0, level: 30 },
  ])
  expect(inventory.valid).toBe(true)
  return { anchor, stronger, inventory, candidates: [
    { id: 'safe', workspace: anchor, extra: { marker: 'preserve-me' } },
    { id: 'linked', workspace: stronger, extra: { marker: 'preserve-me-too' } },
  ] }
}

describe('selecting high-output primary rosters', () => {
  it('defers a non-improving main when explicitly budgeting for successful-anchor fast return', () => {
    const scene = linkedScene(), pool = [scene.candidates[1]!, scene.candidates[0]!]
    const result = selectHighOutputMainCandidates(pool, scene.inventory, { deferNonImproving: true })
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['linked'])
    expect(result.deferredCandidate).toBe(scene.candidates[0])
    const stronger = selectHighOutputMainCandidates(scene.candidates, scene.inventory, { deferNonImproving: true })
    expect(stronger.candidates.map(candidate => candidate.id)).toEqual(['linked', 'safe'])
    expect(stronger.deferredCandidate).toBeUndefined()
  })

  it('uses actual global primary support to select a stronger main and retain the safe anchor', () => {
    const scene = linkedScene(), before = JSON.stringify(scene.candidates)
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory)
    expect(result.candidates.map(row => row.id)).toEqual(['linked', 'safe'])
    expect(result.candidates[0]).toBe(scene.candidates[1])
    expect(result.candidates[0]!.extra).toEqual({ marker: 'preserve-me-too' })
    const score = (id: string) => result.scores.find(row => row.id === id)!.primaryHourlyScore!
    // Vivi E2 grants Gravel +7 production points: 10000 LMD/day * .8 * .07.
    expect((score('linked') - score('safe')) * 24).toBeCloseTo(560, 7)
    expect(JSON.stringify(scene.candidates)).toBe(before)
  })

  it.each([
    { limit: 0, ids: [] }, { limit: 1, ids: ['linked'] }, { limit: 99, ids: ['linked', 'safe'] },
  ])('respects a requested budget of $limit without exceeding two', ({ limit, ids }) => {
    const scene = linkedScene(), score = vi.spyOn(output, 'productionWorkspaceHourlyScore')
    const pool = [...scene.candidates, { id: 'extra', workspace: structuredClone(scene.stronger), extra: { marker: 'third' } }]
    const result = selectHighOutputMainCandidates(pool, scene.inventory, { maxCandidates: limit })
    expect(result.candidates.map(row => row.id)).toEqual(ids)
    if (limit === 0) expect(score).not.toHaveBeenCalled()
    if (limit > 2) expect(result.diagnostics.some(row => row.code === 'MAIN_SELECTION_LIMIT_CLAMPED')).toBe(true)
  })

  it('keeps a next-best candidate when the strongest main is the anchor, allowing F failure recovery', () => {
    const scene = linkedScene(), pool = [scene.candidates[1]!, scene.candidates[0]!]
    const result = selectHighOutputMainCandidates(pool, scene.inventory)
    expect(result.candidates.map(row => row.id)).toEqual(['linked', 'safe'])
  })

  it('prefers the named anchor on a main-score tie and retains another candidate', () => {
    const scene = linkedScene()
    const pool = [{ id: 'first', workspace: scene.stronger }, { id: 'named-anchor', workspace: structuredClone(scene.stronger) }, { id: 'weaker', workspace: scene.anchor }]
    const result = selectHighOutputMainCandidates(pool, scene.inventory, { anchorId: 'named-anchor' })
    expect(result.candidates.map(row => row.id)).toEqual(['named-anchor', 'first'])
  })

  it('retains an explicit weaker anchor instead of treating the first row as the anchor', () => {
    const scene = linkedScene()
    const pool = [{ id: 'first', workspace: scene.stronger }, { id: 'other', workspace: structuredClone(scene.stronger) }, { id: 'named-anchor', workspace: scene.anchor }]
    const result = selectHighOutputMainCandidates(pool, scene.inventory, { anchorId: 'named-anchor' })
    expect(result.candidates.map(row => row.id)).toEqual(['first', 'named-anchor'])
  })

  it.each([undefined, NaN, Infinity, -Infinity])('keeps an unavailable score %s null rather than ranking it as zero', unavailable => {
    const scene = linkedScene()
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(workspace => workspace === scene.anchor ? unavailable : -5)
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory)
    expect(result.scores).toEqual([{ id: 'safe', primaryHourlyScore: null }, { id: 'linked', primaryHourlyScore: -5 }])
    expect(result.candidates.map(row => row.id)).toEqual(['linked', 'safe'])
    expect(result.diagnostics.some(row => row.code === 'MAIN_SCORE_UNAVAILABLE')).toBe(true)
  })

  it('retains a scoring failure as unknown and continues with a quantified candidate', () => {
    const scene = linkedScene()
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(workspace => {
      if (workspace === scene.anchor) throw new Error('fixture projection failed')
      return 10
    })
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory)
    expect(result.scores[0]!.primaryHourlyScore).toBeNull()
    expect(result.candidates.map(row => row.id)).toEqual(['linked', 'safe'])
    expect(result.diagnostics.some(row => row.message.includes('fixture projection failed'))).toBe(true)
  })

  it('keeps only the named anchor when no primary output can be quantified', () => {
    const scene = linkedScene()
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory, { anchorId: 'linked' })
    expect(result.candidates).toEqual([scene.candidates[1]])
    expect(result.scores.every(row => row.primaryHourlyScore === null)).toBe(true)
    expect(result.diagnostics.some(row => row.code === 'MAIN_SELECTION_NO_QUANTIFIED_MAIN')).toBe(true)
  })

  it('does not score an invalid inventory and preserves the anchor for the caller to validate', () => {
    const scene = linkedScene(), invalid = compileOperatorInventory([{ operator: '砾', elitePhase: 2, level: 90 }])
    expect(invalid.valid).toBe(false)
    const scorer = vi.spyOn(output, 'productionWorkspaceHourlyScore')
    const result = selectHighOutputMainCandidates(scene.candidates, invalid)
    expect(scorer).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([scene.candidates[0]])
    expect(result.scores.every(row => row.primaryHourlyScore === null)).toBe(true)
    expect(result.diagnostics.some(row => row.code === 'MAIN_SELECTION_INVALID_INVENTORY')).toBe(true)
  })

  it('uses the actual unlocked stage rather than the maximum-stage supporter', () => {
    const scene = linkedScene()
    const lowStage = compileOperatorInventory(scene.inventory.operators.map(operator => ({
      operator: operator.charId, elitePhase: operator.charId === id('薇薇安娜') ? 0 : operator.elitePhase,
      level: operator.charId === id('薇薇安娜') ? 50 : operator.level,
    })))
    const result = selectHighOutputMainCandidates(scene.candidates, lowStage)
    expect(lowStage.valid).toBe(true)
    expect(result.scores[0]!.primaryHourlyScore).toBeCloseTo(result.scores[1]!.primaryHourlyScore!, 9)
    expect(result.candidates.map(row => row.id)).toEqual(['safe', 'linked'])
  })

  it('retains an unquantified alternative when the quantified best is the anchor', () => {
    const scene = linkedScene()
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(workspace => workspace === scene.anchor ? 10 : undefined)
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory)
    expect(result.candidates.map(row => row.id)).toEqual(['safe', 'linked'])
    expect(result.scores[1]!.primaryHourlyScore).toBeNull()
  })

  it('returns a single unique candidate without manufacturing another proposal', () => {
    const scene = linkedScene()
    const result = selectHighOutputMainCandidates([scene.candidates[1]!], scene.inventory)
    expect(result.candidates).toEqual([scene.candidates[1]])
  })

  it('returns no candidates for an empty pool without evaluating G', () => {
    const scene = linkedScene(), scorer = vi.spyOn(output, 'productionWorkspaceHourlyScore')
    expect(selectHighOutputMainCandidates([], scene.inventory).candidates).toEqual([])
    expect(scorer).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, NaN, Infinity])('rejects an invalid candidate budget %s before evaluating G', maxCandidates => {
    const scene = linkedScene(), scorer = vi.spyOn(output, 'productionWorkspaceHourlyScore')
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory, { maxCandidates })
    expect(result.candidates).toEqual([])
    expect(scorer).not.toHaveBeenCalled()
    expect(result.diagnostics.some(row => row.code === 'MAIN_SELECTION_INVALID_LIMIT')).toBe(true)
  })

  it('falls back to the first candidate when a named anchor is missing', () => {
    const scene = linkedScene()
    const result = selectHighOutputMainCandidates(scene.candidates, scene.inventory, { anchorId: 'missing' })
    expect(result.candidates.map(row => row.id)).toEqual(['linked', 'safe'])
    expect(result.diagnostics.some(row => row.code === 'MAIN_SELECTION_ANCHOR_NOT_FOUND')).toBe(true)
  })

  it('does not let a missing active supporter fall back to maximum catalog skills', () => {
    const scene = linkedScene(), owned = compileOperatorInventory(scene.inventory.operators.filter(operator => operator.charId !== id('薇薇安娜'))
      .map(operator => ({ operator: operator.charId, elitePhase: operator.elitePhase, level: operator.level })))
    const safe = structuredClone(scene.anchor)
    safe.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'free' }
    const linked = structuredClone(scene.stronger)
    linked.mainPlan.facilities.central.slots[0]!.occupant = { kind: 'operator', operatorId: '薇薇安娜' }
    const result = selectHighOutputMainCandidates([{ id: 'safe', workspace: safe }, { id: 'missing-supporter', workspace: linked }], owned)
    expect(owned.valid).toBe(true)
    expect(result.scores[0]!.primaryHourlyScore).not.toBeNull()
    expect(result.scores[1]!.primaryHourlyScore).toBeNull()
    expect(result.candidates.map(row => row.id)).toEqual(['safe', 'missing-supporter'])
    expect(result.diagnostics.some(row => row.code === 'MAIN_SCORE_UNOWNED_OCCUPANT')).toBe(true)
  })
})
