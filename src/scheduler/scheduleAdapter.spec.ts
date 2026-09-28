import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDefaultWorkspace } from '../workbench/defaults'
import { importMowerJson, resolveOperatorCharId } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, isShiftRunOperator } from './scheduleAdapter'

describe('compiledScheduleToRuntimeConfig adapter', () => {
  it('is a pure function that does not mutate the input CompiledSchedule', () => {
    const workspace = importMowerJson(readFileSync('src/workbench/compat/fixtures/mower-252-2gold.json', 'utf8'))
    const schedule = compileRosterSchedule(workspace)
    const clone = structuredClone(schedule)
    const config = compiledScheduleToRuntimeConfig(schedule)

    expect(schedule).toEqual(clone)
    expect(config.positions.length).toBeGreaterThan(0)
    expect(config.beds.length).toBeGreaterThan(0)
  })

  it('reserves trade run-order candidates while retaining Pepe in other facilities', () => {
    const workspace = createDefaultWorkspace()
    const charProviso = resolveOperatorCharId('但书')
    const charTequila = resolveOperatorCharId('龙舌兰')
    const charPepe = resolveOperatorCharId('佩佩')
    const charSilverAsh = resolveOperatorCharId('银灰')

    // Pepe is a trade runner, but remains a normal manufacturing candidate.
    workspace.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: '德克萨斯' },
      groupId: null,
      replacements: ['但书', '银灰', '龙舌兰', '佩佩'],
    }

    const schedule = compileRosterSchedule(workspace)
    const config = compiledScheduleToRuntimeConfig(schedule)

    const pos = config.positions.find(p => p.roomId === 'room_1_1' && p.primary === resolveOperatorCharId('德克萨斯'))
    expect(pos).toBeDefined()
    expect(pos!.candidates).toEqual([charSilverAsh, charPepe])
    expect(pos!.candidates).not.toContain(charProviso)
    expect(pos!.candidates).not.toContain(charTequila)
    expect(pos!.candidates).toContain(charPepe)

    // excludedCandidates must contain shift-run candidates
    expect(config.excludedCandidates).toContain(charProviso)
    expect(config.excludedCandidates).toContain(charTequila)
    expect(config.excludedCandidates).not.toContain(charPepe)
  })

  it('preserves the exact original order of runOrderPolicies', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.type = 'trading'
    workspace.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: '德克萨斯' },
      groupId: null,
      replacements: ['但书', '龙舌兰'],
    }
    workspace.mainPlan.facilities.room_1_2.type = 'trading'
    workspace.mainPlan.facilities.room_1_2.slots[0] = {
      occupant: { kind: 'operator', operatorId: '拉普兰德' },
      groupId: null,
      replacements: ['佩佩', '但书'],
    }

    const schedule = compileRosterSchedule(workspace)
    const config = compiledScheduleToRuntimeConfig(schedule)

    expect(config.runOrderPolicies).toBeDefined()
    const p1 = config.runOrderPolicies!.find(p => p.roomId === 'room_1_1')
    expect(p1?.orderedOperatorIds).toEqual([resolveOperatorCharId('但书'), resolveOperatorCharId('龙舌兰')])

    const p2 = config.runOrderPolicies!.find(p => p.roomId === 'room_1_2')
    expect(p2?.orderedOperatorIds).toEqual([resolveOperatorCharId('佩佩'), resolveOperatorCharId('但书')])
    expect(schedule.diagnostics.some(d => d.code === 'UNSUPPORTED_SPECIAL_ORDER')).toBe(false)
  })

  it('correctly maps Fiammetta swap policy and dormitory free slots to beds', () => {
    const workspace = importMowerJson(readFileSync('src/workbench/compat/fixtures/mower-252-2gold.json', 'utf8'))
    const schedule = compileRosterSchedule(workspace)
    const config = compiledScheduleToRuntimeConfig(schedule)

    // Fiammetta check
    expect(config.fiammetta).toBeDefined()
    expect(config.fiammetta!.operatorId).toBe(resolveOperatorCharId('菲亚梅塔'))
    expect(config.fiammetta!.orderedTargets.length).toBeGreaterThan(0)
    expect(config.fiammetta!.threshold).toBe(21.6)

    // Dormitory free beds check
    expect(config.beds.length).toBe(schedule.restPools.reduce((acc, p) => acc + p.freeSlotIndices.length, 0))
    for (const bed of config.beds) {
      expect(bed.roomId.startsWith('dormitory_')).toBe(true)
    }
    for (const pool of schedule.restPools) {
      const roomBeds = config.beds.filter(bed => bed.roomId === pool.roomId)
      expect(roomBeds.filter(bed => bed.vip)).toHaveLength(1)
      expect(roomBeds[0]?.vip).toBe(true)
    }
  })

  it('applies the custom Fiammetta threshold only with fool protection off and forwards rescue threshold', () => {
    const workspace = importMowerJson(readFileSync('src/workbench/compat/fixtures/mower-252-2gold.json', 'utf8'))
    const protectedConfig = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace, {
      fiammettaFool: true, fiammettaThreshold: .8, rescueThreshold: .9,
    }))
    expect(protectedConfig.fiammetta?.threshold).toBe(21.6)
    expect(protectedConfig.mowerPolicy?.rescueThreshold).toBe(.9)

    const unprotectedConfig = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace, {
      fiammettaFool: false, fiammettaThreshold: .8, rescueThreshold: .9,
    }))
    expect(unprotectedConfig.fiammetta?.threshold).toBeCloseTo(19.2)
    expect(unprotectedConfig.fiammetta?.fool).toBe(false)
  })

  it('identifies shift-run operators accurately via isShiftRunOperator', () => {
    expect(isShiftRunOperator('但书')).toBe(true)
    expect(isShiftRunOperator('龙舌兰')).toBe(true)
    expect(isShiftRunOperator('佩佩')).toBe(false)
    expect(isShiftRunOperator('可露希尔')).toBe(false)
    expect(isShiftRunOperator('U-Official')).toBe(false)
    expect(isShiftRunOperator(resolveOperatorCharId('但书'))).toBe(true)
    expect(isShiftRunOperator('银灰')).toBe(false)
    expect(isShiftRunOperator('德克萨斯')).toBe(false)
  })
})

it('adds low-type workaholic replacements to the native Free blacklist',()=>{
 const workspace=createDefaultWorkspace()
 const schedule=compileRosterSchedule(workspace)
 schedule.policies.workaholic=['char_2026_yu']
 schedule.policies.free_blacklist=['char_010_chen']
 const before=structuredClone(schedule)
 expect(compiledScheduleToRuntimeConfig(schedule).freeBlacklist).toEqual(['char_010_chen','char_2026_yu'])
 expect(schedule).toEqual(before)
})
