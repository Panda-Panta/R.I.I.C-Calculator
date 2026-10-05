import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { compareWorkspacePreference } from './automaticCombinationPreferences'

function perception(blackkey = false, role: 'main' | 'backup' = 'main') {
  const ws = createDefaultWorkspace()
  for (const [roomId, name] of [['room_1_1', '迷迭香'], ['contact', '絮雨'], ...(blackkey ? [['room_3_1', '黑键']] : [])]) {
    const slot = ws.mainPlan.facilities[roomId as keyof typeof ws.mainPlan.facilities].slots[0]!
    if (role === 'main') slot.occupant = { kind: 'operator', operatorId: id(name!) }
    else slot.replacements = [id(name!)]
  }
  return ws
}

describe('automatic perception preference follows physical staffing', () => {
  it('prefers a formed system, then its optional Blackkey, without mutating either workspace', () => {
    const ordinary = createDefaultWorkspace(), core = perception(), supported = perception(true)
    const before = structuredClone(supported)
    expect(compareWorkspacePreference(core, ordinary)).toBeGreaterThan(0)
    expect(compareWorkspacePreference(supported, core)).toBeGreaterThan(0)
    expect(compareWorkspacePreference(supported, perception(true))).toBe(0)
    expect(supported).toEqual(before)
  })
  it('recognizes relief combinations and treats equivalent main/relief presence equally', () => {
    expect(compareWorkspacePreference(perception(true, 'backup'), perception(true))).toBe(0)
    expect(compareWorkspacePreference(perception(false, 'backup'), createDefaultWorkspace())).toBeGreaterThan(0)
  })
  it('does not credit wrong facilities or cores split between shifts', () => {
    const wrongRoom = perception(), split = perception()
    wrongRoom.mainPlan.facilities.contact.type = 'factory'
    split.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'empty' }
    split.mainPlan.facilities.contact.slots[0]!.replacements = [id('絮雨')]
    expect(compareWorkspacePreference(wrongRoom, createDefaultWorkspace())).toBe(0)
    expect(compareWorkspacePreference(split, createDefaultWorkspace())).toBe(0)
  })
  it('does not count an auxiliary Blackkey as a trading support member', () => {
    const ws = perception(true)
    ws.mainPlan.facilities.room_3_1.slots[0]!.occupant = { kind: 'empty' }
    ws.mainPlan.facilities.factory.slots[0]!.occupant = { kind: 'operator', operatorId: id('黑键') }
    expect(compareWorkspacePreference(ws, perception())).toBe(0)
  })
  it('keeps permanent core support active across the relief snapshot', () => {
    const ws = perception(false, 'backup')
    ws.mainPlan.facilities.contact.slots[0]!.replacements = []
    ws.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'operator', operatorId: id('絮雨') }
    ws.mainPlan.conf.workaholic = [id('絮雨')]
    expect(compareWorkspacePreference(ws, createDefaultWorkspace())).toBeGreaterThan(0)
  })
})
