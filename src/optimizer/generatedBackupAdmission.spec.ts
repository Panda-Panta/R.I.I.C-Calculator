import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { exportMowerJson } from '../workbench/compat/mowerJson'
import { fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot, RosterWorkspace } from '../domain/roster'
import type { CandidateSimulationJob } from './candidateSimulation'
import {
  GENERATED_BACKUP_PLAN_NAME, GENERATED_BACKUP_TIMING,
  generatedBackupTriggerExpression, type GeneratedBackupDescriptor,
} from './generatedBackupTypes'
import { validateGeneratedBackupCandidate } from './generatedBackupAdmission'
import { simulateCandidate } from './candidateSimulation'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { generateJointBackupCandidates } from './jointBackupGenerator'

const staffed = (name: string, replacements: string[] = [], groupId: string | null = null): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(name) }, replacements: replacements.map(id), groupId,
})
function rawRoom(workspace: RosterWorkspace, roomId = 'room_1_1') {
  const native = JSON.parse(exportMowerJson(workspace))
  return native[native.default][roomId]
}
function fixture(): CandidateSimulationJob {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(workspace.mainPlan.facilities.room_1_1, { level: 1, product: 'gold', slots: [staffed('砾', ['斑点'], 'production')] })
  Object.assign(workspace.mainPlan.facilities.room_1_3, { level: 3, slots: [staffed('雷蛇', ['空爆'])] })
  Object.assign(workspace.mainPlan.facilities.central, { level: 1, slots: [staffed('阿米娅', ['夜刀'])] })
  Object.assign(workspace.mainPlan.facilities.dormitory_1, { level: 1, slots: [staffed('杜林'),
    ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }))] })
  const generatedBackup: GeneratedBackupDescriptor = {
    version: 'joint-production-v1', trigger: { observers: [{ operatorId: id('阿米娅'), roomId: 'central' }], activeWhen: 'all-present' },
  }
  const alternate = structuredClone(workspace)
  alternate.mainPlan.facilities.room_1_1.product = 'exp'
  alternate.mainPlan.facilities.room_1_1.slots = [staffed('斑点', ['砾'], 'production')]
  workspace.compatibility.backupPlans = [{ name: GENERATED_BACKUP_PLAN_NAME,
    trigger: generatedBackupTriggerExpression(generatedBackup.trigger), trigger_timing: GENERATED_BACKUP_TIMING,
    exit_trigger_timing: GENERATED_BACKUP_TIMING, plan: { room_1_1: rawRoom(alternate) } }]
  const names = new Set(['砾', '斑点', '雷蛇', '空爆', '阿米娅', '夜刀', '杜林'].map(id))
  return { workspace, generatedBackup, options: { operatorInventory: fullCatalogIdleInventory().filter(entry => names.has(entry.operator)),
    sampleHours: 1, warmupHours: 0, production: { seed: 42, droneTarget: 'none' } }, assumptions: { idleOperators: [] } }
}
const raw = (job: CandidateSimulationJob): any => job.workspace.compatibility.backupPlans[0]
const setTrigger = (job: CandidateSimulationJob) => { raw(job).trigger = generatedBackupTriggerExpression(job.generatedBackup!.trigger) }

describe('bounded generated backup candidate admission', () => {
  it('accepts canonical off/on modes and preserves the request and actual lower skill stage', () => {
    const job = fixture()
    Object.assign(job.options!.operatorInventory!.find(entry => entry.operator === id('砾'))!, { elitePhase: 0, level: 1 })
    const before = structuredClone(job)
    expect(validateGeneratedBackupCandidate(job)).toEqual({ valid: true, diagnostics: [] })
    expect(job).toEqual(before)
  })

  it('accepts two independent external observers with canonical positive mood and negation', () => {
    const job = fixture()
    job.generatedBackup!.trigger = { activeWhen: 'not-all-present', observers: [
      { operatorId: id('阿米娅'), roomId: 'central', requirePositiveMood: true },
      { operatorId: id('雷蛇'), roomId: 'room_1_3' },
    ] }
    setTrigger(job)
    expect(validateGeneratedBackupCandidate(job)).toEqual({ valid: true, diagnostics: [] })
  })

  it('requires a strict descriptor with one or two unique supported observers', () => {
    const mutations: ((job: CandidateSimulationJob) => void)[] = [
      job => { delete job.generatedBackup },
      job => { (job.generatedBackup as any).version = 'future' },
      job => { (job.generatedBackup as any).allowAny = true },
      job => { (job.generatedBackup!.trigger as any).expression = 'True' },
      job => { job.generatedBackup!.trigger.observers = [] },
      job => { job.generatedBackup!.trigger.observers = Array(3).fill(job.generatedBackup!.trigger.observers[0]) },
      job => { job.generatedBackup!.trigger.observers = [job.generatedBackup!.trigger.observers[0]!, job.generatedBackup!.trigger.observers[0]!] },
      job => { (job.generatedBackup!.trigger.observers[0] as any).roomId = 'dormitory_1' },
      job => { (job.generatedBackup!.trigger.observers[0] as any).requirePositiveMood = 1 },
      job => { (job.generatedBackup!.trigger.observers[0] as any).inventory = true },
    ]
    for (const mutate of mutations) { const job = fixture(); mutate(job); expect(validateGeneratedBackupCandidate(job).valid).toBe(false) }
  })

  it('rejects additional backups, executable fields and noncanonical raw conditions', () => {
    const mutations: ((job: CandidateSimulationJob) => void)[] = [
      job => { job.workspace.compatibility.backupPlans.push(structuredClone(raw(job))) },
      job => { raw(job).name = 'manual' },
      job => { raw(job).trigger = 'True' },
      job => { raw(job).trigger = { left: raw(job).trigger, operator: '', right: '' } },
      job => { raw(job).trigger_timing = 'BEFORE_WORK' },
      job => { raw(job).exit_trigger_timing = 'END' },
      ...['task', 'conf', 'type', 'group_ids', 'custom'].map(key => (job: CandidateSimulationJob) => { raw(job)[key] = {} }),
      job => { job.workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'other', name: 'Other', trigger: true }] },
    ]
    for (const mutate of mutations) { const job = fixture(); mutate(job); expect(validateGeneratedBackupCandidate(job).valid).toBe(false) }
  })

  it('requires a complete changed production room with canonical names and preserved metadata', () => {
    const mutations: ((job: CandidateSimulationJob) => void)[] = [
      job => { raw(job).plan = {} },
      job => { raw(job).plan.room_1_1 = rawRoom(job.workspace) },
      job => { raw(job).plan.central = rawRoom(job.workspace, 'central') },
      job => { raw(job).plan.room_1_1.name = '贸易站' },
      job => { raw(job).plan.room_1_1.level = 3 },
      job => { raw(job).plan.room_1_1.plans = [] },
      job => { raw(job).plan.room_1_1.plans.push(raw(job).plan.room_1_1.plans[0]) },
      job => { raw(job).plan.room_1_1.plans[0].agent = 'Current' },
      job => { raw(job).plan.room_1_1.plans[0].agent = 'Free' },
      job => { raw(job).plan.room_1_1.plans[0].agent = '' },
      job => { raw(job).plan.room_1_1.plans[0].agent = id('斑点') },
      job => { raw(job).plan.room_1_1.plans[0].custom = 'new' },
      job => { raw(job).plan.room_1_1.product = 'lmd' },
      job => { job.workspace.mainPlan.facilities.room_1_1.level = 3 },
      job => {
        job.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'current' }
        job.assumptions!.currentOccupants = { room_1_1: [id('砾')] }
      },
    ]
    for (const mutate of mutations) { const job = fixture(); mutate(job); expect(validateGeneratedBackupCandidate(job).valid).toBe(false) }
    const job = fixture()
    job.workspace.mainPlan.facilities.room_1_1.slots[0]!.metadata = { comment: 'preserved' }
    job.workspace.compatibility.facilityMetadata = { room_1_1: { custom: { retained: true } } }
    raw(job).plan.room_1_1.plans[0].comment = 'preserved'
    raw(job).plan.room_1_1.custom = { retained: true }
    expect(validateGeneratedBackupCandidate(job)).toEqual({ valid: true, diagnostics: [] })
    raw(job).plan.room_1_1.custom.retained = false
    expect(validateGeneratedBackupCandidate(job).valid).toBe(false)
  })

  it('requires actual inventory for main, overlay-only and bound replacement participants', () => {
    for (const omitted of ['阿米娅', '砾', '斑点', '夜刀']) {
      const job = fixture()
      job.options!.operatorInventory = job.options!.operatorInventory!.filter(entry => entry.operator !== id(omitted))
      expect(validateGeneratedBackupCandidate(job).diagnostics.join(' ')).toContain('INVENTORY_OPERATOR_NOT_OWNED')
    }
    const job = fixture(); delete job.options!.operatorInventory
    expect(validateGeneratedBackupCandidate(job).diagnostics.join(' ')).toContain('INVENTORY_REQUIRED')
    const invalidStage = fixture(); invalidStage.options!.operatorInventory![0]!.elitePhase = 99
    expect(validateGeneratedBackupCandidate(invalidStage).valid).toBe(false)
    const bound = fixture()
    raw(bound).plan.room_1_1.plans[0].group_bindings = [{ group: 'extra', replacement: ['芬'] }]
    expect(validateGeneratedBackupCandidate(bound).diagnostics.join(' ')).toContain('INVENTORY_OPERATOR_NOT_OWNED')
  })

  it('does not allow a moved, absent or self-dependent observer, including transitive shared groups', () => {
    const moved = fixture()
    moved.generatedBackup!.trigger.observers = [{ operatorId: id('砾'), roomId: 'room_1_1' }]; setTrigger(moved)
    expect(validateGeneratedBackupCandidate(moved).valid).toBe(false)
    const absent = fixture()
    absent.generatedBackup!.trigger.observers = [{ operatorId: id('夜刀'), roomId: 'central' }]; setTrigger(absent)
    expect(validateGeneratedBackupCandidate(absent).valid).toBe(false)
    const shared = fixture()
    shared.workspace.mainPlan.facilities.central.slots[0]!.groupId = 'production'
    expect(validateGeneratedBackupCandidate(shared).diagnostics.join(' ')).toContain('OBSERVER_DEPENDENCY')
    const chain = fixture()
    chain.workspace.mainPlan.facilities.central.slots[0]!.replacements = [id('斑点')]
    expect(validateGeneratedBackupCandidate(chain).diagnostics.join(' ')).toContain('OBSERVER_DEPENDENCY')
  })

  it('rejects an activated-mode duplicate even when conditional workspace validation is advisory', () => {
    const job = fixture()
    raw(job).plan.room_1_1.plans[0].agent = '雷蛇'
    expect(validateGeneratedBackupCandidate(job).diagnostics.join(' ')).toContain('DUPLICATE_OPERATOR')
  })

  it('checks recovery capacity and compiler assumptions before starting any simulation', () => {
    const noBeds = fixture()
    noBeds.workspace.mainPlan.facilities.dormitory_1.slots = [staffed('杜林')]
    expect(validateGeneratedBackupCandidate(noBeds).valid).toBe(false)
    const badCompile = fixture(); badCompile.assumptions!.restingThreshold = 2
    expect(validateGeneratedBackupCandidate(badCompile).diagnostics.join(' ')).toContain('INVALID_ASSUMPTION')
    const unknownPolicy = fixture(); unknownPolicy.workspace.mainPlan.conf.unknown_policy = true
    expect(validateGeneratedBackupCandidate(unknownPolicy).diagnostics.join(' ')).toContain('UNKNOWN_POLICY')
  })

  it('checks activated-only group capacity even when the main mode fits', () => {
    const job = fixture()
    job.generatedBackup!.trigger.observers = [{ operatorId: id('雷蛇'), roomId: 'room_1_3' }]; setTrigger(job)
    job.workspace.mainPlan.facilities.central.slots = []
    job.workspace.mainPlan.facilities.dormitory_1.slots = [staffed('杜林'), { occupant: { kind: 'free' }, groupId: null, replacements: [] }]
    Object.assign(job.workspace.mainPlan.facilities.room_2_1, { level: 1, slots: [staffed('夜刀', ['芬'])] })
    job.options!.operatorInventory!.push(fullCatalogIdleInventory().find(entry => entry.operator === id('芬'))!)
    const alternate = structuredClone(job.workspace)
    alternate.mainPlan.facilities.room_2_1.slots[0]!.groupId = 'production'
    raw(job).plan.room_2_1 = rawRoom(alternate, 'room_2_1')
    const result = validateGeneratedBackupCandidate(job)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some(message => message.includes('backup') && message.includes('RECOVERY_GROUP_CAPACITY'))).toBe(true)
    expect(result.diagnostics.some(message => message.includes('main：'))).toBe(false)
  })

  it('admits actual generator outputs with export presence while retaining the pure baselines', () => {
    const input = fixture(), first = structuredClone(input.workspace)
    first.compatibility.backupPlans = []
    first.compatibility.importedHasBackupPlans = false
    const second = structuredClone(first)
    second.mainPlan.facilities.room_1_1.product = 'exp'
    second.mainPlan.facilities.room_1_1.slots = [staffed('斑点', ['砾'], 'production')]
    const before = structuredClone([first, second])
    const generated = generateJointBackupCandidates([{ id: 'a', workspace: first }, { id: 'b', workspace: second }],
      input.options!.operatorInventory!, { triggers: [input.generatedBackup!.trigger] })
    expect(generated.candidates.length, JSON.stringify(generated.diagnostics)).toBe(2)
    for (const candidate of generated.candidates) {
      expect(candidate.workspace.compatibility.importedHasBackupPlans).toBe(true)
      const job = { ...input, workspace: candidate.workspace, generatedBackup: candidate.generatedBackup }
      expect(validateGeneratedBackupCandidate(job)).toEqual({ valid: true, diagnostics: [] })
      const native = JSON.parse(exportMowerJson(candidate.workspace))
      expect(native.backup_plans).toHaveLength(1)
      expect(native.backup_plans[0].trigger.left).toBe(generatedBackupTriggerExpression(candidate.generatedBackup.trigger))
    }
    expect([first, second]).toEqual(before)
    const omitted = fixture(); omitted.workspace.compatibility.importedHasBackupPlans = false
    expect(validateGeneratedBackupCandidate(omitted).diagnostics.join(' ')).toContain('EXPORT_PRESENCE')
  })

  it('runs admitted production through native activation and exit with strict same-run output', () => {
    const job = fixture(); job.options!.sampleHours = 24
    // Native Free selection needs real idle cards in addition to the named shift actors.
    const idle = new Set(['芬', '香草', '翎羽', '梓兰'].map(id))
    job.options!.operatorInventory!.push(...fullCatalogIdleInventory().filter(entry => idle.has(entry.operator)))
    const before = structuredClone(job)
    const result = simulateCandidate(job)
    expect(result.completed, result.diagnostics.join('\n')).toBe(true)
    expect(result.incomeCase?.eligible).toBe(true)
    expect(result.calculationReport).toBeDefined()
    const native = runScheduleSimulationBridge(job.workspace, job.options, job.assumptions).report!
    expect(native.events.some(event => event.type === 'backup-plan' && event.active === true)).toBe(true)
    expect(native.events.some(event => event.type === 'backup-plan' && event.active === false)).toBe(true)
    expect(native.observedHours).toBeCloseTo(24)
    expect(job).toEqual(before)
  })
})
