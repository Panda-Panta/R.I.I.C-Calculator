import { describe, it, expect } from 'vitest'
import { createDefaultWorkspace } from './defaults'
import { validateRosterWorkspace } from './validate'
import { resolveOperatorCharId } from './compat/mowerJson'

describe('validateRosterWorkspace', () => {
  it.each(['但书','龙舌兰','可露希尔','佩佩','U-Official'])('allows an ideal trading candidate already stationed elsewhere (%s)', name => {
    const ws = createDefaultWorkspace()
    const operatorId = resolveOperatorCharId(name)
    ws.mainPlan.facilities.factory.slots[0] = { occupant: { kind: 'operator', operatorId }, groupId: null, replacements: [] }
    ws.mainPlan.facilities.room_3_1.slots[0] = { occupant: { kind: 'operator', operatorId: 'char_002_amiya' }, groupId: null, replacements: [operatorId] }
    expect(validateRosterWorkspace(ws).isValid).toBe(true)
    // Outside trading the same name is an ordinary physical backup, so still conflicts.
    ws.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: 'char_102_texas' }, groupId: null, replacements: [operatorId] }
    const errors = validateRosterWorkspace(ws).criticalErrors
    expect(errors.filter(e => e.code === 'CONFLICTING_REPLACEMENT').map(e=>e.roomId)).toEqual(['room_1_1'])
    // Being virtual does not permit duplicate entries within one slot.
    ws.mainPlan.facilities.room_3_1.slots[0]!.replacements.push(operatorId)
    expect(validateRosterWorkspace(ws).criticalErrors.some(e=>e.code==='DUPLICATE_REPLACEMENT')).toBe(true)
  })
  it('passes validation for default workspace with exact balanced power (810/810)', () => {
    const ws = createDefaultWorkspace()
    const result = validateRosterWorkspace(ws)

    expect(result.isValid).toBe(true)
    expect(result.criticalErrors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.power).toEqual({
      generation: 810,
      consumption: 810,
      margin: 0,
      sufficient: true,
    })
  })

  it('detects duplicate primary operators as critical error and blocks compile', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: [],
    }
    ws.mainPlan.facilities.room_1_2.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: [],
    }

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    const dup = res.criticalErrors.find((e) => e.code === 'DUPLICATE_OPERATOR')
    expect(dup).toBeDefined()
    expect(dup?.severity).toBe('critical')
    expect(dup?.roomId).toBe('room_1_2')
    expect(dup?.message).toContain('阿米娅')
    expect(dup?.message).not.toContain('char_002_amiya')
  })

  it('detects conflicting replacements when replacement is already an active primary operator', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_102_texas' },
      groupId: null,
      replacements: [],
    }
    // room_1_2 assigns char_102_texas as replacement
    ws.mainPlan.facilities.room_1_2.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: ['char_102_texas'],
    }

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    const conflict = res.criticalErrors.find((e) => e.code === 'CONFLICTING_REPLACEMENT')
    expect(conflict).toBeDefined()
    expect(conflict?.severity).toBe('critical')
    expect(conflict?.roomId).toBe('room_1_2')
    expect(conflict?.message).toContain('德克萨斯')
    expect(conflict?.message).not.toContain('char_102_texas')
  })

  it('detects duplicate replacement within the same slot', () => {
    const ws = createDefaultWorkspace()
    // Same slot has duplicate replacements
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: ['char_102_texas', 'char_102_texas'],
    }

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    const dupRep = res.criticalErrors.find((e) => e.code === 'DUPLICATE_REPLACEMENT')
    expect(dupRep).toBeDefined()
    expect(dupRep?.severity).toBe('critical')
    expect(dupRep?.roomId).toBe('room_1_1')
    expect(dupRep?.message).toContain('德克萨斯')
    expect(dupRep?.message).not.toContain('char_102_texas')
  })

  it('allows the same replacement candidate to appear in multiple facilities', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: ['char_103_angel'],
    }
    ws.mainPlan.facilities.room_1_2.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_102_texas' },
      groupId: null,
      replacements: ['char_103_angel'],
    }

    const res = validateRosterWorkspace(ws)
    const dupRep = res.criticalErrors.find((e) => e.code === 'DUPLICATE_REPLACEMENT')
    expect(dupRep).toBeUndefined()
  })

  it('allows Fiammetta in dormitory to reference active primary operators as replacements', () => {
    const ws = createDefaultWorkspace()
    // char_102_texas is primary in room_1_1
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_102_texas' },
      groupId: null,
      replacements: ['char_103_angel'],
    }
    // Fiammetta in dormitory_4 references active primary char_102_texas
    ws.mainPlan.facilities.dormitory_4.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_300_phenxi' },
      groupId: null,
      replacements: ['char_102_texas'],
    }

    const res = validateRosterWorkspace(ws)
    const conflict = res.criticalErrors.find((e) => e.code === 'CONFLICTING_REPLACEMENT')
    expect(conflict).toBeUndefined()
  })

  it('rejects Fiammetta outside dormitory referencing active primary operators as replacements', () => {
    const ws = createDefaultWorkspace()
    // char_102_texas is primary in room_1_1
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_102_texas' },
      groupId: null,
      replacements: ['char_103_angel'],
    }
    // Fiammetta outside dormitory (e.g. room_1_2) references active primary char_102_texas
    ws.mainPlan.facilities.room_1_2.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_300_phenxi' },
      groupId: null,
      replacements: ['char_102_texas'],
    }

    const res = validateRosterWorkspace(ws)
    const conflict = res.criticalErrors.find((e) => e.code === 'CONFLICTING_REPLACEMENT')
    expect(conflict).toBeDefined()
    expect(conflict?.message).toContain('德克萨斯')
    expect(conflict?.message).not.toContain('char_102_texas')
  })

  it('does not warn for normal dormitory keepers without replacements or Free rest pool placeholders', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.dormitory_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_4042_lumen' },
      groupId: null,
      replacements: [],
    }
    ws.mainPlan.facilities.dormitory_1.slots[1] = {
      occupant: { kind: 'free' },
      groupId: null,
      replacements: [],
    }

    const res = validateRosterWorkspace(ws)
    const dormIssues = res.warnings.filter((w) => w.roomId === 'dormitory_1')
    expect(dormIssues).toHaveLength(0)
  })

  it('does not warn when a Mower workaholic has no ordinary replacement', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_3_3.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_285_medic2' },
      groupId: null,
      replacements: [],
    }
    ws.mainPlan.conf.workaholic = ['char_285_medic2']

    const result = validateRosterWorkspace(ws)

    expect(result.warnings.some((item) => item.code === 'NO_REPLACEMENT')).toBe(false)
  })

  it('warns when Fiammetta in dormitory has no replacements', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.dormitory_4.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_300_phenxi' },
      groupId: null,
      replacements: [],
    }

    const res = validateRosterWorkspace(ws)
    const noRep = res.warnings.find((w) => w.code === 'NO_REPLACEMENT' && w.roomId === 'dormitory_4')
    expect(noRep).toBeDefined()
    expect(noRep?.message).toContain('菲亚梅塔')
    expect(noRep?.message).not.toContain('char_300_phenxi')
  })

  it('enforces exact slot capacity for all facility types', () => {
    const ws = createDefaultWorkspace()

    // Manufacture lv1 has capacity 1, but has 2 active operators
    ws.mainPlan.facilities.room_1_1.level = 1
    ws.mainPlan.facilities.room_1_1.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_1' }, groupId: null, replacements: ['rep_1'] },
      { occupant: { kind: 'operator', operatorId: 'char_2' }, groupId: null, replacements: ['rep_2'] },
    ]

    // Power plant capacity 1, but has 2 operators
    ws.mainPlan.facilities.room_1_3.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_3' }, groupId: null, replacements: ['rep_3'] },
      { occupant: { kind: 'operator', operatorId: 'char_4' }, groupId: null, replacements: ['rep_4'] },
    ]

    // Factory capacity 1, but has 2 operators
    ws.mainPlan.facilities.factory.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_5' }, groupId: null, replacements: ['rep_5'] },
      { occupant: { kind: 'operator', operatorId: 'char_6' }, groupId: null, replacements: ['rep_6'] },
    ]

    // Central capacity 5, but has 6 operators
    ws.mainPlan.facilities.central.slots = Array.from({ length: 6 }, (_, i) => ({
      occupant: { kind: 'operator', operatorId: `central_op_${i}` },
      groupId: null,
      replacements: [`central_rep_${i}`],
    }))

    // Dormitory capacity 5, but has 6 operators
    ws.mainPlan.facilities.dormitory_1.slots = Array.from({ length: 6 }, (_, i) => ({
      occupant: { kind: 'operator', operatorId: `dorm_op_${i}` },
      groupId: null,
      replacements: [`dorm_rep_${i}`],
    }))

    // Meeting capacity 2, but has 3 operators
    ws.mainPlan.facilities.meeting.slots = Array.from({ length: 3 }, (_, i) => ({
      occupant: { kind: 'operator', operatorId: `meeting_op_${i}` },
      groupId: null,
      replacements: [`meeting_rep_${i}`],
    }))

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    const overflowRoom11 = res.criticalErrors.find((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'room_1_1')
    expect(overflowRoom11).toBeDefined()
    expect(res.criticalErrors.some((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'room_1_3')).toBe(true)
    expect(res.criticalErrors.some((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'factory')).toBe(true)
    expect(res.criticalErrors.some((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'central')).toBe(true)
    expect(res.criticalErrors.some((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'dormitory_1')).toBe(true)
    expect(res.criticalErrors.some((e) => e.code === 'SLOT_OVERFLOW' && e.roomId === 'meeting')).toBe(true)
  })

  it('detects invalid level, product, and facility types as critical errors', () => {
    const ws = createDefaultWorkspace()

    // Invalid level for manufacture (lv4)
    ws.mainPlan.facilities.room_1_1.level = 4

    // Invalid product for manufacture (money)
    ws.mainPlan.facilities.room_1_2.product = 'money'

    // Invalid product for trading (gold)
    ws.mainPlan.facilities.room_3_1.product = 'gold'

    // Invalid level for dorm (lv6)
    ws.mainPlan.facilities.dormitory_1.level = 6

    // Invalid type for output room
    ws.mainPlan.facilities.room_2_1.type = 'dormitory' as any

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    const invalidErrors = res.criticalErrors.filter((e) => e.code === 'INVALID_CONFIG')
    expect(invalidErrors.length).toBeGreaterThanOrEqual(4)
    expect(invalidErrors.some((e) => e.roomId === 'room_1_1')).toBe(true)
    expect(invalidErrors.some((e) => e.roomId === 'room_1_2')).toBe(true)
    expect(invalidErrors.some((e) => e.roomId === 'room_3_1')).toBe(true)
    expect(invalidErrors.some((e) => e.roomId === 'dormitory_1')).toBe(true)
    expect(invalidErrors.some((e) => e.roomId === 'room_2_1')).toBe(true)
  })

  it('emits non-blocking warnings for placeholders and missing replacements (compilation allowed)', () => {
    const ws = createDefaultWorkspace()

    // Missing replacement on an operator slot
    ws.mainPlan.facilities.room_1_1.slots[0] = {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: [],
    }

    // Placeholders Free and Current
    ws.mainPlan.facilities.room_1_1.slots[1] = {
      occupant: { kind: 'free' },
      groupId: null,
      replacements: [],
    }
    ws.mainPlan.facilities.room_1_1.slots[2] = {
      occupant: { kind: 'current' },
      groupId: null,
      replacements: [],
    }

    const res = validateRosterWorkspace(ws)
    expect(res.criticalErrors).toHaveLength(0)
    expect(res.isValid).toBe(true) // Warnings do NOT block compilation
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NO_REPLACEMENT', severity: 'warning', roomId: 'room_1_1', slotIndex: 0 }),
        expect.objectContaining({ code: 'PLACEHOLDER_SLOT', severity: 'warning', roomId: 'room_1_1', slotIndex: 1 }),
        expect.objectContaining({ code: 'PLACEHOLDER_SLOT', severity: 'warning', roomId: 'room_1_1', slotIndex: 2 }),
      ]),
    )
  })

  it('calculates exact source-backed power values and flags power deficit as critical', () => {
    const ws = createDefaultWorkspace()
    // Turn all 9 output rooms into lv3 manufacture (0 power plants)
    for (const id of [
      'room_1_1', 'room_1_2', 'room_1_3',
      'room_2_1', 'room_2_2', 'room_2_3',
      'room_3_1', 'room_3_2', 'room_3_3',
    ] as const) {
      ws.mainPlan.facilities[id].type = 'manufacture'
      ws.mainPlan.facilities[id].level = 3
    }

    // 9 manufacture lv3 = 9 * 60 = 540
    // 4 dorm lv5 = 4 * 65 = 260
    // meeting lv3 = 60
    // contact lv3 = 60
    // train lv3 = 60
    // factory = 10 (fixed 10)
    // central = 0
    // Total consumption = 540 + 260 + 60 + 60 + 60 + 10 = 990
    // Total generation = 0

    const res = validateRosterWorkspace(ws)
    expect(res.isValid).toBe(false)
    expect(res.power.generation).toBe(0)
    expect(res.power.consumption).toBe(990)
    expect(res.power.margin).toBe(-990)
    expect(res.power.sufficient).toBe(false)

    const powerErr = res.criticalErrors.find((e) => e.code === 'POWER_DEFICIT')
    expect(powerErr).toBeDefined()
    expect(powerErr?.severity).toBe('critical')
  })

  it('leaves gaming facility out of power totals and emits non-blocking unsupported warning when configured', () => {
    const ws = createDefaultWorkspace()

    // Configure gaming_1 with an occupant and level
    ws.mainPlan.facilities.gaming_1.level = 1
    ws.mainPlan.facilities.gaming_1.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_game' }, groupId: null, replacements: ['rep_game'] },
    ]

    const res = validateRosterWorkspace(ws)
    // Gaming is left out of power calculation (consumption remains 810, generation remains 810)
    expect(res.power.generation).toBe(810)
    expect(res.power.consumption).toBe(810)
    expect(res.power.sufficient).toBe(true)

    // Clear non-blocking warning emitted
    const gamingWarning = res.warnings.find((w) => w.code === 'UNSUPPORTED_GAMING')
    expect(gamingWarning).toBeDefined()
    expect(gamingWarning?.severity).toBe('warning')
    expect(gamingWarning?.roomId).toBe('gaming_1')
    expect(res.isValid).toBe(true) // Non-blocking
  })
})
