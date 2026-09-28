import { describe, expect, it } from 'vitest'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson, resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { getMowerSourceRuntime } from '../scheduler/mowerSourceRuntime'
import { prepareRunOrderSwap } from './mowerRunOrder'

type Runner = '普通订单' | '但书' | '龙舌兰' | '佩佩' | '可露希尔' | 'U-Official'
const targetRoom = 'room_1_1'
const expectedEightHours: Record<Runner, { completed: number; special: number; gold: number; lmd: number }> = {
  普通订单: { completed: 4, special: 0, gold: 12, lmd: 6000 },
  但书: { completed: 4, special: 3, gold: 18, lmd: 9000 },
  龙舌兰: { completed: 4, special: 1, gold: 12, lmd: 6500 },
  佩佩: { completed: 1, special: 1, gold: 0, lmd: 1000 },
  可露希尔: { completed: 6, special: 6, gold: 12, lmd: 7200 },
  'U-Official': { completed: 4, special: 4, gold: 8, lmd: 4000 },
}

function sameRoster(runner: Runner) {
  const roster = structuredClone(sourceRoster)
  const slots = roster.plan1.room_1_1.plans
  slots[1]!.agent = '绮良'
  slots[1]!.replacement = runner === '普通订单' ? ['能天使'] : [runner, '能天使']
  slots[2]!.replacement = ['蕾缪安']
  return importMowerJson(JSON.stringify(roster))
}

function compare(runner: Runner) {
  const result = runScheduleSimulationBridge(sameRoster(runner), {
    sampleHours: 8,
    warmupHours: 0,
    production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
  }, { restingThreshold: .65, freeRoom: false, fiammettaFool: false })
  const report = result.report!
  expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
  const orders = report.production!.events.filter(event => event.type === 'order-completed' && event.roomId === targetRoom)
    .map(event => event.order!)
  expect(orders.length).toBeGreaterThan(0)
  return orders
}

describe('same imported Mower roster with one trading operator changed', () => {
  it('does not treat U-Official in a factory replacement slot as a run-order candidate', () => {
    const roster = structuredClone(sourceRoster)
    roster.plan1.room_2_1.plans[0]!.replacement = ['U-Official']
    const schedule = compileRosterSchedule(importMowerJson(JSON.stringify(roster)))
    const config = compiledScheduleToRuntimeConfig(schedule)
    expect(schedule.runOrderPolicies.some(policy => policy.roomId === 'room_2_1')).toBe(false)
    expect(config.positions.find(position => position.id === 'room_2_1_0')?.candidates).toContain(id('U-Official'))
    expect(getMowerSourceRuntime(createRosterRuntime(config)).data.runOrderRooms).not.toHaveProperty('room_2_1')
  })

  it.each(['但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official'] as const)('recognizes %s in the replacement slot as a run-order candidate', runner => {
    const schedule = compileRosterSchedule(sameRoster(runner))
    const room = schedule.rooms.find(value => value.roomId === targetRoom)!
    expect(schedule.runOrderPolicies.find(policy => policy.roomId === targetRoom)?.orderedOperatorIds).toContain(id(runner))
    expect(compiledScheduleToRuntimeConfig(schedule).positions.find(position => position.id === targetRoom + '_1')?.candidates).not.toContain(id(runner))
    expect(prepareRunOrderSwap(room, { [targetRoom + '_1']: id('绮良') }).swaps.some(swap => swap.incomingOperatorId === id(runner))).toBe(true)
  })

  it.each(['普通订单', '但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official'] as const)('%s', runner => {
    const orders = compare(runner)
    expect({ completed: orders.length, special: orders.filter(order => order.kind !== 'gold').length,
      gold: orders.reduce((sum, order) => sum + order.goldCost, 0),
      lmd: orders.reduce((sum, order) => sum + order.lmdReward, 0) }).toEqual(expectedEightHours[runner])
    if (runner === '佩佩') expect(orders.every(order => order.kind === 'pepe' && order.baseMinutes === 270 && order.goldCost === 0 && order.lmdReward === 1000)).toBe(true)
    if (runner === '可露希尔') expect(orders.every(order => order.kind === 'closure' && order.baseMinutes === 144 && order.goldCost === 2 && order.lmdReward === 1200)).toBe(true)
    if (runner === 'U-Official') {
      expect(orders.every(order => order.kind === 'uOfficial' && order.goldCost === 2 && order.lmdReward === 1000)).toBe(true)
    }
    if (runner === '普通订单') expect(orders.every(order => order.kind === 'gold')).toBe(true)
    if (runner === '但书') expect(orders.some(order => order.kind === 'proviso')).toBe(true)
    if (runner === '龙舌兰') {
      expect(orders.some(order => order.kind === 'tequila')).toBe(true)
      expect(orders.every(order => order.kind === 'gold' || order.kind === 'tequila')).toBe(true)
    }
  }, 30000)

  it.each(['但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official'] as const)('Grandet: %s follows its roster role and affects an order', runner => {
    const result = runScheduleSimulationBridge(sameRoster(runner), {
      sampleHours: 8,
      warmupHours: 0,
      recordSegments: true,
      production: { outputMode: 'potential', runOrderMode: 'grandet', droneTarget: 'none', seed: 42 },
    }, { restingThreshold: .65, freeRoom: false, fiammettaFool: false })
    const report = result.report!
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    const entered = report.segments.some(segment => Object.entries(segment.occupants).some(([position, operator]) => position.startsWith(targetRoom + '_') && operator === id(runner)))
    const orders = report.production!.events.filter(event => event.type === 'order-completed' && event.roomId === targetRoom).map(event => event.order!)
    expect(entered).toBe(true)
    expect(orders.some(order => order.kind === ({ 但书: 'proviso', 龙舌兰: 'tequila', 佩佩: 'pepe', 可露希尔: 'closure', 'U-Official': 'uOfficial' } as const)[runner])).toBe(true)
    if (runner === '佩佩') expect(orders.filter(order => order.kind === 'pepe').every(order => order.baseMinutes === 270 && order.goldCost === 0 && order.lmdReward === 1000)).toBe(true)
    if (runner === '可露希尔') expect(orders.filter(order => order.kind === 'closure').every(order => order.baseMinutes === 144 && order.goldCost === 2 && order.lmdReward === 1200)).toBe(true)
    if (runner === 'U-Official') {
      expect(orders[0]?.kind).toBe('uOfficial')
      expect(orders.filter(order => order.kind === 'uOfficial').every(order => order.goldCost === 2 && order.lmdReward === 1000)).toBe(true)
    }
  }, 30000)
})
