import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { formedCombinations, preservesFormedCombinations } from './combinationIntegrity'
import { physicalBackupOperatorIds, shiftSnapshot } from './combinationModel'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'
import * as production from './productionSingletons'
import { generateMainRosterFreeCandidates } from './mainRosterFreeCandidates'

const slot = (main: string, backup?: string, group: string | null = null): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(main) }, groupId: group, replacements: backup ? [id(backup)] : [],
})
const names = (workspace: RosterWorkspace, roomId: MowerRoomId) => workspace.mainPlan.facilities[roomId].slots
  .flatMap(position => position.occupant.kind === 'operator' ? [position.occupant.operatorId] : [])
const held = (names: readonly string[]) => compileOperatorInventory(fullCatalogIdleInventory().filter(row => names.some(name => id(name) === row.operator)))

function fixture() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const first = workspace.mainPlan.facilities.room_1_1
  first.level = 2; first.product = 'exp'; first.slots = [slot('红云', '断罪者', 'capacity'), slot('稀音', 'Castle-3', 'capacity')]
  const second = workspace.mainPlan.facilities.room_1_2
  second.level = 2; second.product = 'gold'; second.slots = [slot('砾', '斑点', 'additive'), slot('夜烟', '白雪', 'additive')]
  const power = workspace.mainPlan.facilities.room_1_3
  power.level = 3; power.slots = [slot('Lancet-2')]
  workspace.mainPlan.conf.workaholic = [id('Lancet-2')]
  const dorm = workspace.mainPlan.facilities.dormitory_1
  dorm.level = 5; dorm.slots = [slot('安赛尔'), ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))]
  const inventory = held(['红云', '稀音', '砾', '夜烟', '断罪者', 'Castle-3', '斑点', '白雪', 'Lancet-2', '安赛尔'])
  expect(applyGeneratedWarmupPolicy(workspace, inventory).valid).toBe(true)
  return { workspace, inventory }
}

// Exact affected slot/group/policy fields from the frozen old full252 failures.
// The saved reports show complete relief, no affected deferral, and 83.330971h /
// 41.061508h ordinary fatigue after the primaries move under these same groups.
function affectedGroupsFixture() {
  const input = fixture(), { workspace } = input
  workspace.mainPlan.facilities.room_1_1.level = 0; workspace.mainPlan.facilities.room_1_1.slots = []
  workspace.mainPlan.facilities.room_1_2.level = 0; workspace.mainPlan.facilities.room_1_2.slots = []
  const first = workspace.mainPlan.facilities.room_2_3, second = workspace.mainPlan.facilities.room_3_1
  const goldGroup = '组合_cantabile_metalcraft_room_2_3:0_room_2_3:1_room_2_3:2'
  const expGroup = '组合_vermeil_capacity_room_3_1:0_room_3_1:1_room_3_1:2'
  Object.assign(first, { type: 'manufacture', level: 3, product: 'gold', slots: [slot('苍苔', '多萝西', goldGroup), slot('砾', '淬羽赫默', goldGroup), slot('引星棘刺', '娜斯提', goldGroup)] })
  Object.assign(second, { type: 'manufacture', level: 3, product: 'exp', slots: [slot('红云', '泡泡', expGroup), slot('稀音', '火神', expGroup), slot('刻俄柏', '贝娜', expGroup)] })
  workspace.mainPlan.conf.exhaust_require = ['雪猎', '槐琥', '稀音', '刻俄柏'].map(id)
  workspace.mainPlan.conf.rest_in_full = ['雪猎', '槐琥'].map(id)
  input.inventory = held(['苍苔', '多萝西', '砾', '淬羽赫默', '引星棘刺', '娜斯提', '红云', '泡泡', '稀音', '火神', '刻俄柏', '贝娜', '雪猎', '槐琥', 'Lancet-2', '安赛尔'])
  const userBase = structuredClone(workspace)
  for (const room of [userBase.mainPlan.facilities.room_2_3, userBase.mainPlan.facilities.room_3_1]) room.slots = Array.from({ length: 3 }, (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
  return { ...input, userBase, goldGroup, expGroup }
}

afterEach(() => vi.restoreAllMocks())

describe('bounded free primary combinations across actual production rooms', () => {
  it('offers independent native recovery for the real exhaust-group mismatch while retaining exact policies and relief', () => {
    const input = affectedGroupsFixture(), before = structuredClone(input)
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase: input.userBase, allowFreeCombinations: true })
    const repairs = result.candidates.filter(candidate => candidate.id.includes(':repair:'))
    expect(repairs.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0)
    for (const candidate of repairs) {
      const compiled = compileRosterSchedule(candidate.workspace), config = compiledScheduleToRuntimeConfig(compiled)
      config.mowerAlpha = true
      const native = getMowerSourceRuntime(createRosterRuntime(config)).data
      expect(candidate.workspace.mainPlan.conf).toEqual(input.workspace.mainPlan.conf)
      expect(validatePhysicalRoster(candidate.workspace)).toEqual([])
      expect(compiled.diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
      expect(applyGeneratedWarmupPolicy(structuredClone(candidate.workspace), input.inventory).valid).toBe(true)
      expect(recoveryGroupCapacityIssues(candidate.workspace)).toEqual([])
      const restUnits = new Set<string>()
      for (const roomId of ['room_2_3', 'room_3_1'] as const) candidate.workspace.mainPlan.facilities[roomId].slots.forEach((position, index) => {
        const original = input.workspace.mainPlan.facilities[roomId].slots[index]!
        expect(position.replacements).toEqual(original.replacements)
        expect(position.groupBindings).toEqual(original.groupBindings)
        expect({ ...position, occupant: original.occupant, groupId: original.groupId }).toEqual(original)
        if (position.groupId !== null) return
        expect(position.occupant.kind).toBe('operator')
        if (position.occupant.kind !== 'operator') return
        const runtime = config.positions.find(row => row.id === `${roomId}_${index}`)!, actor = native.operators[id(position.occupant.operatorId)]!
        expect(runtime.group).toBeUndefined()
        expect(runtime.candidates).toEqual(physicalBackupOperatorIds(candidate.workspace.mainPlan.facilities[roomId], position))
        expect(actor.group).toBe('')
        expect(actor.multiGroup).toBe(false)
        expect(actor.replacement).toEqual(position.replacements.map(id))
        expect(actor.exhaustRequire).toBe(input.workspace.mainPlan.conf.exhaust_require.includes(actor.name))
        restUnits.add(runtime.group ? `group:${runtime.group}` : `slot:${runtime.id}`)
      })
      expect(restUnits.size).toBeGreaterThanOrEqual(3)
    }
    expect(input).toEqual(before)
  })

  it.each(['user-group', 'position-lock', 'actor-lock', 'external-metadata', 'advanced-exclusion'] as const)(
    'preserves the entire original recovery group under %s protection', kind => {
      const input = affectedGroupsFixture(), group = kind === 'position-lock' || kind === 'actor-lock' ? input.goldGroup : input.expGroup
      if (kind === 'user-group') input.userBase.mainPlan.facilities.room_3_1.slots[0]!.groupId = group
      if (kind === 'external-metadata') input.workspace.compatibility.unrecognizedFields.saved_recovery = { target: group }
      if (kind === 'advanced-exclusion') input.workspace.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_exclusions: [group] }
      const options = { userBase: input.userBase, allowFreeCombinations: true,
        ...(kind === 'position-lock' ? { lockedPositions: new Set(['room_2_3:1']) } : {}),
        ...(kind === 'actor-lock' ? { lockedOperators: new Set(['多萝西']) } : {}),
      }
      const before = structuredClone(input), result = generateMainRosterFreeCandidates(input.workspace, input.inventory, options)
      expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_RECOVERY_UNSUPPORTED')).toBe(true)
      for (const { workspace } of result.candidates) for (const room of Object.values(input.workspace.mainPlan.facilities)) {
        room.slots.forEach((position, index) => {
          if (position.groupId === group) expect(workspace.mainPlan.facilities[room.roomId].slots[index]!.groupId).toBe(group)
        })
        expect(workspace.mainPlan.conf).toEqual(input.workspace.mainPlan.conf)
      }
      expect(input).toEqual(before)
    },
  )

  it.each(['external-member', 'extra-binding'] as const)('does not flatten a group with %s', kind => {
    const input = affectedGroupsFixture()
    input.inventory = held([...input.inventory.operators.map(operator => operator.name), '香草'])
    if (kind === 'external-member') {
      input.workspace.mainPlan.facilities.room_1_3.slots[0]!.groupId = input.expGroup
      input.workspace.mainPlan.facilities.room_1_3.slots[0]!.replacements = [id('香草')]
    } else input.workspace.mainPlan.facilities.room_3_1.slots[0]!.groupBindings = [{ groupId: input.goldGroup, replacements: [id('香草')] }]
    const before = structuredClone(input), result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase: input.userBase, allowFreeCombinations: true })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_UNSUPPORTED_LINK'), JSON.stringify(result.diagnostics)).toBe(true)
    expect(input).toEqual(before)
  })

  it('requires free mode and an explicit original workspace before modifying a recovery group', () => {
    const input = affectedGroupsFixture()
    const noOrigin = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(noOrigin.candidates.some(candidate => candidate.id.includes(':repair:'))).toBe(false)
    expect(noOrigin.diagnostics.some(issue => issue.code === 'MAIN_FREE_RECOVERY_NEEDS_USER_BASE')).toBe(true)
    const disabled = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase: input.userBase, allowFreeCombinations: false })
    expect(disabled.candidates.some(candidate => candidate.id.includes(':repair:'))).toBe(false)
    for (const { workspace } of disabled.candidates) for (const roomId of ['room_2_3', 'room_3_1'] as const) {
      expect(workspace.mainPlan.facilities[roomId].slots.map(position => position.groupId)).toEqual(input.workspace.mainPlan.facilities[roomId].slots.map(position => position.groupId))
    }
  })

  it('reserves a repair output slot for the same actors at a budget of one', () => {
    const input = affectedGroupsFixture()
    const original = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true, maxCandidates: 1 })
    const repaired = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase: input.userBase, allowFreeCombinations: true, maxCandidates: 1 })
    expect(original.candidates).toHaveLength(1)
    expect(repaired.candidates).toHaveLength(1)
    expect(repaired.candidates[0]!.id).toContain(':repair:')
    for (const roomId of ['room_2_3', 'room_3_1'] as const) expect(names(repaired.candidates[0]!.workspace, roomId)).toEqual(names(original.candidates[0]!.workspace, roomId))
  })

  it('actually splits an internally generated template and recomputes actual linked skills', () => {
    const input = fixture(), before = structuredClone(input)
    expect(formedCombinations(input.workspace, input.inventory).some(combo => combo.definitionId === 'vermeil_capacity')).toBe(true)
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0)
    expect(result.candidates.some(candidate => !preservesFormedCombinations(input.workspace, candidate.workspace, input.inventory))).toBe(true)
    for (const { workspace } of result.candidates) {
      expect(names(workspace, 'room_1_1')).not.toEqual(names(input.workspace, 'room_1_1'))
      expect(names(workspace, 'room_1_2')).not.toEqual(names(input.workspace, 'room_1_2'))
      expect(validatePhysicalRoster(workspace)).toEqual([])
      expect(compileRosterSchedule(workspace).diagnostics.filter(issue => issue.severity === 'error')).toEqual([])
      expect(recoveryGroupCapacityIssues(workspace)).toEqual([])
      const physical = Object.values(workspace.mainPlan.facilities).flatMap(room => room.level > 0 ? room.slots.flatMap(position => [
        ...(position.occupant.kind === 'operator' ? [id(position.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, position),
      ]) : [])
      expect(new Set(physical).size).toBe(physical.length)
      expect(applyGeneratedWarmupPolicy(structuredClone(workspace), input.inventory).valid).toBe(true)
      expect(production.productionWorkspaceHourlyScore(workspace, input.inventory)).toBeTypeOf('number')
      for (const roomId of ['room_1_1', 'room_1_2'] as const) {
        expect(production.productionWorkspaceHourlyScore(shiftSnapshot(workspace, 'backup', roomId), input.inventory)).toBeTypeOf('number')
        workspace.mainPlan.facilities[roomId].slots.forEach((position, index) => {
          const original = input.workspace.mainPlan.facilities[roomId].slots[index]!
          expect({ ...position, occupant: original.occupant }).toEqual(original)
        })
      }
      expect(workspace.mainPlan.conf).toEqual(input.workspace.mainPlan.conf)
    }
    const split = result.candidates.find(candidate => !preservesFormedCombinations(input.workspace, candidate.workspace, input.inventory))!
    expect(production.productionTeamTheory(split.workspace, input.inventory, 'room_1_1'))
      .not.toBe(production.productionTeamTheory(input.workspace, input.inventory, 'room_1_1'))
    expect(input).toEqual(before)
  })

  it('keeps the original complete combination when free combinations are disabled', () => {
    const input = fixture()
    for (const options of [{}, { allowFreeCombinations: false }]) {
      const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, options)
      expect(result.candidates.every(candidate => preservesFormedCombinations(input.workspace, candidate.workspace, input.inventory))).toBe(true)
      expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_CORE_PROTECTED')).toBe(true)
    }
  })

  it.each(['room_1_1:0', 'room_1_1_0', 'operator', 'replacement'])('preserves explicit %s locks', lock => {
    const input = fixture(), options = lock === 'operator' || lock === 'replacement'
      ? { lockedOperators: new Set([lock === 'operator' ? '红云' : '断罪者']) }
      : { lockedPositions: new Set([lock]) }
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { ...options, allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every(candidate => candidate.workspace.mainPlan.facilities.room_1_1.slots[0]?.occupant.kind === 'operator' &&
      candidate.workspace.mainPlan.facilities.room_1_1.slots[0].occupant.operatorId === id('红云'))).toBe(true)
  })

  it('preserves userBase main slots, ordered references, groups, metadata and formed cores despite free mode', () => {
    const input = fixture(), userBase = structuredClone(input.workspace)
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase, allowFreeCombinations: true }).candidates).toEqual([])
    userBase.mainPlan.facilities.room_1_1.slots = [structuredClone(input.workspace.mainPlan.facilities.room_1_1.slots[0]!)]
    userBase.mainPlan.facilities.room_1_2.slots = []
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase, allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect(candidate.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(userBase.mainPlan.facilities.room_1_1.slots[0])
    const conflict = structuredClone(input.workspace)
    conflict.mainPlan.facilities.room_1_1.slots[0]!.replacements.reverse()
    conflict.mainPlan.facilities.room_1_1.slots[0]!.replacements.push(id('斑点'))
    expect(generateMainRosterFreeCandidates(conflict, input.inventory, { userBase, allowFreeCombinations: true }).candidates).toEqual([])
  })

  it('protects a user slot configured only by an ordered relief list and metadata', () => {
    const input = fixture(), userBase = structuredClone(input.workspace)
    userBase.mainPlan.facilities.room_1_1.slots = [{
      occupant: { kind: 'empty' }, groupId: null,
      replacements: [...input.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements], metadata: { reserved: true },
    }]
    userBase.mainPlan.facilities.room_1_2.slots = []
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.metadata = { reserved: true }
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { userBase, allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect(candidate.workspace.mainPlan.facilities.room_1_1.slots[0])
      .toEqual(input.workspace.mainPlan.facilities.room_1_1.slots[0])
  })

  it('uses actual unlocked skills without assuming a full catalog or admitting unowned references', () => {
    const input = fixture(), rows = fullCatalogIdleInventory().filter(row => input.inventory.operators.some(operator => operator.charId === row.operator))
    const low = compileOperatorInventory(rows.map(row => row.operator === id('稀音') ? { ...row, elitePhase: 0, level: 1 } : row))
    const highTheory = production.productionTeamTheory(input.workspace, input.inventory, 'room_1_1')
    const lowTheory = production.productionTeamTheory(input.workspace, low, 'room_1_1')
    expect(lowTheory).not.toBe(highTheory)
    const result = generateMainRosterFreeCandidates(input.workspace, low, { allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every(candidate => production.productionWorkspaceHourlyScore(candidate.workspace, low) !== undefined)).toBe(true)
    const missing = { ...input.inventory, operators: input.inventory.operators.filter(operator => operator.name !== '砾') }
    expect(generateMainRosterFreeCandidates(input.workspace, missing, { allowFreeCombinations: true }).candidates).toEqual([])
  })

  it('keeps a primary without an unlocked target-facility skill out of the transfer domain', () => {
    const input = fixture()
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('异客') }
    input.inventory = compileOperatorInventory([
      ...fullCatalogIdleInventory().filter(row => input.inventory.operators.some(operator => operator.charId === row.operator)),
      { operator: '异客', elitePhase: 0, level: 1 },
    ])
    expect(input.inventory.operators.find(operator => operator.name === '异客')!.skills.some(skill => skill.roomType === 'MANUFACTURE')).toBe(false)
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every(candidate => names(candidate.workspace, 'room_1_1')[0] === id('异客'))).toBe(true)
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_SKILL_UNAVAILABLE')).toBe(true)
  })

  it('retains ordered special references and unknown metadata exactly', () => {
    const input = fixture()
    input.inventory = held([...input.inventory.operators.map(operator => operator.name), '但书', '龙舌兰'])
    for (const roomId of ['room_1_1', 'room_1_2'] as const) input.workspace.mainPlan.facilities[roomId].slots.forEach((position, index) => {
      position.replacements = ['但书', ...position.replacements, '龙舌兰']
      position.metadata = { saved: [index, { owner: 'original' }] }
    })
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const { workspace } of result.candidates) for (const roomId of ['room_1_1', 'room_1_2'] as const) {
      workspace.mainPlan.facilities[roomId].slots.forEach((position, index) => {
        expect(position.replacements).toEqual(input.workspace.mainPlan.facilities[roomId].slots[index]!.replacements)
        expect(position.metadata).toEqual(input.workspace.mainPlan.facilities[roomId].slots[index]!.metadata)
      })
    }
  })

  it.each(['bindings', 'cross-room', 'incomplete', 'missing-relief', 'backup-plans', 'duplicate', 'beds'] as const)('diagnoses unsupported %s without mutating inputs', kind => {
    const input = fixture(), first = input.workspace.mainPlan.facilities.room_1_1
    if (kind === 'bindings') first.slots[0]!.groupBindings = [{ groupId: 'extra', replacements: [] }]
    if (kind === 'cross-room') first.slots[0]!.groupId = 'additive'
    if (kind === 'incomplete') first.slots.pop()
    if (kind === 'missing-relief') first.slots[0]!.replacements = []
    if (kind === 'backup-plans') input.workspace.compatibility.backupPlans = [{ name: 'user' }]
    if (kind === 'duplicate') input.workspace.mainPlan.facilities.room_1_2.slots[0]!.replacements = [id('断罪者')]
    if (kind === 'beds') input.workspace.mainPlan.facilities.dormitory_1.slots.splice(2)
    const before = structuredClone(input), result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(input).toEqual(before)
  })

  it('refuses a warmup relief and any primary policy normalization', () => {
    const input = fixture()
    input.inventory = held([...input.inventory.operators.map(operator => operator.name), '机械师'])
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('机械师')]
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true }).candidates).toEqual([])
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('断罪者')]
    input.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('机械师') }
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true }).candidates).toEqual([])
    input.workspace.mainPlan.conf.exhaust_require.push(id('机械师'))
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true }).candidates.length).toBeGreaterThan(0)
  })

  it('rejects a new mood-window group that would need a rest_in_full policy change', () => {
    const input = fixture()
    input.workspace.mainPlan.conf.operator_mood_limits = Object.fromEntries(['红云', '稀音', '砾', '夜烟']
      .map((name, index) => [name, { lower: index + 1, upper: 24 }]))
    const before = structuredClone(input.workspace)
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_REJECTED' && issue.message.includes('恢复策略'))).toBe(true)
    expect(input.workspace).toEqual(before)
  })

  it('never treats an unknown main or relief projection as zero', () => {
    const input = fixture(), projection = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true })
    expect(result.candidates).toEqual([])
    expect(projection).toHaveBeenCalled()
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_UNQUANTIFIED')).toBe(true)
    projection.mockImplementation((workspace) => names(workspace, 'room_1_1').includes(id('断罪者')) ? undefined : 1)
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true }).candidates).toEqual([])
  })

  it('uses a hard enumeration/output budget and stable payload deduplication', () => {
    const input = fixture(), projection = vi.spyOn(production, 'productionWorkspaceHourlyScore')
    const first = generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true, maxCandidates: 99 })
    expect(first.candidates.length).toBeGreaterThan(0)
    expect(first.candidates.length).toBeLessThanOrEqual(4)
    expect(new Set(first.candidates.map(candidate => JSON.stringify(candidate.workspace))).size).toBe(first.candidates.length)
    expect(projection.mock.calls.length).toBeLessThanOrEqual(192)
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { allowFreeCombinations: true, maxCandidates: 99 })).toEqual(first)
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { maxCandidates: 0 }).candidates).toEqual([])
    expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { maxCandidates: 1, allowFreeCombinations: true }).candidates).toHaveLength(1)
    for (const maxCandidates of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(generateMainRosterFreeCandidates(input.workspace, input.inventory, { maxCandidates }).candidates).toEqual([])
    }
  })

  it.each([false, true])('stops at 64 proposals with reserved recovery repairs=%s', withRecovery => {
    const input = fixture(), inventory = compileOperatorInventory(fullCatalogIdleInventory())
    const pool = inventory.operators.filter(operator => operator.skills.some(skill => skill.roomType === 'MANUFACTURE') &&
      !isWarmupOperatorInFacility(operator.charId, 'manufacture', inventory) && !['铅踝', 'Lancet-2', '安赛尔', '但书', '龙舌兰'].includes(operator.name)).slice(0, 24)
    expect(pool).toHaveLength(24)
    for (const [roomIndex, roomId] of (['room_1_1', 'room_1_2', 'room_2_1', 'room_2_2'] as const).entries()) {
      const room = input.workspace.mainPlan.facilities[roomId]
      room.level = 3
      room.slots = Array.from({ length: 3 }, (_, index) => slot(pool[roomIndex * 6 + index]!.charId, pool[roomIndex * 6 + index + 3]!.charId, `bounded-${roomIndex}`))
    }
    input.workspace.mainPlan.facilities.room_2_3.level = 3
    input.workspace.mainPlan.facilities.room_2_3.slots = []
    input.workspace.mainPlan.conf.exhaust_require = withRecovery ? [pool[0]!.charId] : []
    const userBase = withRecovery ? structuredClone(input.workspace) : undefined
    if (userBase) for (const room of Object.values(userBase.mainPlan.facilities)) if (room.type === 'manufacture' && room.level > 0) {
      room.slots = room.slots.map(() => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
    }
    const projection = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(1)
    const result = generateMainRosterFreeCandidates(input.workspace, inventory, { allowFreeCombinations: true, ...(userBase ? { userBase } : {}) })
    expect(result.candidates, JSON.stringify(result.diagnostics)).toHaveLength(4)
    expect(projection.mock.calls.length).toBeLessThanOrEqual(192)
    expect(result.diagnostics.some(issue => issue.code === 'MAIN_FREE_STATE_LIMIT')).toBe(true)
    expect(result.diagnostics.find(issue => issue.code === 'MAIN_FREE_BUDGET')!.message).toContain('64/64')
    if (withRecovery) expect(result.diagnostics.find(issue => issue.code === 'MAIN_FREE_BUDGET')!.message).toContain('主位 60、独立恢复尝试 4')
  })
})
