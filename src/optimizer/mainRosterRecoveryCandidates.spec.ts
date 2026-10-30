import { describe, expect, it, vi, afterEach } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import type { MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as output from './productionSingletons'
import * as morale from '../engine/morale'
import { generateMainRosterRecoveryCandidates as generate } from './mainRosterRecoveryCandidates'

afterEach(() => vi.restoreAllMocks())

const full = compileOperatorInventory(fullCatalogIdleInventory())
function slot(name: string, groupId: string | null = null, replacements: string[] = []): MowerSlot {
  return { occupant: { kind: 'operator', operatorId: id(name) }, groupId, replacements: replacements.map(id) }
}
function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const gold = workspace.mainPlan.facilities.room_1_1
  gold.type = 'manufacture'; gold.product = 'gold'; gold.level = 3
  gold.slots = [slot('阿罗玛', 'aroma', ['温米']), slot('槐琥', 'aroma', ['清流']), slot('砾', 'gravel', ['斑点'])]
  const exp = workspace.mainPlan.facilities.room_2_1
  exp.type = 'manufacture'; exp.product = 'exp'; exp.level = 3
  exp.slots = [slot('乌尔比安', 'hunters', ['断罪者']), slot('幽灵鲨', 'hunters', ['红豆']), slot('安哲拉', 'hunters', ['白雪'])]
  const central = workspace.mainPlan.facilities.central
  central.level = 3; central.slots = [slot('歌蕾蒂娅', 'hunters', ['临光']), slot('阿米娅', null, ['凯尔希']), slot('薇薇安娜', null, ['炎熔'])]
  for (const roomId of ['dormitory_1', 'dormitory_2'] as const) {
    const room = workspace.mainPlan.facilities[roomId]
    room.level = 1; room.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  }
  workspace.mainPlan.facilities.dormitory_1.slots[0] = slot('菲亚梅塔', null, ['砾', '阿罗玛'])
  workspace.mainPlan.facilities.dormitory_1.slots[1] = { ...slot('杜林'), dormitoryResident: true }
  workspace.mainPlan.facilities.dormitory_2.slots[0] = { ...slot('桃金娘'), dormitoryResident: true }
  workspace.mainPlan.conf.custom_fiammetta_threshold = 0.37
  workspace.mainPlan.conf.rest_in_full = [id('阿罗玛')]
  return workspace
}
const targets = (workspace: RosterWorkspace): string[] => workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements.map(id)
const membership = (members: string[]): string => [...new Set(members)].sort().join('|')
const freeCounts = (workspace: RosterWorkspace) => Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory')
  .map(room => room.slots.filter(slot => slot.occupant.kind === 'free').length)
const working = (workspace: RosterWorkspace) => Object.fromEntries(Object.values(workspace.mainPlan.facilities)
  .filter(room => room.type !== 'dormitory').map(room => [room.roomId, room]))

describe('bounded main-roster recovery proposals', () => {
  it('proposes different target memberships including a complete cross-room group, preserving every working field', () => {
    const workspace = fixture(), before = structuredClone(workspace), inventoryBefore = structuredClone(full)
    const result = generate(workspace, full, { maxCandidates: 8 })
    const fia = result.candidates.filter(candidate => candidate.id.startsWith('recovery-fia-') && !candidate.id.includes('and-dorm'))
    expect(fia.length).toBeGreaterThanOrEqual(2)
    expect(new Set(fia.map(candidate => membership(targets(candidate.workspace)))).size).toBe(fia.length)
    expect(fia.some(candidate => membership(targets(candidate.workspace)) === membership(['乌尔比安', '幽灵鲨', '安哲拉', '歌蕾蒂娅'].map(id)))).toBe(true)
    const hunters = new Set(['乌尔比安', '幽灵鲨', '安哲拉', '歌蕾蒂娅'].map(id))
    expect(fia.some(candidate => targets(candidate.workspace).every(operator => !hunters.has(operator)))).toBe(true)
    for (const candidate of result.candidates) {
      expect(working(candidate.workspace)).toEqual(working(before))
      expect(candidate.workspace.mainPlan.conf).toEqual(before.mainPlan.conf)
      expect(candidate.workspace.compatibility).toEqual(before.compatibility)
      expect(freeCounts(candidate.workspace)).toEqual(freeCounts(before))
    }
    expect(workspace).toEqual(before)
    expect(full).toEqual(inventoryBefore)
  })

  it.each(['position', 'operator', 'target-reference'] as const)('retains a locked Fia list exactly (%s)', mode => {
    const workspace = fixture(), original = structuredClone(workspace.mainPlan.facilities.dormitory_1.slots[0])
    const options = mode === 'position' ? { lockedPositions: new Set(['dormitory_1:0']) }
      : { lockedOperators: new Set([mode === 'operator' ? '菲亚梅塔' : '阿罗玛']) }
    const result = generate(workspace, full, { ...options, maxCandidates: 8, userBase: workspace })
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_FIA_PROTECTED')).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect(candidate.workspace.mainPlan.facilities.dormitory_1.slots[0]).toEqual(original)
  })

  it('does not propagate an upstream change to an original locked Fia list', () => {
    const userBase = fixture(), workspace = structuredClone(userBase)
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements.reverse()
    const result = generate(workspace, full, { userBase, lockedPositions: new Set(['dormitory_1:0']) })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_ORIGINAL_LOCK_CHANGED')).toBe(true)
  })

  it('does not propagate a removed locked resident or changed empty locked slot', () => {
    const userBase = fixture(), workspace = structuredClone(userBase)
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'empty' }
    expect(generate(workspace, full, { userBase, lockedPositions: new Set(['dormitory_1:0']) }).candidates).toEqual([])
    const other = fixture(), changed = structuredClone(other)
    other.mainPlan.facilities.dormitory_2.slots[4]!.occupant = { kind: 'empty' }
    expect(generate(changed, full, { userBase: other, lockedPositions: new Set(['dormitory_2:4']) }).candidates).toEqual([])
  })

  it('accepts a generated Fia reference to an originally locked worker while keeping its list protected', () => {
    const workspace = fixture(), userBase = structuredClone(workspace)
    userBase.mainPlan.facilities.dormitory_1.slots[0] = { occupant: { kind: 'empty' }, groupId: null, replacements: [] }
    const result = generate(workspace, full, { userBase, lockedPositions: new Set(['room_1_1:2']), lockedOperators: new Set(['砾']) })
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_ORIGINAL_LOCK_CHANGED')).toBe(false)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.workspace.mainPlan.facilities.room_1_1.slots[2]).toEqual(userBase.mainPlan.facilities.room_1_1.slots[2])
      expect(targets(candidate.workspace)).toEqual(targets(workspace))
    }
  })

  it('uses the actual E0 Fia exchange skill without requiring a promotion', () => {
    const workspace = fixture(), inventory = compileOperatorInventory(full.operators.map(operator => ({
      operator: operator.charId, elitePhase: operator.charId === id('菲亚梅塔') ? 0 : operator.elitePhase,
      level: operator.charId === id('菲亚梅塔') ? 1 : operator.level,
    })))
    expect(inventory.operators.find(operator => operator.charId === id('菲亚梅塔'))!.skills.some(skill => skill.buffId.startsWith('dorm_exchangeAp['))).toBe(true)
    const result = generate(workspace, inventory, { maxCandidates: 8 })
    expect(result.candidates.some(candidate => candidate.id.startsWith('recovery-fia-'))).toBe(true)
  })

  it('keeps fixed keeper and dynamic beds protected by locks, bindings and original metadata', () => {
    const workspace = fixture(), first = workspace.mainPlan.facilities.dormitory_1.slots[1]!, second = workspace.mainPlan.facilities.dormitory_2.slots[0]!
    first.metadata = { locked: true, original: 'fixed-keeper' }
    second.groupBindings = [{ groupId: 'fixed', replacements: ['Free'] }]
    const before = structuredClone(workspace)
    const result = generate(workspace, full, { lockedPositions: new Set(['dormitory_1:4']) })
    for (const candidate of result.candidates) {
      expect(candidate.workspace.mainPlan.facilities.dormitory_1.slots[1]).toEqual(before.mainPlan.facilities.dormitory_1.slots[1])
      expect(candidate.workspace.mainPlan.facilities.dormitory_2.slots[0]).toEqual(before.mainPlan.facilities.dormitory_2.slots[0])
      expect(candidate.workspace.mainPlan.facilities.dormitory_1.slots[4]).toEqual(before.mainPlan.facilities.dormitory_1.slots[4])
    }
    expect(result.candidates.some(candidate => candidate.id.startsWith('recovery-dorm'))).toBe(false)
  })

  it('offers finite support layouts with unique actual occupants and no ordinary-backup theft', () => {
    const workspace = fixture(), result = generate(workspace, full, { maxCandidates: 8 })
    const supports = result.candidates.filter(candidate => candidate.id.startsWith('recovery-dorm'))
    expect(supports.length).toBeGreaterThan(0)
    expect(supports.length).toBeLessThanOrEqual(2)
    const backups = new Set(Object.values(workspace.mainPlan.facilities).filter(room => room.type !== 'dormitory')
      .flatMap(room => room.slots.flatMap(slot => slot.replacements.map(id))))
    for (const candidate of supports) {
      const occupants = Object.values(candidate.workspace.mainPlan.facilities).filter(room => room.level > 0)
        .flatMap(room => room.slots.slice(0, facilityCapacity(room.type, room.level)))
        .flatMap(slot => slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : [])
      expect(new Set(occupants).size).toBe(occupants.length)
      expect(occupants.every(operator => full.operators.some(owned => owned.charId === operator))).toBe(true)
      expect(freeCounts(candidate.workspace)).toEqual(freeCounts(workspace))
      for (const room of Object.values(candidate.workspace.mainPlan.facilities).filter(room => room.type === 'dormitory')) {
        expect(room.slots.length).toBe(workspace.mainPlan.facilities[room.roomId].slots.length)
        for (const slot of room.slots) if (slot.occupant.kind === 'operator') expect(backups.has(id(slot.occupant.operatorId))).toBe(false)
      }
    }
  })

  it('never imports an unowned or E0 Myrtle recovery skill into support layouts', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.dormitory_2.slots[0] = { ...slot('安比尔'), dormitoryResident: true }
    const used = new Set(Object.values(workspace.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot => [
      ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...slot.replacements.map(id),
    ])))
    const entries: OwnedOperatorInput[] = full.operators.filter(operator => used.has(operator.charId)).map(operator => ({ operator: operator.charId, elitePhase: operator.elitePhase, level: operator.level }))
    entries.push({ operator: '桃金娘', elitePhase: 0, level: 1 })
    const inventory = compileOperatorInventory(entries), result = generate(workspace, inventory, { maxCandidates: 8 })
    for (const candidate of result.candidates) for (const room of Object.values(candidate.workspace.mainPlan.facilities)) {
      for (const slot of room.slots) if (slot.occupant.kind === 'operator') expect(id(slot.occupant.operatorId)).not.toBe(id('桃金娘'))
    }
  })

  it('does not convert actual empty positions into recovery beds or propose support without a Free bed', () => {
    const workspace = fixture()
    for (const room of Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory')) {
      for (const slot of room.slots) if (slot.occupant.kind === 'free') slot.occupant = { kind: 'empty' }
    }
    const before = structuredClone(workspace)
    expect(generate(workspace, full, { lockedOperators: new Set(['菲亚梅塔']) }).candidates).toEqual([])
    expect(workspace).toEqual(before)
  })

  it('does not move a fixed keeper that is also reserved as an ordinary replacement', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.room_1_1.slots[2]!.replacements.push(id('桃金娘'))
    const before = structuredClone(workspace.mainPlan.facilities.dormitory_2.slots[0])
    const result = generate(workspace, full, { maxCandidates: 8 })
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect(candidate.workspace.mainPlan.facilities.dormitory_2.slots[0]).toEqual(before)
  })

  it.each([0, 1, 3, 8, 100])('respects a budget of %s, with distinct independent snapshots', maxCandidates => {
    const workspace = fixture(), result = generate(workspace, full, { maxCandidates })
    expect(result.candidates.length).toBeLessThanOrEqual(Math.min(8, maxCandidates))
    expect(new Set(result.candidates.map(candidate => JSON.stringify(candidate.workspace))).size).toBe(result.candidates.length)
    if (maxCandidates > 8) expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_LIMIT_CLAMPED')).toBe(true)
    if (maxCandidates > 0) expect(result.candidates.length).toBeGreaterThan(0)
    if (result.candidates.length > 1) {
      const unchanged = structuredClone(result.candidates[1]!.workspace)
      result.candidates[0]!.workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements.push('extra-local-reference')
      expect(result.candidates[1]!.workspace).toEqual(unchanged)
    }
  })

  it.each([-1, NaN, Infinity, 1.5])('rejects invalid budget %s before static scoring', maxCandidates => {
    const score = vi.spyOn(output, 'productionWorkspaceHourlyScore')
    expect(generate(fixture(), full, { maxCandidates }).candidates).toEqual([])
    expect(score).not.toHaveBeenCalled()
  })

  it('does not turn an unknown production marginal into a zero-score dominance claim', () => {
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = generate(fixture(), full)
    expect(result.candidates.some(candidate => candidate.id.startsWith('recovery-fia-'))).toBe(true)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_GROUP_VALUE_UNKNOWN')).toBe(true)
  })

  it('retains the original order without spending a proposal on a membership-only permutation', () => {
    const workspace = fixture(), rates = Object.fromEntries(['阿罗玛', '槐琥', '砾', '乌尔比安', '幽灵鲨', '安哲拉', '歌蕾蒂娅', '阿米娅', '薇薇安娜'].map(name => [id(name), 1]))
    vi.spyOn(morale, 'currentMoraleRates').mockReturnValue({ rates, details: {}, unquantified: [] })
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements = ['歌蕾蒂娅', '安哲拉', '幽灵鲨', '乌尔比安'].map(id)
    const original = membership(targets(workspace)), result = generate(workspace, full, { maxCandidates: 8 })
    for (const candidate of result.candidates.filter(candidate => candidate.id.startsWith('recovery-fia-'))) expect(membership(targets(candidate.workspace))).not.toBe(original)
  })

  it.each(['invalid', 'unowned', 'duplicate', 'over-capacity', 'current'] as const)('returns no proposals for %s physical input', problem => {
    const workspace = fixture()
    let inventory = full
    if (problem === 'invalid') inventory = compileOperatorInventory([{ operator: 'unknown', elitePhase: 0, level: 1 }])
    if (problem === 'unowned') inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(operator => operator.operator !== id('阿罗玛')))
    if (problem === 'duplicate') workspace.mainPlan.facilities.room_1_1.slots[2] = slot('阿罗玛')
    if (problem === 'over-capacity') workspace.mainPlan.facilities.room_1_1.slots.push(slot('夜烟'))
    if (problem === 'current') workspace.mainPlan.facilities.room_1_1.slots[2]!.occupant = { kind: 'current' }
    const result = generate(workspace, inventory)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns no candidates when there is neither a usable Fia nor a movable fixed keeper', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'empty' }
    for (const room of Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory')) for (const slot of room.slots) {
      if (slot.occupant.kind === 'operator') slot.metadata = { preserve: true }
    }
    expect(generate(workspace, full).candidates).toEqual([])
  })
})
