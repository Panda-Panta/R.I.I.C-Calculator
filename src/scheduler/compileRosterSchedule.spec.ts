import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDefaultWorkspace } from '../workbench/defaults'
import { importMowerJson, resolveOperatorCharId } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from './compileRosterSchedule'

describe('lossless roster compiler', () => {
  it('retains real 252 slots, ordered candidates, groups and source without mutation', () => {
    const workspace = importMowerJson(readFileSync('src/workbench/compat/fixtures/mower-252-2gold.json', 'utf8'))
    const before = structuredClone(workspace)
    const result = compileRosterSchedule(workspace)
    for (const facility of Object.values(workspace.mainPlan.facilities)) {
      if (facility.level === 0) {
        expect(result.rooms.some(room => room.roomId === facility.roomId)).toBe(false)
        continue
      }
      const room = result.rooms.find(room => room.roomId === facility.roomId)!
      expect(room.level).toBe(facility.level)
      facility.slots.forEach((slot, index) => {
        expect(room.slots[index]?.orderedCandidates).toEqual(slot.replacements.map(resolveOperatorCharId))
        expect(room.slots[index]?.groupId).toBe(slot.groupId)
        expect(room.slots[index]?.occupant.kind).toBe(slot.occupant.kind)
      })
    }
    expect(result.fiammettaPolicies.length).toBeGreaterThan(0)
    expect(result.fiammettaPolicies[0]?.orderedTargets.length).toBeGreaterThan(0)
    expect(result.restPools.some(pool => pool.freeSlotIndices.length > 0)).toBe(true)
    expect(result.runOrderPolicies.some(policy => policy.orderedOperatorIds.includes(resolveOperatorCharId('但书')))).toBe(true)
    expect(result.sourceWorkspace).toEqual(before)
    expect(workspace).toEqual(before)
  })
  it('does not prune a candidate that is active elsewhere or repeated, and canonicalizes aliases', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: '但书' }, groupId: ' g ', replacements: ['龙舌兰', 'Tequila', '但书'] }
    workspace.mainPlan.facilities.room_1_2.slots[0]!.occupant = { kind: 'operator', operatorId: '龙舌兰' }
    const result = compileRosterSchedule(workspace)
    const slot = result.rooms.find(room => room.roomId === 'room_1_1')!.slots[0]!
    expect(slot.primaryOperatorId).toBe(resolveOperatorCharId('但书'))
    expect(slot.orderedCandidates).toEqual(['龙舌兰', '龙舌兰', '但书'].map(resolveOperatorCharId))
    expect(slot.groupId).toBe(' g ')
  })
  it('retains unresolved Current and unknown policies with explicit diagnostics', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'current' }
    workspace.mainPlan.conf.custom_policy = { future: true }
    workspace.mainPlan.conf.workaholic = ['但书']
    const result = compileRosterSchedule(workspace)
    expect(result.rooms.find(room => room.roomId === 'room_1_1')!.slots[0]!.occupant.kind).toBe('current')
    expect(result.rooms.find(room => room.roomId === 'room_1_1')!.slots[0]!.primaryOperatorId).toBeNull()
    expect(result.policies.custom_policy).toEqual({ future: true })
    expect(result.rawConf.workaholic).toEqual(['但书'])
    expect(result.policies.workaholic).toEqual([resolveOperatorCharId('但书')])
    expect(result.diagnostics.map(item => item.code)).toContain('CURRENT_STATE_REQUIRED')
    expect(result.diagnostics.map(item => item.code)).toContain('UNKNOWN_POLICY')
  })
  it('resolves Current only from explicit room/slot state and reports unknown operators', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'current' }
    workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements = ['future_operator']
    const result = compileRosterSchedule(workspace, { currentOccupants: { room_1_1: ['但书'] } })
    expect(result.rooms.find(room => room.roomId === 'room_1_1')!.slots[0]!.primaryOperatorId).toBe(resolveOperatorCharId('但书'))
    expect(result.diagnostics.map(item => item.code)).toContain('UNKNOWN_OPERATOR')
    expect(result.diagnostics.map(item => item.code)).not.toContain('CURRENT_STATE_REQUIRED')
  })
  it('validates parameter ranges rather than silently accepting invalid simulation inputs', () => {
    const result = compileRosterSchedule(createDefaultWorkspace(), { initialMorale: 25, horizonHours: NaN, initialGold: -1, operatorMorale: { '但书': -2 } })
    expect(result.diagnostics.filter(item => item.code === 'INVALID_ASSUMPTION')).toHaveLength(4)
    expect(result.assumptions.schemaVersion).toBe(1)
    expect(result.assumptions.defaultsApplied).toContain('dormAtmosphere')
  })
})
