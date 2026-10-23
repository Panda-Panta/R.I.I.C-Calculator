import { expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { createReceptionClueTimeline } from './receptionClueTimeline'

function reception(...ids: string[]) {
  const config = createDefaultConfig()
  config.facilityOperatorIds.reception = ids
  return config
}

it('carries unfinished warmup progress and stops in an empty room', () => {
  const timeline = createReceptionClueTimeline(20)
  const config = reception('char_202_demkni')
  timeline.observe(config, 0, 20)
  timeline.observe(reception(), 20, 30)
  timeline.observe(config, 30, 50)
  expect(timeline.report()).toEqual({ completed: 2, progress: expect.closeTo(.24), exchangeMode: 'always-on' })
})

it('integrates Ines ramp across its cap and resets after leaving or exhaustion', () => {
  const timeline = createReceptionClueTimeline(0)
  const config = reception('char_4087_ines')
  timeline.observe(config, 0, 10)
  expect(timeline.report().progress).toBeCloseTo((17.2 + .75) / 20)
  timeline.observe(reception(), 10, 11)
  timeline.observe(config, 11, 12)
  expect(timeline.report().progress).toBeCloseTo((17.95 + 1.73) / 20)
  config.operatorMorale.char_4087_ines = 0
  timeline.observe(config, 12, 13)
  config.operatorMorale.char_4087_ines = 24
  timeline.observe(config, 13, 14)
  expect(timeline.report().completed + timeline.report().progress).toBeCloseTo((17.95 + 1.73 + 1.47 + 1.73) / 20)
})

it('restarts Ines warmup after a confirmed same-room slot move', () => {
  const timeline = createReceptionClueTimeline(0)
  const config = reception('char_4087_ines', 'char_202_demkni')
  timeline.observe(config, 0, 5)
  const before = timeline.report()
  config.facilityOperatorIds.reception.reverse()
  timeline.observe(config, 5, 6)
  const after = timeline.report()
  expect(after.completed + after.progress - before.completed - before.progress).toBeCloseTo(2.09 / 20, 8)
})

it('uses the shared work session when a worker leaves and returns between observations', () => {
  const ines = 'char_4087_ines'
  const timeline = createReceptionClueTimeline(0, undefined, { [ines]: 10 })
  const config = reception(ines)
  timeline.observe(config, 0, 5, new Map([[ines, 0]]))
  const before = timeline.report()
  timeline.observe(config, 5, 6, new Map([[ines, 0]]))
  const after = timeline.report()
  expect(before.completed + before.progress).toBeCloseTo((1.72 * 5 + .25) / 20, 8)
  expect(after.completed + after.progress - before.completed - before.progress).toBeCloseTo(1.73 / 20, 8)
})

it('uses the supplied inventory for both skills and promotion', () => {
  const inventory = compileOperatorInventory([{ operator: '跃跃', elitePhase: 0, level: 1 }])
  const timeline = createReceptionClueTimeline(0, inventory)
  timeline.observe(reception('char_4100_caper'), 0, 20)
  expect(timeline.report()).toEqual({ completed: 1, progress: expect.closeTo(.43), exchangeMode: 'always-on' })
})

it('applies imported Ines tenure only to awake initial occupants and resets it after leaving', () => {
  const ines = 'char_4087_ines'
  const config = reception(ines)
  const initial = createReceptionClueTimeline(0, undefined, { [ines]: 5 })
  initial.observe(config, 0, 1)
  expect(initial.report().progress).toBeCloseTo(.091)
  initial.observe(reception(), 1, 2)
  initial.observe(config, 2, 3)
  expect(initial.report().progress).toBeCloseTo(.091 + .0865)
  const late = createReceptionClueTimeline(0, undefined, { [ines]: 5 })
  late.observe(reception(), 0, 1)
  late.observe(config, 1, 2)
  expect(late.report().progress).toBeCloseTo(.0865)
  const exhausted = createReceptionClueTimeline(0, undefined, { [ines]: 5 })
  exhausted.observe({ ...config, operatorMorale: { [ines]: 0 } }, 0, 1)
  exhausted.observe(config, 1, 2)
  expect(exhausted.report().progress).toBeCloseTo(1.47 / 20 + .0865)
})

it('retains catalog promotion and skills for staffed cards absent from an idle-only inventory', () => {
  const timeline = createReceptionClueTimeline(0, compileOperatorInventory([{ operator: '砾', elitePhase: 0, level: 1 }]))
  timeline.observe(reception('char_202_demkni'), 0, 20)
  expect(timeline.report()).toEqual({ completed: 1, progress: expect.closeTo(.62), exchangeMode: 'always-on' })
})

it('excludes completed clues from three days of warmup and retains progress through 28 sampling days', () => {
  const timeline = createReceptionClueTimeline(72)
  timeline.observe(reception('char_202_demkni'), 0, 72 + 28 * 24)
  // 1.62 / 20 per hour: warmup 5.832 clues, total 60.264, sampled completions 60 - 5.
  expect(timeline.report()).toEqual({ completed: 55, progress: expect.closeTo(.264), exchangeMode: 'always-on' })
})

it('rejects invalid inventory and observation intervals', () => {
  expect(() => createReceptionClueTimeline(0, compileOperatorInventory([{ operator: '跃跃', elitePhase: 3, level: 1 }]))).toThrow('无效精英阶段或等级')
  const timeline = createReceptionClueTimeline(0)
  expect(() => timeline.observe(reception(), 2, 1)).toThrow('Invalid reception clue observation interval')
  expect(() => timeline.observe(reception(), 0, Infinity)).toThrow('Invalid reception clue observation interval')
})

it.each([[0, .0855], [1, .0855], [2, .0905]] as const)('gates monster cuisine on Senshi E%s without changing other resources', (phase, expected) => {
  const config = reception('char_4142_laios')
  config.facilityOperatorIds.dormitories[0] = ['char_4143_sensi']
  const inventory = compileOperatorInventory([{ operator: '森西', elitePhase: phase, level: 1 }])
  const timeline = createReceptionClueTimeline(0, inventory)
  timeline.observe(config, 0, 1)
  expect(timeline.report().progress).toBeCloseTo(expected, 8)
  config.efficiencyResources.monsterCuisine = 3
  const explicit = createReceptionClueTimeline(0, inventory)
  explicit.observe(config, 0, 1)
  expect(explicit.report().progress).toBeCloseTo(.0885, 8)
})
