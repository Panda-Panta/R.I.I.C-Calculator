import { describe, expect, it } from 'vitest'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultWorkspace } from '../workbench/defaults'
import { projectJointBackupRestState } from './jointBackupProjection'

function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const central = workspace.mainPlan.facilities.central
  central.level = 5
  central.slots = ['阿米娅', '杜宾'].map((actor, index) => ({ occupant: { kind: 'operator', operatorId: id(actor) },
    groupId: '中枢组', replacements: [id(['芬', '香草'][index]!)] }))
  const dorm = workspace.mainPlan.facilities.dormitory_1
  dorm.level = 1
  dorm.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  const inventory = compileOperatorInventory(['阿米娅', '杜宾', '芬', '香草', '克洛丝', '但书'].map(operator => ({ operator, elitePhase: 0, level: 1 })))
  return { workspace, inventory }
}

describe('joint backup simple rest-state projection', () => {
  it('projects the complete simple group, actual ordered relief and Free-bed occupants without mutating the plan', () => {
    const { workspace, inventory } = fixture(), before = structuredClone(workspace)
    workspace.mainPlan.facilities.central.slots[0]!.replacements = [id('杜宾'), id('芬'), id('克洛丝')]
    const expected = structuredClone(workspace)
    const projected = projectJointBackupRestState(workspace, inventory, [id('阿米娅')])!
    expect(projected.mainPlan.facilities.central.slots.map(slot => slot.occupant)).toEqual([
      { kind: 'operator', operatorId: id('芬') }, { kind: 'operator', operatorId: id('香草') },
    ])
    expect(projected.mainPlan.facilities.dormitory_1.slots.slice(0, 2).map(slot => slot.occupant)).toEqual([
      { kind: 'operator', operatorId: id('阿米娅') }, { kind: 'operator', operatorId: id('杜宾') },
    ])
    expect(workspace).toEqual(expected)
    expect(before.mainPlan.facilities.central.slots[0]!.replacements).toEqual([id('芬')])
  })

  it('keeps workaholic group members at their exact working position', () => {
    const { workspace, inventory } = fixture()
    workspace.mainPlan.conf.workaholic = ['杜宾']
    const projected = projectJointBackupRestState(workspace, inventory, ['阿米娅'])!
    expect(projected.mainPlan.facilities.central.slots[1]).toEqual(workspace.mainPlan.facilities.central.slots[1])
    expect(projectJointBackupRestState(workspace, inventory, ['杜宾'])).toBeUndefined()
  })

  it.each(['missing relief', 'shared first relief', 'insufficient beds', 'complex binding', 'unowned primary', 'unowned relief'])('leaves %s unknown', reason => {
    const { workspace, inventory } = fixture()
    const central = workspace.mainPlan.facilities.central
    if (reason === 'missing relief') central.slots[0]!.replacements = []
    if (reason === 'shared first relief') central.slots[1]!.replacements = [id('芬'), id('香草')]
    if (reason === 'insufficient beds') workspace.mainPlan.facilities.dormitory_1.slots = []
    if (reason === 'complex binding') central.slots[1]!.groupBindings = [{ groupId: '中枢组', replacements: [id('香草')] }]
    if (reason === 'unowned primary') inventory.operators = inventory.operators.filter(operator => operator.charId !== id('杜宾'))
    if (reason === 'unowned relief') inventory.operators = inventory.operators.filter(operator => operator.charId !== id('芬'))
    expect(projectJointBackupRestState(workspace, inventory, ['阿米娅'])).toBeUndefined()
  })

  it('never uses a dedicated run-order card as ordinary trading relief', () => {
    const { workspace, inventory } = fixture()
    const room = workspace.mainPlan.facilities.room_1_1
    room.level = 1; room.type = 'trading'
    room.slots = [{ occupant: { kind: 'operator', operatorId: id('克洛丝') }, groupId: null, replacements: [id('但书')] }]
    expect(projectJointBackupRestState(workspace, inventory, ['克洛丝'])).toBeUndefined()
  })
})
