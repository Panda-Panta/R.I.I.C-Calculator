import { describe, expect, it, vi, afterEach } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, RosterWorkspace } from '../domain/roster'
import type { MainRosterHybridInput } from './mainRosterHybridTypes'
import { buildMainRosterHybridPolicyVariables } from './mainRosterHybridRecovery'
import { preservesFormedCombinations } from './combinationIntegrity'
import * as production from './productionSingletons'

afterEach(() => vi.restoreAllMocks())
const owned = (names: string[]) => fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator))
function assign(workspace: RosterWorkspace, roomId: MowerRoomId, index: number, name: string, backup: string, group: string | null = null) {
  workspace.mainPlan.facilities[roomId].slots[index] = { occupant: { kind: 'operator', operatorId: id(name) }, replacements: backup ? [id(backup)] : [], groupId: group }
}
function restFixture(): MainRosterHybridInput {
  const userBase = createDefaultWorkspace(), incumbent = structuredClone(userBase), group = 'opaque-auto-rest-unit'
  assign(incumbent, 'central', 0, '歌蕾蒂娅', '阿米娅', group)
  assign(incumbent, 'room_1_1', 0, '斯卡蒂', '芬', group)
  assign(incumbent, 'room_1_1', 1, '乌尔比安', '香草', group)
  assign(incumbent, 'room_1_2', 0, '安哲拉', '调香师', group)
  assign(incumbent, 'room_1_2', 1, '幽灵鲨', '梅兰莎', group)
  incumbent.mainPlan.facilities.room_3_1.level = 1; incumbent.mainPlan.facilities.room_3_1.slots.length = 1
  assign(incumbent, 'room_3_1', 0, '深巡', '能天使', group)
  return { sceneId: 'actual-optional-cross-room-support', userBase, incumbent,
    entries: owned(['歌蕾蒂娅', '斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨', '深巡', '阿米娅', '芬', '香草', '调香师', '梅兰莎', '能天使']) }
}
function fiamFixture(): MainRosterHybridInput {
  const userBase = createDefaultWorkspace(), incumbent = structuredClone(userBase)
  for (const room of Object.values(incumbent.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(incumbent.mainPlan.facilities.central, { level: 5, slots: [] })
  Object.assign(incumbent.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 2, product: 'gold', slots: [] })
  Object.assign(incumbent.mainPlan.facilities.room_1_3, { type: 'power', level: 3, slots: [] })
  Object.assign(incumbent.mainPlan.facilities.room_2_3, { type: 'power', level: 3, slots: [] })
  Object.assign(incumbent.mainPlan.facilities.dormitory_1, { level: 1, slots: [] })
  assign(incumbent, 'central', 0, '森蚺', '')
  assign(incumbent, 'room_1_1', 0, '温蒂', '')
  assign(incumbent, 'room_1_1', 1, '清流', '')
  assign(incumbent, 'room_1_3', 0, 'Lancet-2', '')
  assign(incumbent, 'room_2_3', 0, '承曦格雷伊', '')
  assign(incumbent, 'dormitory_1', 0, '菲亚梅塔', '')
  incumbent.mainPlan.facilities.dormitory_1.slots[0]!.replacements = ['清流', '温蒂', '森蚺'].map(id)
  incumbent.mainPlan.conf.workaholic = [id('Lancet-2')]
  return { sceneId: 'fiam-global-counterfactual', userBase, incumbent,
    entries: owned(['森蚺', '温蒂', '清流', 'Lancet-2', '承曦格雷伊', '菲亚梅塔']) }
}
const vector = (builder: ReturnType<typeof buildMainRosterHybridPolicyVariables>, family: string, value: number) => builder.variables.map(variable => variable.family === family ? value : 0)

describe('main roster hybrid optional recovery policies', () => {
  it('keeps zero policies byte-identical, including metadata and target order', () => {
    const input = fiamFixture(), before = JSON.stringify(input.incumbent)
    input.incumbent.mainPlan.facilities.dormitory_1.slots[0]!.metadata = { source: 'keep exact spelling and order' }
    const exact = JSON.stringify(input.incumbent), builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    const decoded = builder.decode(input.incumbent, builder.variables.map(() => 0))
    expect(decoded.status).toBe('ready'); expect(decoded.workspace).toBe(input.incumbent)
    expect(JSON.stringify(decoded.workspace)).toBe(exact); expect(decoded.gCalls).toBe(0)
    expect(before).not.toBe(exact)
  })

  it('independently rests a real optional cross-room member while retaining actors, relief and whole cores', () => {
    const input = restFixture(), before = structuredClone(input), builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    expect(builder.variables.find(variable => variable.family === 'rest-policy')?.options.map(option => option.id)).toEqual(['keep', 'independent-support', 'independent-global-provider'])
    const decoded = builder.decode(input.incumbent, vector(builder, 'rest-policy', 1))
    expect(decoded.status).toBe('ready')
    const target = decoded.workspace!.mainPlan.facilities.room_3_1.slots[0]!
    expect(target.groupId).toBeNull()
    expect(target.occupant).toEqual(before.incumbent.mainPlan.facilities.room_3_1.slots[0]!.occupant)
    expect(target.replacements).toEqual(before.incumbent.mainPlan.facilities.room_3_1.slots[0]!.replacements)
    expect(preservesFormedCombinations(input.incumbent, decoded.workspace!, compileOperatorInventory(input.entries))).toBe(true)
    expect(decoded.workspace!.mainPlan.facilities.central.slots[0]).toEqual(input.incumbent.mainPlan.facilities.central.slots[0])
    expect(input).toEqual(before)
  })

  it.each(['explicit-group', 'explicit-group-via-peer', 'position-lock', 'operator-lock', 'multi-binding', 'same-room-team'] as const)('preserves %s constraints instead of inferring generated names', kind => {
    const input = restFixture(), group = input.incumbent.mainPlan.facilities.room_3_1.slots[0]!.groupId!
    if (kind === 'explicit-group') { input.userBase.mainPlan.facilities.room_3_1.slots[0] = structuredClone(input.incumbent.mainPlan.facilities.room_3_1.slots[0]!); expect(group).not.toContain('组合_') }
    if (kind === 'explicit-group-via-peer') assign(input.userBase, 'central', 0, '歌蕾蒂娅', '阿米娅', group + '  ')
    if (kind === 'position-lock') input.lockedPositions = ['room_3_1:0']
    if (kind === 'operator-lock') input.lockedOperators = ['深巡']
    if (kind === 'multi-binding') input.incumbent.mainPlan.facilities.room_3_1.slots[0]!.groupBindings = [{ groupId: 'second', replacements: [id('能天使')] }]
    if (kind === 'same-room-team') { input.incumbent.mainPlan.facilities.room_3_1.level = 2; assign(input.incumbent, 'room_3_1', 1, '古米', '吉星', group); input.entries.push(...owned(['古米', '吉星'])) }
    const before = structuredClone(input), builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    const rest = builder.variables.find(variable => variable.family === 'rest-policy')
    expect(rest?.options.some(option => option.id === 'independent-support') ?? false).toBe(false)
    if (kind !== 'same-room-team') expect(rest).toBeUndefined()
    expect(input).toEqual(before)
  })

  it('ranks Fiam targets with actual whole-base marginal G, including a control provider', () => {
    const input = fiamFixture(), inventory = compileOperatorInventory(input.entries), before = structuredClone(input)
    const builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    const variable = builder.variables.find(variable => variable.family === 'fiammetta-policy')!
    expect(variable.options.length).toBeGreaterThan(1); expect(variable.options.length).toBeLessThanOrEqual(4)
    const decoded = builder.decode(input.incumbent, vector(builder, 'fiammetta-policy', 1))
    expect(decoded.status).toBe('ready')
    const baseG = production.productionWorkspaceHourlyScore(input.incumbent, inventory)!
    const oracle = Object.values(input.incumbent.mainPlan.facilities).filter(room => room.type !== 'dormitory').flatMap(room => room.slots.flatMap((slot, index) => {
      if (slot.occupant.kind !== 'operator' || input.incumbent.mainPlan.conf.workaholic.includes(slot.occupant.operatorId)) return []
      const draft = structuredClone(input.incumbent); draft.mainPlan.facilities[room.roomId].slots[index]!.occupant = { kind: 'empty' }
      return [{ id: slot.occupant.operatorId, value: baseG - production.productionWorkspaceHourlyScore(draft, inventory)! }]
    })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)).slice(0, 3).map(row => row.id)
    expect(decoded.workspace!.mainPlan.facilities.dormitory_1.slots[0]!.replacements).toEqual(oracle)
    expect(oracle).toContain(id('森蚺')); expect(decoded.gCalls).toBeGreaterThan(0)
    expect(input).toEqual(before)
  })

  it.each(['user-target', 'slot-lock', 'unowned-fiam', 'not-in-dorm'] as const)('omits Fiam changes when %s makes them inapplicable', kind => {
    const input = fiamFixture()
    if (kind === 'user-target') assign(input.userBase, 'dormitory_1', 0, '菲亚梅塔', '温蒂')
    if (kind === 'slot-lock') input.lockedPositions = ['dormitory_1:0']
    if (kind === 'unowned-fiam') input.entries = input.entries.filter(entry => entry.operator !== id('菲亚梅塔'))
    if (kind === 'not-in-dorm') input.incumbent.mainPlan.facilities.dormitory_1.type = 'factory'
    const before = structuredClone(input), builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    expect(builder.variables.some(variable => variable.family === 'fiammetta-policy')).toBe(false)
    expect(input).toEqual(before)
  })

  it('keeps unknown counterfactual G unknown rather than assigning zero', () => {
    const input = fiamFixture(), original = production.productionWorkspaceHourlyScore
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation((workspace, inventory) =>
      workspace.mainPlan.facilities.room_1_1.slots[0]?.occupant.kind === 'empty' ? undefined : original(workspace, inventory))
    const builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    const decoded = builder.decode(input.incumbent, vector(builder, 'fiammetta-policy', 1))
    expect(decoded.status).toBe('unknown'); expect(decoded.workspace).toBeUndefined()
    expect(decoded.diagnostics.join(' ')).toMatch(/unknown|量化/)
  })

  it('decodes nonzero rest policies only on constructions with actual eligible supports', () => {
    const input = restFixture(), other = fiamFixture().incumbent
    const builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent, other])
    expect(builder.decode(other, vector(builder, 'rest-policy', 1)).status).toBe('rejected')
    expect(builder.decode(input.incumbent, [-1]).status).toBe('rejected')
  })

  it('keeps a small equal-G rest/target oracle as distinct actual jobs', () => {
    const input = restFixture()
    assign(input.incumbent, 'dormitory_1', 0, '菲亚梅塔', '')
    input.incumbent.mainPlan.facilities.dormitory_1.slots[0]!.replacements = ['深巡', '幽灵鲨', '歌蕾蒂娅'].map(id)
    input.entries.push(...owned(['菲亚梅塔']))
    const builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent]), inventory = compileOperatorInventory(input.entries)
    expect(builder.variables.map(variable => variable.options.length)).toEqual([3, 4])
    const expectedG = production.productionWorkspaceHourlyScore(input.incumbent, inventory), jobs = new Set<string>()
    let gCalls = builder.gCalls
    for (let rest = 0; rest < 3; rest++) for (let fiam = 0; fiam < 4; fiam++) {
      const decoded = builder.decode(input.incumbent, [rest, fiam])
      expect(decoded.status).toBe('ready'); gCalls += decoded.gCalls
      expect(production.productionWorkspaceHourlyScore(decoded.workspace!, inventory)).toBe(expectedG)
      jobs.add(JSON.stringify(decoded.workspace))
    }
    expect(jobs.size).toBeGreaterThanOrEqual(9)
    expect(gCalls).toBe(23) // Provider recognition 2; three contexts, 1+6 real G calls each.
  })

  it('uses the actual low-stage global provider instead of promoting its target contribution', () => {
    const high = fiamFixture(), low = structuredClone(high)
    Object.assign(low.entries.find(entry => entry.operator === id('森蚺'))!, { elitePhase: 0, level: 1 })
    const highG = production.productionWorkspaceHourlyScore(high.incumbent, compileOperatorInventory(high.entries))!
    const inventory = compileOperatorInventory(low.entries), lowG = production.productionWorkspaceHourlyScore(low.incumbent, inventory)!
    expect(highG).toBeGreaterThan(lowG)
    const builder = buildMainRosterHybridPolicyVariables(low, [low.incumbent]), decoded = builder.decode(low.incumbent, [1])
    expect(decoded.status).toBe('ready')
    const oracle = ['森蚺', '温蒂', '清流', '承曦格雷伊'].map(name => {
      const draft = structuredClone(low.incumbent)
      for (const room of Object.values(draft.mainPlan.facilities)) for (const slot of room.slots) if (slot.occupant.kind === 'operator' && slot.occupant.operatorId === id(name)) slot.occupant = { kind: 'empty' }
      return { id: id(name), contribution: lowG - production.productionWorkspaceHourlyScore(draft, inventory)! }
    }).sort((a, b) => b.contribution - a.contribution || a.id.localeCompare(b.id)).slice(0, 3).map(row => row.id)
    expect(decoded.workspace!.mainPlan.facilities.dormitory_1.slots[0]!.replacements).toEqual(oracle)
  })

  it('allows an actual control provider core to rest independently without moving its four manufacturing beneficiaries', () => {
    const input = restFixture()
    input.incumbent.mainPlan.facilities.room_3_1.slots[0] = { occupant: { kind: 'empty' }, groupId: null, replacements: [] }
    const before = structuredClone(input), builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    const variable = builder.variables.find(variable => variable.family === 'rest-policy')!
    expect(variable.options.map(option => option.id)).toEqual(['keep', 'independent-global-provider'])
    const decoded = builder.decode(input.incumbent, vector(builder, 'rest-policy', 1))
    expect(decoded.status).toBe('ready')
    expect(decoded.workspace!.mainPlan.facilities.central.slots[0]!.groupId).toBeNull()
    for (const roomId of ['room_1_1', 'room_1_2'] as const) expect(decoded.workspace!.mainPlan.facilities[roomId]).toEqual(input.incumbent.mainPlan.facilities[roomId])
    expect(decoded.workspace!.mainPlan.facilities.central.slots[0]!.replacements).toEqual(input.incumbent.mainPlan.facilities.central.slots[0]!.replacements)
    expect(preservesFormedCombinations(input.incumbent, decoded.workspace!, compileOperatorInventory(input.entries))).toBe(true)
    expect(input).toEqual(before)
  })

  it('does not invent an effective global-provider policy when production grants are suppressed', () => {
    const input = restFixture()
    assign(input.incumbent, 'room_1_1', 2, '温蒂', '')
    assign(input.incumbent, 'room_1_2', 2, '森蚺', '')
    input.entries.push(...owned(['温蒂', '森蚺']))
    const builder = buildMainRosterHybridPolicyVariables(input, [input.incumbent])
    expect(builder.variables.find(variable => variable.family === 'rest-policy')?.options.some(option => option.id === 'independent-global-provider') ?? false).toBe(false)
  })

  it('retains the actual E0 provider at its alpha strength rather than promoting it to beta', () => {
    const high = restFixture(), low = structuredClone(high)
    Object.assign(low.entries.find(entry => entry.operator === id('歌蕾蒂娅'))!, { elitePhase: 0, level: 1 })
    const contribution = (input: MainRosterHybridInput) => {
      const inventory = compileOperatorInventory(input.entries), absent = structuredClone(input.incumbent)
      absent.mainPlan.facilities.central.slots[0]!.occupant = { kind: 'empty' }
      return production.productionWorkspaceHourlyScore(input.incumbent, inventory)! - production.productionWorkspaceHourlyScore(absent, inventory)!
    }
    expect(contribution(high)).toBeCloseTo(contribution(low) * 2, 8)
    const builder = buildMainRosterHybridPolicyVariables(low, [low.incumbent])
    expect(builder.variables.find(variable => variable.family === 'rest-policy')?.options.some(option => option.id === 'independent-global-provider')).toBe(true)
  })
})
