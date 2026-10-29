import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from '../scheduler/scheduleAdapter'
import { shiftSnapshot } from './combinationModel'

function scene() {
  const workspace = createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) { room.level = 0; room.slots = [] }
  workspace.mainPlan.facilities.room_3_1 = { roomId: 'room_3_1', type: 'trading', level: 1,
    slots: [{ occupant: { kind: 'operator', operatorId: '古米' }, groupId: 'trade', replacements: ['鸿雪'] }] }
  workspace.mainPlan.facilities.factory = { roomId: 'factory', type: 'factory', level: 3,
    slots: [{ occupant: { kind: 'operator', operatorId: '杜林' }, groupId: null, replacements: ['麦哲伦'] }] }
  workspace.mainPlan.facilities.train = { roomId: 'train', type: 'train', level: 3,
    slots: [
      { occupant: { kind: 'operator', operatorId: '桃金娘' }, groupId: null, replacements: ['艾拉'] },
      { occupant: { kind: 'operator', operatorId: '褐果' }, groupId: null, replacements: ['阿'] },
    ] }
  return workspace
}

describe('backup snapshots preserve native permanent auxiliary occupants', () => {
  it('keeps passive factory/training presence while actual shift positions change', () => {
    const workspace = scene(), before = structuredClone(workspace)
    const runtime = compiledScheduleToRuntimeConfig(compileRosterSchedule(workspace))
    expect(runtime.positions.filter(position => ['factory', 'train'].includes(position.roomId))).toHaveLength(3)
    expect(runtime.positions.filter(position => ['factory', 'train'].includes(position.roomId)).every(position => position.permanent)).toBe(true)
    const backup = shiftSnapshot(workspace, 'backup')
    expect(backup.mainPlan.facilities.room_3_1.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: 'char_4055_bgsnow' })
    for (const roomId of ['factory', 'train'] as const) expect(backup.mainPlan.facilities[roomId]).toEqual(workspace.mainPlan.facilities[roomId])
    expect(workspace).toEqual(before)
  })

  it('continues replacing explicitly grouped auxiliaries and other ordinary facilities', () => {
    const workspace = scene()
    workspace.mainPlan.facilities.factory.slots[0]!.groupId = 'trade'
    workspace.mainPlan.facilities.contact = { roomId: 'contact', type: 'contact', level: 3,
      slots: [{ occupant: { kind: 'operator', operatorId: '梓兰' }, groupId: null, replacements: ['芬'] }] }
    const backup = shiftSnapshot(workspace, 'backup')
    expect(backup.mainPlan.facilities.factory.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: 'char_248_mgllan' })
    expect(backup.mainPlan.facilities.contact.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: 'char_123_fang' })
    expect(backup.mainPlan.facilities.train).toEqual(workspace.mainPlan.facilities.train)
    expect(shiftSnapshot(workspace, 'main')).toEqual(workspace)
  })
})
