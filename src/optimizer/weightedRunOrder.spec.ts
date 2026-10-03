import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { configureRunOrder } from './configureRunOrder'
import { calculateRunOrderGains } from './runOrderGains'

function fixture(level = 3) {
  const ws = createDefaultWorkspace()
  for (const r of Object.values(ws.mainPlan.facilities)) r.slots = []
  const room = ws.mainPlan.facilities.room_3_1
  room.type = 'trading'; room.product = 'money'; room.level = level
  room.slots = Array.from({ length: level }, (_, i) => ({ occupant: { kind: 'operator' as const, operatorId: id(['芬', '克洛丝', '空爆'][i]!) }, groupId: null, replacements: [id('米格鲁')] }))
  return ws
}
function inventory(names: string[], phase = 2) {
  return compileOperatorInventory(names.map(operator => ({ operator, elitePhase: phase, level: 1 })))
}
function runners(ws: ReturnType<typeof fixture>) {
  return ws.mainPlan.facilities.room_3_1.slots.flatMap(s => s.replacements).filter(ref => ref !== id('米格鲁'))
}
describe('weighted run-order selection', () => {
  it('selects Closure over the normal-quality pair at the default weights', () => {
    const ws = fixture()
    expect(configureRunOrder(ws, inventory(['但书', '龙舌兰', '可露希尔', '佩佩']))).toBe(true)
    expect(runners(ws)).toEqual([id('可露希尔')])
    expect(ws.mainPlan.facilities.room_3_1.slots.every(s => s.replacements.includes(id('米格鲁')))).toBe(true)
  })
  it('switches to the pair when only order money is weighted', () => {
    const ws = fixture()
    ws.productionWeights = { exp: 0, gold: 0, orders: 1, fragments: 0, orundum: 0 }
    configureRunOrder(ws, inventory(['但书', '龙舌兰', '可露希尔', '佩佩']))
    expect(runners(ws)).toEqual([id('但书'), id('龙舌兰')])
  })
  it.each([1, 2])('never adds Tequila or the pair at station level %i', level => {
    const ws = fixture(level)
    configureRunOrder(ws, inventory(['但书', '龙舌兰']))
    expect(runners(ws)).toEqual([id('但书')])
  })
  it('excludes Pepe whenever another unlocked runner is usable, even if Pepe scores higher', () => {
    const ws = fixture(1)
    const inv = compileOperatorInventory([{ operator: '但书', elitePhase: 0, level: 1 }, { operator: '佩佩', elitePhase: 2, level: 1 }])
    configureRunOrder(ws, inv)
    expect(runners(ws)).toEqual([id('但书')])
  })
  it('allows Pepe as the last unlocked candidate and ignores locked Closure', () => {
    const ws = fixture(1)
    const inv = compileOperatorInventory([{ operator: '可露希尔', elitePhase: 0, level: 1 }, { operator: '佩佩', elitePhase: 2, level: 1 }])
    configureRunOrder(ws, inv)
    expect(runners(ws)).toEqual([id('佩佩')])
  })
  it('clears all old dedicated candidates when all weights are zero', () => {
    const ws = fixture()
    ws.productionWeights = { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 }
    ws.mainPlan.facilities.room_3_1.slots[0]!.replacements.unshift(id('可露希尔'), id('佩佩'))
    configureRunOrder(ws, inventory(['但书', '龙舌兰', '可露希尔', '佩佩']))
    expect(runners(ws)).toEqual([])
  })
  it.each([1,2].flatMap(level => ['alpha','beta'].flatMap(quality => [false,true].map(ordersOnly => ({level,quality,ordersOnly})))))
  ('selects the highest positive weighted runner for level $level $quality ordersOnly=$ordersOnly', ({level,quality,ordersOnly}) => {
    const ws = fixture(level), room = ws.mainPlan.facilities.room_3_1
    room.slots[0]!.occupant = { kind: 'operator', operatorId: id('柏喙') }
    const mains = room.slots.map(slot => slot.occupant)
    if (ordersOnly) ws.productionWeights = {exp:0,gold:0,orders:1,fragments:0,orundum:0}
    const inv = compileOperatorInventory([
      ...['但书','龙舌兰','可露希尔','佩佩'].map(operator => ({operator,elitePhase:2,level:1})),
      {operator:'柏喙',elitePhase:quality==='alpha'?0:2,level:1},
    ])
    expect(configureRunOrder(ws, inv)).toBe(true)
    expect(runners(ws)).toEqual([id(ordersOnly && quality==='alpha' ? '但书' : '可露希尔')])
    expect(room.slots.map(slot => slot.occupant)).toEqual(mains)
    expect(room.slots.every(slot => slot.replacements.includes(id('米格鲁')))).toBe(true)
  })
  it.each([1,2].flatMap(level => ['alpha','beta'].map(quality => ({level,quality}))))
  ('keeps Tequila and the pair unavailable and excludes more profitable Pepe for level $level $quality', ({level,quality}) => {
    const ws = fixture(level)
    ws.mainPlan.facilities.room_3_1.slots[0]!.occupant = {kind:'operator',operatorId:id('柏喙')}
    const inv = compileOperatorInventory([
      {operator:'柏喙',elitePhase:quality==='alpha'?0:2,level:1},
      {operator:'但书',elitePhase:0,level:1},{operator:'龙舌兰',elitePhase:2,level:1},{operator:'佩佩',elitePhase:2,level:1},
    ])
    expect(configureRunOrder(ws, inv)).toBe(true)
    expect(runners(ws)).toEqual([id('但书')])
    const gains = calculateRunOrderGains(level, quality as 'alpha'|'beta', 1)
    expect(gains.find(row=>row.key==='pepe2')!.delta).toBeGreaterThan(gains.find(row=>row.key==='proviso0')!.delta)
    expect(gains.filter(row=>row.names.includes('龙舌兰')).every(row=>!row.allowed)).toBe(true)
  })
})
