import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTimeout as yieldToRunner } from 'node:timers/promises'

// annotate flushes pending task updates and awaits the IPC acknowledgement.
// A fixed delay cannot guarantee this before a long synchronous generation.

// Large synchronous generation cases must let Vitest flush worker progress messages.
beforeEach(() => yieldToRunner(5))
afterEach(() => yieldToRunner(5))
import { OPERATORS } from '../domain/operators'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { restoreOperatorMowerName } from '../workbench/compat/mowerJson'
import { generateMolecularCandidates } from './molecularSynthesis'
import { runSmartRoster } from './smartRoster'

const allOwned: OwnedOperatorInput[] = OPERATORS.map((o) => ({
  operator: o.name,
  elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2,
  level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90,
}))

const inventory = compileOperatorInventory(allOwned)

describe('Molecular Synthesis & Indivisible Atomic Units', () => {
  it('preserves unbuilt dorm and training room across automatic staffing candidates', async ({ annotate }) => {
    await annotate('检查自动排班不会补建已省略设施')
    const base = createDefaultWorkspace()
    for (const id of ['dormitory_4', 'train'] as const) {
      base.mainPlan.facilities[id].level = 0
      base.mainPlan.facilities[id].slots = []
    }
    const candidates = generateMolecularCandidates(base, allOwned, inventory, { seed: 42, branchCount: 1 })
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.workspace.mainPlan.facilities.dormitory_4).toMatchObject({ level: 0, slots: [] })
      expect(candidate.workspace.mainPlan.facilities.train).toMatchObject({ level: 0, slots: [] })
    }
  }, 30000)

  it('strictly respects indivisible atomic core members', async ({ annotate }) => {

    await annotate('同步计算前确认测试进度已送达')
    const base = createDefaultWorkspace()
    const candidates = generateMolecularCandidates(base, allOwned, inventory, {
      seed: 42,
      branchCount: 6,
    })

    expect(candidates.length).toBeGreaterThan(0)

    for (const cand of candidates) {
      const ws = cand.workspace
      const allAssignedMains = Object.values(ws.mainPlan.facilities).flatMap((r) =>
        r.slots.flatMap((s) => (s.occupant.kind === 'operator' ? [restoreOperatorMowerName(s.occupant.operatorId)] : [])),
      )
      const allAssignedSet = new Set(allAssignedMains)

      // 1. If Abyssal Hunters applied: all 5 core must be present
      if (cand.appliedAtoms.includes('abyssal_hunters')) {
        expect(allAssignedSet.has('歌蕾蒂娅')).toBe(true)
        expect(allAssignedSet.has('斯卡蒂')).toBe(true)
        expect(allAssignedSet.has('乌尔比安')).toBe(true)
        expect(allAssignedSet.has('安哲拉')).toBe(true)
        expect(allAssignedSet.has('幽灵鲨')).toBe(true)

        // Gladiia in Central
        const centralOps = ws.mainPlan.facilities.central.slots.map((s) =>
          s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '',
        )
        expect(centralOps).toContain('歌蕾蒂娅')

        // Other 4 hunters in conf.resting_priority
        const restingLow = ws.mainPlan.conf.resting_priority.map(restoreOperatorMowerName)
        expect(restingLow).toContain('乌尔比安')
        expect(restingLow).toContain('斯卡蒂')
        expect(restingLow).toContain('幽灵鲨')
        // Crucial Check: Abyssal Hunters in ANY manufacture room must NOT exceed 2 (to respect Gladiia 90% cap)
        for (const room of Object.values(ws.mainPlan.facilities)) {
          if (room.type === 'manufacture') {
            const huntersInRoom = room.slots.filter((s) =>
              s.occupant.kind === 'operator' &&
              ['斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨'].includes(restoreOperatorMowerName(s.occupant.operatorId)),
            ).length
            expect(huntersInRoom).toBeLessThanOrEqual(2)
          }
        }
      }

      // 2. If Vermeil Dionysus applied: all 3 must be together in the same room
      if (cand.appliedAtoms.includes('vermeil_dionysus')) {
        const expRooms = Object.values(ws.mainPlan.facilities).filter(
          (r) => r.type === 'manufacture' && r.product === 'exp',
        )
        const roomWithVermeil = expRooms.find((r) =>
          r.slots.some((s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === '红云'),
        )
        expect(roomWithVermeil).toBeDefined()
        const roomOps = roomWithVermeil!.slots.map((s) =>
          s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '',
        )
        expect(roomOps).toContain('红云')
        expect(roomOps).toContain('酒神')
        expect(roomOps).toContain('Miss.Christine')
      }

      // 3. Automatic runners Proviso and Tequila remain reserved for temporary order swaps.
      const tradingRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'trading')
      const tradingOps = tradingRooms.flatMap((r) =>
        r.slots.map((s) => (s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '')),
      )
      expect(tradingOps).not.toContain('但书')
      expect(tradingOps).not.toContain('龙舌兰')

      // 4. Penguin Logistics: Sora is strictly excluded
      if (cand.appliedAtoms.includes('penguin_logistics')) {
        expect(tradingOps).not.toContain('空')
      }

      // 5. Pozemka 4-Durin requirement: 4 Durins must be in the base
      if (cand.appliedAtoms.includes('pozemka_durin')) {
        const durins = ['杜林', '桃金娘', '褐果', '至简']
        const durinsInBase = durins.filter((name) => allAssignedSet.has(name))
        expect(durinsInBase.length).toBe(4)
      }
    }
  }, 120000)

  it('generates correct 2-power adaptive automation conf with Lancet-2 in workaholic', async ({ annotate }) => {


    await annotate('同步计算前确认测试进度已送达')
    const base = createDefaultWorkspace()
    // Configure as 2-power layout (room_3_3 changed to manufacture)
    base.mainPlan.facilities.room_3_3 = {
      roomId: 'room_3_3',
      type: 'manufacture',
      level: 3,
      product: 'gold',
      slots: Array.from({ length: 3 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    base.mainPlan.facilities.room_3_1.level = 2
    for (const room of Object.values(base.mainPlan.facilities)) {
      if (room.type === 'dormitory' || room.type === 'contact' || room.type === 'factory' || room.type === 'train') {
        room.level = 1
      }
    }

    const candidates = generateMolecularCandidates(base, allOwned, inventory, {
      seed: 101,
      branchCount: 4,
    })

    const autoCandidate = candidates.find((c) => c.appliedAtoms.includes('automation'))
    expect(autoCandidate).toBeDefined()

    const ws = autoCandidate!.workspace
    // Lancet-2 must be in conf.workaholic (0-morale worker, no dorm rest)
    const workaholicNames = ws.mainPlan.conf.workaholic.map(restoreOperatorMowerName)
    expect(workaholicNames).toContain('Lancet-2')

    // Eunectes in Central in 2-power layout
    const centralOps = ws.mainPlan.facilities.central.slots.map((s) =>
      s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '',
    )
    expect(centralOps).toContain('森蚺')

    // Lancet-2 in power station
    const powerOps = Object.values(ws.mainPlan.facilities)
      .filter((r) => r.type === 'power')
      .flatMap((r) => r.slots.map((s) => (s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '')))
    expect(powerOps).toContain('Lancet-2')
    expect(powerOps).toContain('承曦格雷伊')
  }, 120000)

  it('configures Aroma and Waai Fu in exhaust_require and rest_in_full', async ({ annotate }) => {


    await annotate('同步计算前确认测试进度已送达')
    const base = createDefaultWorkspace()
    const candidates = generateMolecularCandidates(base, allOwned, inventory, {
      seed: 42,
      branchCount: 8,
    })

    const aromaCand = candidates.find((c) => c.appliedAtoms.includes('aroma_waaifu'))
    if (aromaCand) {
      const exhaustNames = aromaCand.workspace.mainPlan.conf.exhaust_require.map(restoreOperatorMowerName)
      const restInFullNames = aromaCand.workspace.mainPlan.conf.rest_in_full.map(restoreOperatorMowerName)
      expect(exhaustNames).toContain('阿罗玛')
      expect(exhaustNames).toContain('槐琥')
      expect(restInFullNames).toContain('阿罗玛')
      expect(restInFullNames).toContain('槐琥')
    }
  }, 120000)

  it('runs full smartRoster end-to-end with 82 dynamic simulation scoring', async ({ annotate }) => {


    await annotate('同步计算前确认测试进度已送达')
    const base = createDefaultWorkspace()
    const result = runSmartRoster(base, allOwned, {
      branchCount: 2,
      simulationTopK: 2,
      simulationWarmupHours: 12,
      simulationSampleHours: 24,
      enableDeepSearch: false,
      seed: 999,
    })

    expect(result.status).toBe('draft')
    expect(result.workspace).not.toBeNull()
    expect(result.score).toBeGreaterThan(0)
    expect(result.phases.simulation).not.toBeNull()
    expect(result.phases.simulation!.candidates.length).toBeGreaterThanOrEqual(1)

    // Verify final conf has valid fields populated
    const conf = result.workspace!.mainPlan.conf
    expect(Array.isArray(conf.exhaust_require)).toBe(true)
    expect(Array.isArray(conf.rest_in_full)).toBe(true)
    expect(Array.isArray(conf.resting_priority)).toBe(true)
    expect(Array.isArray(conf.ope_resting_priority)).toBe(true)
    expect(Array.isArray(conf.workaholic)).toBe(true)
  }, 120000)
})
