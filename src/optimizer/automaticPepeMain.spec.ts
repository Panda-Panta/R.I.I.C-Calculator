import { expect, it } from 'vitest'
import { OPERATORS } from '../domain/operators'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { generateMolecularCandidates } from './molecularSynthesis'
import { buildSingletonFallback } from './singletonFallback'

const entries = OPERATORS.filter(o => ['佩佩', '可露希尔', '空爆', '梓兰', '月见夜', '梅', 'Lancet-2'].includes(o.name))
  .map(o => ({ operator: o.name, elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2, level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90 }))
const inventory = compileOperatorInventory(entries)
function baseWorkspace(locked = false) {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  base.mainPlan.facilities.room_1_3.level = 1
  base.mainPlan.facilities.room_1_3.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }]
  base.mainPlan.conf.workaholic = [id('Lancet-2')]
  const room = base.mainPlan.facilities.room_3_1
  room.level = 1
  room.slots = [{ occupant: locked ? { kind: 'operator', operatorId: id('佩佩') } : { kind: 'empty' }, groupId: null, replacements: [] }]
  return base
}

it.each(['molecular', 'fallback'] as const)('does not fill a scarce physical trade main with neutral E0 Pepe in %s generation', mode => {
  const scarce = entries.filter(o => ['佩佩', '可露希尔', '空爆', 'Lancet-2'].includes(o.operator))
    .map(o => o.operator === '佩佩' ? { ...o, elitePhase: 0, level: 1 } : o)
  const owned = compileOperatorInventory(scarce), base = baseWorkspace()
  expect(owned.valid).toBe(true)
  if (mode === 'molecular') expect(generateMolecularCandidates(base, scarce, owned, { branchCount: 1 })).toEqual([])
  else expect(buildSingletonFallback(base, owned, new Set())).toBeNull()
})

it.each(['molecular', 'fallback'] as const)('does not select physical Pepe over a usable Closure runner in %s generation', mode => {
  const base = baseWorkspace(), before = structuredClone(base)
  expect(inventory.valid, JSON.stringify(inventory.diagnostics)).toBe(true)
  const candidate = mode === 'molecular'
    ? generateMolecularCandidates(base, entries, inventory, { branchCount: 1 })[0]?.workspace
    : buildSingletonFallback(base, inventory, new Set())
  expect(candidate).toBeTruthy()
  const room = candidate!.mainPlan.facilities.room_3_1
  expect(room.slots[0]!.occupant).not.toEqual({ kind: 'operator', operatorId: id('佩佩') })
  expect(room.slots.flatMap(slot => slot.replacements)).toContain(id('可露希尔'))
  expect(base).toEqual(before)
})

it.each(['molecular', 'fallback'] as const)('preserves an existing locked Pepe main in %s generation', mode => {
  const base = baseWorkspace(true), before = structuredClone(base), locked = new Set(['room_3_1:0'])
  const candidate = mode === 'molecular'
    ? generateMolecularCandidates(base, entries, inventory, { branchCount: 1, lockedPositions: locked, lockedOperators: new Set([id('佩佩')]) })[0]?.workspace
    : buildSingletonFallback(base, inventory, locked)
  expect(candidate).toBeTruthy()
  expect(candidate!.mainPlan.facilities.room_3_1.slots[0]!.occupant).toEqual(before.mainPlan.facilities.room_3_1.slots[0]!.occupant)
  expect(base).toEqual(before)
})
