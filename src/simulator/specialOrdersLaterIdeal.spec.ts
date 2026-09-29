import { describe, expect, it } from 'vitest'
import sourceRoster from '../../validation/mower-output-2026-09-27/roster.json'
import { importMowerJson, resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'

const kinds = { 但书: 'proviso', 龙舌兰: 'tequila', 佩佩: 'pepe', 可露希尔: 'closure', 'U-Official': 'uOfficial' } as const
const roomId = 'room_1_1'

describe('ideal run-order mode recognizes every later trading replacement', () => {
  it.each(Object.entries(kinds) as [keyof typeof kinds, string][])('%s', (runner, kind) => {
    const roster = structuredClone(sourceRoster)
    const slots = roster.plan1.room_1_1.plans
    slots[1]!.agent = '绮良'
    slots[1]!.replacement = ['能天使', runner]
    slots[2]!.replacement = ['蕾缪安']
    const result = runScheduleSimulationBridge(importMowerJson(JSON.stringify(roster)), {
      sampleHours: 8, warmupHours: 0, recordSegments: true,
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
    }, { restingThreshold: .65, freeRoom: false, fiammettaFool: false })
    const report = result.report!
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.production!.events.some(event => event.type === 'order-completed' && event.roomId === roomId && event.order?.kind === kind)).toBe(true)
    expect(report.segments.some(segment => Object.entries(segment.occupants).some(([position, occupant]) => position.startsWith(roomId + '_') && occupant === id(runner)))).toBe(false)
  }, 30000)
})
