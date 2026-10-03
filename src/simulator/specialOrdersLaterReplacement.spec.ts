import { describe, expect, it } from 'vitest'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson, resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'

const runners = ['但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official'] as const
const kinds = { 但书: 'proviso', 龙舌兰: 'tequila', 佩佩: 'pepe', 可露希尔: 'closure', 'U-Official': 'uOfficial' } as const
const roomId = 'room_1_1'

describe('run-order candidates after ordinary trading replacements', () => {
  it.each(runners)('%s stays out of ordinary shifts and runs its order', runner => {
    const roster = structuredClone(sourceRoster)
    const slots = roster.plan1.room_1_1.plans
    slots[1]!.agent = '绮良'
    slots[1]!.replacement = ['能天使', runner]
    slots[2]!.replacement = ['蕾缪安']
    const workspace = importMowerJson(JSON.stringify(roster))
    const schedule = compileRosterSchedule(workspace)
    const config = compiledScheduleToRuntimeConfig(schedule)
    expect(schedule.runOrderPolicies.find(policy => policy.roomId === roomId)?.orderedOperatorIds).toContain(id(runner))
    expect(config.positions.find(position => position.id === roomId + '_1')?.candidates).not.toContain(id(runner))
    expect(config.excludedCandidates).toContain(id(runner))

    const result = runScheduleSimulationBridge(workspace, {
      sampleHours: 8, warmupHours: 0, recordSegments: true,
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
    }, { restingThreshold: .65, freeRoom: false, fiammettaFool: false })
    const report = result.report!
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.segments.some(segment=>Object.entries(segment.occupants).some(([position,operator])=>position.startsWith(roomId+'_')&&operator===id(runner)))).toBe(false)
    const orders = report.production!.events.filter(event => event.type === 'order-completed' && event.roomId === roomId).map(event => event.order!)
    expect(orders.some(order => order.kind === kinds[runner])).toBe(true)
  }, 30000)
})
