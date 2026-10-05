import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { buildCombinationPool } from './combinationEvaluation'
import { allocateCombinationSkeleton, normalizeProductionShifts } from './combinationAllocation'
import { productionTeamHourlyOutput, productionTeamTheory } from './productionSingletons'
import { shiftSnapshot } from './combinationModel'

describe('production headcount selection and whole shift output ordering', () => {
  it('selects the completable two-person gold automation footprint without counting support stations', () => {
    const ws = createDefaultWorkspace()
    for (const room of Object.values(ws.mainPlan.facilities)) {
      if (!['room_1_1', 'room_1_2', 'room_1_3', 'room_2_2', 'room_3_2', 'room_3_3', 'central'].includes(room.roomId)) {
        room.level = 0; room.slots = []
      }
    }
    ws.mainPlan.facilities.room_1_1.product = 'exp'
    ws.mainPlan.facilities.room_1_2.type = 'trading'; ws.mainPlan.facilities.room_1_2.product = 'money'
    const gold = ws.mainPlan.facilities.room_2_2
    gold.type = 'manufacture'; gold.product = 'gold'; gold.level = 2; gold.slots.length = 2
    ws.mainPlan.facilities.room_3_2.type = 'trading'; ws.mainPlan.facilities.room_3_2.product = 'money'
    const names = ['温蒂', '清流', '森蚺', 'Lancet-2', '承曦格雷伊']
    const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(o => names.some(n => id(n) === o.operator)))
    const pool = buildCombinationPool(ws, inventory)
    const two = pool.values.find(v => v.variant.definitionId === 'automation' && v.variant.placements.some(p => p.roomId === 'room_2_2'))!
    expect(two.productionCount).toBe(2)
    expect(two.supportCount).toBe(3)
    expect(two.perCapita).toBe(50)
    const allocated = allocateCombinationSkeleton(ws, pool, 0).workspace
    expect(allocated.mainPlan.facilities.room_2_2.slots.map(s => s.occupant)).toEqual([
      { kind: 'operator', operatorId: id('温蒂') }, { kind: 'operator', operatorId: id('清流') },
    ])
    expect(allocated.mainPlan.facilities.room_1_1.slots.some(s => s.occupant.kind === 'operator' && s.occupant.operatorId === id('温蒂'))).toBe(false)
  })
  it('retains the higher whole-room hourly output even if a smaller relief team has higher per-capita skill', () => {
    const ws = createDefaultWorkspace(), inventory = compileOperatorInventory(fullCatalogIdleInventory())
    const room = ws.mainPlan.facilities.room_1_1
    room.product = 'gold'
    ;['苍苔', '砾', '斑点'].forEach((name, i) => { room.slots[i]!.occupant = { kind: 'operator', operatorId: id(name) } })
    room.slots[0]!.replacements = [id('温蒂')]
    ;['room_1_3', 'room_2_3', 'room_3_3'].forEach((roomId, i) => {
      const power = ws.mainPlan.facilities[roomId as 'room_1_3']
      power.type = 'power'; power.level = 3
      power.slots = [{ occupant: { kind: 'operator', operatorId: id(['雷蛇', '格雷伊', '伊芙利特'][i]!) }, groupId: null, replacements: [] }]
      ws.mainPlan.conf.workaholic.push(power.slots[0]!.occupant.kind === 'operator' ? power.slots[0]!.occupant.operatorId : '')
    })
    const relief = shiftSnapshot(ws, 'backup', room.roomId)
    expect(productionTeamTheory(relief, inventory, room.roomId)!).toBeGreaterThan(productionTeamTheory(ws, inventory, room.roomId)! / 3)
    expect(productionTeamHourlyOutput(ws, inventory, room.roomId)!).toBeGreaterThan(productionTeamHourlyOutput(relief, inventory, room.roomId)!)
    const before = structuredClone(room)
    expect(normalizeProductionShifts(ws, inventory, {}, 'hourly-output')).toEqual([])
    expect(ws.mainPlan.facilities.room_1_1).toEqual(before)
  })
})
