import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runGlobalPerCapitaReplacement } from './globalPerCapitaReplacement'

describe('final automatic combination integrity', () => {
  it('does not move a Pinus core into another factory for a better singleton score', () => {
    const ws = createDefaultWorkspace()
    const room = ws.mainPlan.facilities.room_1_1
    room.product = 'exp'
    ;['野鬃', '灰毫', '远牙'].forEach((name, i) => {
      room.slots[i]!.occupant = { kind: 'operator', operatorId: id(name) }
      room.slots[i]!.groupId = 'pinus'
      room.slots[i]!.replacements = [id(['水月', '香草', '杰西卡'][i]!)]
    })
    ;['薇薇安娜', '焰尾'].forEach((name, i) => {
      const slot = ws.mainPlan.facilities.central.slots[i]!
      slot.occupant = { kind: 'operator', operatorId: id(name) }; slot.groupId = 'pinus'
      slot.replacements = [id(['阿米娅', '涤火杰西卡'][i]!)]
    })
    const other = ws.mainPlan.facilities.room_3_1
    other.type = 'manufacture'; other.product = 'exp'
    ;['酒神', '裂响', '机械师'].forEach((name, i) => {
      other.slots[i]!.occupant = { kind: 'operator', operatorId: id(name) }
      other.slots[i]!.replacements = [id(['多萝西', '淬羽赫默', '溯光星源'][i]!)]
    })
    const result = runGlobalPerCapitaReplacement(ws, compileOperatorInventory(fullCatalogIdleInventory()), {
      powerCount: 2, maxEvaluations: 3, baselineScore: 100,
      evaluator: candidate => candidate.mainPlan.facilities.room_3_1.slots.some(s =>
        s.occupant.kind === 'operator' && s.occupant.operatorId === id('野鬃')) ? 200 : 100,
    })
    const actual = result.workspace.mainPlan.facilities.room_1_1.slots.map(s => s.occupant)
    expect(actual).toEqual(room.slots.map(s => s.occupant))
  }, 30000)
})
