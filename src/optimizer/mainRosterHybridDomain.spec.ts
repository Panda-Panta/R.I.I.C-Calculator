import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { normalizeProductionWeights } from '../domain/productionWeights'
import type { MowerSlot, RosterWorkspace } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import * as bridge from '../workbench/scheduleSimulationBridge'
import { generateContextualCrewCandidates } from './jointBackupCrewSeeds'
import { buildMainRosterHybridDomain } from './mainRosterHybridDomain'
import type { MainRosterHybridDomain, MainRosterHybridInput } from './mainRosterHybridTypes'
import { generateMolecularCandidates, type MolecularCandidate } from './molecularSynthesis'
import * as output from './productionSingletons'

vi.mock('./molecularSynthesis', () => ({ generateMolecularCandidates: vi.fn(() => []) }))
vi.mock('./jointBackupCrewSeeds', () => ({ generateContextualCrewCandidates: vi.fn(() => ({ candidates: [], diagnostics: [] })) }))
afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.mocked(generateMolecularCandidates).mockReturnValue([])
  vi.mocked(generateContextualCrewCandidates).mockReturnValue({ candidates: [], diagnostics: [] })
})

const empty = (): MowerSlot => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
const slot = (primary: string, backup?: string): MowerSlot => ({ ...empty(), occupant: { kind: 'operator', operatorId: id(primary) }, replacements: backup ? [id(backup)] : [] })
const candidate = (workspace: RosterWorkspace, name = 'actual-construction'): MolecularCandidate => ({ id: name, name, workspace,
  appliedAtoms: [], staticScore: 0, simScore: null, diagnostics: [], confPolicy: {} })

function scene(): MainRosterHybridInput {
  const incumbent = createDefaultWorkspace()
  for (const room of Object.values(incumbent.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(incumbent.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 1, product: 'gold', slots: [slot('砾', '夜烟')] })
  Object.assign(incumbent.mainPlan.facilities.room_1_3, { type: 'power', level: 3, slots: [slot('Lancet-2')] })
  Object.assign(incumbent.mainPlan.facilities.central, { level: 1, slots: [slot('临光', '玫兰莎')] })
  Object.assign(incumbent.mainPlan.facilities.dormitory_1, { level: 1, slots: [slot('薇薇安娜'), ...Array.from({ length: 4 }, () => ({ ...empty(), occupant: { kind: 'free' as const } }))] })
  incumbent.mainPlan.conf.workaholic = [id('Lancet-2')]
  const entries: OwnedOperatorInput[] = [
    { operator: '砾', elitePhase: 2, level: 70 }, { operator: '夜烟', elitePhase: 2, level: 70 },
    { operator: '薇薇安娜', elitePhase: 2, level: 90 }, { operator: '临光', elitePhase: 2, level: 80 },
    { operator: 'Lancet-2', elitePhase: 0, level: 30 }, { operator: '玫兰莎', elitePhase: 1, level: 55 },
  ]
  const userBase = structuredClone(incumbent)
  for (const room of Object.values(userBase.mainPlan.facilities)) for (const position of room.slots) {
    position.occupant = { kind: room.type === 'dormitory' ? 'free' : 'empty' }; position.replacements = []
  }
  return { sceneId: 'real-global-link', userBase, incumbent, entries, maxVectors: 16 }
}

function linked(input: MainRosterHybridInput): RosterWorkspace {
  const workspace = structuredClone(input.incumbent)
  workspace.mainPlan.facilities.central.slots[0]!.occupant = { kind: 'operator', operatorId: id('薇薇安娜') }
  workspace.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('临光') }
  return workspace
}

function policyScene(): MainRosterHybridInput {
  const input = scene(), incumbent = input.incumbent, cycle = 'opaque-generated-cycle'
  Object.assign(incumbent.mainPlan.facilities.central, { level: 2, slots: [slot('临光', '玫兰莎'), { ...slot('歌蕾蒂娅', '阿米娅'), groupId: cycle }] })
  Object.assign(incumbent.mainPlan.facilities.room_1_2, { type: 'manufacture', level: 2, product: 'gold', slots: ['斯卡蒂', '乌尔比安'].map((name, index) => ({ ...slot(name, ['梓兰', '安赛尔'][index]), groupId: cycle })) })
  Object.assign(incumbent.mainPlan.facilities.room_2_1, { type: 'manufacture', level: 2, product: 'exp', slots: ['安哲拉', '幽灵鲨'].map((name, index) => ({ ...slot(name, ['芙蓉', '黑角'][index]), groupId: cycle })) })
  Object.assign(incumbent.mainPlan.facilities.room_2_2, { type: 'trading', level: 1, product: 'money', slots: [{ ...slot('深巡', '能天使'), groupId: cycle }] })
  incumbent.mainPlan.facilities.dormitory_1.slots[0] = slot('菲亚梅塔')
  incumbent.mainPlan.facilities.dormitory_1.slots[0]!.replacements = ['深巡', '斯卡蒂', '砾'].map(id)
  Object.assign(incumbent.mainPlan.facilities.dormitory_2, { level: 1, slots: Array.from({ length: 5 }, () => ({ ...empty(), occupant: { kind: 'free' as const } })) })
  const names = Object.values(incumbent.mainPlan.facilities).flatMap(room => room.slots.flatMap(position => [
    ...(position.occupant.kind === 'operator' ? [id(position.occupant.operatorId)] : []), ...position.replacements.map(id),
  ]))
  input.entries = fullCatalogIdleInventory().filter(entry => names.includes(entry.operator))
  input.userBase = structuredClone(incumbent)
  for (const room of Object.values(input.userBase.mainPlan.facilities)) for (const position of room.slots) {
    position.occupant = { kind: room.type === 'dormitory' ? 'free' : 'empty' }; position.groupId = null; position.replacements = []
  }
  input.sceneId = 'actual-rest-and-fiam-coupling'; input.maxVectors = 128
  return input
}

const row = (domain: MainRosterHybridDomain, construction = 0) => domain.materializations[[construction, ...domain.initial.slice(1)].join(',')]!
const publicFeasible = (domain: MainRosterHybridDomain, vector: number[]) => !domain.publicSpec.forbidden.some(rule => rule.vars.every((variable, index) => vector[variable] === rule.values[index]))
const publicG = (domain: MainRosterHybridDomain, vector: number[]) => domain.publicSpec.unary.reduce((sum, values, index) => sum + values[vector[index]!]!, 0) +
  domain.publicSpec.factors.reduce((sum, factor) => sum + (factor.table[factor.vars.map(index => vector[index]).join(',')] ?? 0), 0)

describe('finite actual main-roster hybrid domain', () => {
  it('keeps the initial vector byte-identical and measures the actual Vivi→Gravel global gain', () => {
    const input = scene(), before = JSON.stringify(input)
    expect(compileOperatorInventory(input.entries).valid).toBe(true)
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(linked(input))])
    const simulation = vi.spyOn(bridge, 'runScheduleSimulationBridge').mockImplementation(() => { throw new Error('F forbidden') })
    const domain = buildMainRosterHybridDomain(input)
    expect(domain.initial.every(value => value === 0)).toBe(true)
    expect(row(domain).workspace).toEqual(input.incumbent)
    expect(JSON.stringify(row(domain).workspace)).toBe(JSON.stringify(input.incumbent))
    expect(row(domain).status).toBe('ready'); expect(row(domain, 1).status).toBe('ready')
    // E2 Vivi grants the working Gravel seven production points: 10000 × .8 × .07 = 560/day.
    expect((row(domain, 1).primaryHourlyScore! - row(domain).primaryHourlyScore!) * 24).toBeCloseTo(560, 7)
    expect(domain.publicSpec.id).toBe(input.sceneId)
    expect(JSON.stringify(input)).toBe(before)
    expect(simulation).not.toHaveBeenCalled()
  })

  it('encodes exactly the measured finite G table and explicit exclusions, without native labels', () => {
    const input = scene(), bad = linked(input)
    bad.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('薇薇安娜') }
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(linked(input)), candidate(bad, 'duplicate')])
    const domain = buildMainRosterHybridDomain(input)
    for (const materialized of Object.values(domain.materializations)) {
      expect(publicFeasible(domain, materialized.vector)).toBe(materialized.status === 'ready')
      if (materialized.status === 'ready') expect(publicG(domain, materialized.vector)).toBe(materialized.primaryHourlyScore)
    }
    expect(domain.publicSpec.factors).toHaveLength(1)
    expect(domain.publicSpec.metadata.proofScope).toBe('declared-finite-primary-G-model-only')
    expect(JSON.stringify(domain.publicSpec)).not.toMatch(/simScore|nativeScore|fullScore|simulatorScore/)
  })

  it.each(['room_1_1:0', 'room_1_1_0'])('uses the original user position lock %s', key => {
    const input = scene()
    input.userBase.mainPlan.facilities.room_1_1.slots[0] = structuredClone(input.incumbent.mainPlan.facilities.room_1_1.slots[0]!)
    input.lockedPositions = [key]
    const changed = linked(input); changed.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('玫兰莎')]
    changed.mainPlan.facilities.central.slots[0]!.replacements = [id('夜烟')]
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(changed)])
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    expect(row(domain, 1).status).toBe('rejected')
    expect(row(domain, 1).diagnostics.join(' ')).toContain('USER_LOCK')
  })

  it('preserves an original operator lock across actual roles using normalized aliases', () => {
    const input = scene()
    input.userBase.mainPlan.facilities.central.slots[0] = structuredClone(input.incumbent.mainPlan.facilities.central.slots[0]!)
    input.lockedOperators = ['临光']
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(linked(input))])
    expect(row(buildMainRosterHybridDomain(input), 1).status).toBe('rejected')
  })

  it('does not freeze a core that was generated only in the incumbent', () => {
    const input = scene(), alternative = structuredClone(input.incumbent)
    input.entries.push({ operator: '多萝西', elitePhase: 2, level: 90 })
    input.incumbent.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('多萝西') }
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(alternative)])
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status).toBe('ready'); expect(row(domain, 1).status).toBe('ready')
  })

  it.each(['backup', 'dorm'] as const)('rejects an unowned actual %s before consulting G', role => {
    const input = scene(), unowned = linked(input)
    if (role === 'backup') unowned.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('斑点')]
    else unowned.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('斑点') }
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(unowned)])
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain, 1).status).toBe('rejected')
    expect(row(domain, 1).diagnostics.join(' ')).toContain('INVENTORY_OPERATOR_NOT_OWNED')
    expect(row(domain, 1).primaryHourlyScore).toBeNull()
  })

  it('keeps a locked relief actor in its original physical role instead of accepting the same name elsewhere', () => {
    const input = scene(), changed = linked(input)
    input.userBase.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('夜烟')]
    input.lockedOperators = ['夜烟']
    changed.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id('玫兰莎')]
    changed.mainPlan.facilities.central.slots[0]!.replacements = [id('夜烟')]
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(changed)])
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    expect(row(domain, 1).status).toBe('rejected')
    expect(row(domain, 1).diagnostics.join(' ')).toContain('USER_LOCK_OPERATOR')
  })

  it('includes preserved metadata in the complete original slot lock', () => {
    const input = scene()
    input.incumbent.mainPlan.facilities.room_1_1.slots[0]!.metadata = { userTag: 'keep' }
    input.userBase.mainPlan.facilities.room_1_1.slots[0] = structuredClone(input.incumbent.mainPlan.facilities.room_1_1.slots[0]!)
    input.lockedPositions = ['room_1_1:0']
    const changed = linked(input); changed.mainPlan.facilities.room_1_1.slots[0]!.metadata = { userTag: 'changed' }
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(changed)])
    expect(row(buildMainRosterHybridDomain(input), 1).diagnostics.join(' ')).toContain('USER_LOCK_POSITION')
  })

  it('preserves an explicit user group while filling its unlocked vacant primary', () => {
    const input = scene()
    input.userBase.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'user-group'
    input.incumbent.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'user-group'
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    const changed = linked(input); changed.mainPlan.facilities.room_1_1.slots[0]!.groupId = null
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(changed)])
    expect(row(buildMainRosterHybridDomain(input), 1).diagnostics.join(' ')).toContain('USER_GROUP')
  })

  it('compares effective shared weights while keeping exact initial metadata', () => {
    const input = scene()
    input.incumbent.productionWeights = normalizeProductionWeights()
    const changed = linked(input); changed.productionWeights = { ...input.incumbent.productionWeights, exp: 2 }
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(changed)])
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    expect(row(domain).workspace).toEqual(input.incumbent)
    expect(row(domain, 1).status).toBe('rejected')
    expect(row(domain, 1).diagnostics.join(' ')).toContain('USER_WEIGHTS')
  })

  it('uses the actual unlocked stage in the same global context', () => {
    const high = scene(), low = scene()
    low.entries = low.entries.map(entry => entry.operator === '薇薇安娜' ? { ...entry, elitePhase: 0, level: 1 } : entry)
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(linked(high))])
    const highDomain = buildMainRosterHybridDomain(high)
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(linked(low))])
    const lowDomain = buildMainRosterHybridDomain(low)
    expect(row(highDomain, 1).primaryHourlyScore!).toBeGreaterThan(row(lowDomain, 1).primaryHourlyScore!)
    expect(row(lowDomain, 1).primaryHourlyScore! - row(lowDomain).primaryHourlyScore!).toBeCloseTo(0, 9)
  })

  it.each([undefined, NaN, Infinity, -Infinity])('leaves unavailable G %s unknown and excluded from the public model', unavailable => {
    const input = scene()
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockReturnValue(unavailable)
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).workspace).toEqual(input.incumbent)
    expect(row(domain).status).toBe('unknown'); expect(row(domain).primaryHourlyScore).toBeNull()
    expect(publicFeasible(domain, domain.initial)).toBe(false)
    expect(Object.keys(domain.publicSpec.factors[0]!.table)).toHaveLength(0)
  })

  it('retains a thrown G failure as unknown and never calls the simulator', () => {
    vi.spyOn(output, 'productionWorkspaceHourlyScore').mockImplementation(() => { throw new Error('projection-not-supported') })
    const domain = buildMainRosterHybridDomain(scene())
    expect(row(domain).status).toBe('unknown')
    expect(row(domain).diagnostics.join(' ')).toContain('projection-not-supported')
  })

  it('declares a bounded unique construction domain and keeps option zero with a one-vector budget', () => {
    const input = scene(), stronger = linked(input)
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(stronger), candidate(structuredClone(stronger), 'duplicate')])
    vi.mocked(generateContextualCrewCandidates).mockReturnValue({ candidates: [{ id: 'same-crew', workspace: structuredClone(stronger) }], diagnostics: [] })
    const domain = buildMainRosterHybridDomain(input)
    expect(domain.variables[0]!.options).toHaveLength(2)
    expect(domain.evidence.declaredVectors).toBeLessThanOrEqual(128)
    expect(Object.keys(domain.materializations)).toHaveLength(domain.evidence.declaredVectors)
    const limited = buildMainRosterHybridDomain({ ...input, maxVectors: 1 })
    expect(limited.evidence.declaredVectors).toBe(1)
    expect(row(limited).workspace).toEqual(input.incumbent)
  })

  it('preserves construction failures as evidence while still measuring the incumbent', () => {
    vi.mocked(generateMolecularCandidates).mockImplementation(() => { throw new Error('construction-is-unsupported') })
    const domain = buildMainRosterHybridDomain(scene())
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    expect(domain.evidence.diagnostics.join(' ')).toContain('construction-is-unsupported')
  })

  it('does not promote invalid actual stages or incomplete staffing to ready', () => {
    const input = scene()
    input.entries[0] = { ...input.entries[0]!, elitePhase: 2, level: 900 }
    expect(row(buildMainRosterHybridDomain(input)).status).toBe('rejected')
    const incomplete = scene(); incomplete.incumbent.mainPlan.facilities.central.slots[0]!.occupant = { kind: 'empty' }
    expect(row(buildMainRosterHybridDomain(incomplete)).status).toBe('rejected')
  })

  it('reports warmup and recovery violations without rewriting the original initial vector', () => {
    const input = scene()
    input.entries.push({ operator: '机械师', elitePhase: 2, level: 90 })
    input.incumbent.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('机械师') }
    const domain = buildMainRosterHybridDomain(input)
    expect(row(domain).status).toBe('rejected')
    expect(row(domain).workspace).toEqual(input.incumbent)
    expect(row(domain).diagnostics.join(' ')).toContain('WARMUP')
    const noBeds = scene()
    noBeds.incumbent.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'no-beds'
    noBeds.incumbent.mainPlan.facilities.dormitory_1.level = 0; noBeds.incumbent.mainPlan.facilities.dormitory_1.slots = []
    const rejected = row(buildMainRosterHybridDomain(noBeds))
    expect(rejected.status).toBe('rejected'); expect(rejected.diagnostics.join(' ')).toContain('RECOVERY')
  })

  it('retains actual equal-G recovery/Fiammetta jobs and forbids a construction-policy conflict', () => {
    const input = policyScene(), alreadyIndependent = structuredClone(input.incumbent), before = JSON.stringify(input)
    alreadyIndependent.mainPlan.facilities.room_2_2.slots[0]!.groupId = null
    vi.mocked(generateMolecularCandidates).mockReturnValue([candidate(alreadyIndependent)])
    const domain = buildMainRosterHybridDomain(input)
    const rest = domain.variables.findIndex(variable => variable.family === 'rest-policy'), fia = domain.variables.findIndex(variable => variable.family === 'fiammetta-policy')
    expect(rest).toBeGreaterThan(0); expect(fia).toBeGreaterThan(0)
    expect(row(domain).status, row(domain).diagnostics.join('\n')).toBe('ready')
    const changed = Object.values(domain.materializations).filter(materialized => materialized.status === 'ready' && materialized.vector[rest] === 1 && materialized.vector[fia]! > 0)
    expect(changed.length).toBeGreaterThan(0)
    for (const materialized of changed) {
      expect(materialized.primaryHourlyScore).toBeCloseTo(row(domain).primaryHourlyScore!, 9)
      expect(JSON.stringify(materialized.workspace)).not.toBe(JSON.stringify(input.incumbent))
      expect(publicFeasible(domain, materialized.vector)).toBe(true)
    }
    const conflict = [1, ...domain.initial.slice(1)]; conflict[rest] = 1
    const rejected = domain.materializations[conflict.join(',')]!
    expect(rejected.status).toBe('rejected'); expect(publicFeasible(domain, conflict)).toBe(false)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('records an operator whose only schedule change is its recovery group', () => {
    const input = policyScene(), domain = buildMainRosterHybridDomain(input)
    const rest = domain.variables.findIndex(variable => variable.family === 'rest-policy')
    const vector = [...domain.initial]; vector[rest] = 1
    const materialized = domain.materializations[vector.join(',')]!
    expect(materialized.status, materialized.diagnostics.join('\n')).toBe('ready')
    expect(materialized.workspace!.mainPlan.facilities.room_2_2.slots[0]!.occupant).toEqual(input.incumbent.mainPlan.facilities.room_2_2.slots[0]!.occupant)
    expect(materialized.workspace!.mainPlan.facilities.room_2_2.slots[0]!.groupId).toBeNull()
    expect(materialized.changedOperators).toContain(id('深巡'))
    expect(materialized.changedFacilities).toContain('room_2_2')
  })

  it('trims the declared policy Cartesian product to a smaller caller budget without changing option zero', () => {
    const input = policyScene(); input.maxVectors = 3
    const domain = buildMainRosterHybridDomain(input)
    expect(domain.evidence.declaredVectors).toBeLessThanOrEqual(3)
    expect(domain.publicSpec.domains.reduce((product, count) => product * count, 1)).toBe(domain.evidence.declaredVectors)
    expect(row(domain).workspace).toEqual(input.incumbent)
    expect(row(domain).status).toBe('ready')
  })
})
