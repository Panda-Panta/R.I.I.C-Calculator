import { describe, expect, it } from 'vitest'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createDefaultWorkspace } from '../workbench/defaults'
import { simulationOutputAmounts } from './productionScore'
import { simulateSchedule } from './scheduleSimulation'

function switchingSchedule(source: 'gold' | 'fragment', target: 'orirock' | 'exp3') {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  Object.assign(workspace.mainPlan.facilities.room_1_1, {
    level: 3, product: source,
    slots: [{ occupant: { kind: 'operator', operatorId: 'char_123_fang' }, groupId: null, replacements: [] }],
  })
  workspace.mainPlan.conf.workaholic = ['char_123_fang']
  workspace.compatibility.unrecognizedFields.advanced_settings = {
    product_switching: { enable: true, use_drones_when_leaving_orirock: false, waiting_seconds: 0 },
  }
  workspace.compatibility.backupPlans = [{
    name: 'product', trigger: "op_data.operators['芬'].current_mood() < 23.5",
    plan: { room_1_1: { product: target, plans: [] } },
  }]
  return compileRosterSchedule(workspace)
}

describe.each(['mower-default', 'mower-alpha'] as const)('resource-specific output after recipe switches in %s', schedulingModel => {
  it.each([
    ['gold', 'orirock', { gold: 3, exp: 0, fragments: 6 }],
    ['fragment', 'exp3', { gold: 0, exp: 1000, fragments: 4 }],
  ] as const)('keeps completed %s output when switching to %s', (source, target, expected) => {
    const report = simulateSchedule(switchingSchedule(source, target), {
      schedulingModel, sampleHours: 8, consumptionOverrides: { char_123_fang: 1 },
      production: { outputMode: 'potential', droneTarget: 'none', seed: 7 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(simulationOutputAmounts(report)).toMatchObject(expected)
  })

  it('subtracts warmup fragments by resource even when the final recipe is EXP', () => {
    const schedule = switchingSchedule('fragment', 'exp3')
    const options = {
      schedulingModel, consumptionOverrides: { char_123_fang: 1 },
      production: { outputMode: 'potential' as const, droneTarget: 'none' as const, seed: 7 },
    }
    const prefix = simulateSchedule(schedule, { ...options, sampleHours: 2 })
    const sampled = simulateSchedule(schedule, { ...options, warmupHours: 2, sampleHours: 6 })
    expect(prefix.success && sampled.success).toBe(true)
    expect(simulationOutputAmounts(prefix).fragments).toBeGreaterThan(0)
    expect(simulationOutputAmounts(sampled).fragments).toBe(4 - (simulationOutputAmounts(prefix).fragments ?? 0))
    expect(simulationOutputAmounts(sampled).exp).toBe(1000)
  })
})
