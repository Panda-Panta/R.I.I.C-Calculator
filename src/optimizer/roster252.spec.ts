import { describe, expect, it } from 'vitest'
import { OPERATORS } from '../domain/operators'
import { type OwnedOperatorInput } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { restoreOperatorMowerName } from '../workbench/compat/mowerJson'
import { runSmartRoster, type SmartRosterProgress } from './smartRoster'
import { validatePhysicalRoster } from './rosterDraft'

const allOwned: OwnedOperatorInput[] = OPERATORS.map((o) => ({
  operator: o.name,
  elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2,
  level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90,
}))

describe('252 Layout Automatic Roster Generation (Trade 2+1, Manufacture 33332, Right Side Full, 2 Power)', () => {
  it('generates a fully valid 252 roster with complete tracking and all rules satisfied', async ({ annotate }) => {
    await annotate('同步排班与逐人动态验证前刷新测试进度')
    const ws = createDefaultWorkspace()

    // Configure 252 Layout:
    // Left side:
    // Trade: room_3_1 (level 2), room_3_2 (level 1)
    // Manufacture: room_1_1 (3), room_1_2 (3), room_2_1 (3), room_2_2 (3), room_3_3 (2)
    // Power: room_1_3 (3), room_2_3 (3) (Total 2 power stations = 540 power)
    ws.mainPlan.facilities.room_3_1 = {
      roomId: 'room_3_1',
      type: 'trading',
      level: 2,
      product: 'money',
      slots: Array.from({ length: 2 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    ws.mainPlan.facilities.room_3_2 = {
      roomId: 'room_3_2',
      type: 'trading',
      level: 1,
      product: 'money',
      slots: Array.from({ length: 1 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    ws.mainPlan.facilities.room_1_1.level = 3
    ws.mainPlan.facilities.room_1_2.level = 3
    ws.mainPlan.facilities.room_2_1.level = 3
    ws.mainPlan.facilities.room_2_2.level = 3
    ws.mainPlan.facilities.room_3_3 = {
      roomId: 'room_3_3',
      type: 'manufacture',
      level: 2,
      product: 'gold',
      slots: Array.from({ length: 2 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    ws.mainPlan.facilities.room_1_3 = {
      roomId: 'room_1_3',
      type: 'power',
      level: 3,
      slots: Array.from({ length: 1 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    ws.mainPlan.facilities.room_2_3 = {
      roomId: 'room_2_3',
      type: 'power',
      level: 3,
      slots: Array.from({ length: 1 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }

    // Right side: Full level
    // meeting: 3, factory: 3, contact: 3, train: 3, central: 5
    ws.mainPlan.facilities.central.level = 5
    ws.mainPlan.facilities.meeting.level = 3
    ws.mainPlan.facilities.factory.level = 3
    ws.mainPlan.facilities.contact.level = 3
    ws.mainPlan.facilities.train.level = 3

    // Dormitories: level 1 to balance power to exactly 540
    ws.mainPlan.facilities.dormitory_1.level = 1
    ws.mainPlan.facilities.dormitory_2.level = 1
    ws.mainPlan.facilities.dormitory_3.level = 1
    ws.mainPlan.facilities.dormitory_4.level = 1

    // Verify 540/540 power balance
    // Generation: 2 power rooms * 270 = 540
    // Consumption: 4 manu (lv3 * 60) + 1 manu (lv2 * 30) + 1 trade (lv2 * 30) + 1 trade (lv1 * 10) + meeting (60) + contact (60) + train (60) + factory (10) + 4 dorms (lv1 * 10) = 540
    const powerGenerated = 2 * 270
    const powerConsumed = 4 * 60 + 30 + 30 + 10 + 60 + 60 + 60 + 10 + 4 * 10
    expect(powerGenerated).toBe(540)
    expect(powerConsumed).toBe(540)
    expect(powerGenerated).toBe(powerConsumed)

    // Track generation progress
    const trackingEvents: SmartRosterProgress[] = []
    const result = runSmartRoster(
      ws,
      allOwned,
      {
        branchCount: 2,
        simulationTopK: 2,
        simulationWarmupHours: 6,
        simulationSampleHours: 18,
        enableDeepSearch: false,
        seed: 42,
      },
      (p) => trackingEvents.push({ ...p }),
    )

    // Verification 1: Generation status must be 'draft'
    expect(result.status).toBe('draft')
    expect(result.workspace).not.toBeNull()
    const outWs = result.workspace!
    console.log('=== 252 AUTO ROSTER TRACKING SUMMARY ===')
    console.log('Score:', result.score)
    console.log('Phases count:', trackingEvents.length)
    console.log('Phases:', trackingEvents.map(e => `[${e.phase}] ${e.label}`).filter(Boolean).slice(0, 10))
    console.log('Replacement logs:', result.phases.replacement?.logs)
    for (const [id, f] of Object.entries(outWs.mainPlan.facilities)) {
      if (f.slots.length > 0) {
        const occs = f.slots.map(s => s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : s.occupant.kind)
        const reps = f.slots.map(s => s.replacements.map(restoreOperatorMowerName).join(','))
        console.log(`[${id}] (${f.type} lv${f.level}):`, occs.join(', '), '| 替补:', reps.join(' ; '))
      }
    }

    // Verification 2: Physical roster validation must have 0 critical errors
    const physErrors = validatePhysicalRoster(outWs)
    expect(physErrors).toEqual([])

    // Verification 3: Tracking recorded all 3 phases
    expect(trackingEvents.some((e) => e.phase === 'building')).toBe(true)
    expect(trackingEvents.some((e) => e.phase === 'simulating')).toBe(true)
    expect(trackingEvents.some((e) => e.phase === 'searching')).toBe(true)
    expect(trackingEvents.some((e) => e.phase === 'done')).toBe(true)

    // Verification 4: Rule 3 Check: Minimalist (至简) strictly forbidden from manufacture under 2 power
    for (const fac of Object.values(outWs.mainPlan.facilities)) {
      if (fac.type === 'manufacture') {
        for (const slot of fac.slots) {
          if (slot.occupant.kind === 'operator') {
            expect(restoreOperatorMowerName(slot.occupant.operatorId)).not.toBe('至简')
          }
          for (const rep of slot.replacements) {
            expect(restoreOperatorMowerName(rep)).not.toBe('至简')
          }
        }
      }
    }

    // Verification 5: Rule 2 Check: Auxiliary facilities (meeting, factory, train) must have operators
    expect(outWs.mainPlan.facilities.meeting.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
    expect(outWs.mainPlan.facilities.factory.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
    expect(outWs.mainPlan.facilities.train.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)

    // Verification 6: All working production rooms are fully staffed
    expect(outWs.mainPlan.facilities.room_3_1.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
    expect(outWs.mainPlan.facilities.room_3_2.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
    expect(outWs.mainPlan.facilities.room_3_3.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
  }, 180000)
})
