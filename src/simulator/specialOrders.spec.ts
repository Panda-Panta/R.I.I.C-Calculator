import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { simulateSchedule } from './scheduleSimulation'

const owned = (operator: string, elitePhase: number) => ({ operator, elitePhase, level: 1 })

function tradeSchedule(operator: string, replacements: string[] = []) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) room.slots = []
  const trade = workspace.mainPlan.facilities.room_3_1
  trade.level = 3
  trade.slots = [{ occupant: { kind: 'operator', operatorId: id(operator) }, groupId: null, replacements: replacements.map(id) }]
  const schedule = compileRosterSchedule(workspace)
  schedule.rooms = schedule.rooms.filter(room => room.roomId === trade.roomId)
  schedule.restPools = []
  return schedule
}

function orders(operator: string, phase: number, replacements: string[] = []) {
  const schedule = tradeSchedule(operator, replacements)
  const report = simulateSchedule(schedule, {
    sampleHours: 12,
    consumptionOverrides: Object.fromEntries([operator, ...replacements].map(name => [id(name), 0])),
    operatorInventory: [operator, ...replacements].map(name => owned(name, name === operator && name !== '芬' ? phase : name === '芬' ? 0 : 2)),
    production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
  })
  expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
  return report.production!.events.filter(event => event.type === 'order-completed').map(event => event.order!)
}

describe('all special trading orders', () => {
  it('locks Pepe orders to 270 minutes at 100 percent and zero gold only after E2 unlock', () => {
    expect(orders('佩佩', 0)[0]!.kind).toBe('gold')
    const special = orders('佩佩', 2)
    expect(special).toHaveLength(2)
    expect(special.every(order => order.kind === 'pepe' && order.baseMinutes === 270 && order.goldCost === 0 && order.lmdReward === 1000 && !order.efficiencyAffected)).toBe(true)
  })

  it('uses Closure fixed two-gold orders only after E2 unlock', () => {
    expect(orders('可露希尔', 0)[0]!.kind).toBe('gold')
    expect(orders('可露希尔', 2)[0]).toMatchObject({ kind: 'closure', baseMinutes: 144, goldCost: 2, lmdReward: 1200, efficiencyAffected: true })
  })

  it('uses U-Official reward conversion while retaining the base order duration at E0', () => {
    const captured = orders('U-Official', 0)
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.every(order => order.kind === 'uOfficial' && order.goldCost === 2 && order.lmdReward === 1000 && order.efficiencyAffected)).toBe(true)
    expect(captured.some(order => order.baseMinutes !== 144)).toBe(true)
  })

  it('allows Pepe and Closure in a trading roster and as dedicated run-order candidates', () => {
    for (const name of ['佩佩', '可露希尔']) {
      const schedule = tradeSchedule('芬', [name])
      expect(schedule.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_SPECIAL_ORDER')).toBe(false)
      expect(schedule.runOrderPolicies[0]?.orderedOperatorIds).toContain(id(name))
      expect(compiledScheduleToRuntimeConfig(schedule).positions.find(position => position.roomId === 'room_3_1')?.candidates).not.toContain(id(name))
    }
  })

  it('starts ideal Pepe and Closure orders from their configured replacement candidate', () => {
    expect(orders('芬', 2, ['佩佩'])[0]).toMatchObject({ kind: 'pepe', baseMinutes: 270, goldCost: 0 })
    expect(orders('芬', 2, ['可露希尔'])[0]).toMatchObject({ kind: 'closure', baseMinutes: 144, goldCost: 2 })
  })

  it('locks Pepe workload from the first ideal order without inserting the runner', () => {
    const schedule = tradeSchedule('芬', ['佩佩'])
    const report = simulateSchedule(schedule, {
      sampleHours: 12,
      consumptionOverrides: { [id('芬')]: 0, [id('佩佩')]: 0 },
      operatorInventory: [owned('芬', 0), owned('佩佩', 2)],
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    const completed = report.production!.events.filter(event => event.type === 'order-completed').map(event => event.order!)
    expect(completed[0]).toMatchObject({ kind: 'pepe', baseMinutes: 270, goldCost: 0 })
    expect(completed[1]).toMatchObject({ kind: 'pepe', baseMinutes: 270, goldCost: 0 })
  })

  it('does not spend trading drones on a Pepe order without a verified acceleration rule', () => {
    const report = simulateSchedule(tradeSchedule('佩佩'), {
      sampleHours: 1,
      operatorInventory: [owned('佩佩', 2)],
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'trading', initialResources: { drone: 235 }, seed: 42 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.production!.events.some(event => event.type === 'trade-drone')).toBe(false)
    expect(report.diagnostics.some(diagnostic => diagnostic.code === 'PEPE_DRONE_UNVERIFIED')).toBe(true)
  })

  it('keeps the ideal order clock moving when a Pepe trade cannot use drones', () => {
    const report = simulateSchedule(tradeSchedule('佩佩'), {
      sampleHours: 6,
      operatorInventory: [owned('佩佩', 2)],
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'trading', initialResources: { drone: 235 }, seed: 42 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.production!.trading[0]!.completedOrders).toBeGreaterThan(0)
    expect(report.production!.events.some(event => event.type === 'trade-drone')).toBe(false)
  })
})
