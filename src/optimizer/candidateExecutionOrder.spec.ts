import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { OPERATOR_MAP } from '../domain/operators'
import * as morale from '../engine/morale'
import { candidateExecutionOrder } from './candidateExecutionOrder'
import type { CandidateSimulationJob } from './candidateSimulation'

afterEach(() => vi.restoreAllMocks())

function meetingJob(phase: 0 | 2, role: 'main' | 'backup' = 'main'): CandidateSimulationJob {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  const room = workspace.mainPlan.facilities.meeting
  room.level = 2
  const primary = role === 'main' ? ['char_4231_clemnt', 'char_009_12fce'] : [id('芬'), id('香草')]
  const relief = role === 'main' ? [id('芬'), id('香草')] : ['char_4231_clemnt', 'char_009_12fce']
  room.slots = primary.map((operator, index) => ({
    occupant: { kind: 'operator', operatorId: operator }, groupId: 'meeting-pair', replacements: [relief[index]!],
  }))
  return { workspace, options: { operatorInventory: [
    { operator: 'char_4231_clemnt', elitePhase: phase, level: 1 },
    ...['char_009_12fce', id('芬'), id('香草')].map(operator => ({ operator, elitePhase: 0, level: 1 })),
  ] }, assumptions: {} }
}

function freezeRecursively(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeRecursively(child)
  Object.freeze(value)
}

describe('candidate execution cost ordering', () => {
  it('uses each job inventory and its actual skill stage even when the workspace is shared', () => {
    const low = meetingJob(0), high = meetingJob(2)
    high.workspace = low.workspace
    expect(candidateExecutionOrder([low, high])).toEqual([1, 0])
    expect(candidateExecutionOrder([high, low])).toEqual([0, 1])
  })

  it('recognizes an event-heavy backup shift without changing the job or global catalog', () => {
    const ordinary = meetingJob(0), heavyBackup = meetingJob(2, 'backup')
    const jobs = [ordinary, heavyBackup], before = structuredClone(jobs)
    const catalog = structuredClone(OPERATOR_MAP.get('char_4231_clemnt'))
    freezeRecursively(jobs)
    expect(candidateExecutionOrder(jobs)).toEqual([1, 0])
    expect(jobs).toEqual(before)
    expect(OPERATOR_MAP.get('char_4231_clemnt')).toEqual(catalog)
  })

  it('excludes a permanent worker from the positive fatigue cost', () => {
    const permanent = meetingJob(2, 'backup'), ordinary = meetingJob(0)
    permanent.workspace.mainPlan.conf.workaholic = [OPERATOR_MAP.get('char_4231_clemnt')!.name]
    expect(candidateExecutionOrder([permanent, ordinary])).toEqual([1, 0])
  })

  it('keeps stable ties and returns every index when inventory is missing or invalid', () => {
    const missing = meetingJob(0), empty = meetingJob(0), invalid = meetingJob(0)
    missing.options = undefined
    empty.options!.operatorInventory = []
    invalid.options!.operatorInventory = [{ operator: id('芬'), elitePhase: 9, level: 1 }]
    const jobs = [missing, meetingJob(0), empty, meetingJob(0), invalid]
    const order = candidateExecutionOrder(jobs)
    expect(order).toEqual([1, 3, 0, 2, 4])
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    expect(candidateExecutionOrder([])).toEqual([])
  })

  it('does not infer maximum catalog skills for a present operator missing from the job inventory', () => {
    const missing = meetingJob(2), known = meetingJob(0)
    missing.options!.operatorInventory = missing.options!.operatorInventory!.filter(entry => entry.operator !== 'char_4231_clemnt')
    expect(candidateExecutionOrder([missing, known])).toEqual([1, 0])
  })

  it('leaves a job that cannot be projected in the permutation with zero scheduling priority', () => {
    const broken = meetingJob(2), ordinary = meetingJob(0)
    vi.spyOn(morale, 'currentMoraleRates').mockImplementationOnce(() => { throw new Error('unsupported projection') })
    expect(candidateExecutionOrder([broken, ordinary])).toEqual([1, 0])
  })

  it.each([
    { rates: { char_4231_clemnt: Infinity }, details: {}, unquantified: [] },
    { rates: { char_4231_clemnt: 100 }, details: {}, unquantified: ['unknown morale rule'] },
  ])('does not promote nonfinite or explicitly unquantified estimates', snapshot => {
    vi.spyOn(morale, 'currentMoraleRates').mockReturnValueOnce(snapshot)
    expect(candidateExecutionOrder([meetingJob(2), meetingJob(0)])).toEqual([1, 0])
  })
})
