import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runGlobalPerCapitaReplacement } from './globalPerCapitaReplacement'
import { productionTeamTheory } from './productionSingletons'

function scenario(names: string[], replacements: string[], extra: string[]) {
  const ws = createDefaultWorkspace()
  for (const room of Object.values(ws.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  ws.mainPlan.facilities.room_1_1 = { roomId: 'room_1_1', type: 'manufacture', product: 'gold', level: 3,
    slots: names.map((name, i) => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: '莱茵组合', replacements: [id(replacements[i]!)] })) }
  ws.mainPlan.facilities.room_3_3 = { roomId: 'room_3_3', type: 'power', level: 3,
    slots: [{ occupant: { kind: 'operator', operatorId: id('雷蛇') }, groupId: null, replacements: [id('格雷伊')] }] }
  const owned = fullCatalogIdleInventory().filter(o => [...names, ...replacements, ...extra, '雷蛇', '格雷伊'].some(name => id(name) === o.operator))
  return { ws, owned }
}
const mainIds = (ws: ReturnType<typeof createDefaultWorkspace>) => ws.mainPlan.facilities.room_1_1.slots.map(s => s.occupant.kind === 'operator' ? id(s.occupant.operatorId) : '')

describe('sequential one-person validation of grouped production teams', () => {
  it('replaces a weak optional member without banning partial shift-group changes', () => {
    const { ws, owned } = scenario(['多萝西', '淬羽赫默', '赫默'], ['调香师', '夜烟', '斑点'], ['梅尔'])
    Object.assign(owned.find(o => o.operator === id('赫默'))!, { elitePhase: 0, level: 1 })
    const inventory = compileOperatorInventory(owned), before = productionTeamTheory(ws, inventory, 'room_1_1')!
    const result = runGlobalPerCapitaReplacement(ws, inventory)
    expect(inventory.valid, JSON.stringify(inventory.diagnostics)).toBe(true)
    expect(mainIds(result.workspace), result.logs.join('\n')).toContain(id('梅尔'))
    expect(mainIds(result.workspace)).toContain(id('多萝西'))
    expect(mainIds(result.workspace)).toContain(id('淬羽赫默'))
    expect(productionTeamTheory(result.workspace, inventory, 'room_1_1')!).toBeGreaterThan(before)
    expect(new Set(result.workspace.mainPlan.facilities.room_1_1.slots.map(s => s.groupId)).size).toBe(1)
  })

  it('retains metalcraft synergy when a stronger individual would lower the whole team', () => {
    const { ws, owned } = scenario(['苍苔', '砾', '斑点'], ['梅尔', '白面鸮', '调香师'], ['淬羽赫默'])
    const inventory = compileOperatorInventory(owned)
    const result = runGlobalPerCapitaReplacement(ws, inventory)
    expect(mainIds(result.workspace)).toEqual(mainIds(ws))
    expect(productionTeamTheory(result.workspace, inventory, 'room_1_1')).toBe(110)
  })

  it('can draw a high-efficiency singleton from relief while replacing its vacated assignment', () => {
    const { ws, owned } = scenario(['多萝西', '淬羽赫默', '香草'], ['梅尔', '夜烟', '斑点'], [])
    const inventory = compileOperatorInventory(owned)
    const result = runGlobalPerCapitaReplacement(ws, inventory)
    expect(inventory.valid, JSON.stringify(inventory.diagnostics)).toBe(true)
    expect(mainIds(result.workspace), result.logs.join('\n')).toContain(id('梅尔'))
    expect(result.workspace.mainPlan.facilities.room_1_1.slots.flatMap(s => s.replacements)).toContain(id('香草'))
    const all = Object.values(result.workspace.mainPlan.facilities).flatMap(r => r.slots.flatMap(s => [...(s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []), ...s.replacements.map(id)]))
    expect(new Set(all).size).toBe(all.length)
  })

  it.each([90, 100 + 1e-10, Number.NaN])('rolls back when full dynamic verification does not improve or is unknown (%s)', score => {
    const { ws, owned } = scenario(['多萝西', '淬羽赫默', '赫默'], ['调香师', '夜烟', '斑点'], ['梅尔'])
    Object.assign(owned.find(o => o.operator === id('赫默'))!, { elitePhase: 0, level: 1 })
    const result = runGlobalPerCapitaReplacement(ws, compileOperatorInventory(owned), { baselineScore: 100, evaluator: () => score })
    expect(result.workspace).toEqual(ws)
    expect(result.swappedCount).toBe(0)
  })
})
