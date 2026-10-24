import { describe, expect, it } from 'vitest'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { simulateSchedule } from '../simulator/scheduleSimulation'
import { createDefaultWorkspace } from '../workbench/defaults'
import { evaluateOperators } from './operatorRules'
import { evaluateTradeOrderCapacity } from './orderCapacity'
import { currentMoraleRates } from './morale'

describe.each([0, 2] as const)('Lappland E%s physical partner condition', elitePhase => {
  it('keeps Lappland morale reduction for a physical Texas while her own skill remains active', () => {
    const config = createDefaultConfig(), room = createRoom('target', 'trading')
    config.operatorRecords = inventoryOperatorRecords(compileOperatorInventory([{ operator: '拉普兰德', elitePhase, level: 1 }]))
    room.operatorIds = ['拉普兰德', '德克萨斯'].map(id); room.operatorCount = 2
    config.rooms = [room]; config.controlOperatorIds = []; config.operatorMorale[id('德克萨斯')] = 0
    expect(currentMoraleRates(config).rates[id('拉普兰德')]).toBeCloseTo(.85, 10)
    config.operatorMorale[id('拉普兰德')] = 0
    expect(currentMoraleRates(config).rates[id('拉普兰德')]).toBeUndefined()
  })

  it('keeps a fatigued Texas presence in capacity-derived efficiency without reactivating her skill', () => {
    const config = createDefaultConfig(), room = createRoom('target', 'trading')
    config.operatorRecords = inventoryOperatorRecords(compileOperatorInventory([{ operator: '拉普兰德', elitePhase, level: 1 }]))
    room.operatorIds = ['拉普兰德', '琳琅诗怀雅', '德克萨斯'].map(id)
    config.rooms = [room]; config.controlOperatorIds = []; config.zeroMoraleOperatorIds = [id('德克萨斯')]
    const active = new Set(room.operatorIds.filter(operator => operator !== id('德克萨斯')))
    const result = evaluateOperators(room, config, active)
    const capacity = elitePhase === 2 ? 4 : 2
    expect(evaluateTradeOrderCapacity(room, config, active, result).limit).toBe(10 + capacity)
    expect(result.operatorContributions.find(item => item.operatorId === id('琳琅诗怀雅'))!.skillBonus).toBe(20 + capacity * 4)
    expect(result.operatorContributions.find(item => item.operatorId === id('德克萨斯'))!.skillBonus).toBe(0)
    config.zeroMoraleOperatorIds.push(id('拉普兰德')); active.delete(id('拉普兰德'))
    expect(evaluateOperators(room, config, active).operatorContributions.find(item => item.operatorId === id('琳琅诗怀雅'))!.skillBonus).toBe(20)
  })

  it.each(['mower-default', 'mower-alpha'] as const)('preserves the physical condition through %s simulation', schedulingModel => {
    const workspace = createDefaultWorkspace()
    for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
    const names = ['拉普兰德', '琳琅诗怀雅', '德克萨斯']
    Object.assign(workspace.mainPlan.facilities.room_3_1, {
      level: 3, product: 'money', slots: names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] })),
    })
    workspace.mainPlan.conf.workaholic = names.map(id)
    const report = simulateSchedule(compileRosterSchedule(workspace, { operatorMorale: { [id('德克萨斯')]: 0 } }), {
      schedulingModel, sampleHours: 1, operatorInventory: [{ operator: '拉普兰德', elitePhase, level: 1 }],
      consumptionOverrides: { [id('拉普兰德')]: 0, [id('琳琅诗怀雅')]: 0 }, production: { droneTarget: 'none', seed: 7 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.rooms.find(room => room.roomId === 'room_3_1')!.averageEfficiencyPercent).toBe(elitePhase === 2 ? 138 : 130)
    expect(report.operators.find(operator => operator.operatorId === id('德克萨斯'))).toMatchObject({ exhaustedHours: 1, permanentPrimaryOccupancyHours: 1 })
  })

  it.each(['mower-default', 'mower-alpha'] as const)('keeps the matching morale reduction through %s simulation', schedulingModel => {
    const workspace = createDefaultWorkspace()
    for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
    const names = ['拉普兰德', '德克萨斯']
    Object.assign(workspace.mainPlan.facilities.room_3_1, {
      level: 3, product: 'money', slots: names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] })),
    })
    workspace.mainPlan.conf.workaholic = names.map(id)
    const report = simulateSchedule(compileRosterSchedule(workspace, { operatorMorale: { [id('德克萨斯')]: 0 } }), {
      schedulingModel, sampleHours: 1, operatorInventory: [{ operator: '拉普兰德', elitePhase, level: 1 }], production: { droneTarget: 'none', seed: 7 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.operators.find(operator => operator.operatorId === id('拉普兰德'))!.finalMorale).toBeCloseTo(23.15, 8)
  })
})
