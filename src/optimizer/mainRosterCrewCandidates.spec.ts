import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { physicalBackupOperatorIds } from './combinationModel'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'
import * as production from './productionSingletons'
import { generateMainRosterCrewCandidates } from './mainRosterCrewCandidates'

const slot = (primary: string, relief?: string): MowerSlot => ({ occupant: { kind: 'operator', operatorId: id(primary) }, groupId: null, replacements: relief ? [id(relief)] : [] })
const held = (names: readonly string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(row => names.some(name => id(name) === row.operator)))
const actors = (workspace: RosterWorkspace, roomId: MowerRoomId = 'room_1_1', relief = false) => workspace.mainPlan.facilities[roomId].slots
  .flatMap(position => relief ? physicalBackupOperatorIds(workspace.mainPlan.facilities[roomId], position) : position.occupant.kind === 'operator' ? [id(position.occupant.operatorId)] : [])
const sorted = (names: readonly string[]) => names.map(id).sort()

function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(workspace.mainPlan.facilities.room_1_1, { level: 3, product: 'gold', slots: [slot('克洛丝', '卡缇'), slot('砾', '夜烟'), slot('清流', '斑点')] })
  const power = workspace.mainPlan.facilities.room_1_3; power.level = 3; power.slots = [slot('Lancet-2')]
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  const dorm = workspace.mainPlan.facilities.dormitory_1; dorm.level = 5
  dorm.slots = [slot('安赛尔'), ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))]
  const inventory = held(['克洛丝', '砾', '清流', '卡缇', '夜烟', '斑点', '温蒂', '异客', 'Lancet-2', '安赛尔'])
  expect(applyGeneratedWarmupPolicy(workspace, inventory).valid).toBe(true)
  expect(validatePhysicalRoster(workspace)).toEqual([])
  const userBase = structuredClone(workspace)
  userBase.mainPlan.facilities.room_1_1.slots = Array.from({ length: 3 }, (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
  return { workspace, inventory, userBase, options: { userBase, allowFreeCombinations: true } }
}

function controlledScores() {
  return vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace => {
    const team = actors(workspace)
    if (['温蒂', '异客', '清流'].every(name => team.includes(id(name)))) return 200
    if (['砾', '夜烟', '斑点'].every(name => team.includes(id(name)))) return 190
    return 100 + team.filter(actor => [id('温蒂'), id('异客')].includes(actor)).length * 10
  })
}

afterEach(() => vi.restoreAllMocks())

describe('bounded joint main and relief crews', () => {
  it('changes complete primary and relief teams together rather than keeping an incompatible old relief', () => {
    const f = fixture(), before = structuredClone(f)
    controlledScores()
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options, maxCandidates: 4 })
    const strong = result.candidates.find(candidate => sorted(actors(candidate.workspace)).join() === sorted(['温蒂', '异客', '清流']).join())
    expect(strong, JSON.stringify(result.diagnostics)).toBeDefined()
    expect(sorted(actors(strong!.workspace, 'room_1_1', true))).toEqual(sorted(['砾', '夜烟', '斑点']))
    expect(new Set([...actors(strong!.workspace), ...actors(strong!.workspace, 'room_1_1', true)]).size).toBe(6)
    for (const candidate of result.candidates) {
      expect(candidate.workspace.mainPlan.conf).toEqual(f.workspace.mainPlan.conf)
      expect(candidate.workspace.mainPlan.facilities.dormitory_1).toEqual(f.workspace.mainPlan.facilities.dormitory_1)
      expect(validatePhysicalRoster(candidate.workspace)).toEqual([])
      expect(compileRosterSchedule(candidate.workspace).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
      expect(recoveryGroupCapacityIssues(candidate.workspace)).toEqual([])
    }
    expect(f).toEqual(before)
  })

  it('uses actual current manufacturing skills, global context and no stage promotion', () => {
    const f = fixture()
    const entries = fullCatalogIdleInventory().filter(row => f.inventory.operators.some(operator => operator.charId === row.operator))
    const low = compileOperatorInventory(entries.map(row => row.operator === id('异客') ? { ...row, elitePhase: 0, level: 1 } : row))
    expect(low.operators.find(operator => operator.charId === id('异客'))!.skills.some(skill => skill.roomType === 'MANUFACTURE')).toBe(false)
    const run = vi.spyOn(production, 'productionWorkspaceHourlyScore')
    const result = generateMainRosterCrewCandidates(f.workspace, low, f.options)
    expect(result.candidates.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0)
    expect(result.candidates.flatMap(candidate => [...actors(candidate.workspace), ...actors(candidate.workspace, 'room_1_1', true)])).not.toContain(id('异客'))
    expect(run.mock.calls.length).toBeGreaterThan(0)
    for (const [probe, inventory] of run.mock.calls) {
      expect(inventory).toBe(low)
      expect(probe.mainPlan.facilities.room_1_3).toEqual(f.workspace.mainPlan.facilities.room_1_3)
    }
  })

  it.each(['slot-colon', 'slot-underscore', 'primary', 'relief', 'configured'])('protects original user facts and locks: %s', kind => {
    const f = fixture()
    if (kind === 'configured') f.userBase.mainPlan.facilities.room_1_1.slots[0] = structuredClone(f.workspace.mainPlan.facilities.room_1_1.slots[0]!)
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options,
      ...(kind.startsWith('slot') ? { lockedPositions: new Set([kind === 'slot-colon' ? 'room_1_1:0' : 'room_1_1_0']) } : {}),
      ...(kind === 'primary' || kind === 'relief' ? { lockedOperators: new Set([kind === 'primary' ? '克洛丝' : '卡缇']) } : {}),
    })
    expect(result.candidates).toEqual([])
  })

  it('leaves an unused locked actor and all external occupants unavailable', () => {
    const f = fixture(); controlledScores()
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options, lockedOperators: new Set(['温蒂']) })
    expect(result.candidates.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect([...actors(candidate.workspace), ...actors(candidate.workspace, 'room_1_1', true)]).not.toContain(id('温蒂'))
      expect(candidate.workspace.mainPlan.facilities.room_1_3).toEqual(f.workspace.mainPlan.facilities.room_1_3)
    }
  })

  it('preserves exact conf, slot metadata, virtual relief order and external rooms', () => {
    const f = fixture(); controlledScores()
    f.inventory = held([...f.inventory.operators.map(operator => operator.charId), '但书', '龙舌兰'])
    f.workspace.mainPlan.conf.userField = { ordered: [3, 1] }
    f.workspace.mainPlan.facilities.room_1_1.slots.forEach((slot, index) => {
      slot.metadata = { retained: ['slot', index] }
      slot.replacements = [id('但书'), ...slot.replacements, id('龙舌兰')]
    })
    const before = structuredClone(f), result = generateMainRosterCrewCandidates(f.workspace, f.inventory, f.options)
    expect(result.candidates.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.workspace.mainPlan.conf).toEqual(f.workspace.mainPlan.conf)
      expect(candidate.workspace.compatibility).toEqual(f.workspace.compatibility)
      for (const room of Object.values(f.workspace.mainPlan.facilities)) if (room.roomId !== 'room_1_1') expect(candidate.workspace.mainPlan.facilities[room.roomId]).toEqual(room)
      candidate.workspace.mainPlan.facilities.room_1_1.slots.forEach((slot, index) => {
        expect(slot.metadata).toEqual(f.workspace.mainPlan.facilities.room_1_1.slots[index]!.metadata)
        expect(slot.groupId).toBe(f.workspace.mainPlan.facilities.room_1_1.slots[index]!.groupId)
        expect(slot.replacements[0]).toBe(id('但书'))
        expect(slot.replacements[2]).toBe(id('龙舌兰'))
      })
    }
    expect(f).toEqual(before)
  })

  it('excludes actually unlocked warmup workers from both ordinary team roles', () => {
    const f = fixture(); controlledScores()
    const full = compileOperatorInventory(fullCatalogIdleInventory())
    const warmup = full.operators.find(operator => !f.inventory.operators.some(owned => owned.charId === operator.charId) &&
      isWarmupOperatorInFacility(operator.charId, 'manufacture', full))!
    expect(warmup).toBeDefined()
    f.inventory = held([...f.inventory.operators.map(operator => operator.charId), warmup.charId])
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, f.options)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect([...actors(candidate.workspace), ...actors(candidate.workspace, 'room_1_1', true)]).not.toContain(warmup.charId)
  })

  it('shares bounded scoring across two rooms and leaves the third room untouched', () => {
    const f = fixture(), full = compileOperatorInventory(fullCatalogIdleInventory())
    const occupied = new Set([...actors(f.workspace), ...actors(f.workspace, 'room_1_1', true), id('Lancet-2'), id('安赛尔')])
    const extra = full.operators.filter(operator => !occupied.has(operator.charId) && operator.skills.some(skill => skill.roomType === 'MANUFACTURE') &&
      !isWarmupOperatorInFacility(operator.charId, 'manufacture', full)).slice(0, 12)
    expect(extra).toHaveLength(12)
    for (const [index, roomId] of (['room_1_2', 'room_2_1'] as const).entries()) {
      const members = extra.slice(index * 6, index * 6 + 6).map(operator => operator.charId)
      Object.assign(f.workspace.mainPlan.facilities[roomId], { type: 'manufacture', product: 'exp', level: 3,
        slots: Array.from({ length: 3 }, (_, index) => slot(members[index]!, members[index + 3]!)) })
      f.userBase.mainPlan.facilities[roomId] = structuredClone(f.workspace.mainPlan.facilities[roomId])
      f.userBase.mainPlan.facilities[roomId].slots = Array.from({ length: 3 }, (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
    }
    const run = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(100)
    const result = generateMainRosterCrewCandidates(f.workspace, full, { ...f.options, maxCandidates: 999 })
    expect(result.candidates).toHaveLength(4)
    expect(run.mock.calls.length).toBeGreaterThan(56)
    expect(run.mock.calls.length).toBeLessThanOrEqual(512)
    for (const [probe] of run.mock.calls) expect(probe.mainPlan.facilities.room_2_1).toEqual(f.workspace.mainPlan.facilities.room_2_1)
    expect(result.diagnostics.find(issue => issue.code === 'MAIN_CREW_BUDGET')?.message).toContain('房间 2/2')
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_CREW_ROOM_LIMIT')).toBe(true)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0])('does not score with invalid/zero output budget %s', maxCandidates => {
    const f = fixture(), score = vi.spyOn(production, 'productionWorkspaceHourlyScore')
    expect(generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options, maxCandidates }).candidates).toEqual([])
    expect(score).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('is read-only without explicit free combinations: %s', allowFreeCombinations => {
    const f = fixture(), score = vi.spyOn(production, 'productionWorkspaceHourlyScore')
    expect(generateMainRosterCrewCandidates(f.workspace, f.inventory, { userBase: f.userBase, allowFreeCombinations }).candidates).toEqual([])
    expect(score).not.toHaveBeenCalled()
  })

  it('does not assume a configured full seed is an empty original when userBase is absent', () => {
    const f = fixture()
    expect(generateMainRosterCrewCandidates(f.workspace, f.inventory, { allowFreeCombinations: true }).candidates).toEqual([])
  })

  it.each(['bindings', 'multiple-relief', 'cross-room', 'backup-plan', 'unowned', 'duplicate-role'])('rejects unsupported or physically invalid source: %s', kind => {
    const f = fixture(), target = f.workspace.mainPlan.facilities.room_1_1
    if (kind === 'bindings') target.slots[0]!.groupBindings = [{ groupId: 'extra', replacements: [id('温蒂')] }]
    if (kind === 'multiple-relief') target.slots[0]!.replacements.push(id('温蒂'))
    if (kind === 'cross-room') { target.slots[0]!.groupId = 'cross'; f.workspace.mainPlan.facilities.room_1_3.slots[0]!.groupId = 'cross' }
    if (kind === 'backup-plan') f.workspace.compatibility.backupPlans = [{ name: 'user backup', trigger: 'True', plan: {} }]
    if (kind === 'unowned') target.slots[0]!.replacements = [id('阿米娅')]
    if (kind === 'duplicate-role') target.slots[0]!.replacements = [id('砾')]
    expect(generateMainRosterCrewCandidates(f.workspace, f.inventory, f.options).candidates).toEqual([])
  })

  it('does not rewrite a named recovery group referenced by advanced or unknown fields', () => {
    const f = fixture(), run = controlledScores()
    for (const slot of f.workspace.mainPlan.facilities.room_1_1.slots) slot.groupId = 'generated-local'
    f.workspace.mainPlan.conf.customRecovery = { excludeGroup: 'generated-local' }
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, f.options)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_CREW_EXTERNAL_REFERENCE')).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not overlook missing recovery beds merely because the workers have independent groups', () => {
    const f = fixture(); controlledScores()
    for (const slot of f.workspace.mainPlan.facilities.dormitory_1.slots) if (slot.occupant.kind === 'free') slot.occupant = { kind: 'empty' }
    f.userBase = structuredClone(f.workspace)
    f.userBase.mainPlan.facilities.room_1_1.slots = Array.from({ length: 3 }, (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options, userBase: f.userBase })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_CREW_NO_ADMISSIBLE_PAIR')).toBe(true)
  })

  it('keeps unknown G unknown and respects the shared 512-call and four-output limits', () => {
    const f = fixture(), score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = generateMainRosterCrewCandidates(f.workspace, f.inventory, { ...f.options, maxCandidates: 999 })
    expect(result.candidates).toEqual([])
    expect(score.mock.calls.length).toBeLessThanOrEqual(512)
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_CREW_UNQUANTIFIED')).toBe(true)
  })
})
