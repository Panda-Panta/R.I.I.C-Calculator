import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, MowerSlot } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { applyGeneratedRecoveryPolicy } from './generatedRecoveryPolicy'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { validatePhysicalRoster } from './rosterDraft'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { generateProductionShiftAlternatives } from './jointBackupMainAlternatives'

const slot = (main: string, backup: string, group = 'local'): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(main) }, groupId: group, replacements: [id(backup)],
})
const held = (names: string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(row => names.some(name => id(name) === row.operator)))
function fixture(level = 2, roomId: MowerRoomId = 'room_1_1') {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  workspace.mainPlan.facilities.room_1_3.level = 3
  workspace.mainPlan.facilities.dormitory_1.level = 5
  workspace.mainPlan.facilities.dormitory_1.slots = [
    { occupant: { kind: 'operator', operatorId: id('闪灵') }, groupId: null, replacements: [] },
    ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] })),
  ]
  const room = workspace.mainPlan.facilities[roomId]
  room.type = 'manufacture'; room.product = 'gold'; room.level = level
  room.slots = ['砾', '斑点', '夜烟'].slice(0, level).map((main, index) => slot(main, ['香草', '维伊', '梅尔'][index]!))
  const inventory = held(['砾', '斑点', '夜烟', '香草', '维伊', '梅尔', '闪灵', '调香师', '塞雷娅', '雷蛇',
    '能天使', '伺夜', '空弦', '深巡', '但书', '龙舌兰', '阿罗玛'])
  return { workspace, inventory, roomId, candidates: [{ id: 'source', workspace }] }
}

describe('production main/ordinary-relief complement proposals', () => {
  it.each([1, 2, 3])('swaps a complete %i-seat crew without touching configuration, data or metadata', level => {
    const input = fixture(level), room = input.workspace.mainPlan.facilities[input.roomId]
    room.slots[0]!.metadata = { nested: { order: [3, 1] }, user: true }
    input.workspace.mainPlan.conf.userCustom = { untouched: ['a', 'b'] }
    input.workspace.compatibility.unrecognizedFields.secretModel = { retained: 9 }
    const before = structuredClone(input.workspace), inventoryBefore = structuredClone(input.inventory)
    const result = generateProductionShiftAlternatives(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(1)
    const proposal = result.candidates[0]!.workspace, changed = proposal.mainPlan.facilities[input.roomId]
    changed.slots.forEach((position, index) => {
      const original = room.slots[index]!
      expect(position.occupant).toEqual({ kind: 'operator', operatorId: original.replacements[0] })
      expect(position.replacements).toEqual([original.occupant.kind === 'operator' ? original.occupant.operatorId : ''])
      expect(position.groupId).toBe(original.groupId)
      expect(position.metadata).toEqual(original.metadata)
    })
    expect(proposal.mainPlan.conf).toEqual(before.mainPlan.conf)
    expect(proposal.compatibility).toEqual(before.compatibility)
    expect(proposal.mainPlan.facilities.dormitory_1).toEqual(before.mainPlan.facilities.dormitory_1)
    expect(validatePhysicalRoster(proposal)).toEqual([])
    expect(recoveryGroupCapacityIssues(proposal)).toEqual([])
    expect(applyGeneratedWarmupPolicy(structuredClone(proposal), input.inventory).valid).toBe(true)
    const recovery = structuredClone(proposal); applyGeneratedRecoveryPolicy(recovery)
    expect(recovery.mainPlan.conf).toEqual(proposal.mainPlan.conf)
    expect(input.workspace).toEqual(before)
    expect(input.inventory).toEqual(inventoryBefore)
    expect(proposal).not.toBe(input.workspace)
  })

  it('preserves exact virtual run-order references and their order while swapping trading crews', () => {
    const input = fixture(2, 'room_3_1'), room = input.workspace.mainPlan.facilities.room_3_1
    room.type = 'trading'; room.product = 'money'
    room.slots = [slot('能天使', '空弦'), slot('伺夜', '深巡')]
    room.slots[0]!.replacements = ['但书', '空弦', '龙舌兰']
    room.slots[0]!.metadata = { runOrderReference: true }
    const result = generateProductionShiftAlternatives(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(1)
    const changed = result.candidates[0]!.workspace.mainPlan.facilities.room_3_1
    expect(changed.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('空弦') })
    expect(changed.slots[0]!.replacements).toEqual(['但书', id('能天使'), '龙舌兰'])
    expect(changed.slots[0]!.metadata).toEqual(room.slots[0]!.metadata)
  })

  it.each(['砾', '香草'])('honors a locked %s alias on either side of the swap', name => {
    const input = fixture()
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory, { lockedOperators: new Set([name]) }).candidates).toEqual([])
  })
  it.each(['room_1_1:1', 'room_1_1_1'])('freezes the whole room for position lock %s, keeping lock inputs unchanged', position => {
    const input = fixture(), locks = new Set([position])
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory, { lockedPositions: locks }).candidates).toEqual([])
    expect([...locks]).toEqual([position])
  })
  it('ignores a lock on an unmoved virtual runner reference', () => {
    const input = fixture(1, 'room_3_1'), room = input.workspace.mainPlan.facilities.room_3_1
    room.type = 'trading'; room.product = 'money'; room.slots = [slot('能天使', '空弦')]
    room.slots[0]!.replacements.unshift('但书')
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory, { lockedOperators: new Set(['但书']) }).candidates).toHaveLength(1)
  })

  it('does not invent an absent actor or use invalid inventory', () => {
    const input = fixture(1)
    const missing = { ...input.inventory, operators: input.inventory.operators.filter(operator => operator.name !== '香草') }
    expect(generateProductionShiftAlternatives(input.candidates, missing).candidates).toEqual([])
    expect(generateProductionShiftAlternatives(input.candidates, { ...input.inventory, valid: false }).candidates).toEqual([])
  })
  it('rejects repeated physical backups and backups already occupying another room', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements = [id('香草')]
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    input.workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements = [id('维伊')]
    input.workspace.mainPlan.facilities.central.level = 1
    input.workspace.mainPlan.facilities.central.slots = [{ ...slot('香草', '调香师', 'separate') }]
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
  })
  it.each(['binding', 'cross-room'] as const)('skips a complex %s group without changing it', mode => {
    const input = fixture()
    if (mode === 'binding') input.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupBindings = [{ groupId: 'second', replacements: [id('调香师')] }]
    else input.workspace.mainPlan.facilities.room_1_3.slots = [slot('塞雷娅', '雷蛇')]
    const before = structuredClone(input.workspace)
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    expect(input.workspace).toEqual(before)
  })
  it('requires a complete room and exactly one ordinary backup per seat', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.room_1_1.slots.pop()
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    input.workspace.mainPlan.facilities.room_1_1.slots.push(slot('斑点', '维伊'))
    input.workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements.push(id('梅尔'))
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
  })
  it('rejects an existing backup plan instead of silently treating it as a pure main table', () => {
    const input = fixture()
    input.workspace.compatibility.backupPlans = [{ name: 'user-conditional-table', unchanged: true }]
    const before = structuredClone(input.workspace)
    const result = generateProductionShiftAlternatives(input.candidates, input.inventory)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'SHIFT_ALTERNATIVE_NOT_PURE_MAIN')).toBe(true)
    expect(input.workspace).toEqual(before)
  })
  it('does not split an actual cross-room core merely because its shift group labels differ', () => {
    const input = fixture(1)
    input.workspace.mainPlan.facilities.room_1_1.slots = [slot('迷迭香', '香草', 'target')]
    input.workspace.mainPlan.facilities.contact.level = 1
    input.workspace.mainPlan.facilities.contact.slots = [slot('絮雨', '调香师', 'external')]
    const inventory = held(['迷迭香', '香草', '絮雨', '调香师', '闪灵'])
    const result = generateProductionShiftAlternatives(input.candidates, inventory)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'SHIFT_ALTERNATIVE_CORE_SPLIT')).toBe(true)
  })
  it('rejects insufficient recovery beds, including a single ungrouped worker', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.dormitory_1.slots.splice(2)
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    const singleton = fixture(1)
    singleton.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId = null
    singleton.workspace.mainPlan.facilities.dormitory_1.slots.splice(1)
    expect(generateProductionShiftAlternatives(singleton.candidates, singleton.inventory).candidates).toEqual([])
  })

  it('uses the actual incoming warmup stage and rejects a conf change instead of applying it', () => {
    const input = fixture(1)
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('阿罗玛')]
    const low = { ...input.inventory, operators: input.inventory.operators.filter(operator => operator.name !== '阿罗玛').concat(compileOperatorInventory([{ operator: '阿罗玛', elitePhase: 0, level: 1 }]).operators) }
    expect(generateProductionShiftAlternatives(input.candidates, low).candidates).toHaveLength(1)
    const before = structuredClone(input.workspace)
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    expect(input.workspace).toEqual(before)
    input.workspace.mainPlan.conf.exhaust_require = [id('阿罗玛')]
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toHaveLength(1)
  })
  it('rejects moving a warmup primary into an ordinary low role even with an exhaustion flag', () => {
    const input = fixture(1)
    input.workspace.mainPlan.facilities.room_1_1.slots[0] = slot('阿罗玛', '香草')
    input.workspace.mainPlan.conf.exhaust_require = [id('阿罗玛')]
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
  })
  it('rejects a newly required full-recovery policy and accepts the same existing policy unchanged', () => {
    const input = fixture()
    input.workspace.mainPlan.conf.operator_mood_limits = { 香草: { lower: 12, upper: 24 } }
    const before = structuredClone(input.workspace)
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates).toEqual([])
    expect(input.workspace).toEqual(before)
    input.workspace.mainPlan.conf.rest_in_full = [id('香草')]
    const result = generateProductionShiftAlternatives(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.workspace.mainPlan.conf).toEqual(input.workspace.mainPlan.conf)
  })
  it('deduplicates whole workspaces canonically, not merely seats, and excludes existing main candidates', () => {
    const input = fixture(1), duplicate = structuredClone(input.workspace)
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.metadata = { a: 1, b: 2 }
    duplicate.mainPlan.facilities.room_1_1.slots[0]!.metadata = { b: 2, a: 1 }
    const one = generateProductionShiftAlternatives([...input.candidates, { id: 'duplicate', workspace: duplicate }], input.inventory)
    expect(one.candidates).toHaveLength(1)
    const complementary = structuredClone(input.workspace)
    complementary.mainPlan.facilities.room_1_1.slots[0] = { ...complementary.mainPlan.facilities.room_1_1.slots[0]!, occupant: { kind: 'operator', operatorId: id('香草') }, replacements: [id('砾')] }
    expect(generateProductionShiftAlternatives([...input.candidates, { id: 'complement', workspace: complementary }], input.inventory).candidates).toEqual([])
    duplicate.mainPlan.facilities.room_1_1.slots[0]!.metadata = { a: 1, b: 3 }
    expect(generateProductionShiftAlternatives([...input.candidates, { id: 'different-meta', workspace: duplicate }], input.inventory).candidates).toHaveLength(2)
  })
  it('uses a default of two, supports a lower bound, and imposes a fixed hard output ceiling', () => {
    const input = fixture(1)
    const sources = Array.from({ length: 20 }, (_, index) => ({ id: `main-${index}`, workspace: { ...structuredClone(input.workspace), name: `different-${index}` } }))
    expect(generateProductionShiftAlternatives(sources, input.inventory).candidates).toHaveLength(2)
    expect(generateProductionShiftAlternatives(sources, input.inventory, { maxCandidates: 1 }).candidates).toHaveLength(1)
    expect(generateProductionShiftAlternatives(sources, input.inventory, { maxCandidates: 0 }).candidates).toEqual([])
    const bounded = generateProductionShiftAlternatives(sources, input.inventory, { maxCandidates: 1000 })
    expect(bounded.candidates.length).toBeGreaterThanOrEqual(2)
    expect(bounded.candidates.length).toBeLessThanOrEqual(8)
    expect(generateProductionShiftAlternatives(sources, input.inventory, { maxCandidates: Number.NaN }).candidates).toEqual([])
  })
})
