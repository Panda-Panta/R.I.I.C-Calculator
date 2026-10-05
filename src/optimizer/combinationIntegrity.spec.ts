import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { formedCombinations, preservesFormedCombinations } from './combinationIntegrity'

const inventory = compileOperatorInventory(fullCatalogIdleInventory())
function perception() {
  const ws = createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('迷迭香') }
  ws.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'operator', operatorId: id('絮雨') }
  ws.mainPlan.facilities.room_3_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('黑键') }
  return ws
}
describe('physical combination membership', () => {
  it('allows a whole perception system to move to relief while retaining its cores', () => {
    const before = perception(), after = structuredClone(before)
    for (const room of Object.values(after.mainPlan.facilities)) for (const slot of room.slots) {
      if (slot.occupant.kind !== 'operator') continue
      slot.replacements = [slot.occupant.operatorId]; slot.occupant = { kind: 'operator', operatorId: id('芬') }
    }
    expect(formedCombinations(after, inventory).some(c => c.definitionId === 'pure_perception' && c.role === 'backup')).toBe(true)
    expect(preservesFormedCombinations(before, after, inventory)).toBe(true)
    after.mainPlan.facilities.contact.slots[0]!.replacements = [id('可露希尔')]
    expect(preservesFormedCombinations(before, after, inventory)).toBe(false)
  })
  it('does not infer membership from labels or accept a manufacturing core in trading', () => {
    const ws = perception()
    ws.mainPlan.facilities.room_1_1.type = 'trading'; ws.mainPlan.facilities.room_1_1.product = 'money'
    ws.mainPlan.facilities.room_1_1.slots[0]!.groupId = '组合_pure_perception'
    expect(formedCombinations(ws, inventory).some(c => c.definitionId === 'pure_perception')).toBe(false)
  })
  it('allows optional member replacement without treating it as a core threshold', () => {
    const before = perception(), after = structuredClone(before)
    after.mainPlan.facilities.room_3_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('伺夜') }
    expect(preservesFormedCombinations(before, after, inventory)).toBe(true)
  })
  it('requires local cores to occupy the same factory and recipe', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.product = 'gold'
    ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('阿罗玛') }
    ws.mainPlan.facilities.room_1_2.slots[0]!.occupant = { kind: 'operator', operatorId: id('槐琥') }
    expect(formedCombinations(ws, inventory).some(c => c.definitionId === 'aroma_waaifu')).toBe(false)
    ws.mainPlan.facilities.room_1_1.slots[1]!.occupant = { kind: 'operator', operatorId: id('槐琥') }
    expect(formedCombinations(ws, inventory).some(c => c.definitionId === 'aroma_waaifu')).toBe(true)
    ws.mainPlan.facilities.room_1_1.product = 'exp'
    expect(formedCombinations(ws, inventory).some(c => c.definitionId === 'aroma_waaifu')).toBe(false)
  })
})
