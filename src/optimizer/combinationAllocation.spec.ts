import { afterEach, describe, expect, it } from 'vitest'
import { setTimeout as yieldToRunner } from 'node:timers/promises'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { generateMolecularCandidates } from './molecularSynthesis'
import { productionTeamTheory } from './productionSingletons'
import { shiftSnapshot } from './combinationModel'
import { allocateCombinationSkeleton, normalizeProductionShifts, regroupCombination } from './combinationAllocation'
import { buildCombinationPool } from './combinationEvaluation'
import { applySmartDormitoryPolicy } from '../scheduler/smartDormitoryPolicy'
import mixedEntries from './fixtures/mixed-level-inventory.json'
import { validatePhysicalRoster } from './rosterDraft'
import type { CombinationVariant } from './combinationModel'

afterEach(() => yieldToRunner(5))
function layout(type: 'manufacture' | 'trading', level: number) {
  const base = createDefaultWorkspace()
  for (const room of Object.values(base.mainPlan.facilities)) {
    if (room.roomId !== 'room_1_1') { room.level = 0; room.slots = [] }
  }
  const room = base.mainPlan.facilities.room_1_1
  room.type = type; room.level = level; room.product = type === 'manufacture' ? 'gold' : 'money'
  room.slots = Array.from({ length: level }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }))
  base.mainPlan.facilities.room_3_3 = { roomId: 'room_3_3', type: 'power', level: 3,
    slots: [{ occupant: { kind: 'operator', operatorId: id('雷蛇') }, groupId: null, replacements: [id('格雷伊')] }] }
  base.mainPlan.facilities.dormitory_1.level = 1
  base.mainPlan.facilities.dormitory_1.slots = Array.from({ length: 5 }, (_, i) => ({
    occupant: i === 0 ? { kind: 'operator', operatorId: id('杜林') } : { kind: 'free' }, groupId: null, replacements: [],
  }))
  base.mainPlan.conf.disable_auto_dorm_keeper = true
  return base
}
const entries = (names: string[]) => fullCatalogIdleInventory().filter(o => [...names, '雷蛇', '格雷伊', '杜林'].some(name => id(name) === o.operator))

describe('combination-first main and backup allocation', () => {
  it('finds the physical source rather than a Fiammetta refresh reference', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('砾') }
    ws.mainPlan.facilities.room_1_2.slots[0]!.occupant = { kind: 'operator', operatorId: id('苍苔') }
    const fiam = ws.mainPlan.facilities.dormitory_4.slots[0]!
    fiam.occupant = { kind: 'operator', operatorId: id('菲亚梅塔') }; fiam.replacements = [id('苍苔')]
    const variant: CombinationVariant = { id: 'source-repair', definitionId: 'cantabile_metalcraft', name: '苍苔',
      coreOperatorIds: [id('苍苔')], optionalOperatorIds: [], policy: {},
      placements: [{ roomId: 'room_1_1', slotIndex: 0, role: 'main', operatorId: id('苍苔') }] }
    const draft = regroupCombination(ws, compileOperatorInventory(entries(['苍苔', '砾', '菲亚梅塔'])), variant, 'main')!
    expect(draft).not.toBeNull()
    expect(draft.mainPlan.facilities.room_1_2.slots[0]!.occupant).toEqual({ kind: 'operator', operatorId: id('砾') })
    expect(draft.mainPlan.facilities.dormitory_4.slots[0]!.replacements).toEqual([id('苍苔')])
    expect(validatePhysicalRoster(draft).filter(d => d.code === 'DUPLICATE_OPERATOR')).toEqual([])
  })

  it('allows an existing core referenced by Fiammetta to acquire optional members', () => {
    const base = createDefaultWorkspace()
    base.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('苍苔') }
    const fiam = base.mainPlan.facilities.dormitory_4.slots[0]!
    fiam.occupant = { kind: 'operator', operatorId: id('菲亚梅塔') }; fiam.replacements = [id('苍苔')]
    const inventory = compileOperatorInventory(entries(['苍苔', '砾', '斑点', '菲亚梅塔']))
    const pool = buildCombinationPool(base, inventory)
    const supported = pool.values.find(v => v.status === 'evaluated' && v.variant.definitionId === 'cantabile_metalcraft' && v.variant.optionalOperatorIds.length === 2)!
    expect(supported).toBeDefined()
    const allocated = allocateCombinationSkeleton(base, { ...pool, values: [supported] }, 0)
    expect(allocated.variants.length).toBe(1)
    expect(productionTeamTheory(allocated.workspace, inventory, 'room_1_1')).toBe(110)
    expect(allocated.workspace.mainPlan.facilities.dormitory_4.slots[0]!.replacements).toEqual([id('苍苔')])
  })

  it('repairs refresh targets when an outgoing worker becomes relief, and preserves a locked refresh list', () => {
    const ws = createDefaultWorkspace()
    ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('砾') }
    ws.mainPlan.facilities.room_1_2.slots[0]!.occupant = { kind: 'operator', operatorId: id('斑点') }
    ws.mainPlan.facilities.room_1_2.slots[0]!.replacements = [id('苍苔')]
    const fiam = ws.mainPlan.facilities.dormitory_4.slots[0]!
    fiam.occupant = { kind: 'operator', operatorId: id('菲亚梅塔') }; fiam.replacements = [id('砾')]
    const variant: CombinationVariant = { id: 'relief-repair', definitionId: 'cantabile_metalcraft', name: '苍苔',
      coreOperatorIds: [id('苍苔')], optionalOperatorIds: [], policy: {},
      placements: [{ roomId: 'room_1_1', slotIndex: 0, role: 'main', operatorId: id('苍苔') }] }
    const inventory = compileOperatorInventory(entries(['苍苔', '砾', '斑点', '菲亚梅塔']))
    const draft = regroupCombination(ws, inventory, variant, 'main')!
    expect(draft.mainPlan.facilities.room_1_2.slots[0]!.replacements).toEqual([id('砾')])
    expect(draft.mainPlan.facilities.dormitory_4.slots[0]!.replacements).toEqual([id('苍苔')])
    expect(regroupCombination(ws, inventory, variant, 'main', { lockedPositions: new Set(['dormitory_4:0']) })).toBeNull()
  })
  it.each([null, 'user-core'])('keeps a locked metalcraft core unchanged while adding optional members (group %s)', groupId => {
    const base = layout('manufacture', 3), core = base.mainPlan.facilities.room_1_1.slots[0]!
    core.occupant = { kind: 'operator', operatorId: id('苍苔') }; core.groupId = groupId
    const before = structuredClone(core), inventory = compileOperatorInventory(entries(['苍苔', '砾', '斑点']))
    const locks = { lockedPositions: new Set(['room_1_1:0']), lockedOperators: new Set([id('苍苔')]) }
    const pool = buildCombinationPool(base, inventory)
    const supported = pool.values.find(v => v.status === 'evaluated' && v.variant.definitionId === 'cantabile_metalcraft' && v.variant.optionalOperatorIds.length === 2)!
    expect(supported).toBeDefined()
    const allocation = allocateCombinationSkeleton(base, { ...pool, values: [supported] }, 0, locks)
    expect(allocation.variants.length).toBe(1)
    expect(allocation.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(before)
    expect(productionTeamTheory(allocation.workspace, inventory, 'room_1_1')).toBe(110)
    const regrouped = regroupCombination(base, inventory, supported.variant, 'main', locks)
    expect(regrouped).not.toBeNull()
    expect(regrouped!.mainPlan.facilities.room_1_1.slots[0]).toEqual(before)
    expect(productionTeamTheory(regrouped!, inventory, 'room_1_1')).toBe(110)
  })

  it('retains low-stage Rhine presence through repeated dormitory finishing', () => {
    const base = createDefaultWorkspace(), owned = entries(['多萝西', '娜斯提', '伊芙利特'])
    Object.assign(owned.find(o => o.operator === id('伊芙利特'))!, { elitePhase: 0, level: 1 })
    const inventory = compileOperatorInventory(owned), pool = buildCombinationPool(base, inventory)
    const supported = pool.values.find(v => v.status === 'evaluated' && v.variant.definitionId === 'rhine_lab' && v.variant.optionalOperatorIds.includes(id('娜斯提')) && v.variant.optionalOperatorIds.includes(id('伊芙利特')))!
    const ws = allocateCombinationSkeleton(base, { ...pool, values: [supported] }, 0).workspace
    const p = supported.variant.placements.find(p => p.operatorId === id('伊芙利特'))!
    const before = productionTeamTheory(ws, inventory, 'room_1_1')
    for (let i = 0; i < 2; i++) applySmartDormitoryPolicy(ws, { entries: owned })
    expect(ws.mainPlan.facilities[p.roomId].slots[p.slotIndex]!.occupant).toEqual({ kind: 'operator', operatorId: id('伊芙利特') })
    expect(productionTeamTheory(ws, inventory, 'room_1_1')).toBe(before)
  })

  it('audits final production ordering after all finishing and presence changes', async () => {
    await yieldToRunner(5)
    const inventory = compileOperatorInventory(mixedEntries)
    const candidate = generateMolecularCandidates(createDefaultWorkspace(), mixedEntries, inventory, { branchCount: 1 })[0]!
    expect(candidate).toBeDefined()
    for (const room of Object.values(candidate.workspace.mainPlan.facilities).filter(r => r.level > 0 && ['manufacture', 'trading'].includes(r.type))) {
      const main = productionTeamTheory(candidate.workspace, inventory, room.roomId)!
      const backup = productionTeamTheory(shiftSnapshot(candidate.workspace, 'backup', room.roomId), inventory, room.roomId)!
      if (main + 1e-9 < backup) expect(candidate.diagnostics.join('；')).toContain(`${room.roomId} 替班人均较高`)
    }
  }, 30000)
  it('builds the new Monster Hunter pair before singleton staffing consumes either core', async () => {
    await yieldToRunner(5)
    const owned = entries(['焰狐龙梓兰', '雷狼龙S空爆', '梓兰', '月见夜'])
    const candidates = generateMolecularCandidates(layout('trading', 2), owned, compileOperatorInventory(owned), { branchCount: 1 })
    expect(candidates.length).toBeGreaterThan(0)
    const room = candidates[0]!.workspace.mainPlan.facilities.room_1_1
    expect(room.slots.map(s => s.occupant.kind === 'operator' ? id(s.occupant.operatorId) : '')).toEqual(expect.arrayContaining([id('焰狐龙梓兰'), id('雷狼龙S空爆')]))
  })

  it('regroups metalcraft and keeps the higher complete production team in main', async () => {
    await yieldToRunner(5)
    const owned = entries(['苍苔', '砾', '斑点', '梅尔', '白面鸮', '调香师'])
    const inventory = compileOperatorInventory(owned)
    const candidates = generateMolecularCandidates(layout('manufacture', 3), owned, inventory, { branchCount: 1 })
    expect(candidates.length).toBeGreaterThan(0)
    const workspace = candidates[0]!.workspace
    const ids = workspace.mainPlan.facilities.room_1_1.slots.map(s => s.occupant.kind === 'operator' ? id(s.occupant.operatorId) : '')
    expect(ids).toEqual(expect.arrayContaining([id('苍苔'), id('砾'), id('斑点')]))
    expect(productionTeamTheory(workspace, inventory, 'room_1_1')).toBe(110)
    expect(productionTeamTheory(shiftSnapshot(workspace, 'backup'), inventory, 'room_1_1')).toBe(80)
  })

  it('reunites available Dorothy support instead of treating it as a permanently reserved singleton', () => {
    const owned = entries(['多萝西', '淬羽赫默', '梅尔', '白面鸮', '调香师', '夜烟'])
    const inventory = compileOperatorInventory(owned)
    const candidates = generateMolecularCandidates(layout('manufacture', 3), owned, inventory, { branchCount: 1 })
    expect(candidates.length).toBeGreaterThan(0)
    const ws = candidates[0]!.workspace
    const teams = [ws, shiftSnapshot(ws, 'backup')].map(w => w.mainPlan.facilities.room_1_1.slots.map(s => s.occupant.kind === 'operator' ? id(s.occupant.operatorId) : ''))
    expect(teams.some(team => team.includes(id('多萝西')) && team.includes(id('淬羽赫默')))).toBe(true)
    expect(productionTeamTheory(ws, inventory, 'room_1_1')!).toBeGreaterThanOrEqual(productionTeamTheory(shiftSnapshot(ws, 'backup'), inventory, 'room_1_1')!)
  })

  it('swaps complete teams, and reports a user lock instead of silently violating it', () => {
    const ws = layout('manufacture', 3), names = ['梅尔', '白面鸮', '调香师'], relief = ['苍苔', '砾', '斑点']
    ws.mainPlan.facilities.room_1_1.slots.forEach((slot, i) => {
      slot.occupant = { kind: 'operator', operatorId: id(names[i]!) }; slot.replacements = [id(relief[i]!)]; slot.groupId = 'same-shift'
    })
    const inventory = compileOperatorInventory(entries([...names, ...relief]))
    const locked = structuredClone(ws)
    expect(normalizeProductionShifts(locked, inventory, { lockedPositions: new Set(['room_1_1:0']) }).join('')).toContain('用户锁定')
    expect(locked).toEqual(ws)
    normalizeProductionShifts(ws, inventory)
    expect(productionTeamTheory(ws, inventory, 'room_1_1')).toBe(110)
    expect(productionTeamTheory(shiftSnapshot(ws, 'backup'), inventory, 'room_1_1')).toBe(80)
  })

  it('does not block main/relief ordering merely because a core has no facility skill unlocked yet', () => {
    const ws = layout('manufacture', 3)
    const names = ['多萝西', '赫默', '调香师'], backups = ['苍苔', '砾', '斑点']
    ws.mainPlan.facilities.room_1_1.slots.forEach((slot, i) => {
      slot.occupant = { kind: 'operator', operatorId: id(names[i]!) }; slot.replacements = [id(backups[i]!)]; slot.groupId = 'stage-aware'
    })
    const owned = entries([...names, ...backups])
    Object.assign(owned.find(o => o.operator === id('赫默'))!, { elitePhase: 0, level: 1 })
    const inventory = compileOperatorInventory(owned)
    expect(normalizeProductionShifts(ws, inventory)).toEqual([])
    expect(productionTeamTheory(ws, inventory, 'room_1_1')).toBe(110)
    expect(ws.mainPlan.facilities.room_1_1.slots[1]!.replacements).toContain(id('赫默'))
  })
})
