import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import * as synthesis from './molecularSynthesis'
import * as computation from './computedManufacturingRoster'
import * as generation from './jointBackupGenerator'
import * as observers from './jointBackupObservers'
import * as alternatives from './jointBackupMainAlternatives'
import * as crewSeeds from './jointBackupCrewSeeds'
import * as simulation from './candidateSimulation'
import { runSmartRoster, runSmartRosterParallel } from './smartRoster'
import { generatedBackupTriggerExpression, type GeneratedBackupDescriptor } from './generatedBackupTypes'

const descriptor: GeneratedBackupDescriptor = { version: 'joint-production-v1', trigger: {
  observers: [{ operatorId: 'Lancet-2', roomId: 'room_1_3' }], activeWhen: 'all-present',
} }

function scene() {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const production = base.mainPlan.facilities.room_1_1
  production.type = 'manufacture'; production.product = 'gold'; production.level = 1
  production.slots = [{ occupant: { kind: 'empty' }, groupId: null, replacements: [] }]
  const power = base.mainPlan.facilities.room_1_3
  power.type = 'power'; power.level = 1; power.slots = [{ occupant: { kind: 'empty' }, groupId: null, replacements: [] }]
  const dorm = base.mainPlan.facilities.dormitory_1
  dorm.level = 1; dorm.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' as const }, groupId: null, replacements: [] }))
  const main = structuredClone(base)
  main.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('砾') }, groupId: 'production', replacements: [id('斑点')] }
  main.mainPlan.facilities.room_1_3.slots[0] = { occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }
  main.mainPlan.conf.workaholic = [id('Lancet-2')]
  main.mainPlan.facilities.dormitory_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('杜林') }, groupId: null, replacements: [] }
  const other = structuredClone(main)
  other.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('斑点') }, groupId: 'production', replacements: [id('砾')] }
  const owned = fullCatalogIdleInventory().filter(row => ['砾', '斑点', 'Lancet-2', '杜林'].some(name => row.operator === id(name)))
  const branches = [main, other].map((workspace, index) => ({ id: `main-${index}`, name: 'fixture', workspace,
    appliedAtoms: [], staticScore: 100, simScore: null, diagnostics: [], confPolicy: {} }))
  return { base, main, other, owned, branches }
}

beforeEach(() => {
  vi.spyOn(computation, 'computeManufacturingRoster').mockReturnValue({ workspace: null, diagnostics: [], calculation: {
    status: 'unsupported', libraryComplete: false, columnCount: 0, quantifiedColumnCount: 0, initialObjective: null,
    frozenComponents: [], elapsedMs: 0, proofScope: 'quantified-manufacturing-model-only',
  } })
})
afterEach(() => vi.restoreAllMocks())

function prepare(score = 120) {
  const fixture = scene()
  vi.spyOn(synthesis, 'generateMolecularCandidates').mockReturnValue(fixture.branches)
  vi.spyOn(observers, 'selectJointBackupTriggers').mockReturnValue([descriptor.trigger])
  const joint = structuredClone(fixture.main)
  joint.name = 'joint-winner'; joint.compatibility.importedHasBackupPlans = true
  joint.compatibility.backupPlans = [{ name: '自动联动副表', trigger: generatedBackupTriggerExpression(descriptor.trigger),
    trigger_timing: 'AFTER_PLANNING', exit_trigger_timing: 'AFTER_PLANNING', plan: {} }]
  const generator = vi.spyOn(generation, 'generateJointBackupCandidates').mockReturnValue({ candidates: [
    { id: 'joint', mainId: 'main-1', overlayId: 'main-0', workspace: joint, generatedBackup: descriptor },
  ], diagnostics: [] })
  const evaluator = vi.spyOn(simulation, 'simulateCandidate').mockImplementation(job => ({ completed: true,
    simScore: job.generatedBackup ? score : 100, diagnostics: [] }))
  return { ...fixture, generator, evaluator }
}

describe('smart roster joint backup opt-in', () => {
  it('preserves the ordinary generation path when the new mode is absent', () => {
    const fixture = prepare(), result = runSmartRoster(fixture.base, fixture.owned, { seed: 42 })
    expect(result.status).toBe('draft')
    expect(result.workspace?.compatibility.backupPlans).toEqual([])
    expect(fixture.generator).not.toHaveBeenCalled()
  })

  it('includes contextual whole-crew seeds only in the experimental candidate batch', () => {
    const fixture = prepare(100), seed = { id: 'contextual-crew', workspace: { ...structuredClone(fixture.other), name: 'contextual-crew' } }
    const proposer = vi.spyOn(crewSeeds, 'generateContextualCrewCandidates').mockReturnValue({ candidates: [seed], diagnostics: [] })
    runSmartRoster(fixture.base, fixture.owned, { seed: 42 })
    expect(proposer).not.toHaveBeenCalled()
    const result = runSmartRoster(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true })
    expect(proposer).toHaveBeenCalledOnce()
    expect(fixture.generator.mock.calls[0]![0].some(candidate => candidate.id === seed.id)).toBe(true)
    expect(result.phases.simulation!.candidates.length).toBeLessThanOrEqual(4)
  })

  it('compares multiple main plans and returns the exact completed joint winner', () => {
    const fixture = prepare(), before = JSON.stringify(fixture.base)
    const result = runSmartRoster(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true })
    expect(fixture.generator).toHaveBeenCalledOnce()
    expect(fixture.generator.mock.calls[0]![0].length).toBeGreaterThanOrEqual(2)
    expect(result.status).toBe('draft')
    expect(result.score).toBe(120)
    expect(result.workspace?.name).toBe('joint-winner')
    expect(result.workspace?.compatibility.backupPlans).toHaveLength(1)
    expect(fixture.evaluator.mock.calls.filter(([job]) => job.generatedBackup)).toHaveLength(1)
    expect(fixture.evaluator.mock.calls.length).toBeLessThanOrEqual(8)
    expect(JSON.stringify(fixture.base)).toBe(before)
  })

  it('keeps a plain table on an equal-scoring joint proposal', () => {
    const fixture = prepare(100), result = runSmartRoster(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true })
    expect(result.status).toBe('draft')
    expect(result.score).toBe(100)
    expect(result.workspace?.compatibility.backupPlans).toEqual([])
  })

  it('reports why an automatic room complement was rejected', () => {
    const fixture = prepare(100)
    const rejection = { code: 'SHIFT_ALTERNATIVE_WARMUP_UNSUPPORTED', message: '暖机普通替班不能整房对调' }
    vi.spyOn(alternatives, 'generateProductionShiftAlternatives').mockReturnValue({ candidates: [], diagnostics: [rejection] })
    const result = runSmartRoster(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true })
    expect(result.diagnostics).toContainEqual(rejection)
  })

  it('keeps candidate identity and selected workspace equal across serial and reordered parallel batches', async () => {
    const fixture = prepare(), serial = runSmartRoster(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true })
    const parallel = await runSmartRosterParallel(fixture.base, fixture.owned, { seed: 42, enableBackupGeneration: true },
      async (jobs, onComplete) => {
        const results = jobs.map(job => simulation.simulateCandidate(job))
        for (let index = results.length - 1; index >= 0; index--) onComplete(results[index]!, index)
        return results
      })
    expect(parallel.status).toBe('draft')
    expect(parallel.score).toBe(serial.score)
    expect(parallel.workspace).toEqual(serial.workspace)
    expect(parallel.workspace?.compatibility.backupPlans).toHaveLength(1)
  })
})
