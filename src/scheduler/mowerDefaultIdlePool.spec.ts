import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OPERATORS } from '../domain/operators'
import { importMowerJson, resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { createBackupPlanController } from './backupPlans'
import { compileRosterSchedule } from './compileRosterSchedule'
import { getMowerSourceRuntime } from './mowerSourceRuntime'
import { compiledScheduleToRuntimeConfig, createRosterRuntime } from './rosterRuntime'

const source = readFileSync(new URL('../../validation/mower-backup-2026-09-22/roster.json', import.meta.url), 'utf8')
const pools = [
  { label: 'owned inventory', operatorIds: [id('Castle-3'), id('芬'), id('阿罗玛')] },
  { label: 'full catalog', operatorIds: OPERATORS.map(operator => operator.charId) },
]

describe('default Mower backup idle pool', () => {
  it.each(pools)('preserves the $label through backup activation and exit', ({ operatorIds }) => {
    const workspace = importMowerJson(source)
    workspace.compatibility.backupPlans = [{
      trigger: "op_data.operators['阿罗玛'].current_mood() < 10",
      conf: { exhaust_require: ['焰尾'] },
    }]
    const schedule = compileRosterSchedule(workspace)
    const config = compiledScheduleToRuntimeConfig(schedule)
    config.mowerAlpha = false
    config.availableIdleOperators = operatorIds
    const state = createRosterRuntime(config)
    const runtimePool = state.config.availableIdleOperators
    expect(runtimePool).toEqual(operatorIds)
    const controller = createBackupPlanController(schedule, state)
    const initial = getMowerSourceRuntime(state)
    expect(initial.data.alpha).toBe(false)
    expect(initial.data.operators[id('Castle-3')]).toBeUndefined()
    expect(initial.data.unregisteredIdleNames).toEqual(operatorIds)

    for (const [mood, enabled] of [[1, true], [24, false]] as const) {
      const previousConfig = state.config
      state.morale[id('阿罗玛')] = mood
      getMowerSourceRuntime(state).data.operators[id('阿罗玛')]!.mood = mood
      controller.evaluate('END')
      expect(controller.active).toEqual([enabled])
      expect(state.config).not.toBe(previousConfig)
      expect(state.config.availableIdleOperators).toBe(runtimePool)
      const rebuilt = getMowerSourceRuntime(state)
      expect(rebuilt.config).toBe(state.config)
      expect(rebuilt.data.alpha).toBe(false)
      expect(rebuilt.data.unregisteredIdleNames).toEqual(operatorIds)
      expect(rebuilt.data.operators[id('Castle-3')]).toBeUndefined()
    }
  })
})
