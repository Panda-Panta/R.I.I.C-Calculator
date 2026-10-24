import { describe, expect, it } from 'vitest'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { createDefaultWorkspace } from '../workbench/defaults'
import { simulateSchedule } from './scheduleSimulation'

function slotTask(swap: boolean) {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    room.level = 0
    room.slots = []
  }
  const names = ['芬', '香草', '斑点']
  const room = workspace.mainPlan.facilities.room_1_1
  room.level = 3
  room.product = 'gold'
  room.slots = names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] }))
  workspace.mainPlan.conf.workaholic = names.map(id)
  const assigned = swap ? ['香草', '芬', '斑点'] : names
  workspace.compatibility.backupPlans = [{
    name: 'confirmed-slot-task', trigger: 'True',
    plan: { room_1_1: { plans: assigned.map(agent => ({ agent, group: '', replacement: [] })) } },
    task: { room_1_1: assigned },
  }]
  return compileRosterSchedule(workspace, { idleOperators: [] })
}

describe('confirmed Mower work-position sessions', () => {
  it.each([
    { swap: true, expected: 178 },
    { swap: false, expected: 183 },
  ])('same-room task swap=$swap preserves only unmoved warmup', ({ swap, expected }) => {
    const report = simulateSchedule(slotTask(swap), {
      schedulingModel: 'mower-alpha', sampleHours: 1, warmupModel: 'hourly', recordSegments: true,
      initialWorkHours: Object.fromEntries(['芬', '香草', '斑点'].map(name => [id(name), 10])),
      consumptionOverrides: Object.fromEntries(['芬', '香草', '斑点'].map(name => [id(name), 0])),
      production: { outputMode: 'potential', droneTarget: 'none', seed: 42 },
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.events.some(event => event.type === 'backup-plan' && event.active)).toBe(true)
    expect(report.segments[report.segments.length - 1]!.occupants.room_1_1_0).toBe(id(swap ? '香草' : '芬'))
    // Fang contributes 15% after ten hours but 10% in the first fresh hour.
    expect(report.rooms.find(room => room.roomId === 'room_1_1')!.averageEfficiencyPercent).toBeCloseTo(expected, 1)
  })

  it.each([true, false])('reception production uses the same confirmed slot clock, swap=%s', swap => {
    const workspace = slotTask(false).sourceWorkspace
    workspace.mainPlan.facilities.room_1_1.level = 0
    workspace.mainPlan.facilities.room_1_1.slots = []
    const names = ['伊内丝', '赫拉格']
    const room = workspace.mainPlan.facilities.meeting
    room.level = 3
    room.slots = names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] }))
    workspace.mainPlan.conf.workaholic = names.map(id)
    const assigned = swap ? [...names].reverse() : names
    workspace.compatibility.backupPlans = [{
      name: 'reception-slot-task', trigger: 'True',
      plan: { meeting: { plans: assigned.map(agent => ({ agent, group: '', replacement: [] })) } },
      task: { meeting: assigned },
    }]
    const report = simulateSchedule(compileRosterSchedule(workspace, { idleOperators: [] }), {
      schedulingModel: 'mower-alpha', sampleHours: 1,
      initialWorkHours: { [id('伊内丝')]: 10 },
      consumptionOverrides: Object.fromEntries(names.map(name => [id(name), 0])),
    })
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true)
    expect(report.events.some(event => event.type === 'backup-plan' && event.active)).toBe(true)
    const result = report.receptionClues!
    // No dorm ambience or external providers: 111% room + 10% rarity +
    // 32% E2 + 10% awake. Ines adds a fresh-hour average 21%, or retained 30%.
    // Hellag has no reception skill; this is not the Saria/default-dorm fixture.
    expect(result.completed + result.progress).toBeCloseTo((swap ? 1.84 : 1.93) / 20, 4)
  })
})
