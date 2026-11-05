import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { projectScheduleState, simulateSchedule } from './scheduleSimulation'
import { createProductionTimeline, type ProductionFrame } from './productionTimeline'
import { evaluateOperators } from '../engine/operatorRules'
import { createMowerProductionIO } from './mowerNativeProductionIO'
import { MowerTaskQueue } from '../scheduler/mowerTaskQueue'
import { collectMowerTodoList } from '../scheduler/mowerNotification'

function scenario(level = 3, names: string[] = []) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  workspace.mainPlan.facilities.recycle.level = level
  workspace.mainPlan.facilities.recycle.slots = names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] }))
  workspace.mainPlan.conf.workaholic = names.map(id)
  return compileRosterSchedule(workspace)
}

const production = { droneTarget: 'none' as const, outputMode: 'settled' as const, collectionIntervalHours: 1000 }

describe('recycling integrated production and morale', () => {
  it('continues unmanned conversion and collects through native todo even with no staffed plan entry', () => {
    const schedule = scenario(1)
    expect(compiledScheduleToRuntimeConfig(schedule).mowerRecycleBuilt).toBe(true)
    const beforeWake = simulateSchedule(schedule, { sampleHours: 49, production })
    expect(beforeWake.production!.recycle).toMatchObject({ completedItems: 1, collectedItems: 0, pendingItems: 1 })
    const report = simulateSchedule(schedule, { sampleHours: 52, production })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo(100)
    expect(report.production!.recycle).toMatchObject({ completedItems: 1, collectedItems: 1, pendingItems: 0, blockedHours: 0 })
    expect(report.production!.events.some(event => event.type === 'recycle-collected' && event.amount === 1)).toBe(true)
    expect(report.production!.sample.completed).toEqual({ exp: 0, gold: 0, orderLmd: 0 })
    expect(report.production!.ledger.balances.lmd ?? 0).toBe(0)
  })

  it('applies two staffed positions and Homebound E2 without inventing a currency value', () => {
    const report = simulateSchedule(scenario(3, ['旅骨', '砾']), {
      sampleHours: 96, production,
      consumptionOverrides: { [id('旅骨')]: 0, [id('砾')]: 0 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo(152, 8)
    expect(report.production!.recycle).toMatchObject({ completedItems: 3, collectedItems: 3, pendingItems: 0 })
    for (const name of ['旅骨', '砾']) {
      expect(report.operators.find(operator => operator.operatorId === id(name))).toMatchObject({ workHours: 96, restHours: 0, exhaustedHours: 0, finalMorale: 24 })
    }
  })

  it('stops a worker bonus at exhausted morale while base conversion continues', () => {
    const schedule = scenario(3, ['旅骨'])
    schedule.assumptions.operatorMorale[id('旅骨')] = 1
    schedule.operators[id('旅骨')]!.morale = 1
    const report = simulateSchedule(schedule, { sampleHours: 48, production, consumptionOverrides: { [id('旅骨')]: 1 } })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.operators.find(operator => operator.operatorId === id('旅骨'))).toMatchObject({ finalMorale: 0 })
    expect(report.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo((151 + 47 * 120) / 48, 6)
    expect(report.production!.recycle!.completedItems).toBe(1)
    expect(report.production!.recycle!.remainingBaseHours).toBeCloseTo(96 - (1.51 + 47 * 1.2), 6)
  })

  it('uses Dominion personal consumption before exhaustion and then keeps only base conversion', () => {
    const schedule = scenario(3, ['国度'])
    const dominion = id('国度')
    schedule.assumptions.operatorMorale[dominion] = 9
    schedule.operators[dominion]!.morale = 9
    const report = simulateSchedule(schedule, {
      sampleHours: 48, production,
      operatorInventory: [{ operator: '国度', elitePhase: 0, level: 1 }],
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.operators.find(operator => operator.operatorId === dominion)!.finalMorale).toBe(0)
    // Nine mood lasts ten hours at 0.9/h. Once exhausted, the 21% worker
    // contribution ends while the level-three facility continues at 120%.
    expect(report.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo((10 * 141 + 38 * 120) / 48, 6)
    expect(report.production!.recycle!.remainingBaseHours).toBeCloseTo(96 - (10 * 1.41 + 38 * 1.2), 6)
  })

  it('excludes warmup conversions and remains invariant under simulation step subdivision', () => {
    const coarse = simulateSchedule(scenario(1), { warmupHours: 48, sampleHours: 52, maxStepHours: 1, production })
    const fine = simulateSchedule(scenario(1), { warmupHours: 48, sampleHours: 52, maxStepHours: .25, production })
    expect(coarse.success && fine.success).toBe(true)
    expect(coarse.production!.recycle).toMatchObject({ completedItems: 2, sampleCompletedItems: 1, collectedItems: 2 })
    expect(fine.production!.recycle).toMatchObject({ completedItems: 2, sampleCompletedItems: 1, collectedItems: 2 })
    expect(fine.production!.recycle!.remainingBaseHours).toBeCloseTo(coarse.production!.recycle!.remainingBaseHours, 8)
    expect(fine.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo(coarse.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent, 8)
  })

  it('pauses at a full warehouse until an explicit native receipt, then resumes partial work', () => {
    const schedule = scenario(1), state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const frame = (): ProductionFrame => {
      const config = projectScheduleState(schedule, state), active = new Set(Object.keys(state.morale)), morale = new Map(Object.entries(state.morale))
      return { time: state.time, config, active, morale, evaluations: Object.fromEntries(config.rooms.map(room => [room.id, evaluateOperators(room, config, active, morale)])) }
    }
    const controller = createProductionTimeline(schedule, state, production, 0, () => {}, true)
    controller.settle(frame)
    controller.advance(48 * 7, frame()); state.time = 48 * 7
    expect(controller.report().recycle).toMatchObject({ capacity: 5, completedItems: 5, pendingItems: 5, blockedHours: 96 })
    const io = createMowerProductionIO(state, controller, frame)
    const generator = collectMowerTodoList({ queue: new MowerTaskQueue(), flags: { todoTask: false, collectNotification: false, planned: false }, lastTodoMicros: null, collectRecycle: true }, { nowMicros: () => Math.round(state.time * 3_600_000_000) })
    let next = generator.next()
    while (!next.done) {
      const request = next.value
      const adapter = io.mowerNotificationIO!(request, state)
      if (!('observe' in adapter)) throw new Error('Expected deterministic native notification observation')
      next = generator.next(adapter.observe())
    }
    expect(controller.report().recycle).toMatchObject({ collectedItems: 5, pendingItems: 0, completedItems: 5 })
    controller.advance(24, frame()); state.time += 24
    expect(controller.report().recycle).toMatchObject({ completedItems: 5, pendingItems: 0, remainingBaseHours: 24, blockedHours: 96 })
  })

  it('keeps the recycling production field absent for unchanged old scenarios', () => {
    const report = simulateSchedule(scenario(0), { sampleHours: 1, production })
    expect(report.success).toBe(true)
    expect(report.production).not.toHaveProperty('recycle')
    expect(report.rooms.some(room => room.roomId === 'recycle')).toBe(false)
  })

  it.each([{ phase: 0, efficiency: 141 }, { phase: 2, efficiency: 151 }])('uses the actual unlocked Homebound stage E$phase in production', ({ phase, efficiency }) => {
    const report = simulateSchedule(scenario(3, ['旅骨']), {
      sampleHours: 48, production, consumptionOverrides: { [id('旅骨')]: 0 },
      operatorInventory: [{ operator: '旅骨', elitePhase: phase, level: 1 }],
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.rooms.find(room => room.roomId === 'recycle')!.averageEfficiencyPercent).toBeCloseTo(efficiency, 8)
    expect(report.production!.recycle!.remainingBaseHours).toBeCloseTo(96 - 48 * efficiency / 100, 7)
  })
})
