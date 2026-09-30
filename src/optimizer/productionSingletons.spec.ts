import { describe, expect, it } from 'vitest'
import { OPERATORS } from '../domain/operators'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import type { MowerRoomId } from '../workbench/model'
import { projectRosterConfig } from './rosterProjection'
import { clearQualityCache, rankStaffingCandidates } from './staffingQuality'
import { applySingletonWorkPolicy, singletonTheory } from './productionSingletons'
import { runGlobalPerCapitaReplacement } from './globalPerCapitaReplacement'
import { generateBackupNeighbors } from './backupNeighborhood'
import { assignBackups } from './rosterDraft'

const entries: OwnedOperatorInput[] = OPERATORS.map(o => ({ operator: o.name,
  elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2,
  level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90 }))
const inventory = compileOperatorInventory(entries)
const place = (w: ReturnType<typeof createDefaultWorkspace>, room: MowerRoomId, names: string[]) => {
  w.mainPlan.facilities[room].slots = names.map(name => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: null, replacements: [] }))
}
const theory = (w: ReturnType<typeof createDefaultWorkspace>, room: MowerRoomId, name: string) => {
  const config = projectRosterConfig(w); config.operatorRecords = inventoryOperatorRecords(inventory)
  return singletonTheory(config, room, id(name))
}

describe('user reference singleton admission and theoretical ranking', () => {
  it('re-ranks power skills when the same operator inventory changes its unlocked stage', () => {
    clearQualityCache()
    const w = createDefaultWorkspace(), position = { roomId: 'room_1_3' as const, slotIndex: 0 }
    const pool = ['雷蛇', '格雷伊'].map(id)
    const high = compileOperatorInventory([{ operator: '雷蛇', elitePhase: 2, level: 1 }, { operator: '格雷伊', elitePhase: 0, level: 1 }])
    const low = compileOperatorInventory([{ operator: '雷蛇', elitePhase: 0, level: 1 }, { operator: '格雷伊', elitePhase: 0, level: 1 }])
    expect(rankStaffingCandidates(w, high, position, pool, 'main')).toEqual(pool)
    expect(rankStaffingCandidates(w, low, position, pool, 'main')).toEqual([...pool].reverse())
  })
  it.each(['central', 'room_1_3'] as const)('filters a sole candidate by unlocked facility skill in %s', roomId => {
    const w = createDefaultWorkspace()
    expect(rankStaffingCandidates(w, inventory, { roomId, slotIndex: 0 }, [id('砾')], 'main')).toEqual([])
    expect(rankStaffingCandidates(w, inventory, { roomId, slotIndex: 0 }, [id('砾')], 'main', { allowNeutral: true })).toEqual([id('砾')])
  })
  it.each(['main', 'backup'] as const)('selects the higher effective skill before a documented singleton for %s', role => {
    const w = createDefaultWorkspace()
    w.mainPlan.facilities.train.level = 1
    expect(rankStaffingCandidates(w, inventory, { roomId: 'room_1_1', slotIndex: 0 },
      ['维伊', '香草'].map(id), role)).toEqual(['香草', '维伊'].map(id))
  })
  it.each(['main', 'backup'] as const)('admits a quantified additive skill without a singleton name entry for %s', role => {
    const w = createDefaultWorkspace()
    expect(rankStaffingCandidates(w, inventory, { roomId: 'room_3_1', slotIndex: 0 },
      [id('贝洛内')], role)).toEqual([id('贝洛内')])
    place(w, 'room_3_1', ['贝洛内'])
    expect(theory(w, 'room_3_1', '贝洛内')).toBe(30)
  })
  it('ranks warmed Mechanist above 35% operators independently of input order', () => {
    const w = createDefaultWorkspace(), p = { roomId: 'room_2_1' as const, slotIndex: 0 }
    const pool = ['酒神', '红豆', '机械师', '断罪者'].map(id)
    expect(rankStaffingCandidates(w, inventory, p, pool, 'main')[0]).toBe(id('机械师'))
    expect(rankStaffingCandidates(w, inventory, p, [...pool].reverse(), 'backup')[0]).toBe(id('机械师'))
    place(w, p.roomId, ['机械师']); expect(theory(w, p.roomId, '机械师')).toBe(40)
    applySingletonWorkPolicy(w, p.roomId, 0)
    expect(w.mainPlan.conf.exhaust_require.map(id)).toContain(id('机械师'))
    expect(w.mainPlan.facilities[p.roomId].slots[0]!.groupId).toBeNull()
  })
  it.each([['阿罗玛', 45], ['砾', 35], ['引星棘刺', 36], ['清流', 40], ['雪猎', 30], ['梅尔', 30], ['淬羽赫默', 30]] as const)(
    '%s uses its actual gold skill contribution, excluding staffing bonus', (name, expected) => {
      const w = createDefaultWorkspace(); place(w, 'room_1_1', [name])
      expect(theory(w, 'room_1_1', name)).toBe(expected)
    })
  it('rejects a sole ineligible candidate instead of bypassing admission for small pools', () => {
    const w = createDefaultWorkspace(), p = { roomId: 'room_1_1' as const, slotIndex: 0 }
    for (const name of ['槐琥', '断罪者', '能天使']) expect(rankStaffingCandidates(w, inventory, p, [id(name)], 'main')).toEqual([])
    const low = compileOperatorInventory([{ operator: '机械师', elitePhase: 0, level: 1 }])
    expect(rankStaffingCandidates(w, low, { roomId: 'room_2_1', slotIndex: 0 }, [id('机械师')], 'main')).toEqual([id('机械师')])
  })
  it('uses only the applicable skill when another slot targets a different product', () => {
    const w = createDefaultWorkspace()
    place(w, 'room_1_1', ['机械师'])
    expect(theory(w, 'room_1_1', '机械师')).toBe(10)
    expect(rankStaffingCandidates(w, inventory, { roomId: 'room_1_1', slotIndex: 0 },
      ['机械师', '香草'].map(id), 'main')).toEqual(['香草', '机械师'].map(id))
  })
  it('ranks eligible additive production staff by efficiency', () => {
    const w = createDefaultWorkspace(), p = { roomId: 'room_1_1' as const, slotIndex: 0 }
    expect(rankStaffingCandidates(w, inventory, p, ['芬', '阿罗玛', '香草', '槐琥'].map(id), 'main')).toEqual(['阿罗玛', '芬', '香草'].map(id))
  })
  it('respects actual facility levels and two-power Minimalist exclusion', () => {
    const w = createDefaultWorkspace(); place(w, 'room_1_1', ['维伊'])
    w.mainPlan.facilities.train.level = 1
    expect(theory(w, 'room_1_1', '维伊')).toBe(10)
    w.mainPlan.facilities.room_3_3.type = 'manufacture'
    expect(rankStaffingCandidates(w, inventory, { roomId: 'room_1_1', slotIndex: 0 }, [id('至简')], 'main')).toEqual([])
  })
  it('admits fully upgraded three-power Minimalist without treating robot supply as unquantified output', () => {
    const w = createDefaultWorkspace()
    place(w, 'room_1_1', ['至简'])
    expect(theory(w, 'room_1_1', '至简')).toBe(40)
    expect(rankStaffingCandidates(w, inventory, { roomId: 'room_1_1', slotIndex: 0 }, [id('至简')], 'main')).toEqual([id('至简')])
  })
  it('counts working colleagues for Kichisei rather than assigning a fixed 40%', () => {
    const w = createDefaultWorkspace()
    place(w, 'room_3_1', ['吉星', '能天使']); expect(theory(w, 'room_3_1', '吉星')).toBe(20)
    place(w, 'room_3_1', ['吉星', '能天使', '海蒂']); expect(theory(w, 'room_3_1', '吉星')).toBe(40)
  })
  it('maps the last output room correctly even when an earlier layout cell is filtered', () => {
    const w = createDefaultWorkspace()
    w.mainPlan.facilities.room_1_1.type = 'gaming'
    const room = w.mainPlan.facilities.room_3_3; room.type = 'manufacture'; room.product = 'exp'
    expect(rankStaffingCandidates(w, inventory, { roomId: room.roomId, slotIndex: 0 }, ['酒神', '机械师'].map(id), 'main')[0]).toBe(id('机械师'))
  })
  it('does not exchange EXP-only backups into a gold factory', () => {
    const w = createDefaultWorkspace()
    place(w, 'room_1_1', ['砾']); place(w, 'room_2_1', ['断罪者'])
    w.mainPlan.facilities.room_1_1.slots[0]!.replacements = ['斑点']
    w.mainPlan.facilities.room_2_1.slots[0]!.replacements = ['红豆']
    expect(generateBackupNeighbors(w, entries, 21).some(n => n.move.kind === 'exchange')).toBe(false)
  })
  it('evaluates a whole automation relief shift without retaining outgoing suppression', () => {
    const w = createDefaultWorkspace(); place(w, 'room_1_1', ['温蒂', '清流', '冬时'])
    const room = w.mainPlan.facilities.room_1_1
    room.slots.forEach(slot => { slot.groupId = '自动化组' })
    const rest = assignBackups(w, inventory, room.slots.map((slot, slotIndex) => ({ roomId: room.roomId, slotIndex,
      operatorId: slot.occupant.kind === 'operator' ? slot.occupant.operatorId : '' })))
    expect(rest.missingReplacementIds).toEqual([])
    expect(new Set(room.slots.map(slot => slot.replacements[0])).size).toBe(3)
  })
  it('keeps Kichisei available while a complete three-person relief team is being assigned', () => {
    const w = createDefaultWorkspace(); place(w, 'room_3_1', ['德克萨斯', '拉普兰德', '空弦'])
    const room = w.mainPlan.facilities.room_3_1
    room.slots.forEach(slot => { slot.groupId = '企鹅物流' })
    const inv = compileOperatorInventory(entries.filter(e => ['吉星', '海蒂', '赫德雷'].includes(e.operator)))
    const rest = assignBackups(w, inv, room.slots.map((slot, slotIndex) => ({ roomId: room.roomId, slotIndex,
      operatorId: slot.occupant.kind === 'operator' ? slot.occupant.operatorId : '' })))
    expect(rest.missingReplacementIds).toEqual([])
    expect(room.slots.flatMap(slot => slot.replacements)).toContain(id('吉星'))
  })
  it('uses the unlocked colleague bonus while constructing a complete relief team', () => {
    const w = createDefaultWorkspace(); place(w, 'room_3_1', ['德克萨斯', '拉普兰德', '空弦'])
    w.mainPlan.facilities.room_3_1.slots.forEach(slot => { slot.groupId = '企鹅物流' })
    const inv = compileOperatorInventory([{ operator: '吉星', elitePhase: 0, level: 1 }, { operator: '火哨', elitePhase: 2, level: 1 }])
    expect(rankStaffingCandidates(w, inv, { roomId: 'room_3_1', slotIndex: 0 }, ['吉星', '火哨'].map(id),
      'backup', { completingReliefTeam: true })).toEqual(['火哨', '吉星'].map(id))
  })
  it('keeps theoretical upgrades provisional until the whole-roster score improves', () => {
    const w = createDefaultWorkspace(); place(w, 'room_2_1', ['红豆'])
    w.mainPlan.facilities.room_2_1.slots[0]!.replacements = ['白雪']
    const result = runGlobalPerCapitaReplacement(w, inventory, { baselineScore: 100, evaluator: () => 99 })
    expect(result.swappedCount).toBe(0)
    expect(result.workspace).toEqual(w)
  })
})
