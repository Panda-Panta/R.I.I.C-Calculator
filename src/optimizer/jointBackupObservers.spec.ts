import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId } from '../domain/roster'
import { selectJointBackupTriggers } from './jointBackupObservers'

function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const fill = (roomId: MowerRoomId, names: string[]) => {
    const room = workspace.mainPlan.facilities[roomId]
    room.level = roomId === 'central' ? 5 : names.length
    room.slots = names.map(name => ({ occupant: { kind: 'operator' as const, operatorId: id(name) }, groupId: null, replacements: [] }))
  }
  fill('central', ['森蚺'])
  fill('room_1_3', ['Lancet-2']); fill('room_2_3', ['Castle-3'])
  fill('room_1_2', ['芬']); fill('room_2_2', ['夜刀'])
  workspace.mainPlan.facilities.room_1_1.type = 'manufacture'
  workspace.mainPlan.facilities.room_1_1.product = 'gold'
  fill('room_1_1', ['温蒂', '异客', '清流'])
  workspace.mainPlan.conf.workaholic = [id('Lancet-2'), id('Castle-3')]
  const other = structuredClone(workspace)
  other.mainPlan.facilities.room_1_1.slots.forEach((slot, i) => { slot.occupant = { kind: 'operator', operatorId: id(['砾', '斑点', '夜烟'][i]!) } })
  const names = ['森蚺', 'Lancet-2', 'Castle-3', '芬', '夜刀', '温蒂', '异客', '清流', '砾', '斑点', '夜烟']
  const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(row => names.some(name => row.operator === id(name))))
  return { candidates: [{ id: 'automation', workspace }, { id: 'ordinary', workspace: other }], inventory }
}

describe('joint backup external observers', () => {
  it('prioritizes a changing external provider with a real static ranking crossover', () => {
    const { candidates, inventory } = fixture()
    const triggers = selectJointBackupTriggers(candidates, inventory, 4)
    expect(triggers.length).toBeGreaterThanOrEqual(2)
    expect(triggers[0]!.observers).toEqual([{ operatorId: id('森蚺'), roomId: 'central', requirePositiveMood: true }])
    expect(triggers.slice(0, 2).map(trigger => trigger.activeWhen)).toEqual(['all-present', 'not-all-present'])
    expect(triggers.every(trigger => trigger.observers.every(observer => observer.roomId !== 'room_1_1'))).toBe(true)
  })

  it('is bounded, reproducible and never mutates the input candidates', () => {
    const { candidates, inventory } = fixture(), before = JSON.stringify(candidates)
    expect(selectJointBackupTriggers(candidates, inventory, 1)).toHaveLength(1)
    expect(selectJointBackupTriggers(candidates, inventory, 0)).toEqual([])
    expect(selectJointBackupTriggers(candidates, inventory, 4)).toEqual(selectJointBackupTriggers(candidates, inventory, 4))
    expect(JSON.stringify(candidates)).toBe(before)
  })

  it('does not fabricate observers for absent inventory or an unchanged production plan', () => {
    const { candidates, inventory } = fixture()
    expect(selectJointBackupTriggers([candidates[0]!, candidates[0]!], inventory)).toEqual([])
    expect(selectJointBackupTriggers(candidates, { valid: false, operators: [], diagnostics: [] })).toEqual([])
    const noProvider = { ...inventory, operators: inventory.operators.filter(operator => operator.charId !== id('森蚺')) }
    expect(selectJointBackupTriggers(candidates, noProvider).flatMap(trigger => trigger.observers.map(observer => observer.operatorId))).not.toContain(id('森蚺'))
  })
})
