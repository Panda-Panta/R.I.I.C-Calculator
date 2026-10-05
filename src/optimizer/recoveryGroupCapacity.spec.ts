import { describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { fullCatalogIdleInventory, compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { regroupCombination } from './combinationAllocation'
import { simulateCandidate } from './candidateSimulation'
import * as bridge from '../workbench/scheduleSimulationBridge'
import type { CombinationVariant } from './combinationModel'

function constrainedWorkspace() {
  const ws = createDefaultWorkspace()
  for (const room of Object.values(ws.mainPlan.facilities)) if (room.type === 'dormitory') {
    room.level = room.roomId === 'dormitory_1' ? 1 : 0
    room.slots = room.level ? Array.from({ length: 5 }, (_, i) => ({
      occupant: i < 2 ? { kind: 'operator' as const, operatorId: id(i ? '杜林' : '桃金娘') } : { kind: 'free' as const },
      groupId: null, replacements: [],
    })) : []
  }
  for (const [roomId, names] of [ ['room_1_1', ['多萝西', '赫默', '调香师']], ['room_2_1', ['苍苔', '砾', '斑点']] ] as const) {
    const room = ws.mainPlan.facilities[roomId]
    room.slots = names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: roomId, replacements: [] }))
  }
  return ws
}
const variant: CombinationVariant = { id: 'cross-room-relief', definitionId: 'cross-room-relief', name: '跨站替班',
  coreOperatorIds: [id('食铁兽'), id('铅踝')], optionalOperatorIds: [], policy: {},
  placements: [ { roomId: 'room_1_1', slotIndex: 0, role: 'backup', operatorId: id('食铁兽') },
    { roomId: 'room_2_1', slotIndex: 0, role: 'backup', operatorId: id('铅踝') } ] }

describe('generated combinations fit their physical recovery beds', () => {
  it('rejects a regrouping that would merge two feasible groups beyond bed capacity', () => {
    const ws = constrainedWorkspace(), before = structuredClone(ws)
    const inventory = compileOperatorInventory(fullCatalogIdleInventory())
    expect(regroupCombination(ws, inventory, variant, 'backup', { enforceRecoveryCapacity: true })).toBeNull()
    expect(ws).toEqual(before)
  })
  it('does not merge two existing combinations even when beds are sufficient', () => {
    const ws = constrainedWorkspace()
    ws.mainPlan.facilities.dormitory_2.level = 1
    ws.mainPlan.facilities.dormitory_2.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))
    expect(regroupCombination(ws, compileOperatorInventory(fullCatalogIdleInventory()), variant, 'backup')).toBeNull()
  })
  it('adds only ungrouped slots to one existing combination and retains its group', () => {
    const ws = constrainedWorkspace()
    ws.mainPlan.facilities.dormitory_2.level = 1
    ws.mainPlan.facilities.dormitory_2.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))
    for (const slot of ws.mainPlan.facilities.room_2_1.slots) slot.groupId = null
    const result = regroupCombination(ws, compileOperatorInventory(fullCatalogIdleInventory()), variant, 'backup')!
    expect(result.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('room_1_1')
    expect(result.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe(result.mainPlan.facilities.room_2_1.slots[0]!.groupId)
  })
  it('fills the third relief position without moving either existing core', () => {
    const ws = constrainedWorkspace(), room = ws.mainPlan.facilities.room_1_1
    room.slots.forEach((s, i) => { s.replacements = i < 2 ? [id(i ? '铅踝' : '食铁兽')] : [] })
    const before = structuredClone(room.slots)
    const fill: CombinationVariant = { ...variant, coreOperatorIds: [id('食铁兽')], optionalOperatorIds: [id('梅尔')],
      placements: [{ roomId: 'room_1_1', slotIndex: 0, role: 'backup', operatorId: id('食铁兽') },
        { roomId: 'room_1_1', slotIndex: 2, role: 'backup', operatorId: id('梅尔') }] }
    const result = regroupCombination(ws, compileOperatorInventory(fullCatalogIdleInventory()), fill, 'backup', {
      protectedCombinationOperators: new Set([id('多萝西'), id('食铁兽')]),
    })!
    expect(result).not.toBeNull()
    expect(result.mainPlan.facilities.room_1_1.slots[0]).toEqual(before[0])
    expect(result.mainPlan.facilities.room_1_1.slots[1]).toEqual(before[1])
    expect(result.mainPlan.facilities.room_1_1.slots[2]!.replacements).toEqual([id('梅尔')])
  })
  it('does not move an existing core to make room for another combination', () => {
    const ws = constrainedWorkspace()
    const move: CombinationVariant = { ...variant, coreOperatorIds: [id('多萝西')], optionalOperatorIds: [],
      placements: [{ roomId: 'room_2_1', slotIndex: 0, role: 'main', operatorId: id('多萝西') }] }
    expect(regroupCombination(ws, compileOperatorInventory(fullCatalogIdleInventory()), move, 'main', {
      protectedCombinationOperators: new Set([id('多萝西'), id('苍苔')]),
    })).toBeNull()
  })
  it('rejects an impossible generated group before starting its dynamic simulation', () => {
    const ws = constrainedWorkspace()
    for (const roomId of ['room_1_1', 'room_2_1'] as const) for (const slot of ws.mainPlan.facilities[roomId].slots) slot.groupId = 'oversized'
    const simulate = vi.spyOn(bridge, 'runScheduleSimulationBridge')
    try {
      const result = simulateCandidate({ workspace: ws, options: { warmupHours: 24, sampleHours: 72 }, assumptions: {} })
      expect(result.completed).toBe(false)
      expect(result.diagnostics.join(' ')).toContain('RECOVERY_GROUP_CAPACITY')
      expect(simulate).not.toHaveBeenCalled()
    } finally { simulate.mockRestore() }
  })
})
