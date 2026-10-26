import { describe, expect, it } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createDefaultConfig } from '../domain/defaults'
import { createDefaultWorkspace } from '../workbench/defaults'
import { createReceptionClueTimeline } from '../simulator/receptionClueTimeline'
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from './generatedWarmupPolicy'

const inventory = compileOperatorInventory(fullCatalogIdleInventory())

describe('explicit warmup curves and assumed maximum probabilities stay distinct', () => {
  it.each([
    ['柏喙', 'trading'], ['巫恋', 'trading'], ['贝娜', 'trading'], ['卡夫卡', 'trading'],
    ['安洁莉娜', 'meeting'], ['莫斯提马', 'meeting'], ['霍尔海雅', 'meeting'], ['奥达', 'meeting'],
    ['早露', 'contact'], ['海蒂', 'central'],
  ] as const)('does not impose automatic exhaustion on %s in %s for an unspecified probability ramp', (name, facility) => {
    expect(isWarmupOperatorInFacility(name, facility, inventory)).toBe(false)
  })

  it('preserves user policies and probability-based ordinary replacements', () => {
    const workspace = createDefaultWorkspace()
    for (const room of Object.values(workspace.mainPlan.facilities)) room.slots = []
    workspace.mainPlan.facilities.room_3_1.slots = [{ occupant: { kind: 'operator', operatorId: id('巫恋') }, groupId: null, replacements: [id('柏喙')] }]
    workspace.mainPlan.facilities.meeting.slots = [{ occupant: { kind: 'operator', operatorId: id('安洁莉娜') }, groupId: null, replacements: [id('莫斯提马')] }]
    workspace.mainPlan.conf.exhaust_require = ['巫恋']
    const before = structuredClone(workspace)
    expect(applyGeneratedWarmupPolicy(workspace, inventory)).toMatchObject({ valid: true, addedExhaustOperatorIds: [], unsupportedWarmupBackups: [] })
    expect(workspace).toEqual(before)
  })

  it('keeps the explicit Ines efficiency ramp and its automatic exhaustion policy', () => {
    expect(isWarmupOperatorInFacility('伊内丝', 'meeting', inventory)).toBe(true)
    const workspace = createDefaultWorkspace()
    for (const room of Object.values(workspace.mainPlan.facilities)) room.slots = []
    workspace.mainPlan.facilities.meeting.slots = [{ occupant: { kind: 'operator', operatorId: id('伊内丝') }, groupId: null, replacements: [id('提丰')] }]
    expect(applyGeneratedWarmupPolicy(workspace, inventory).addedExhaustOperatorIds).toEqual([id('伊内丝')])
    const config = createDefaultConfig()
    config.facilityOperatorIds.reception = [id('伊内丝')]
    const cold = createReceptionClueTimeline(0, inventory)
    const warm = createReceptionClueTimeline(0, inventory, { [id('伊内丝')]: 5 })
    cold.observe(config, 0, 1)
    warm.observe(config, 0, 1)
    expect(cold.report().progress).toBeCloseTo(1.73 / 20)
    expect(warm.report().progress).toBeCloseTo(1.82 / 20)
  })
})
