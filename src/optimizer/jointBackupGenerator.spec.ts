import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { exportMowerJson, importMowerJson } from '../workbench/compat/mowerJson'
import { compileBackupExpression } from '../scheduler/backupExpression'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { withMowerFreeBeds } from '../test/mowerRosterFixture'
import { validatePhysicalRoster } from './rosterDraft'
import { generateJointBackupCandidates } from './jointBackupGenerator'
import * as production from './productionSingletons'
import {
  GENERATED_BACKUP_PLAN_NAME, GENERATED_BACKUP_TIMING, generatedBackupTriggerExpression,
  type GeneratedBackupTrigger,
} from './generatedBackupTypes'

const primary = ['芬', '香草', '翎羽']
const alternate = ['克洛丝', '炎熔', '米格鲁']
const observers = ['阿米娅', '杜宾']
const inventory = (): OwnedOperatorInput[] => [...primary, ...alternate, ...observers, '霜叶', '红豆']
  .map(operator => ({ operator, elitePhase: 0, level: 1 }))
const slot = (operator: string, replacement?: string): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(operator) }, groupId: '生产组',
  replacements: replacement ? [id(replacement)] : [],
})
const trigger = (activeWhen: GeneratedBackupTrigger['activeWhen'] = 'all-present'): GeneratedBackupTrigger => ({
  observers: [{ operatorId: id(observers[0]!), roomId: 'central', requirePositiveMood: true }], activeWhen,
})

function pair() {
  const a = withMowerFreeBeds(createDefaultWorkspace(), 6)
  a.mainPlan.facilities.room_1_1.slots = primary.map((name, index) => slot(name, alternate[index]))
  observers.forEach((name, index) => {
    a.mainPlan.facilities.central.slots[index] = { occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] }
  })
  const b = structuredClone(a)
  b.mainPlan.facilities.room_1_1.slots = alternate.map((name, index) => slot(name, primary[index]))
  return [{ id: 'A', workspace: a }, { id: 'B', workspace: b }]
}

const rawPlan = (workspace: RosterWorkspace) => workspace.compatibility.backupPlans[0] as Record<string, unknown>
const crewKey = (workspace: RosterWorkspace) => JSON.stringify(workspace.mainPlan.facilities.room_1_1.slots.map(position => position.occupant))
const observerPresent = (workspace: RosterWorkspace) => {
  const occupant = workspace.mainPlan.facilities.central.slots[0]!.occupant
  return occupant.kind === 'operator' && id(occupant.operatorId) === id('阿米娅')
}
const withObserverRelief = <T extends { workspace: RosterWorkspace }>(mains: T[]): T[] => {
  for (const main of mains) main.workspace.mainPlan.facilities.central.slots.forEach((slot, index) => {
    if (slot.occupant.kind === 'operator') slot.replacements = [id(['霜叶', '红豆'][index]!)]
  })
  return mains
}
function threeOrFourMains(includeFourth = false) {
  const [a, b] = withObserverRelief(pair())
  const middle = structuredClone(a!)
  middle.id = 'initial'
  middle.workspace.mainPlan.facilities.room_1_1.slots.reverse()
  const result = [a!, middle]
  if (includeFourth) {
    const other = structuredClone(a!)
    other.id = 'other'
    const row = other.workspace.mainPlan.facilities.room_1_1.slots
    row.push(row.shift()!)
    result.push(other)
  }
  return [...result, b!]
}
afterEach(() => vi.restoreAllMocks())

describe('joint main and one conditional production backup generation', () => {
  it('generates both directions from exact full exported rooms, with no task/conf and no input mutation', () => {
    const mains = pair(), entries = inventory(), before = structuredClone({ mains, entries })
    expect(mains.map(main => validatePhysicalRoster(main.workspace))).toEqual([[], []])
    expect(compileOperatorInventory(entries).operators.some(operator => !operator.matchesMaximumSkills)).toBe(true)
    const result = generateJointBackupCandidates(mains, entries, { triggers: [trigger()] })
    expect(result.candidates, JSON.stringify(result.diagnostics)).toHaveLength(2)
    expect(result.candidates.map(candidate => [candidate.mainId, candidate.overlayId])).toEqual([['A', 'B'], ['B', 'A']])
    for (const candidate of result.candidates) {
      const base = mains.find(main => main.id === candidate.mainId)!.workspace
      const target = mains.find(main => main.id === candidate.overlayId)!.workspace
      const exported = JSON.parse(exportMowerJson(target))
      expect(candidate.workspace.mainPlan).toEqual(base.mainPlan)
      expect(candidate.workspace.compatibility.backupPlans).toHaveLength(1)
      expect(rawPlan(candidate.workspace)).toEqual({
        name: GENERATED_BACKUP_PLAN_NAME,
        trigger: generatedBackupTriggerExpression(trigger()),
        trigger_timing: GENERATED_BACKUP_TIMING,
        exit_trigger_timing: GENERATED_BACKUP_TIMING,
        plan: { room_1_1: exported[target.compatibility.defaultPlanKey].room_1_1 },
      })
      expect(candidate.generatedBackup).toEqual({ version: 'joint-production-v1', trigger: trigger() })
      expect(JSON.stringify(rawPlan(candidate.workspace))).not.toContain('Current')
    }
    expect({ mains, entries }).toEqual(before)
    result.candidates[0]!.workspace.name = 'detached result'
    expect(mains[0]!.workspace.name).toBe(before.mains[0]!.workspace.name)
  })

  it('copies all changed production rooms together, preserving trade product serialization', () => {
    const mains = pair()
    const spares = ['安德切尔', '斑点', '卡缇', '梓兰', '史都华德', '芙蓉']
    const workerSlot = (name: string) => slot(name, spares[[...primary, ...alternate].indexOf(name)])
    for (const main of mains) main.workspace.mainPlan.facilities.room_1_1.slots = primary.map(workerSlot)
    mains[0]!.workspace.mainPlan.facilities.room_3_1.slots = alternate.map(workerSlot)
    mains[1]!.workspace.mainPlan.facilities.room_1_1.slots = alternate.map(workerSlot)
    mains[1]!.workspace.mainPlan.facilities.room_3_1.slots = primary.map(workerSlot)
    const entries = [...inventory(), ...spares.map(operator => ({ operator, elitePhase: 0, level: 1 }))]
    expect(mains.map(main => validatePhysicalRoster(main.workspace))).toEqual([[], []])
    const result = generateJointBackupCandidates(mains, entries, { triggers: [trigger()] })
    expect(result.candidates, JSON.stringify(result.diagnostics)).toHaveLength(2)
    for (const candidate of result.candidates) {
      const plan = rawPlan(candidate.workspace).plan as Record<string, { product: string; plans: unknown[] }>
      expect(Object.keys(plan).sort()).toEqual(['room_1_1', 'room_3_1'])
      expect(plan.room_3_1!.product).toBe('lmd')
      expect(Object.values(plan).every(room => room.plans.length === 3)).toBe(true)
    }
  })

  it('promotes only the new backup presence flag before export, and reimports the exact generated room and condition', () => {
    const mains = pair()
    for (const main of mains) {
      main.workspace.compatibility.importedHasBackupPlans = false
      main.workspace.compatibility.unrecognizedFields.future_export = { preserve: true }
    }
    const before = structuredClone(mains)
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()] })
    expect(result.candidates).toHaveLength(2)
    for (const candidate of result.candidates) {
      expect(candidate.workspace.compatibility.importedHasBackupPlans).toBe(true)
      const exported = exportMowerJson(candidate.workspace)
      expect(JSON.parse(exported).backup_plans).toHaveLength(1)
      const restored = importMowerJson(exported)
      expect(restored.compatibility.backupPlans).toHaveLength(1)
      expect(rawPlan(restored).plan).toEqual(rawPlan(candidate.workspace).plan)
      expect(rawPlan(restored).trigger).toEqual({ left: generatedBackupTriggerExpression(trigger()), operator: '', right: '' })
      const runtime = createRosterRuntime({ positions: [{ id: 'central_0', roomId: 'central', primary: id('阿米娅'), candidates: [] }], beds: [] })
      const expression = compileBackupExpression(rawPlan(restored).trigger, new Set())
      expect(expression.evaluate(runtime)).toBe(true)
      delete runtime.occupants.central_0
      expect(expression.evaluate(runtime)).toBe(false)
      expect(restored.compatibility.unrecognizedFields.future_export).toEqual({ preserve: true })
    }
    expect(mains).toEqual(before)
  })

  it('rejects a production room omitted by imported export-presence metadata', () => {
    const mains = pair()
    for (const main of mains) main.workspace.compatibility.importedPresentRooms = ['central']
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()] })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'UNEXPORTABLE_PRODUCTION_ROOM')).toBe(true)
  })

  it.each(['room_1_1_0', 'room_1_1:0'])('preserves a locked position: %s', position => {
    const result = generateJointBackupCandidates(pair(), inventory(), {
      triggers: [trigger()], lockedPositions: new Set([position]),
    })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code.includes('LOCK'))).toBe(true)
  })

  it('preserves locked operators across main/replacement role changes', () => {
    const result = generateJointBackupCandidates(pair(), inventory(), {
      triggers: [trigger()], lockedOperators: new Set(['芬']),
    })
    expect(result.candidates).toEqual([])
  })

  it('keeps unchanged locked observers and unknown configuration byte-for-value', () => {
    const mains = pair()
    for (const main of mains) main.workspace.mainPlan.conf.future_policy = { private: ['preserve', 7] }
    const result = generateJointBackupCandidates(mains, inventory(), {
      triggers: [trigger()], lockedPositions: new Set(['central_0']), lockedOperators: new Set(['阿米娅']),
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]!.workspace.mainPlan.conf.future_policy).toEqual({ private: ['preserve', 7] })
    expect(rawPlan(result.candidates[0]!.workspace)).not.toHaveProperty('conf')
  })

  it('does not invent unowned cards or promote an invalid actual stage', () => {
    const missing = inventory().filter(entry => entry.operator !== '克洛丝')
    expect(generateJointBackupCandidates(pair(), missing, { triggers: [trigger()] }).candidates).toEqual([])
    const invalid = inventory().map(entry => entry.operator === '芬' ? { ...entry, elitePhase: 2 } : entry)
    expect(generateJointBackupCandidates(pair(), invalid, { triggers: [trigger()] }).candidates).toEqual([])
    expect(generateJointBackupCandidates(pair(), inventory().filter(entry => entry.operator !== '阿米娅'), { triggers: [trigger()] }).candidates).toEqual([])
  })

  it('rejects a trigger observer inside the complete overlay main or replacement closure', () => {
    const internal: GeneratedBackupTrigger = {
      observers: [{ operatorId: id('芬'), roomId: 'room_1_1' }], activeWhen: 'all-present',
    }
    expect(generateJointBackupCandidates(pair(), inventory(), { triggers: [internal] }).candidates).toEqual([])
  })

  it('rejects an external observer connected to an overlay shift group', () => {
    const mains = pair()
    for (const main of mains) observers.forEach((_name, index) => {
      const observerSlot = main.workspace.mainPlan.facilities.central.slots[index]!
      observerSlot.groupId = '生产组'
      observerSlot.replacements = [id(observers[1 - index]!)]
    })
    expect(mains.map(main => validatePhysicalRoster(main.workspace))).toEqual([[], []])
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()] })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.some(diagnostic => diagnostic.code.includes('OBSERVER')), JSON.stringify(result.diagnostics)).toBe(true)
  })

  it('supports the shared two-observer room/mood predicate and its complement without editing observers', () => {
    const typed: GeneratedBackupTrigger = {
      observers: observers.map(name => ({ operatorId: id(name), roomId: 'central', requirePositiveMood: true })),
      activeWhen: 'not-all-present',
    }
    const result = generateJointBackupCandidates(pair(), inventory(), { triggers: [typed] })
    expect(result.candidates).toHaveLength(2)
    const expression = rawPlan(result.candidates[0]!.workspace).trigger
    expect(expression).toBe(generatedBackupTriggerExpression(typed))
    const runtime = createRosterRuntime({ positions: observers.map((name, index) => ({
      id: `central_${index}`, roomId: 'central', primary: id(name), candidates: [],
    })), beds: [] })
    const compiled = compileBackupExpression(expression, new Set())
    expect(compiled.evaluate(runtime)).toBe(false)
    runtime.morale[id('杜宾')] = 0
    expect(compiled.evaluate(runtime)).toBe(true)
    expect((rawPlan(result.candidates[0]!.workspace).plan as object)).not.toHaveProperty('central')
  })

  it.each([
    ['conf', (workspace: RosterWorkspace) => { workspace.mainPlan.conf.future_policy = 8 }],
    ['layout', (workspace: RosterWorkspace) => { workspace.mainPlan.facilities.room_1_1.level = 2 }],
    ['non-production', (workspace: RosterWorkspace) => { workspace.mainPlan.facilities.central.slots[0]!.groupId = 'changed' }],
    ['compatibility metadata', (workspace: RosterWorkspace) => { workspace.compatibility.unrecognizedFields.future = 'changed' }],
    ['slot metadata', (workspace: RosterWorkspace) => { workspace.mainPlan.facilities.room_1_1.slots[0]!.metadata = { future: 1 } }],
    ['complex binding', (workspace: RosterWorkspace) => { workspace.mainPlan.facilities.room_1_1.slots[0]!.groupBindings = [{ groupId: 'other', replacements: [] }] }],
    ['incomplete room', (workspace: RosterWorkspace) => { workspace.mainPlan.facilities.room_1_1.slots[2]!.occupant = { kind: 'empty' } }],
  ])('rejects unsupported %s differences', (_label, alter) => {
    const mains = pair()
    alter(mains[1]!.workspace)
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()] }).candidates).toEqual([])
  })

  it('skips existing backups and nondefault backup groups instead of deleting them', () => {
    const mains = pair()
    mains[1]!.workspace.compatibility.backupPlans = [{ name: 'user retained', trigger: 'True' }]
    const before = structuredClone(mains)
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()] }).candidates).toEqual([])
    expect(mains).toEqual(before)
    const grouped = pair()
    for (const main of grouped) main.workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'custom', name: '用户分组', trigger: 'True' }]
    expect(generateJointBackupCandidates(grouped, inventory(), { triggers: [trigger()] }).candidates).toEqual([])
  })

  it('deduplicates full workspaces and respects one fixed total candidate limit', () => {
    const mains = pair()
    const duplicated = [mains[0]!, { id: 'copy-A', workspace: structuredClone(mains[0]!.workspace) }, mains[1]!]
    const result = generateJointBackupCandidates(duplicated, inventory(), { triggers: [trigger(), trigger()] })
    expect(result.candidates).toHaveLength(2)
    expect(new Set(result.candidates.map(candidate => JSON.stringify(candidate.workspace))).size).toBe(2)
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: 1 }).candidates).toHaveLength(1)
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: 0 }).candidates).toEqual([])
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: -1 }).candidates).toEqual([])
    expect(generateJointBackupCandidates([mains[0]!], inventory(), { triggers: [trigger()] }).candidates).toEqual([])
    expect(generateJointBackupCandidates(mains, inventory(), { triggers: [] }).candidates).toEqual([])
  })

  it('skips invalid trigger entries and keeps rejection diagnostics bounded', () => {
    const duplicate = trigger()
    duplicate.observers = [duplicate.observers[0]!, duplicate.observers[0]!]
    const invalid: GeneratedBackupTrigger = { observers: [], activeWhen: 'all-present' }
    const result = generateJointBackupCandidates(pair(), inventory(), {
      triggers: [...Array.from({ length: 40 }, () => invalid), duplicate, trigger()],
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.diagnostics.length).toBeLessThanOrEqual(16)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'INVALID_TRIGGER')).toBe(true)
  })

  it('spreads four proposals over pairs before spending them on both trigger polarities', () => {
    const mains = threeOrFourMains()
    expect(mains.map(main => validatePhysicalRoster(main.workspace))).toEqual([[], [], []])
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(undefined)
    const result = generateJointBackupCandidates(mains, inventory(), {
      triggers: [trigger(), trigger('not-all-present')], maxCandidates: 4,
    })
    expect(result.candidates).toHaveLength(4)
    expect(result.candidates.map(candidate => [candidate.mainId, candidate.overlayId])).toEqual([
      ['A', 'initial'], ['A', 'B'], ['initial', 'B'], ['initial', 'A'],
    ])
    expect(result.candidates.every(candidate => candidate.generatedBackup.trigger.activeWhen === 'all-present')).toBe(true)
  })

  it('prioritizes a quantified observer-state crossover pair in a four-main pool without calling F', () => {
    const mains = threeOrFourMains(true), before = structuredClone(mains)
    const scores = new Map(mains.map((main, index) => [crewKey(main.workspace), [[10, 4], [5, 3], [4, 2], [6, 9]][index]!]))
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace => {
      const on = observerPresent(workspace)
      return scores.get(crewKey(workspace))?.[on ? 0 : 1]
    })
    const result = generateJointBackupCandidates(mains, inventory(), {
      triggers: [trigger(), trigger('not-all-present')], maxCandidates: 4,
    })
    expect(result.candidates).toHaveLength(4)
    expect(result.candidates[0]).toMatchObject({ mainId: 'B', overlayId: 'A' })
    expect(new Set(result.candidates.map(candidate => [candidate.mainId, candidate.overlayId].sort().join('|'))).size).toBe(4)
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
    expect(mains).toEqual(before)
  })

  it('spends a one-candidate budget on the direction that follows the stronger conditional state', () => {
    const mains = withObserverRelief(pair())
    const scores = new Map(mains.map((main, index) => [crewKey(main.workspace), [[10, 4], [6, 9]][index]!]))
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace =>
      scores.get(crewKey(workspace))?.[observerPresent(workspace) ? 0 : 1])
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: 1 })
    expect(result.candidates.map(candidate => [candidate.mainId, candidate.overlayId])).toEqual([['B', 'A']])
  })

  it('reverses the preferred endpoints for the complementary predicate and avoids duplicate state policies', () => {
    const mains = withObserverRelief(pair())
    const scores = new Map(mains.map((main, index) => [crewKey(main.workspace), [[10, 4], [6, 9]][index]!]))
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace =>
      scores.get(crewKey(workspace))?.[observerPresent(workspace) ? 0 : 1])
    const complement = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger('not-all-present')], maxCandidates: 1 })
    expect(complement.candidates[0]).toMatchObject({ mainId: 'A', overlayId: 'B' })
    const both = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger(), trigger('not-all-present')], maxCandidates: 4 })
    expect(both.candidates).toHaveLength(2)
    expect(both.candidates.every(candidate => candidate.generatedBackup.trigger.activeWhen === 'all-present')).toBe(true)
  })

  it('does not rank an unavailable observer rest state as an empty workplace or a zero score', () => {
    const mains = pair()
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(100)
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: 1 })
    expect(result.candidates[0]).toMatchObject({ mainId: 'A', overlayId: 'B' })
    expect(score.mock.calls.every(([workspace]) => observerPresent(workspace))).toBe(true)
  })

  it('keeps the original fair pair order when one static projection is unquantified, not zero', () => {
    const mains = threeOrFourMains(true), unavailable = crewKey(mains[3]!.workspace)
    vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace =>
      crewKey(workspace) === unavailable ? undefined : observerPresent(workspace) ? 5 : 2)
    const result = generateJointBackupCandidates(mains, inventory(), {
      triggers: [trigger(), trigger('not-all-present')], maxCandidates: 4,
    })
    expect(result.candidates.map(candidate => [candidate.mainId, candidate.overlayId])).toEqual([
      ['A', 'initial'], ['A', 'other'], ['A', 'B'], ['initial', 'other'],
    ])
  })

  it('keeps one shared static-call bound when the real input domain exceeds four mains or eight triggers', () => {
    const mains = threeOrFourMains(true)
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(1)
    const conditions = [trigger(), trigger('not-all-present'),
      ...(['all-present', 'not-all-present'] as const).flatMap(activeWhen => [
        { activeWhen, observers: [{ operatorId: id('杜宾'), roomId: 'central' as const }] },
        { activeWhen, observers: observers.map(operatorId => ({ operatorId, roomId: 'central' as const })) },
      ])]
    generateJointBackupCandidates(mains, inventory(), { triggers: [...conditions, trigger(), trigger()], maxCandidates: 4 })
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
    score.mockClear()
    generateJointBackupCandidates(mains, inventory(), { triggers: Array.from({ length: 9 }, () => trigger()), maxCandidates: 4 })
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
    const fifth = structuredClone(mains[3]!)
    fifth.id = 'fifth-unique'
    fifth.workspace.mainPlan.facilities.room_1_1.slots.reverse()
    generateJointBackupCandidates([...mains, fifth], inventory(), { triggers: [trigger()], maxCandidates: 4 })
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
  })

  it('still selects the useful direction from six distinct mains while keeping unknown peers in the pool', () => {
    const mains = threeOrFourMains(true)
    const fifth = structuredClone(mains[0]!), sixth = structuredClone(mains[0]!)
    fifth.id = 'fifth'; fifth.workspace.name = 'fifth'
    sixth.id = 'sixth'; sixth.workspace.name = 'sixth'
    const row = fifth.workspace.mainPlan.facilities.room_1_1.slots
    ;[row[0], row[1]] = [row[1]!, row[0]!]
    sixth.workspace.mainPlan.facilities.room_1_1.slots.reverse()
    mains.push(fifth, sixth)
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace => {
      if (workspace.name === 'fifth' || workspace.name === 'sixth') return undefined
      const scores = new Map(mains.slice(0, 4).map((main, index) => [crewKey(main.workspace), [[10, 4], [5, 3], [4, 2], [6, 9]][index]!]))
      return scores.get(crewKey(workspace))?.[observerPresent(workspace) ? 0 : 1]
    })
    const result = generateJointBackupCandidates(mains, inventory(), { triggers: [trigger()], maxCandidates: 1 })
    expect(result.candidates[0]).toMatchObject({ mainId: 'B', overlayId: 'A' })
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
  })

  it('does not exceed 100 static calls even when many legal endpoint copies compete for one proposal', () => {
    const mains = withObserverRelief(pair())
    const many = Array.from({ length: 60 }, (_, index) => {
      const main = structuredClone(mains[index % 2]!)
      main.id = `copy-${index}`; main.workspace.name = `copy-${index}`
      return main
    })
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockReturnValue(100)
    const result = generateJointBackupCandidates(many, inventory(), { triggers: [trigger()], maxCandidates: 1 })
    expect(result.candidates).toHaveLength(1)
    expect(score).toHaveBeenCalledTimes(100)
  })

  it('counts verified-plain plus four inputs by unique workspace, not by the five raw rows', () => {
    const mains = threeOrFourMains(true)
    const scores = new Map(mains.map((main, index) => [crewKey(main.workspace), [[10, 4], [5, 3], [4, 2], [6, 9]][index]!]))
    const score = vi.spyOn(production, 'productionWorkspaceHourlyScore').mockImplementation(workspace =>
      scores.get(crewKey(workspace))?.[observerPresent(workspace) ? 0 : 1])
    const result = generateJointBackupCandidates([{ id: 'verified-plain', workspace: structuredClone(mains[0]!.workspace) }, ...mains], inventory(), {
      triggers: [trigger(), trigger('not-all-present')], maxCandidates: 4,
    })
    expect(result.candidates[0]).toMatchObject({ mainId: 'B', overlayId: 'verified-plain' })
    expect(score.mock.calls.length).toBeGreaterThan(0)
    expect(score.mock.calls.length).toBeLessThanOrEqual(100)
  })
})
