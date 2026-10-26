import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerRoomId, MowerSlot } from '../domain/roster'
import { createDefaultWorkspace } from '../workbench/defaults'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { decodeManufacturingCrewSelection, enumerateManufacturingCrewColumns, ManufacturingCrewBudgetExceeded,
  prepareManufacturingCrewDomain, type ManufacturingCrewColumn, type ManufacturingCrewDomain } from './manufacturingCrewDomain'

const slot = (main: string, backup: string, groupId: string): MowerSlot => ({
  occupant: { kind: 'operator', operatorId: id(main) }, replacements: [id(backup)], groupId,
})
function fixture(roomId: MowerRoomId = 'room_3_2', capacity = 1) {
  const initial = createDefaultWorkspace()
  for (const room of Object.values(initial.mainPlan.facilities)) room.slots = []
  initial.mainPlan.facilities.dormitory_1.slots = [
    { occupant: { kind: 'operator', operatorId: id('闪灵') }, groupId: null, replacements: [] },
    ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] })),
  ]
  const userBase = structuredClone(initial)
  const names = ['砾', '斑点', '夜烟', '香草', '玫兰莎', '调香师', '维伊', '闪灵']
  const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
  const room = initial.mainPlan.facilities[roomId]
  room.type = 'manufacture'; room.product = 'gold'; room.level = capacity
  room.slots = Array.from({ length: capacity }, (_, index) => slot(names[index]!, names[index + 3]!, 'local'))
  userBase.mainPlan.facilities[roomId] = { ...structuredClone(room), slots: [] }
  return { userBase, initial, inventory, lockedPositions: new Set<string>(), lockedOperators: new Set<string>() }
}
function ready(input: ReturnType<typeof fixture>): ManufacturingCrewDomain {
  const result = prepareManufacturingCrewDomain(input)
  expect(result.status).toBe('ready')
  if (!result.domain) throw new Error(JSON.stringify(result.diagnostics))
  return result.domain
}

function automationFixture() {
  const input = fixture('room_1_1', 3)
  const names = ['温蒂', '森蚺', '清流', '冬时', '承曦格雷伊', '正义骑士号', '香草', '梅尔', '雪猎', '砾', '斑点', '夜烟', '维伊', '白面鸮', '赫默', '闪灵']
  input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
  input.initial.mainPlan.facilities.room_1_1.slots = [slot('温蒂', '维伊', 'local'), slot('森蚺', '白面鸮', 'local'), slot('清流', '赫默', 'local')]
  input.initial.mainPlan.facilities.room_2_1.slots = [slot('砾', '香草', 'other'), slot('斑点', '梅尔', 'other'), slot('夜烟', '雪猎', 'other')]
  input.initial.mainPlan.facilities.room_1_3.slots = [{ ...slot('承曦格雷伊', '正义骑士号', 'local'), metadata: { fixedAnchor: [2, 1] } }]
  return input
}
function automationExpSelection(domain: ManufacturingCrewDomain) {
  const rows = [...enumerateManufacturingCrewColumns(domain)]
  const find = (groupId: string, roomId: MowerRoomId, role: 'main' | 'backup', names: string[]) => rows.find(row =>
    row.groupId === groupId && row.roomId === roomId && row.role === role && names.every(name => row.ids.includes(id(name))))!
  return { rows, selected: [
    find('local', 'room_2_1', 'main', ['温蒂', '森蚺', '冬时']),
    find('local', 'room_2_1', 'backup', ['维伊', '白面鸮', '赫默']),
    find('other', 'room_1_1', 'main', ['清流', '砾', '斑点']),
    find('other', 'room_1_1', 'backup', ['香草', '梅尔', '雪猎']),
  ] }
}
function fairEnumerationFixture() {
  const input = fixture('room_1_1', 2)
  const names = ['砾', '斑点', '香草', '维伊', '红豆', '霜叶', '白面鸮', '赫默', '雪猎', '梅尔', '夜烟', '温米', '多萝西', '泡泡', '火神', '贝娜', '闪灵']
  input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => names.some(name => id(name) === entry.operator)))
  input.initial.mainPlan.facilities.room_1_1.slots = [slot('砾', '香草', 'local'), slot('斑点', '维伊', 'local')]
  input.initial.mainPlan.facilities.room_2_1 = { roomId: 'room_2_1', type: 'manufacture', level: 2, product: 'exp', slots: [slot('红豆', '白面鸮', 'second'), slot('霜叶', '赫默', 'second')] }
  input.initial.mainPlan.facilities.room_3_2 = { roomId: 'room_3_2', type: 'manufacture', level: 2, product: 'gold', slots: [slot('雪猎', '夜烟', 'third'), slot('梅尔', '温米', 'third')] }
  return input
}
const sortRows = <T extends { id: string }>(rows: T[]) => rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
const contextKey = (row: { groupId: string; roomId: string; role: string }) => `${row.groupId}/${row.roomId}/${row.role}`

describe('manufacturing crew domain extraction', () => {
  it.each([1, 2, 3])('derives a complete %i-seat room without fixed room numbers or a full inventory fallback', capacity => {
    const input = fixture('room_3_2', capacity), before = structuredClone(input.initial)
    const domain = ready(input)
    expect(domain.rooms).toEqual(['room_3_2'])
    expect(domain.groups[0]).toMatchObject({ id: 'local', originalRoomId: 'room_3_2', capacity, support: [] })
    const rows = [...enumerateManufacturingCrewColumns(domain)]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const owned = new Set(input.inventory.operators.map(operator => operator.charId))
    for (const row of rows) {
      expect(row.seatOperatorIds).toHaveLength(capacity)
      expect(new Set(row.ids)).toEqual(new Set(row.seatOperatorIds))
      expect(row.ids.every(operatorId => owned.has(operatorId))).toBe(true)
      expect(row.ids).not.toContain(id('阿罗玛'))
    }
    expect(input.initial).toEqual(before)
  })
  it('keeps an exact initial seat order and unknown fields on a no-op decode', () => {
    const input = fixture('room_2_1', 2)
    input.initial.mainPlan.facilities.room_2_1.slots.reverse()
    input.initial.mainPlan.facilities.room_2_1.slots[0]!.metadata = { lockedStyle: 'keep', unknown: [2, 1] }
    input.initial.mainPlan.conf.userCustom = { b: 2, a: 1 }
    const domain = ready(input), before = JSON.stringify(input.initial)
    expect(domain.initialColumns.find(row => row.role === 'main')!.seatOperatorIds).toEqual(['斑点', '砾'].map(id))
    const decoded = decodeManufacturingCrewSelection(domain, domain.initialColumns)
    expect(decoded.valid).toBe(true)
    expect(JSON.stringify(decoded.workspace)).toBe(before)
    expect(decoded.workspace).not.toBe(input.initial)
  })
  it('freezes user-locked blocks and follows a fixed Fiammetta target back to the complete group', () => {
    const input = fixture('room_1_1', 1)
    input.initial.mainPlan.facilities.room_2_2 = { roomId: 'room_2_2', type: 'manufacture', product: 'gold', level: 1, slots: [slot('斑点', '维伊', 'other')] }
    input.initial.mainPlan.facilities.dormitory_2.slots = [{ occupant: { kind: 'operator', operatorId: id('菲亚梅塔') }, groupId: null, replacements: [id('砾')] }]
    input.inventory = compileOperatorInventory([...fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator)), ...fullCatalogIdleInventory().filter(entry => entry.operator === id('菲亚梅塔'))])
    const domain = ready(input)
    expect(domain.rooms).toEqual(['room_2_2'])
    expect(domain.frozenComponents.some(block => block.reason === 'external-reference')).toBe(true)
    const decoded = decodeManufacturingCrewSelection(domain, domain.initialColumns)
    expect(decoded.workspace.mainPlan.facilities.dormitory_2).toEqual(input.initial.mainPlan.facilities.dormitory_2)
    input.lockedPositions.add('room_2_2:0')
    const result = prepareManufacturingCrewDomain(input)
    expect(result.status).toBe('unsupported')
    expect(result.frozenComponents.some(block => block.reason === 'user-lock')).toBe(true)
  })
  it('freezes additional bindings and one group spanning multiple manufacturing rooms', () => {
    const input = fixture('room_3_2', 2)
    input.initial.mainPlan.facilities.central.slots = [slot('夜烟', '调香师', 'second')]
    input.initial.mainPlan.facilities.room_3_2.slots[0]!.groupBindings = [{ groupId: 'second', replacements: [id('维伊')] }]
    const bound = prepareManufacturingCrewDomain(input)
    expect(bound.status, JSON.stringify(bound.diagnostics)).toBe('unsupported')
    const shared = fixture()
    shared.initial.mainPlan.facilities.room_2_1 = { roomId: 'room_2_1', type: 'manufacture', product: 'gold', level: 1, slots: [slot('斑点', '维伊', 'local')] }
    const result = prepareManufacturingCrewDomain(shared)
    expect(result.status).toBe('unsupported')
    expect(result.frozenComponents.some(block => block.reason === 'multiple-manufacturing-rooms')).toBe(true)
  })
  it('distinguishes an optional generated core from the same complete core in userBase', () => {
    const input = fixture('room_1_1', 3)
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['阿罗玛', '槐琥', '砾', '斑点', '香草', '玫兰莎', '夜烟', '维伊', '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('阿罗玛', '斑点', 'local'), slot('槐琥', '香草', 'local'), slot('砾', '玫兰莎', 'local')]
    applyGeneratedWarmupPolicy(input.initial, input.inventory)
    const optional = ready(input), core = optional.coreIds.find(value => value.startsWith('aroma_waaifu:'))!
    expect(core).toBeTruthy()
    expect(optional.requiredCores).not.toContain(core)
    const rows = [...enumerateManufacturingCrewColumns(optional)]
    expect(rows.some(row => row.role === 'main' && !row.ids.includes(id('阿罗玛')) && !row.ids.includes(id('槐琥')))).toBe(true)
    expect(rows.some(row => row.ids.includes(id('阿罗玛')) !== row.ids.includes(id('槐琥')))).toBe(false)
    input.userBase = structuredClone(input.initial)
    expect(ready(input).requiredCores).toContain(core)
  })
  it('allows an internal whole core to be omitted but rolls back the same omission when it belongs to userBase', () => {
    const input = fixture('room_1_1', 2)
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['泡泡', '火神', '砾', '斑点', '香草', '玫兰莎', '夜烟', '维伊', '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('泡泡', '香草', 'local'), slot('火神', '玫兰莎', 'local')]
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    const main = rows.find(row => row.role === 'main' && row.ids.includes(id('砾')) && row.ids.includes(id('斑点')))!
    const backup = domain.initialColumns.find(row => row.role === 'backup')!
    expect(decodeManufacturingCrewSelection(domain, [main, backup]).valid).toBe(true)
    input.userBase = structuredClone(input.initial)
    const required = ready(input), rejected = decodeManufacturingCrewSelection(required, [main, backup])
    expect(rejected.valid).toBe(false)
    expect(rejected.workspace).toEqual(input.initial)
  })
  it('tracks only actual initial cores while still admitting new complete units', () => {
    const input = fixture('room_1_1', 2)
    input.inventory = compileOperatorInventory([...fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator)),
      ...fullCatalogIdleInventory().filter(entry => ['泡泡', '火神'].some(name => id(name) === entry.operator))])
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    expect(domain.coreIds).toEqual([])
    const row = rows.find(row => row.role === 'main' && row.ids.includes(id('泡泡')) && row.ids.includes(id('火神')))
    expect(row).toBeTruthy()
    expect(row!.retainedCores).toEqual([])
  })
  it('rejects an initial workspace that has already lost a locked user position', () => {
    const input = fixture()
    input.userBase = structuredClone(input.initial)
    input.lockedPositions.add('room_3_2:0')
    input.initial.mainPlan.facilities.room_3_2.slots[0]!.occupant = { kind: 'operator', operatorId: id('夜烟') }
    const result = prepareManufacturingCrewDomain(input)
    expect(result.status).toBe('invalid')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'CREW_INITIAL_CONSTRAINTS')).toBe(true)
  })
  it('keeps fixed cross-station anchors required while retaining their exact support positions', () => {
    const input = fixture('room_2_1', 3)
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['水月', '香草', '杰西卡', '涤火杰西卡', '砾', '斑点', '玫兰莎', '夜烟', '维伊', '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_2_1.slots = [slot('水月', '砾', 'local'), slot('香草', '斑点', 'local'), slot('杰西卡', '玫兰莎', 'local')]
    input.initial.mainPlan.facilities.central.slots = [slot('涤火杰西卡', '维伊', 'local')]
    const domain = ready(input), core = domain.coreIds.find(value => value.startsWith('blacksteel:'))!
    expect(core).toBeTruthy()
    expect(domain.requiredCores).toContain(core)
    expect(domain.groups[0]!.support).toEqual([{ roomId: 'central', index: 0 }])
    for (const row of enumerateManufacturingCrewColumns(domain)) expect(row.ids).not.toContain(id('涤火杰西卡'))
    const decoded = decodeManufacturingCrewSelection(domain, domain.initialColumns)
    expect(decoded.valid).toBe(true)
    expect(decoded.workspace.mainPlan.facilities.central).toEqual(input.initial.mainPlan.facilities.central)
  })
  it('can replace a generated gold automation variant with complete EXP automation and release its old variant-only member', () => {
    const input = automationFixture(), before = structuredClone(input.initial), domain = ready(input)
    const { rows, selected } = automationExpSelection(domain)
    expect(selected.every(Boolean), JSON.stringify(selected)).toBe(true)
    const core = domain.requiredCores.find(value => value.startsWith('automation:'))!
    expect(core).toBeTruthy()
    expect(domain.initialColumns.find(row => row.groupId === 'local' && row.role === 'main')!.retainedCores).toContain(core)
    expect(selected[0]!.retainedCores).toContain(core)
    expect(selected[2]!.retainedCores).not.toContain(core)
    expect(rows.some(row => row.ids.includes(id('温蒂')) !== row.ids.includes(id('森蚺')))).toBe(false)
    const decoded = decodeManufacturingCrewSelection(domain, selected)
    expect(decoded.valid, JSON.stringify(decoded.diagnostics)).toBe(true)
    expect(decoded.workspace.mainPlan.facilities.room_1_3).toEqual(before.mainPlan.facilities.room_1_3)
    expect(decoded.workspace.mainPlan.facilities.room_2_1.slots.every(position => position.groupId === 'local')).toBe(true)
    expect(decoded.workspace.mainPlan.facilities.room_1_1.slots.some(position => position.occupant.kind === 'operator' && position.occupant.operatorId === id('清流'))).toBe(true)
    expect(decodeManufacturingCrewSelection(domain, domain.initialColumns).workspace).toEqual(before)
    expect(input.initial).toEqual(before)
  })
  it('keeps a user-provided gold automation signature exact even when an internal family could use EXP', () => {
    const input = automationFixture(), generated = ready(input), { selected } = automationExpSelection(generated)
    expect(selected.every(Boolean)).toBe(true)
    input.userBase = structuredClone(input.initial)
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    expect(domain.requiredCores.some(value => value.startsWith('automation:gold:'))).toBe(true)
    expect(rows.some(row => row.roomId === 'room_2_1' && row.ids.includes(id('温蒂')))).toBe(false)
    const decoded = decodeManufacturingCrewSelection(domain, selected)
    expect(decoded.valid).toBe(false)
    expect(decoded.workspace).toEqual(input.initial)
  })
  it('freezes an automation user lock instead of using a generated family to move that block', () => {
    const input = automationFixture()
    input.userBase = structuredClone(input.initial)
    input.lockedPositions.add('room_1_1:0')
    const domain = ready(input)
    expect(domain.rooms).toEqual(['room_2_1'])
    expect(domain.frozenComponents.some(component => component.roomIds.includes('room_1_1') && component.reason === 'user-lock')).toBe(true)
    expect([...enumerateManufacturingCrewColumns(domain)].some(row => row.ids.includes(id('温蒂')))).toBe(false)
    expect(decodeManufacturingCrewSelection(domain, domain.initialColumns).workspace).toEqual(input.initial)
  })
  it('does not give the generated automation family to a wrong support group, backup role, or non-whitelist filler', () => {
    const domain = ready(automationFixture()), { rows, selected } = automationExpSelection(domain)
    expect(selected[0]).toBeTruthy()
    expect(rows.some(row => row.groupId === 'other' && row.ids.includes(id('温蒂')))).toBe(false)
    expect(rows.some(row => row.role === 'backup' && row.ids.includes(id('温蒂')))).toBe(false)
    expect(rows.some(row => row.roomId === 'room_2_1' && ['温蒂', '森蚺', '砾'].every(name => row.ids.includes(id(name))))).toBe(false)
  })
  it('does not invent a generated automation variant for an unsupported target product', () => {
    const input = automationFixture()
    input.initial.mainPlan.facilities.room_2_1.product = 'fragment'
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    expect(domain.rooms).toEqual(['room_1_1'])
    expect(domain.requiredCores.some(value => value.startsWith('automation:gold:'))).toBe(true)
    expect(rows.some(row => row.roomId === 'room_2_1')).toBe(false)
    expect(rows.some(row => row.ids.includes(id('冬时')) && row.ids.includes(id('温蒂')))).toBe(false)
  })
  it('freezes a complete core that crosses two manufacturing rooms even with separate shift groups', () => {
    const input = fixture('room_1_1', 2)
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨', '歌蕾蒂娅', '砾', '斑点', '香草', '玫兰莎', '维伊', '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('斯卡蒂', '砾', 'local'), slot('乌尔比安', '香草', 'local')]
    input.initial.mainPlan.facilities.room_2_2 = { roomId: 'room_2_2', type: 'manufacture', level: 2, product: 'exp', slots: [slot('安哲拉', '斑点', 'second'), slot('幽灵鲨', '玫兰莎', 'second')] }
    input.initial.mainPlan.facilities.central.slots = [slot('歌蕾蒂娅', '维伊', 'local')]
    const result = prepareManufacturingCrewDomain(input)
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('unsupported')
    expect(result.frozenComponents.some(block => block.reason === 'multiple-manufacturing-core')).toBe(true)
  })
  it('does not treat an initial product-specific core as an unrelated singleton in another product', () => {
    const input = fixture('room_1_1', 1)
    input.inventory = compileOperatorInventory([...fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator)),
      ...fullCatalogIdleInventory().filter(entry => entry.operator === id('苍苔'))])
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('苍苔', '香草', 'local')]
    input.initial.mainPlan.facilities.room_2_2 = { roomId: 'room_2_2', type: 'manufacture', product: 'exp', level: 1, slots: [slot('斑点', '维伊', 'other')] }
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    expect(domain.coreIds.some(value => value.startsWith('cantabile_metalcraft:gold:'))).toBe(true)
    expect(rows.some(row => row.roomId === 'room_2_2' && row.ids.includes(id('苍苔')))).toBe(false)
  })
  it('can retain two complete user cores in one legal crew without requiring both filler lists to cover the whole crew', () => {
    const input = fixture('room_1_1', 3)
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['多萝西', '砾', '斑点', '泡泡', '火神', '贝娜', '香草', '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('多萝西', '泡泡', 'local'), slot('砾', '火神', 'local'), slot('斑点', '贝娜', 'local')]
    input.userBase = structuredClone(input.initial)
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    const combined = rows.find(row => row.role === 'backup' && ['多萝西', '泡泡', '火神'].every(name => row.ids.includes(id(name))))
    expect(combined).toBeTruthy()
    expect(combined!.retainedCores).toEqual([...domain.requiredCores].sort())
    const main = rows.find(row => row.role === 'main' && ['砾', '斑点', '香草'].every(name => row.ids.includes(id(name))))!
    const decoded = decodeManufacturingCrewSelection(domain, [main, combined!])
    expect(decoded.valid, JSON.stringify(decoded.diagnostics)).toBe(true)
    expect(decoded.workspace.mainPlan.facilities.room_1_1.slots.map(position => position.replacements[0]).sort()).toEqual(['多萝西', '泡泡', '火神'].map(id).sort())
  })
  it('uses actual unlocked skills when excluding warmup operators from ordinary backups', () => {
    const input = fixture('room_1_1', 1)
    const entries = fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator))
    input.inventory = compileOperatorInventory([...entries, { operator: '阿罗玛', elitePhase: 0, level: 1 }])
    const low = [...enumerateManufacturingCrewColumns(ready(input))]
    input.inventory = compileOperatorInventory([...entries, { operator: '阿罗玛', elitePhase: 2, level: 1 }])
    const high = [...enumerateManufacturingCrewColumns(ready(input))]
    expect(low.some(row => row.role === 'backup' && row.ids.includes(id('阿罗玛')))).toBe(true)
    expect(high.some(row => row.role === 'main' && row.ids.includes(id('阿罗玛')))).toBe(true)
    expect(high.some(row => row.role === 'backup' && row.ids.includes(id('阿罗玛')))).toBe(false)
  })
  it('does not certify an initial ordinary warmup backup through the no-op path', () => {
    const input = fixture()
    input.inventory = compileOperatorInventory([...fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator)),
      { operator: '阿罗玛', elitePhase: 2, level: 1 }])
    input.initial.mainPlan.facilities.room_3_2.slots[0]!.replacements = [id('阿罗玛')]
    const result = prepareManufacturingCrewDomain(input)
    expect(result.status).toBe('invalid')
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'CREW_INITIAL_WARMUP_POLICY')).toBe(true)
  })
  it('uses an explicit cooperative budget instead of silently truncating the crew library', () => {
    const domain = ready(fixture('room_2_1', 2))
    expect(() => [...enumerateManufacturingCrewColumns(domain, { maxColumns: 1 })]).toThrow(ManufacturingCrewBudgetExceeded)
    expect(() => [...enumerateManufacturingCrewColumns(domain, { check: () => false })]).toThrow(ManufacturingCrewBudgetExceeded)
  })
  it('matches every complete row of an independent small-domain oracle, including seats and family tags', () => {
    const input = fixture('room_1_1', 1)
    const names = ['多萝西', '砾', '斑点', '香草', '维伊']
    input.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => [...names, '闪灵'].some(name => id(name) === entry.operator)))
    input.initial.mainPlan.facilities.room_1_1.slots = [slot('多萝西', '砾', 'local')]
    input.initial.mainPlan.facilities.room_2_1 = { roomId: 'room_2_1', type: 'manufacture', level: 1, product: 'exp', slots: [slot('斑点', '香草', 'other')] }
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    const expected = ['local', 'other'].flatMap(groupId => ['room_1_1', 'room_2_1'].flatMap(roomId => ['main', 'backup'].flatMap(role => names.map(name => {
      const operatorId = id(name)
      return { id: JSON.stringify([groupId, roomId, role, [operatorId]]), roomId, groupId, groupOrigin: groupId === 'local' ? 'room_1_1' : 'room_2_1',
        role, ids: [operatorId], seatOperatorIds: [operatorId], retainedCores: name === '多萝西' ? [`rhine_lab:family:${operatorId}`] : [] }
    }))))
    expect(rows.slice(0, domain.initialColumns.length)).toEqual(domain.initialColumns)
    expect(sortRows(rows)).toEqual(sortRows(expected))
  })
  it('preserves the full pre-rotation automation library fingerprint, including ordered seats and retained cores', () => {
    const rows = sortRows([...enumerateManufacturingCrewColumns(ready(automationFixture()))])
    // Captured from source 0879023a before changing only the iteration schedule.
    expect({ count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }).toEqual({ count: 963, sha256: 'a3cfb7f0e1b69cd8703a3248b6033ccf7afab6ead1ae6aaf6a59a3f66c816182' })
  })
  it('gives every available group-room-role context an atomic representative before a small column budget stops it', () => {
    const domain = ready(fairEnumerationFixture()), initialIds = new Set(domain.initialColumns.map(row => row.id))
    const expectedContexts = domain.groups.flatMap(group => domain.rooms.flatMap(roomId => ['main', 'backup'].map(role => `${group.id}/${roomId}/${role}`)))
    const prefix: ManufacturingCrewColumn[] = [], limit = domain.initialColumns.length + expectedContexts.length
    let stopped: unknown
    try { for (const row of enumerateManufacturingCrewColumns(domain, { maxColumns: limit })) prefix.push(row) } catch (error) { stopped = error }
    expect(stopped).toBeInstanceOf(ManufacturingCrewBudgetExceeded)
    expect(stopped).toMatchObject({ reason: 'columns', columns: limit })
    expect(prefix.slice(0, domain.initialColumns.length)).toEqual(domain.initialColumns)
    const expanded = prefix.filter(row => !initialIds.has(row.id))
    expect([...new Set(expanded.map(contextKey))].sort()).toEqual(expectedContexts.sort())
    expect(expanded.every(row => row.ids.includes(id('多萝西')) || ['泡泡', '火神'].every(name => row.ids.includes(id(name))))).toBe(true)
  })
  it('does not let a duplicate-heavy context consume the visit budget before later groups can expand', () => {
    const input = fairEnumerationFixture()
    input.initial.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('多萝西') }
    const domain = ready(input), initialIds = new Set(domain.initialColumns.map(row => row.id))
    const template = domain.templates.find(value => value.groupId === 'local' && value.roomId === 'room_1_1' && value.role === 'main' && value.definitionId === 'rhine_lab')!
    // Equivalent overlapping template witnesses yield only the already-seen initial row.
    // They do not change the domain, but stress the rejected-attempt scheduling path.
    domain.templates = [...Array.from({ length: 1000 }, () => ({ ...template, fillerIds: [id('斑点')] })), ...domain.templates]
    const prefix: ManufacturingCrewColumn[] = []
    let stopped: unknown
    try { for (const row of enumerateManufacturingCrewColumns(domain, { maxVisits: 100 })) prefix.push(row) } catch (error) { stopped = error }
    expect(stopped).toBeInstanceOf(ManufacturingCrewBudgetExceeded)
    expect(stopped).toMatchObject({ reason: 'visits' })
    const lastGroup = prefix.filter(row => row.groupId === 'third' && !initialIds.has(row.id))
    expect([...new Set(lastGroup.map(contextKey))].sort()).toEqual(domain.rooms.flatMap(roomId => ['main', 'backup'].map(role => `third/${roomId}/${role}`)).sort())
  })
})

describe('manufacturing crew transactional decode', () => {
  it('rejects duplicate people and malformed complete selections without changing input', () => {
    const input = fixture(), domain = ready(input), before = structuredClone(input.initial)
    const main = domain.initialColumns.find(row => row.role === 'main')!
    const backup = domain.initialColumns.find(row => row.role === 'backup')!
    for (const rows of [[main], [main, main], [main, { ...backup, seatOperatorIds: [...main.seatOperatorIds], ids: [...main.ids] }]]) {
      const result = decodeManufacturingCrewSelection(domain, rows)
      expect(result.valid).toBe(false)
      expect(result.workspace).toEqual(before)
    }
    expect(input.initial).toEqual(before)
  })
  it('decodes a complete legal change while preserving external fields and slot metadata', () => {
    const input = fixture()
    input.initial.mainPlan.facilities.room_3_2.slots[0]!.metadata = { future: { b: 2, a: 1 } }
    input.initial.mainPlan.conf.future = { keep: ['x', 'y'] }
    const domain = ready(input)
    const rows = [...enumerateManufacturingCrewColumns(domain)]
    const main = rows.find(row => row.role === 'main' && row.ids.includes(id('夜烟')))!
    const backup = domain.initialColumns.find(row => row.role === 'backup')!
    expect(main).toBeTruthy()
    const result = decodeManufacturingCrewSelection(domain, [main, backup])
    expect(result.valid).toBe(true)
    expect(result.workspace.mainPlan.facilities.room_3_2.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('夜烟') })
    expect(result.workspace.mainPlan.facilities.central).toEqual(input.initial.mainPlan.facilities.central)
    expect(result.workspace.compatibility).toEqual(input.initial.compatibility)
    expect(result.workspace.mainPlan.facilities.room_3_2.slots[0]!.metadata).toEqual(input.initial.mainPlan.facilities.room_3_2.slots[0]!.metadata)
    expect(result.workspace.mainPlan.conf).toEqual(input.initial.mainPlan.conf)
  })
  it('decodes a complete two-room move using seat order and preserves physical slot metadata', () => {
    const input = fixture()
    input.initial.mainPlan.facilities.room_2_1 = { roomId: 'room_2_1', type: 'manufacture', product: 'gold', level: 1, slots: [slot('斑点', '玫兰莎', 'second')] }
    input.initial.mainPlan.facilities.room_3_2.slots[0]!.metadata = { physicalSeat: 32 }
    input.initial.mainPlan.facilities.room_2_1.slots[0]!.metadata = { physicalSeat: 21 }
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    const find = (groupId: string, roomId: MowerRoomId, role: 'main' | 'backup', name: string) => rows.find(row => row.groupId === groupId && row.roomId === roomId && row.role === role && row.ids[0] === id(name))!
    const selected = [find('local', 'room_2_1', 'main', '夜烟'), find('local', 'room_2_1', 'backup', '香草'),
      find('second', 'room_3_2', 'main', '斑点'), find('second', 'room_3_2', 'backup', '砾')]
    expect(selected.every(Boolean), JSON.stringify(selected)).toBe(true)
    const decoded = decodeManufacturingCrewSelection(domain, selected)
    expect(decoded.valid, JSON.stringify(decoded.diagnostics)).toBe(true)
    expect(decoded.workspace.mainPlan.facilities.room_2_1.slots[0]).toEqual({ ...slot('夜烟', '香草', 'local'), metadata: { physicalSeat: 21 } })
    expect(decoded.workspace.mainPlan.facilities.room_3_2.slots[0]).toEqual({ ...slot('斑点', '砾', 'second'), metadata: { physicalSeat: 32 } })
  })
  it('adds the generated exhaustion policy before accepting a new warmup primary', () => {
    const input = fixture()
    input.inventory = compileOperatorInventory([...fullCatalogIdleInventory().filter(entry => input.inventory.operators.some(operator => operator.charId === entry.operator)),
      { operator: '阿罗玛', elitePhase: 2, level: 1 }])
    const domain = ready(input), rows = [...enumerateManufacturingCrewColumns(domain)]
    const main = rows.find(row => row.role === 'main' && row.ids.includes(id('阿罗玛')))!
    const decoded = decodeManufacturingCrewSelection(domain, [main, domain.initialColumns.find(row => row.role === 'backup')!])
    expect(decoded.valid, JSON.stringify(decoded.diagnostics)).toBe(true)
    expect(decoded.workspace.mainPlan.conf.exhaust_require).toContain(id('阿罗玛'))
    expect(input.initial.mainPlan.conf.exhaust_require).not.toContain(id('阿罗玛'))
  })
})
