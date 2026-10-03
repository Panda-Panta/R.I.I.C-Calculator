import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { simulateCandidate } from './candidateSimulation'
import { runRosterIncomeSearchParallel } from './rosterIncomeSearch'
import * as backups from './backupNeighborhood'
import * as primaries from './primaryNeighborhood'
import * as primaryBackups from './primaryBackupNeighborhood'

afterEach(() => vi.restoreAllMocks())

it.each(['multi-start','draft'] as const)('rejects unsupported automatic runner combinations before evaluating (%s)', async variant => {
  const baseline = createDefaultWorkspace()
  const execute = vi.fn(async () => { throw new Error('unsupported configuration reached evaluation') })
  const request = { baseline, inventory: [], configureRunOrderCandidates: true,
    mode: variant === 'multi-start' ? 'multi-start' as const : 'single-pass' as const,
    draft: variant === 'draft' ? structuredClone(baseline) : undefined,
    options: { sampleHours: 1, warmupHours: 0 },
  }
  await expect(runRosterIncomeSearchParallel(request, execute)).rejects.toThrow(/自动跑单/)
  expect(execute).not.toHaveBeenCalled()
})

it.each([false, true].flatMap(automatic => ['香草', '佩佩'].map(replacement => ({automatic,replacement}))))('reconsiders runners and guards physical Pepe only in automatic search ($automatic, $replacement)', async ({automatic,replacement}) => {
  const baseline = createDefaultWorkspace(), room = baseline.mainPlan.facilities.room_3_1
  const inventory = ['芬', '克洛丝', '空爆', '香草', '但书', '龙舌兰', '可露希尔', '佩佩'].map(operator => ({
    operator, elitePhase: ['芬', '克洛丝', '空爆', '香草'].includes(operator) ? 1 : 2,
    level: ['芬', '克洛丝', '空爆', '香草'].includes(operator) ? 55 : 80,
  }))
  room.slots.forEach((slot, index) => { slot.occupant = { kind: 'operator', operatorId: id(['芬', '克洛丝', '空爆'][index]!) } })
  const before = structuredClone(baseline), neighbor = structuredClone(baseline)
  neighbor.mainPlan.facilities.room_3_1.slots[0]!.occupant = { kind: 'operator', operatorId: id(replacement) }
  vi.spyOn(backups, 'generateBackupNeighbors').mockReturnValue([])
  vi.spyOn(primaryBackups, 'generatePrimaryBackupNeighbors').mockReturnValue([])
  vi.spyOn(primaries, 'generateProductionMainNeighbors').mockReturnValue([
    { workspace: neighbor, label: 'change trade main', move: { kind: 'production-main', positions: ['room_3_1_0'] } },
  ])
  const weights = { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  const batches: string[][] = []
  const result = await runRosterIncomeSearchParallel({ baseline, inventory, maxCandidates: 2,
    includeProductionMains: true, configureRunOrderCandidates: automatic, objective: 'composite',
    options: { sampleHours: 1, warmupHours: 0, productionWeights: weights, production: { droneTarget: 'none' } },
  }, async jobs => {
    expect(jobs.every(job => JSON.stringify(job.options?.productionWeights) === JSON.stringify(weights))).toBe(true)
    batches.push(jobs[0]!.workspace.mainPlan.facilities.room_3_1.slots.flatMap(slot => slot.replacements))
    return jobs.map(simulateCandidate)
  })
  const rejectsPepe = automatic && replacement === '佩佩'
  expect(result.candidates).toHaveLength(rejectsPepe ? 1 : 2)
  expect(batches).toEqual(rejectsPepe ? [[]] : [[], automatic ? [id('可露希尔')] : []])
  expect(baseline).toEqual(before)
})
