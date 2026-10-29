import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { generateContextualCrewCandidates } from './jointBackupCrewSeeds'
import { generateProductionShiftAlternatives } from './jointBackupMainAlternatives'
import { isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { preservesFormedCombinations } from './combinationIntegrity'
import * as production from './productionSingletons'

const slot = (main: string, backup?: string, group: string | null = null): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(main) }, groupId: group, replacements: backup ? [id(backup)] : [],
})
const held = (names: readonly string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(row => names.some(name => id(name) === row.operator)))
const actors = (workspace: RosterWorkspace, backup = false) => workspace.mainPlan.facilities.room_1_1.slots.map(position =>
  backup ? position.replacements.find(ref => !['但书', '龙舌兰'].includes(ref))! : position.occupant.kind === 'operator' ? position.occupant.operatorId : '')
const sorted = (names: readonly string[]) => names.map(id).sort()

// Actual skills/stages and the physical context of the complete-external entry regression.
function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const place = (roomId: MowerRoomId, level: number, rows: MowerSlot[]) => {
    const room = workspace.mainPlan.facilities[roomId]; room.level = level; room.slots = rows
  }
  place('room_1_1', 3, [slot('克洛丝', '卡缇'), slot('砾', '夜烟'), slot('清流', '斑点')])
  place('room_1_3', 3, [slot('Lancet-2')])
  place('room_2_3', 3, [slot('炎熔', '安德切尔', 'fixed-second-power')])
  place('room_3_1', 1, [slot('梓兰', '史都华德', 'fixed-trade-1')])
  place('room_3_2', 1, [slot('月见夜', '玫兰莎', 'fixed-trade-2')])
  place('central', 5, [slot('森蚺', '米格鲁', 'external-control'), slot('红', '杜宾', 'fixed-control-1'),
    slot('临光', '芬', 'fixed-control-2'), slot('凯尔希', '香草', 'fixed-control-3'), slot('阿米娅', '翎羽', 'fixed-control-4')])
  for (const [roomId, resident] of [['dormitory_1', '闪灵'], ['dormitory_2', '安赛尔']] as const) {
    place(roomId, 5, [slot(resident), ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))])
  }
  workspace.mainPlan.conf.exhaust_require = [id('克洛丝')]
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  const inventory = held(['温蒂', '异客', '清流', '砾', '斑点', '夜烟', '森蚺', 'Lancet-2', '米格鲁', '安赛尔', '闪灵',
    '杜宾', '芬', '香草', '翎羽', '克洛丝', '安德切尔', '玫兰莎', '月见夜', '卡缇', '梓兰', '史都华德', '炎熔', '红', '临光', '凯尔希', '阿米娅'])
  return { workspace, inventory, candidates: [{ id: 'actual-initial', workspace }] }
}

afterEach(() => vi.restoreAllMocks())

describe('bounded contextual complete manufacturing crews', () => {
  it('naturally creates the real automation/additive complementary pair excluded by singleton admission', () => {
    const input = fixture()
    expect(generateProductionShiftAlternatives(input.candidates, input.inventory).candidates.every(candidate =>
      JSON.stringify(candidate.workspace.mainPlan.facilities.room_1_1) === JSON.stringify(input.workspace.mainPlan.facilities.room_1_1))).toBe(true)
    const result = generateContextualCrewCandidates(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(2)
    expect(sorted(actors(result.candidates[0]!.workspace))).toEqual(sorted(['温蒂', '异客', '清流']))
    expect(sorted(actors(result.candidates[0]!.workspace, true))).toEqual(sorted(['砾', '斑点', '夜烟']))
    expect(actors(result.candidates[1]!.workspace)).toEqual(actors(result.candidates[0]!.workspace, true))
    expect(actors(result.candidates[1]!.workspace, true)).toEqual(actors(result.candidates[0]!.workspace))
    for (const candidate of result.candidates) {
      expect(new Set([...actors(candidate.workspace), ...actors(candidate.workspace, true)]).size).toBe(6)
      expect([...actors(candidate.workspace), ...actors(candidate.workspace, true)].every(actor => !isWarmupOperatorInFacility(actor, 'manufacture', input.inventory))).toBe(true)
      expect(preservesFormedCombinations(input.workspace, candidate.workspace, input.inventory)).toBe(true)
      const lockedPositions = new Set(Object.values(candidate.workspace.mainPlan.facilities).filter(room => room.roomId !== 'room_1_1')
        .flatMap(room => room.slots.map((_, index) => `${room.roomId}:${index}`)))
      const reverse = generateProductionShiftAlternatives([candidate], input.inventory, { lockedPositions }).candidates
      expect(reverse).toHaveLength(1)
    }
  })

  it('preserves exact conf, external rooms, group labels, nonordinary references, metadata and all input data', () => {
    const input = fixture()
    input.inventory = held([...input.inventory.operators.map(operator => operator.name), '但书', '龙舌兰'])
    const target = input.workspace.mainPlan.facilities.room_1_1
    target.slots.forEach((position, index) => {
      position.metadata = { index, user: ['unchanged', index] }
      position.replacements = ['但书', ...position.replacements, '龙舌兰']
    })
    input.workspace.mainPlan.conf.userField = { retained: true }
    input.workspace.compatibility.unrecognizedFields.extra = { nested: [3, 1] }
    const before = structuredClone(input), result = generateContextualCrewCandidates(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(2)
    for (const { workspace } of result.candidates) {
      expect(workspace.mainPlan.conf).toEqual(before.workspace.mainPlan.conf)
      expect(workspace.compatibility).toEqual(before.workspace.compatibility)
      for (const room of Object.values(workspace.mainPlan.facilities)) if (room.roomId !== 'room_1_1') {
        expect(room).toEqual(before.workspace.mainPlan.facilities[room.roomId])
      }
      workspace.mainPlan.facilities.room_1_1.slots.forEach((position, index) => {
        expect(position.metadata).toEqual(before.workspace.mainPlan.facilities.room_1_1.slots[index]!.metadata)
        expect(position.groupId).toBe(before.workspace.mainPlan.facilities.room_1_1.slots[index]!.groupId)
        expect(position.replacements[0]).toBe('但书')
        expect(position.replacements[2]).toBe('龙舌兰')
      })
    }
    expect(input).toEqual(before)
  })

  it.each(['room_1_1:0', 'room_1_1_0', 'primary', 'backup'])('preserves original user lock %s', kind => {
    const input = fixture()
    const options = kind === 'primary' || kind === 'backup'
      ? { lockedOperators: new Set([kind === 'primary' ? '克洛丝' : '卡缇']) }
      : { lockedPositions: new Set([kind]) }
    expect(generateContextualCrewCandidates(input.candidates, input.inventory, options).candidates).toEqual([])
  })
  it('excludes an unused locked actor while leaving an unrelated external position lock untouched', () => {
    const input = fixture(), result = generateContextualCrewCandidates(input.candidates, input.inventory, {
      lockedOperators: new Set(['温蒂']), lockedPositions: new Set(['central:0']),
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.flatMap(candidate => [...actors(candidate.workspace), ...actors(candidate.workspace, true)])).not.toContain(id('温蒂'))
  })
  it('uses actual unlocked manufacture skills and never promotes a missing actor', () => {
    const input = fixture()
    const entries = fullCatalogIdleInventory().filter(row => input.inventory.operators.some(operator => operator.charId === row.operator))
    const low = compileOperatorInventory(entries.map(row => row.operator === id('异客') ? { ...row, elitePhase: 0, level: 1 } : row))
    expect(low.operators.find(operator => operator.name === '异客')!.skills.some(skill => skill.roomType === 'MANUFACTURE')).toBe(false)
    const result = generateContextualCrewCandidates(input.candidates, low)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.flatMap(candidate => [...actors(candidate.workspace), ...actors(candidate.workspace, true)])).not.toContain(id('异客'))
    const missing = { ...input.inventory, operators: input.inventory.operators.filter(operator => operator.name !== '清流') }
    expect(generateContextualCrewCandidates(input.candidates, missing).candidates).toEqual([])
    expect(generateContextualCrewCandidates(input.candidates, { ...input.inventory, valid: false }).candidates).toEqual([])
  })
  it('does not steal an actor already used in any external ordinary physical role', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.contact.level = 1
    input.workspace.mainPlan.facilities.contact.slots = [slot('温蒂')]
    const result = generateContextualCrewCandidates(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.flatMap(candidate => [...actors(candidate.workspace), ...actors(candidate.workspace, true)])).not.toContain(id('温蒂'))
    expect(result.candidates[0]!.workspace.mainPlan.facilities.contact).toEqual(input.workspace.mainPlan.facilities.contact)
  })
  it.each(['workaholic', 'resting_standby'] as const)('preserves an original %s policy actor and excludes an unused one', field => {
    const input = fixture()
    input.workspace.mainPlan.conf[field] = [...input.workspace.mainPlan.conf[field] ?? [], id('克洛丝')]
    expect(generateContextualCrewCandidates(input.candidates, input.inventory).candidates).toEqual([])
    input.workspace.mainPlan.conf[field] = [...fixture().workspace.mainPlan.conf[field] ?? [], id('温蒂')]
    const result = generateContextualCrewCandidates(input.candidates, input.inventory)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.flatMap(candidate => [...actors(candidate.workspace), ...actors(candidate.workspace, true)])).not.toContain(id('温蒂'))
  })
  it.each(['binding', 'cross-room', 'incomplete', 'non-main'] as const)('skips unsupported %s inputs', mode => {
    const input = fixture(), room = input.workspace.mainPlan.facilities.room_1_1
    if (mode === 'binding') room.slots[0]!.groupBindings = [{ groupId: 'extra', replacements: [] }]
    if (mode === 'cross-room') { room.slots[0]!.groupId = 'external-control' }
    if (mode === 'incomplete') room.slots.pop()
    if (mode === 'non-main') input.workspace.compatibility.backupPlans = [{ name: 'user-backup' }]
    expect(generateContextualCrewCandidates(input.candidates, input.inventory).candidates).toEqual([])
  })
  it('requires enough actual recovery beds and refuses policy normalization', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.room_1_1.slots.forEach(position => { position.groupId = 'complete-crew' })
    input.workspace.mainPlan.facilities.dormitory_1.slots.splice(3)
    input.workspace.mainPlan.facilities.dormitory_2.level = 0
    input.workspace.mainPlan.facilities.dormitory_2.slots = []
    expect(generateContextualCrewCandidates(input.candidates, input.inventory).candidates).toEqual([])
    const limits = fixture()
    limits.workspace.mainPlan.facilities.room_1_1.slots.forEach(position => { position.groupId = 'complete-crew' })
    limits.workspace.mainPlan.conf.operator_mood_limits = Object.fromEntries(['清流', '砾', '斑点', '夜烟', '卡缇', '温蒂', '异客'].map((name, index) => [name, { lower: index + 1, upper: 24 }]))
    const before = structuredClone(limits.workspace)
    const workspaceScore = vi.spyOn(production, 'productionWorkspaceHourlyScore'), teamOutput = vi.spyOn(production, 'productionTeamHourlyOutput')
    expect(generateContextualCrewCandidates(limits.candidates, limits.inventory).candidates).toEqual([])
    expect(limits.workspace).toEqual(before)
    expect(workspaceScore.mock.calls.length + teamOutput.mock.calls.length).toBeLessThanOrEqual(256)
  })
  it('preserves a complete cross-facility core even when that makes a reversible pair impossible', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('迷迭香') }
    input.workspace.mainPlan.facilities.contact.level = 1
    input.workspace.mainPlan.facilities.contact.slots = [slot('絮雨')]
    const inventory = held([...input.inventory.operators.map(operator => operator.name), '迷迭香', '絮雨'])
    expect(generateContextualCrewCandidates(input.candidates, inventory).candidates).toEqual([])
  })
  it('never treats an unquantified whole-base projection as zero or a candidate', () => {
    const input = fixture(), workspaceScore = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    expect(generateContextualCrewCandidates(input.candidates, input.inventory).candidates).toEqual([])
    expect(workspaceScore).toHaveBeenCalled()
  })
  it('requires the complete team projection too, and keeps a hard static-call budget independent of inventory size', () => {
    const input = fixture(), extra = held([...input.inventory.operators.map(operator => operator.name), '梅尔', '维伊', '雪猎', '淬羽赫默', '至简'])
    const workspaceScore = vi.spyOn(production, 'productionWorkspaceHourlyScore'), teamOutput = vi.spyOn(production, 'productionTeamHourlyOutput')
    const result = generateContextualCrewCandidates(input.candidates, extra)
    expect(result.candidates).toHaveLength(2)
    expect(workspaceScore.mock.calls.length).toBeGreaterThan(0)
    expect(teamOutput.mock.calls.length).toBeGreaterThan(0)
    expect(workspaceScore.mock.calls.length + teamOutput.mock.calls.length).toBeLessThanOrEqual(256)
    const crews = new Set(workspaceScore.mock.calls.map(([workspace]) => sorted(actors(workspace)).join('|')))
    expect(crews.size).toBeLessThanOrEqual(56)
    teamOutput.mockReturnValue(undefined)
    expect(generateContextualCrewCandidates(input.candidates, input.inventory).candidates).toEqual([])
  })
  it('caps output at two, can return one or zero, and removes complete-workspace duplicates', () => {
    const input = fixture()
    expect(generateContextualCrewCandidates(input.candidates, input.inventory, { maxCandidates: 1 }).candidates).toHaveLength(1)
    expect(generateContextualCrewCandidates(input.candidates, input.inventory, { maxCandidates: 0 }).candidates).toEqual([])
    expect(generateContextualCrewCandidates(input.candidates, input.inventory, { maxCandidates: 999 }).candidates).toHaveLength(2)
    expect(generateContextualCrewCandidates(input.candidates, input.inventory, { maxCandidates: Number.NaN }).candidates).toEqual([])
    const pair = generateContextualCrewCandidates(input.candidates, input.inventory).candidates
    expect(generateContextualCrewCandidates([...input.candidates, ...pair], input.inventory).candidates).toEqual([])
  })
})
