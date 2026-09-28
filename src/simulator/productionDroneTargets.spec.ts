import { describe, expect, it } from 'vitest'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createDefaultWorkspace } from '../workbench/defaults'
import { droneFacilities } from '../workbench/droneTargets'
import { simulateSchedule } from './scheduleSimulation'

function isolatedRoom(roomId: 'room_1_1' | 'room_3_1', product: 'money' | 'orundum' | 'fragment') {
  const workspace = createDefaultWorkspace()
  for (const facility of Object.values(workspace.mainPlan.facilities)) facility.slots = []
  const room = workspace.mainPlan.facilities[roomId]!
  room.product = product
  room.level = 3
  const schedule = compileRosterSchedule(workspace)
  schedule.rooms = schedule.rooms.filter(candidate => candidate.roomId === roomId)
  return { workspace, schedule }
}

describe('selected drone facility output', () => {
  it.each([
    { roomId: 'room_3_1' as const, product: 'money' as const, reward: 'lmd' as const },
    { roomId: 'room_1_1' as const, product: 'fragment' as const, reward: 'fragment' as const },
  ])('increases $product output in the default potential calculation', ({ roomId, product, reward }) => {
    const { workspace, schedule } = isolatedRoom(roomId, product)
    const selected = droneFacilities(workspace).find(facility => facility.roomId === roomId)!
    const production = { outputMode: 'potential' as const, seed: 42, initialResources: { drone: 235 } }
    const natural = simulateSchedule(schedule, { sampleHours: 24, production: { ...production, droneTarget: 'none' } })
    const accelerated = simulateSchedule(schedule, { sampleHours: 24, production: { ...production, droneTarget: selected.target, droneRoomId: selected.roomId } })
    expect(accelerated.success).toBe(true)
    expect(accelerated.production!.drones.consumed).toBeGreaterThan(0)
    expect(accelerated.production!.sample.inflows[reward]).toBeGreaterThan(natural.production!.sample.inflows[reward] ?? 0)
  })

  it.each(['money', 'orundum'] as const)('accelerates a %s trade order and settles its reward', product => {
    const roomId = 'room_3_1'
    const { schedule } = isolatedRoom(roomId, product)
    const base = { sampleHours: 24, production: { inventoryMode: 'finite' as const, seed: 42, collectionIntervalHours: 0, initialResources: { drone: 235, gold: 1000, fragment: 1000 } } }
    const natural = simulateSchedule(schedule, { ...base, production: { ...base.production, droneTarget: 'none' } })
    const accelerated = simulateSchedule(schedule, { ...base, production: { ...base.production, droneTarget: 'trading', droneRoomId: roomId } })
    const a = accelerated.production!, n = natural.production!
    expect(accelerated.success).toBe(true)
    expect(a.events.some(event => event.type === 'native-trade-drone' && event.roomId === roomId)).toBe(true)
    expect(a.drones.consumed).toBeGreaterThan(0)
    expect(a.trading[0]!.completedOrders).toBeGreaterThan(n.trading[0]!.completedOrders)
    expect(a.trading[0]!.collectedOrders).toBeGreaterThan(n.trading[0]!.collectedOrders)
    expect(a.ledger.inflows[product === 'money' ? 'lmd' : 'orundum']).toBeGreaterThan(n.ledger.inflows[product === 'money' ? 'lmd' : 'orundum'] ?? 0)
    expect(a.materialsConsumed[product === 'money' ? 'gold' : 'fragment']).toBeGreaterThan(0)
    expect(a.ledger.outflows[product === 'money' ? 'gold' : 'fragment']).toBe(a.materialsConsumed[product === 'money' ? 'gold' : 'fragment'])
    expect(a.drones.initial + a.drones.generated - a.drones.consumed - a.drones.overflow).toBeCloseTo(a.drones.stock, 7)
  })

  it.each([
    { formula: 'fragment-orirock' as const, material: 'orirock' as const, materialCost: 2, lmdCost: 1600 },
    { formula: 'fragment-device' as const, material: 'device' as const, materialCost: 1, lmdCost: 1000 },
  ])('accelerates fragment manufacturing with $formula input costs paid once per batch', ({ formula, material, materialCost, lmdCost }) => {
    const roomId = 'room_1_1'
    const { workspace, schedule } = isolatedRoom(roomId, 'fragment')
    const selected = droneFacilities(workspace).find(facility => facility.roomId === roomId)!
    const base = { sampleHours: 24, production: { inventoryMode: 'finite' as const, seed: 42, collectionIntervalHours: 0, fragmentFormulaByRoom: { [roomId]: formula }, initialResources: { drone: 235, orirock: 100, device: 100, lmd: 100000 } } }
    const natural = simulateSchedule(schedule, { ...base, production: { ...base.production, droneTarget: 'none' } })
    const accelerated = simulateSchedule(schedule, { ...base, production: { ...base.production, droneTarget: selected.target, droneRoomId: selected.roomId } })
    const a = accelerated.production!, n = natural.production!
    expect(accelerated.success).toBe(true)
    expect(a.events.some(event => event.type === 'native-manufacture-drone' && event.roomId === roomId)).toBe(true)
    expect(a.drones.consumed).toBeGreaterThan(0)
    expect(a.manufacturing[0]!.completedItems).toBeGreaterThan(n.manufacturing[0]!.completedItems)
    expect(a.ledger.inflows.fragment).toBeGreaterThan(n.ledger.inflows.fragment ?? 0)
    const started = a.ledger.entries.filter(entry => entry.reason.includes('manufacture-start:')).length
    expect(a.ledger.outflows[material]).toBe(materialCost * started)
    expect(a.ledger.outflows.lmd).toBe(lmdCost * started)
    expect(a.ledger.outflows[material === 'orirock' ? 'device' : 'orirock'] ?? 0).toBe(0)
    expect(a.drones.initial + a.drones.generated - a.drones.consumed - a.drones.overflow).toBeCloseTo(a.drones.stock, 7)
  })
})
