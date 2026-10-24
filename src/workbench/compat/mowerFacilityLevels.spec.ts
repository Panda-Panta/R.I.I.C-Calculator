import { describe, expect, it } from 'vitest'
import { importMowerJson, exportMowerJson } from './mowerJson'
import { calculateFacilityPower, validateRosterWorkspace } from '../validate'
import { mowerBackupRoomCapacity, prepareMowerBackupRoom } from '../../domain/mowerBackupFacilities'
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule'

interface Room { name: string; plans: { agent: string; replacement?: string[] }[]; product?: string }
const fixture = () => ({ default: 'plan1', conf: {}, backup_plans: [], plan1: {
  room_1_1: { name: '制造站', product: 'gold', plans: [{ agent: '芬', replacement: ['香草'] }] },
  room_1_3: { name: '发电站', plans: [] },
  dormitory_1: { name: '', plans: Array.from({ length: 5 }, () => ({ agent: 'Free' })) },
} as Record<string, Room> })
const read = (document: unknown) => importMowerJson(JSON.stringify(document))

describe('saved Mower facility levels', () => {
  it('consumes explicit levels and keeps unstaffed built rooms and Free-only dorms', () => {
    const raw = { ...fixture(), facility_levels: { room_1_1: 1, room_1_3: 2, dormitory_1: 2, contact: 1, meeting: 0, train: 0, factory: 3, recycle: 3 } }
    const original = structuredClone(raw), workspace = read(raw), facilities = workspace.mainPlan.facilities
    expect(facilities.dormitory_1).toMatchObject({ level: 2, slots: Array(5).fill({ occupant: { kind: 'free' }, groupId: null, replacements: [] }) })
    expect(facilities.contact).toMatchObject({ level: 1, slots: [] })
    expect(calculateFacilityPower(facilities)).toEqual({ generation: 130, consumption: 50, margin: 80, sufficient: true })
    const compiled = compileRosterSchedule(workspace)
    expect(compiled.rooms.find(room => room.roomId === 'dormitory_1')?.level).toBe(2)
    expect(compiled.assumptions.levelSource).toBe('saved-with-inferred-fallback')
    expect(raw).toEqual(original)
    expect(JSON.parse(exportMowerJson(workspace)).facility_levels).toEqual(raw.facility_levels)
  })

  it('defaults omitted legacy support buildings to level three while keeping optional recycle unbuilt', () => {
    const raw = fixture(); delete raw.plan1.dormitory_1
    const workspace = read(raw)
    for (const room of ['meeting', 'factory', 'contact', 'train'] as const) expect(workspace.mainPlan.facilities[room]).toMatchObject({ level: 3, slots: [] })
    expect(workspace.mainPlan.facilities.recycle).toMatchObject({ level: 0, slots: [] })
    expect(calculateFacilityPower(workspace.mainPlan.facilities)).toEqual({ generation: 270, consumption: 250, margin: 20, sufficient: true })
    expect(JSON.parse(exportMowerJson(workspace)).plan1).toMatchObject(raw.plan1)
    expect(Object.keys(JSON.parse(exportMowerJson(workspace)).plan1)).toEqual(Object.keys(raw.plan1))
    const changed = read({ ...raw, facility_levels: { train: 1, contact: 0 } })
    expect(calculateFacilityPower(changed.mainPlan.facilities).consumption).toBe(140)
  })

  it('uses explicit construction state while inferring the remaining rooms', () => {
    const raw = fixture()
    raw.plan1.room_2_3 = { name: '发电站', plans: [] }; raw.plan1.room_3_3 = { name: '发电站', plans: [] }
    expect(read(raw).mainPlan.facilities.dormitory_1.level).toBe(5)
    const workspace = read({ ...raw, facility_levels: { room_3_3: 0, room_1_1: 2 } })
    expect(workspace.mainPlan.facilities.dormitory_1.level).toBe(1)
    expect(workspace.mainPlan.facilities.room_1_1.level).toBe(2)
    expect(() => prepareMowerBackupRoom(workspace, 'room_1_1', 2)).toThrow()
  })

  it.each([
    { dormitory_1: 6 }, { contact: 4 }, { room_1_1: 1.5 }, { central: -1 }, { contact: '2' }, { unknown: 1 }, { gaming_1: 1 },
    null, [], 1,
  ])('rejects invalid levels %j', facility_levels => {
    expect(() => read({ ...fixture(), facility_levels })).toThrow()
  })

  it('requires a declared output-room category before enabling an omitted output room', () => {
    expect(() => read({ ...fixture(), facility_levels: { room_2_1: 1 } })).toThrow(/设施类别/)
  })

  it('accepts equal supply and demand, retains disabled configured slots and reports them invalid', () => {
    const raw = { ...fixture(), facility_levels: { room_1_3: 1, room_1_1: 2, dormitory_1: 3, meeting: 0, contact: 0, train: 0, factory: 0 } }
    expect(validateRosterWorkspace(read(raw)).power).toEqual({ generation: 60, consumption: 60, margin: 0, sufficient: true })
    raw.facility_levels.dormitory_1 = 4
    expect(validateRosterWorkspace(read(raw)).criticalErrors.some(issue => issue.code === 'POWER_DEFICIT')).toBe(true)
    raw.facility_levels.room_1_1 = 0
    const workspace = read(raw)
    expect(workspace.mainPlan.facilities.room_1_1.slots).toHaveLength(1)
    expect(validateRosterWorkspace(workspace).criticalErrors.some(issue => issue.code === 'INVALID_CONFIG' && issue.roomId === 'room_1_1')).toBe(true)
    const saved = JSON.parse(exportMowerJson(workspace))
    expect(saved.plan1.room_1_1.plans[0].agent).toBe('芬')
    expect(read(saved).mainPlan.facilities.room_1_1.slots).toHaveLength(1)
  })

  it('updates saved explicit keys from edited levels without changing the imported dictionary', () => {
    const raw = { ...fixture(), facility_levels: { room_1_1: 1, dormitory_1: 2, contact: 1 } }
    const workspace = read(raw), original = structuredClone(workspace.compatibility.unrecognizedFields.facility_levels)
    workspace.mainPlan.facilities.room_1_1.level = 2; workspace.mainPlan.facilities.dormitory_1.level = 0; workspace.mainPlan.facilities.contact.level = 0
    const saved = JSON.parse(exportMowerJson(workspace))
    expect(saved.facility_levels).toEqual({ room_1_1: 2, dormitory_1: 0, contact: 0 })
    expect(saved.plan1.dormitory_1.plans).toHaveLength(5)
    const restored = read(saved)
    expect(restored.mainPlan.facilities.room_1_1.level).toBe(2)
    expect(restored.mainPlan.facilities.dormitory_1.level).toBe(0)
    expect(workspace.compatibility.unrecognizedFields.facility_levels).toEqual(original)
  })

  it('persists a newly disabled configured room even when the imported input had no level dictionary', () => {
    const workspace = read(fixture())
    workspace.mainPlan.facilities.room_1_1.level = 0
    const saved = JSON.parse(exportMowerJson(workspace))
    expect(saved.facility_levels).toEqual({ room_1_1: 0 })
    expect(saved.plan1.room_1_1.plans[0].agent).toBe('芬')
    const restored = read(saved)
    expect(restored.mainPlan.facilities.room_1_1).toMatchObject({ level: 0, slots: [{ occupant: { kind: 'operator' } }] })
    expect(validateRosterWorkspace(restored).criticalErrors.some(issue => issue.code === 'INVALID_CONFIG' && issue.roomId === 'room_1_1')).toBe(true)
  })

  it('preserves newly edited nonzero levels without freezing unchanged legacy inference', () => {
    const raw = fixture()
    raw.plan1.room_2_3 = { name: '发电站', plans: [] }; raw.plan1.room_3_3 = { name: '发电站', plans: [] }
    const workspace = read(raw)
    expect(JSON.parse(exportMowerJson(workspace)).facility_levels).toBeUndefined()
    workspace.mainPlan.facilities.room_1_1.level = 2
    workspace.mainPlan.facilities.contact.level = 1
    const saved = JSON.parse(exportMowerJson(workspace))
    expect(saved.facility_levels).toEqual({ room_1_1: 2, contact: 1 })
    expect(read(saved).mainPlan.facilities.room_1_1.level).toBe(2)
    expect(read(saved).mainPlan.facilities.contact.level).toBe(1)
  })

  it('keeps a level-one recycling room limited to one staff member', () => {
    const workspace = read({ ...fixture(), facility_levels: { recycle: 1 } })
    expect(prepareMowerBackupRoom(workspace, 'recycle', 1).level).toBe(1)
    expect(() => prepareMowerBackupRoom(workspace, 'recycle', 2)).toThrow(/设施容量/)
  })

  it('uses physical construction limits for support backups and central staffing', () => {
    const raw = { ...fixture(), facility_levels: { contact: 1, recycle: 0, central: 1 } }
    raw.plan1.central = { name: '', plans: [{ agent: '阿米娅' }, { agent: '杜宾' }] }
    const workspace = read(raw)
    expect(prepareMowerBackupRoom(workspace, 'contact', 1).level).toBe(1)
    expect(mowerBackupRoomCapacity(workspace, 'central')).toBe(1)
    expect(() => prepareMowerBackupRoom(workspace, 'recycle', 1)).toThrow()
    expect(validateRosterWorkspace(workspace).criticalErrors.some(issue => issue.code === 'SLOT_OVERFLOW' && issue.roomId === 'central')).toBe(true)
  })
})
