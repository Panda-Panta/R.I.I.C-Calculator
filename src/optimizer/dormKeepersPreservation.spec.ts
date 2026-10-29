import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultWorkspace } from '../workbench/defaults'
import { applySmartDormitoryPolicy, hasDormRecoverySkill, isAoeDormKeeper, isSingleDormKeeper } from '../scheduler/smartDormitoryPolicy'
import { preserveExistingDormKeepers } from './dormKeepers'

function scene(entries: OwnedOperatorInput[] = [
  { operator: '杜林', elitePhase: 0, level: 1 }, { operator: '桃金娘', elitePhase: 1, level: 1 },
]) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  for (const roomId of ['dormitory_1', 'dormitory_2'] as const) {
    const room = workspace.mainPlan.facilities[roomId]
    room.level = 1
    room.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  }
  return { workspace, entries, inventory: compileOperatorInventory(entries) }
}

describe('preserve existing actual recovery keepers before smart dormitory finishing', () => {
  it('leaves every field of an explicitly locked keeper unchanged through generation cleanup', () => {
    const { workspace, entries, inventory } = scene()
    const slot = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    slot.occupant = { kind: 'operator', operatorId: '杜林' }
    slot.metadata = { user: 'exact-locked-slot' }
    const before = structuredClone(slot), lockedPositions = new Set(['dormitory_1:3'])
    preserveExistingDormKeepers(workspace, inventory, lockedPositions)
    applySmartDormitoryPolicy(workspace, { entries, lockedPositions })
    expect(workspace.mainPlan.facilities.dormitory_1.slots[3]).toEqual(before)
  })

  it.each([
    ['杜林', 0, 1], ['桃金娘', 1, 1], ['闪灵', 0, 1],
  ] as const)('protects the already-unlocked fixed %s at its original slot through repeated cleanup', (name, elitePhase, level) => {
    const { workspace, entries, inventory } = scene([{ operator: name, elitePhase, level }])
    const slot = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    slot.occupant = { kind: 'operator', operatorId: name }
    slot.metadata = { locked: true, original: { label: 'user-keeper' } }
    const original = structuredClone(slot), inventoryBefore = structuredClone(inventory)
    preserveExistingDormKeepers(workspace, inventory)
    for (let iteration = 0; iteration < 2; iteration++) applySmartDormitoryPolicy(workspace, { entries })
    expect(slot.occupant).toEqual(original.occupant)
    expect(workspace.mainPlan.facilities.dormitory_1.slots[3]).toEqual({ ...original, dormitoryResident: true })
    expect(workspace.mainPlan.facilities.dormitory_1.slots.filter(candidate => candidate.occupant.kind === 'free').length).toBeGreaterThanOrEqual(3)
    expect(inventory).toEqual(inventoryBefore)
  })

  it('keeps Durin and Myrtle in their original different dorms without changing Free beds or other metadata', () => {
    const { workspace, inventory } = scene()
    const durin = workspace.mainPlan.facilities.dormitory_1.slots[2]!, myrtle = workspace.mainPlan.facilities.dormitory_2.slots[4]!
    durin.occupant = { kind: 'operator', operatorId: id('杜林') }
    myrtle.occupant = { kind: 'operator', operatorId: id('桃金娘') }
    durin.metadata = { user: 'aoe' }; myrtle.metadata = { user: 'aoe-other-room' }
    const expected = structuredClone(workspace)
    expected.mainPlan.facilities.dormitory_1.slots[2]!.dormitoryResident = true
    expected.mainPlan.facilities.dormitory_2.slots[4]!.dormitoryResident = true
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(expected)
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(expected)
  })

  it('does not promote E0 Myrtle or an unowned recovery operator from the maximum catalog', () => {
    const { workspace, inventory } = scene([{ operator: '桃金娘', elitePhase: 0, level: 1 }])
    const myrtle = workspace.mainPlan.facilities.dormitory_1.slots[3]!, durin = workspace.mainPlan.facilities.dormitory_2.slots[4]!
    myrtle.occupant = { kind: 'operator', operatorId: '桃金娘' }
    durin.occupant = { kind: 'operator', operatorId: '杜林' }
    const before = structuredClone(workspace)
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(before)
  })

  it('does not turn a self-recovery resting worker into a permanent keeper', () => {
    const inventory = compileOperatorInventory(fullCatalogIdleInventory()), records = inventoryOperatorRecords(inventory)
    const selfOnly = Object.values(records).find(operator => hasDormRecoverySkill(operator) && !isAoeDormKeeper(operator) && !isSingleDormKeeper(operator))
    expect(selfOnly).toBeDefined()
    const { workspace } = scene()
    const slot = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    slot.occupant = { kind: 'operator', operatorId: selfOnly!.charId }
    preserveExistingDormKeepers(workspace, inventory)
    expect(slot.dormitoryResident).toBeUndefined()
  })

  it.each(['group', 'extra-binding', 'free-candidate', 'operator-candidate', 'explicit-false'] as const)('retains %s semantics without inferring permanent residency', mode => {
    const { workspace, inventory } = scene()
    const slot = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    slot.occupant = { kind: 'operator', operatorId: '杜林' }
    if (mode === 'group') { slot.groupId = 'work-rest'; slot.replacements = ['Free'] }
    if (mode === 'extra-binding') slot.groupBindings = [{ groupId: 'work-rest', replacements: ['Free'], metadata: { original: true } }]
    if (mode === 'free-candidate') slot.replacements = ['Free']
    if (mode === 'operator-candidate') slot.replacements = ['桃金娘']
    if (mode === 'explicit-false') slot.dormitoryResident = false
    slot.metadata = { original: { mode, retained: true } }
    const before = structuredClone(workspace)
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(before)
  })

  it.each(['primary', 'replacement', 'additional-binding'] as const)('does not freeze a keeper referenced by an external %s role', mode => {
    const { workspace, inventory } = scene()
    const keeper = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    keeper.occupant = { kind: 'operator', operatorId: '杜林' }
    const manufacture = workspace.mainPlan.facilities.room_1_1
    manufacture.level = 1
    manufacture.slots = [{ occupant: { kind: 'empty' }, groupId: null, replacements: [] }]
    if (mode === 'primary') manufacture.slots[0]!.occupant = { kind: 'operator', operatorId: id('杜林') }
    if (mode === 'replacement') manufacture.slots[0]!.replacements = [id('杜林')]
    if (mode === 'additional-binding') manufacture.slots[0]!.groupBindings = [{ groupId: 'work-rest', replacements: [id('杜林')] }]
    const before = structuredClone(workspace)
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(before)
  })

  it('does not modify disabled dorms, nonoperator slots or explicit existing residency records', () => {
    const { workspace, inventory } = scene()
    const disabled = workspace.mainPlan.facilities.dormitory_1
    disabled.level = 0; disabled.slots[0]!.occupant = { kind: 'operator', operatorId: '杜林' }
    const resident = workspace.mainPlan.facilities.dormitory_2.slots[0]!
    resident.occupant = { kind: 'operator', operatorId: '桃金娘' }; resident.dormitoryResident = true
    resident.groupId = 'existing-explicit'; resident.replacements = ['Free']; resident.metadata = { keep: 'exact' }
    workspace.mainPlan.facilities.dormitory_2.slots[2]!.occupant = { kind: 'current' }
    workspace.mainPlan.facilities.dormitory_2.slots[3]!.occupant = { kind: 'empty' }
    const before = structuredClone(workspace)
    preserveExistingDormKeepers(workspace, inventory)
    expect(workspace).toEqual(before)
  })

  it('does not infer residency from an invalid inventory', () => {
    const { workspace } = scene(), slot = workspace.mainPlan.facilities.dormitory_1.slots[3]!
    slot.occupant = { kind: 'operator', operatorId: '杜林' }
    const before = structuredClone(workspace)
    preserveExistingDormKeepers(workspace, compileOperatorInventory([{ operator: '未知', elitePhase: 2, level: 90 }]))
    expect(workspace).toEqual(before)
  })

  it('protects only valid dormitory positions and leaves over-capacity imported tails untouched', () => {
    const { workspace, inventory } = scene(), dorm = workspace.mainPlan.facilities.dormitory_1
    dorm.slots[0]!.occupant = { kind: 'operator', operatorId: '杜林' }
    dorm.slots.push({ occupant: { kind: 'operator', operatorId: '桃金娘' }, groupId: null, replacements: [] })
    const tail = structuredClone(dorm.slots[5])
    preserveExistingDormKeepers(workspace, inventory)
    expect(dorm.slots[0]!.dormitoryResident).toBe(true)
    expect(dorm.slots[5]).toEqual(tail)
  })
})
