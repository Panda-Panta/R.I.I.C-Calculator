import { describe, expect, it, vi, afterEach } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import type { MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as output from './productionSingletons'
import * as morale from '../engine/morale'
import * as dormitory from '../engine/dormitoryRecovery'
import * as priorities from './mainRosterRecoveryPriorities'
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
const family = (candidate: { id: string }): string => candidate.id === 'recovery-fia-and-dorm-support' ? 'joint'
  : candidate.id.startsWith('recovery-dorm-') ? 'dorm' : candidate.id.startsWith('recovery-fia-two-groups') ? 'mixed' : 'fia'
const primaryGroup = ['阿罗玛', '槐琥'].map(id)
const secondaryGroup = ['乌尔比安', '幽灵鲨', '安哲拉', '歌蕾蒂娅'].map(id)
function orderedGroups(workspace: RosterWorkspace) {
  const rates = Object.fromEntries(Object.values(workspace.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot =>
    slot.occupant.kind === 'operator' ? [[id(slot.occupant.operatorId), 1]] : [])))
  primaryGroup.forEach((actor, index) => { rates[actor] = 3 - index })
  secondaryGroup.forEach((actor, index) => { rates[actor] = 4 - index })
  vi.spyOn(morale, 'currentMoraleRates').mockReturnValue({ rates, details: {}, unquantified: [] })
  return vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(draft => Object.values(draft.mainPlan.facilities)
    .flatMap(room => room.slots.flatMap(slot => slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []))
    .reduce((sum, actor) => sum + (primaryGroup.includes(actor) ? 1000 : secondaryGroup.includes(actor) ? 100 : 1), 0))
}

describe('bounded main-roster recovery proposals', () => {
  it.each([
    { maxCandidates: 2, families: ['fia', 'dorm'] },
    { maxCandidates: 3, families: ['fia', 'dorm', 'joint'] },
    { maxCandidates: 4, families: ['fia', 'dorm', 'joint', 'mixed'] },
  ])('gives available recovery families a turn within $maxCandidates proposals', ({ maxCandidates, families }) => {
    const workspace = fixture(), fullDomain = generate(workspace, full, { maxCandidates: 8 })
    expect(new Set(fullDomain.candidates.map(family))).toEqual(new Set(['fia', 'dorm', 'joint', 'mixed']))
    const result = generate(workspace, full, { maxCandidates })
    expect(result.candidates.map(family)).toEqual(families)
    expect(result.candidates[0]).toEqual(fullDomain.candidates.find(candidate => candidate.id === 'recovery-fia-whole-group'))
    const pureDorm = result.candidates.find(candidate => family(candidate) === 'dorm')!
    expect(targets(pureDorm.workspace)).toEqual(targets(workspace))
    const joint = result.candidates.find(candidate => family(candidate) === 'joint')
    if (joint) {
      const mixed = fullDomain.candidates.find(candidate => family(candidate) === 'mixed')
      expect(targets(joint.workspace)).toEqual(targets(mixed?.workspace ?? result.candidates[0]!.workspace))
      const onlyDorm = structuredClone(joint.workspace)
      onlyDorm.mainPlan.facilities.dormitory_1.slots[0]!.replacements = [...targets(workspace)]
      expect(onlyDorm).toEqual(pureDorm.workspace)
    }
  })

  it('recomputes all available families from a new winner without state or suppressing its existing Fia policy', () => {
    const workspace = fixture(), winner = generate(workspace, full, { maxCandidates: 8 }).candidates[0]!.workspace
    const before = structuredClone(winner), first = generate(winner, full, { maxCandidates: 4 }), second = generate(winner, full, { maxCandidates: 4 })
    expect(new Set(first.candidates.map(family))).toEqual(new Set(['fia', 'dorm', 'joint', 'mixed']))
    expect(first).toEqual(second)
    const dorm = first.candidates.find(candidate => family(candidate) === 'dorm')!
    expect(targets(dorm.workspace)).toEqual(targets(winner))
    expect(winner).toEqual(before)
  })

  it('reuses the budget for Fia proposals when dorm support is protected', () => {
    const workspace = fixture(), result = generate(workspace, full, { maxCandidates: 4, lockedPositions: new Set(['dormitory_1:1', 'dormitory_2:0']) })
    expect(result.candidates.length).toBeGreaterThan(1)
    expect(result.candidates.every(candidate => ['fia', 'mixed'].includes(family(candidate)))).toBe(true)
  })

  it('keeps all explicit original Fia and fixed-keeper locks when the budget is shared between families', () => {
    const workspace = fixture(), userBase = structuredClone(workspace)
    const lockedPositions = new Set(['dormitory_1:0', 'dormitory_1:1', 'dormitory_2:0'])
    expect(generate(workspace, full, { userBase, lockedPositions, maxCandidates: 4 }).candidates).toEqual([])
  })

  it('proposes different target memberships including a complete cross-room group, preserving every working field', () => {
    const workspace = fixture(), before = structuredClone(workspace), inventoryBefore = structuredClone(full)
    const result = generate(workspace, full, { maxCandidates: 8 })
    const fia = result.candidates.filter(candidate => candidate.id.startsWith('recovery-fia-') && !candidate.id.includes('and-dorm'))
    expect(fia.length).toBeGreaterThanOrEqual(2)
    expect(new Set(fia.map(candidate => targets(candidate.workspace).join('|'))).size).toBe(fia.length)
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
    const userBase = structuredClone(workspace)
    userBase.mainPlan.facilities.dormitory_1.slots[1]!.occupant = { kind: 'empty' }
    userBase.mainPlan.facilities.dormitory_2.slots[0]!.occupant = { kind: 'empty' }
    const options = mode === 'position' ? { lockedPositions: new Set(['dormitory_1:0']) }
      : { lockedOperators: new Set([mode === 'operator' ? '菲亚梅塔' : '阿罗玛']) }
    const result = generate(workspace, full, { ...options, maxCandidates: 8, userBase })
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
    userBase.mainPlan.facilities.dormitory_1.slots[1]!.occupant = { kind: 'empty' }
    userBase.mainPlan.facilities.dormitory_2.slots[0]!.occupant = { kind: 'empty' }
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

  it('offers a different native Fia priority order for the same target membership', () => {
    const workspace = fixture(), rates = Object.fromEntries(['阿罗玛', '槐琥', '砾', '乌尔比安', '幽灵鲨', '安哲拉', '歌蕾蒂娅', '阿米娅', '薇薇安娜'].map(name => [id(name), 1]))
    vi.spyOn(morale, 'currentMoraleRates').mockReturnValue({ rates, details: {}, unquantified: [] })
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements = ['歌蕾蒂娅', '安哲拉', '幽灵鲨', '乌尔比安'].map(id)
    const original = [...targets(workspace)], result = generate(workspace, full, { maxCandidates: 8 })
    const reordered = result.candidates.filter(candidate => candidate.id.startsWith('recovery-fia-') &&
      membership(targets(candidate.workspace)) === membership(original))
    expect(reordered.length).toBeGreaterThan(0)
    for (const candidate of reordered) expect(targets(candidate.workspace)).not.toEqual(original)
    expect(targets(workspace)).toEqual(original)
  })

  it('preserves both native priority directions for the top two complete groups within eight proposals', () => {
    const workspace = fixture(), before = structuredClone(workspace)
    orderedGroups(workspace)
    const result = generate(workspace, full, { maxCandidates: 8 })
    const mixed = result.candidates.filter(candidate => family(candidate) === 'mixed')
    expect(mixed.map(candidate => targets(candidate.workspace))).toEqual([
      [...primaryGroup, ...secondaryGroup], [...secondaryGroup, ...primaryGroup],
    ])
    expect(result.candidates.length).toBeLessThanOrEqual(8)
    expect(workspace).toEqual(before)
  })

  it('prioritizes the complementary group when the current winner already has the complete primary group', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements = [...primaryGroup]
    orderedGroups(workspace)
    const result = generate(workspace, full, { maxCandidates: 8 })
    expect(result.candidates.filter(candidate => family(candidate) === 'mixed').map(candidate => targets(candidate.workspace)))
      .toEqual([[...secondaryGroup, ...primaryGroup], [...primaryGroup, ...secondaryGroup]])
    expect(targets(generate(workspace, full, { maxCandidates: 4 }).candidates.find(candidate => family(candidate) === 'mixed')!.workspace))
      .toEqual([...secondaryGroup, ...primaryGroup])
  })

  it('keeps the one-proposal complete-group fast path without evaluating any changed dorm support layout', () => {
    const workspace = fixture(), score = orderedGroups(workspace)
    const result = generate(workspace, full, { maxCandidates: 1 })
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['recovery-fia-whole-group'])
    expect(targets(result.candidates[0]!.workspace)).toEqual(primaryGroup)
    const dorms = (draft: RosterWorkspace) => Object.values(draft.mainPlan.facilities).filter(room => room.type === 'dormitory')
    for (const [draft] of score.mock.calls) expect(dorms(draft)).toEqual(dorms(workspace))
    expect(score.mock.calls.length).toBeGreaterThan(0)
  })

  it('builds the actual mixed-priority and support compound before either parent needs to win', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements = [...primaryGroup]
    orderedGroups(workspace)
    const result = generate(workspace, full, { maxCandidates: 4 })
    const mixed = result.candidates.find(candidate => family(candidate) === 'mixed')!
    const dorm = result.candidates.find(candidate => family(candidate) === 'dorm')!
    const joint = result.candidates.find(candidate => family(candidate) === 'joint')!
    const expected = structuredClone(dorm.workspace)
    expected.mainPlan.facilities.dormitory_1.slots[0]!.replacements = [...targets(mixed.workspace)]
    expect(joint.workspace).toEqual(expected)
    expect(targets(joint.workspace)).toEqual([...secondaryGroup, ...primaryGroup])
  })

  it('keeps one mixed priority exploration in the default four-proposal budget', () => {
    const workspace = fixture()
    orderedGroups(workspace)
    const result = generate(workspace, full)
    expect(result.candidates.map(family)).toEqual(['fia', 'dorm', 'joint', 'mixed'])
  })

  it('protects original user Fia and fixed dorm residents without requiring repeated explicit locks', () => {
    const workspace = fixture(), userBase = structuredClone(workspace), before = structuredClone(workspace)
    const result = generate(workspace, full, { userBase, maxCandidates: 8 })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_FIA_PROTECTED')).toBe(true)
    expect(workspace).toEqual(before)
    expect(userBase).toEqual(before)
  })

  it.each(['fia-priority', 'keeper', 'keeper-metadata'] as const)('rejects an upstream change to original recovery facts without explicit locks (%s)', change => {
    const userBase = fixture(), workspace = structuredClone(userBase)
    if (change === 'fia-priority') workspace.mainPlan.facilities.dormitory_1.slots[0]!.replacements.reverse()
    if (change === 'keeper') workspace.mainPlan.facilities.dormitory_2.slots[0]!.occupant = { kind: 'empty' }
    if (change === 'keeper-metadata') workspace.mainPlan.facilities.dormitory_2.slots[0]!.metadata = { changed: true }
    const result = generate(workspace, full, { userBase, maxCandidates: 8 })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_ORIGINAL_LOCK_CHANGED')).toBe(true)
  })

  it('passes actual full-base G to the support ranking and reserves both the no-loss and maximum-recovery choices', () => {
    const workspace = fixture()
    workspace.mainPlan.facilities.dormitory_1.slots[1] = { ...slot('黑'), dormitoryResident: true }
    const used = new Set(Object.values(workspace.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot => [
      ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...slot.replacements.map(id),
    ])))
    for (const extra of ['波登可', '冰酿']) used.add(id(extra))
    const inventory = compileOperatorInventory(full.operators.filter(operator => used.has(operator.charId)).map(operator => ({
      operator: operator.charId, elitePhase: operator.elitePhase, level: operator.level,
    })))
    const ranking = vi.spyOn(priorities, 'rankRecoverySupportProposals')
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(draft => Object.values(draft.mainPlan.facilities)
      .some(room => room.slots.some(slot => slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === id('桃金娘'))) ? 100 : 100 - 17.109)
    vi.spyOn(dormitory, 'evaluateDormitoryRecovery').mockImplementation((config, _roomIndex, moods) => {
      const residents = config.facilityOperatorIds.dormitories.flat()
      const has = (name: string) => residents.includes(id(name))
      const total = has('冰酿') && !has('桃金娘') ? 18.94 : has('波登可') ? 18.69 : 10
      const probes = [...moods].filter(([, mood]) => mood === 10).map(([actor]) => actor)
      return { rates: new Map(probes.map(actor => [actor, total / 2 / probes.length])), details: new Map(), unquantified: [] }
    })
    const before = structuredClone(workspace), result = generate(workspace, inventory, { maxCandidates: 2, lockedOperators: new Set(['菲亚梅塔']) })
    expect(result.candidates.map(candidate => candidate.id)).toEqual([
      `recovery-dorm-support-dormitory_1-1-${id('波登可')}`, `recovery-dorm-support-dormitory_2-0-${id('冰酿')}`,
    ])
    expect(ranking).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ candidate: expect.objectContaining({ id: `recovery-dorm-support-dormitory_1-1-${id('波登可')}` }), supportScore: expect.closeTo(18.69, 7), primaryScore: 100 }),
      expect.objectContaining({ candidate: expect.objectContaining({ id: `recovery-dorm-support-dormitory_2-0-${id('波登可')}` }), supportScore: expect.closeTo(18.69, 7), primaryScore: 100 - 17.109 }),
    ]), 100)
    expect(workspace).toEqual(before)
  })

  it('keeps an unavailable full-base support score unknown when calling the shared priority helper', () => {
    const ranking = vi.spyOn(priorities, 'rankRecoverySupportProposals')
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = generate(fixture(), full, { maxCandidates: 2, lockedOperators: new Set(['菲亚梅塔']) })
    expect(result.candidates).toHaveLength(2)
    expect(ranking).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ primaryScore: null }),
    ]), null)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'RECOVERY_SUPPORT_PRIMARY_UNKNOWN')).toBe(true)
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
