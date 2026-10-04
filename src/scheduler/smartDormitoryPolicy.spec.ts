import { describe, it, expect } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import {
  applySmartDormitoryPolicy,
  calculateSlotRecoveryRate,
  findLowestRecoveryDormitorySlot,
  isAoeDormKeeper,
  isSingleDormKeeper,
} from './smartDormitoryPolicy'
import { OPERATOR_MAP, OPERATORS } from '../domain/operators'

import { validateRosterWorkspace } from '../workbench/validate'

const id = (n: string) => OPERATORS.find((o) => o.name === n)!.charId

describe('smartDormitoryPolicy', () => {
  it('correctly classifies AOE and single dormitory recovery keepers', () => {
    const durn = OPERATOR_MAP.get(id('杜林'))!
    const shining = OPERATOR_MAP.get(id('闪灵'))!

    expect(isAoeDormKeeper(durn)).toBe(true)
    expect(isSingleDormKeeper(shining)).toBe(true)
  })

  it('assigns 2 keepers (1 AOE + 1 single) to each of the 4 dormitories by default', () => {
    const ws = createDefaultWorkspace()
    const report = applySmartDormitoryPolicy(ws)

    expect(report.applied).toBe(true)
    for (let i = 1; i <= 4; i++) {
      const dormKey = `dormitory_${i}` as 'dormitory_1' | 'dormitory_2' | 'dormitory_3' | 'dormitory_4'
      const dorm = ws.mainPlan.facilities[dormKey]
      expect(report.dormitoryKeepers[dormKey]?.aoe).toBeDefined()
      expect(report.dormitoryKeepers[dormKey]?.single).toBeDefined()

      // Slot 0 has an AOE keeper, Slot 1 has a single keeper
      expect(dorm?.slots[0]?.occupant.kind).toBe('operator')
      expect(dorm?.slots[1]?.occupant.kind).toBe('operator')
    }
  })

  it('places Fiammetta into the slowest recovery dormitory and avoids conflict', () => {
    const ws = createDefaultWorkspace()
    // Give Fiammetta as an assigned working operator
    if (ws.mainPlan.facilities.room_1_1.slots[0]) {
      ws.mainPlan.facilities.room_1_1.slots[0].occupant = {
        kind: 'operator',
        operatorId: 'char_300_phenxi',
      }
    }
    // Set dormitory_4 to level 1 and others to level 5
    ws.mainPlan.facilities.dormitory_1.level = 5
    ws.mainPlan.facilities.dormitory_2.level = 5
    ws.mainPlan.facilities.dormitory_3.level = 5
    ws.mainPlan.facilities.dormitory_4.level = 1

    const report = applySmartDormitoryPolicy(ws)
    expect(report.fiammettaRoomId).toBe('dormitory_4')
    expect(ws.mainPlan.facilities.dormitory_4.slots[0]?.occupant).toEqual({
      kind: 'operator',
      operatorId: 'char_300_phenxi',
    })
  })

  it('skips auto assignment when disable_auto_dorm_keeper is true', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.conf.disable_auto_dorm_keeper = true

    const report = applySmartDormitoryPolicy(ws)
    expect(report.applied).toBe(false)
  })

  it('supports Chinese operator names in candidateOperatorIds and fills remaining beds with free', () => {
    const ws = createDefaultWorkspace()
    const report = applySmartDormitoryPolicy(ws, {
      candidateOperatorIds: ['杜林', '闪灵', '波卜', 'Lancet-2'],
    })

    expect(report.applied).toBe(true)
    const dorm1 = ws.mainPlan.facilities.dormitory_1
    // Dorm 1 should have 1 AOE keeper and 1 single keeper
    expect(dorm1.slots[0]?.occupant.kind).toBe('operator')
    expect(dorm1.slots[1]?.occupant.kind).toBe('operator')
    // Slots 2, 3, 4 should be free beds
    expect(dorm1.slots[2]?.occupant.kind).toBe('free')
    expect(dorm1.slots[3]?.occupant.kind).toBe('free')
    expect(dorm1.slots[4]?.occupant.kind).toBe('free')
  })

  it('uses actually unlocked recovery skills without a maximum-skill gate', () => {
    const ws = createDefaultWorkspace()
    // Both have lower recovery versions already unlocked at E0 level 1.
    const unmaxedEntries = [
      { operator: '杜林', elitePhase: 0, level: 1 },
      { operator: '闪灵', elitePhase: 0, level: 1 },
    ]
    const unmaxedReport = applySmartDormitoryPolicy(ws, { entries: unmaxedEntries })
    expect(unmaxedReport.dormitoryKeepers.dormitory_1?.aoe).toBe(id('杜林'))
    expect(unmaxedReport.dormitoryKeepers.dormitory_1?.single).toBe(id('闪灵'))

    // Operators matching maximum skills (杜林 E0 Lv30, 闪灵 E2 Lv1) should be assigned
    const ws2 = createDefaultWorkspace()
    const maxEntries = [
      { operator: '杜林', elitePhase: 0, level: 30 },
      { operator: '闪灵', elitePhase: 2, level: 1 },
    ]
    const report = applySmartDormitoryPolicy(ws2, { entries: maxEntries })
    expect(report.applied).toBe(true)
    expect(report.dormitoryKeepers.dormitory_1?.aoe).toBe(id('杜林'))
    expect(report.dormitoryKeepers.dormitory_1?.single).toBe(id('闪灵'))
  })

  it('keeps presence support and a locked slot when Fiammetta chooses her dorm', () => {
    const ws = createDefaultWorkspace(), slot = ws.mainPlan.facilities.dormitory_4.slots[0]!
    slot.occupant = { kind: 'operator', operatorId: id('伊芙利特') }; slot.groupId = '组合驻留_rhine_lab'
    const locked = ws.mainPlan.facilities.dormitory_4.slots[2]!, before = structuredClone(locked)
    applySmartDormitoryPolicy(ws, { entries: [{ operator: '伊芙利特', elitePhase: 0, level: 1 },
      { operator: '菲亚梅塔', elitePhase: 0, level: 1 }], lockedPositions: new Set(['dormitory_4:2']) })
    expect(slot.occupant).toEqual({ kind: 'operator', operatorId: id('伊芙利特') })
    expect(ws.mainPlan.facilities.dormitory_4.slots[1]!.occupant).toEqual({ kind: 'operator', operatorId: id('菲亚梅塔') })
    expect(locked).toEqual(before)
  })

  it('prevents duplicate operators when Fiammetta and Pianst already exist in dorms', () => {
    const ws = createDefaultWorkspace()
    // Simulate pre-existing state:
    // Fiammetta in dormitory_1 slot 4
    const slot4 = ws.mainPlan.facilities.dormitory_1.slots[4]
    if (slot4) {
      slot4.occupant = {
        kind: 'operator',
        operatorId: 'char_300_phenxi',
      }
    }
    // 至简 (Pianst) in dormitory_1 slot 3
    const slot3 = ws.mainPlan.facilities.dormitory_1.slots[3]
    if (slot3) {
      slot3.occupant = {
        kind: 'operator',
        operatorId: id('至简'),
      }
    }

    applySmartDormitoryPolicy(ws, {
      candidateOperatorIds: ['菲亚梅塔', '至简', '杜林', '闪灵'],
    })

    const validation = validateRosterWorkspace(ws)
    const duplicateErrors = validation.criticalErrors.filter((e) => e.code === 'DUPLICATE_OPERATOR')
    expect(duplicateErrors).toEqual([])
  })

  it('calculates slot recovery rate accurately and identifies lowest recovery rate slot', () => {
    const ws = createDefaultWorkspace()
    // Dormitory 1 is level 5, Dormitory 4 is level 1
    ws.mainPlan.facilities.dormitory_1.level = 5
    ws.mainPlan.facilities.dormitory_4.level = 1

    const rateDorm1Slot0 = calculateSlotRecoveryRate(ws, 'dormitory_1', 0)
    const rateDorm4Slot0 = calculateSlotRecoveryRate(ws, 'dormitory_4', 0)

    // Level 5 base (4.0) > Level 1 base (2.0)
    expect(rateDorm1Slot0).toBeGreaterThan(rateDorm4Slot0)
    expect(rateDorm4Slot0).toBeCloseTo(2.0)

    const lowest = findLowestRecoveryDormitorySlot(ws, false)
    expect(lowest).not.toBeNull()
    expect(lowest?.roomId).toBe('dormitory_4')
  })
})
