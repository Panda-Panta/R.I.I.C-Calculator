import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { afterEach, describe, expect, it } from 'vitest'
import { setTimeout as yieldToRunner } from 'node:timers/promises'
import { OPERATORS } from '../domain/operators'
import type { OwnedOperatorInput } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { runSmartRoster, type SmartRosterProgress } from './smartRoster'
import { validatePhysicalRoster } from './rosterDraft'
import { MOWER_OUTPUT_ROOM_IDS } from '../workbench/model'
import { runCalculationBridge } from '../workbench/calculationBridge'

// Each synchronous simulation takes tens of seconds. Flush pending test-runner
// messages between cases so their combined CPU time cannot starve Vitest RPC.
afterEach(() => yieldToRunner(5))

const allOwned: OwnedOperatorInput[] = OPERATORS.map((o) => ({
  operator: o.name,
  elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2,
  level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90,
}))

const mains = (w: ReturnType<typeof createDefaultWorkspace>) =>
  Object.values(w.mainPlan.facilities).flatMap((r) =>
    r.slots.flatMap((s) => (s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []))
  )

describe('smartRoster generation with 3-phase optimization', () => {
  it('builds complete 243 mains with backups and simulation validation', () => {
    const base = createDefaultWorkspace()
    base.compatibility.importedPresentRooms = [...MOWER_OUTPUT_ROOM_IDS, 'central']
    const progressLogs: SmartRosterProgress[] = []

    const result = runSmartRoster(
      base,
      allOwned,
      {
        branchCount: 2,
        simulationTopK: 1,
        simulationWarmupHours: 6,
        simulationSampleHours: 18,
        enableDeepSearch: false,
        seed: 42,
      },
      (p) => progressLogs.push({ ...p })
    )

    expect(result.status).toBe('draft')
    expect(result.workspace).not.toBeNull()
    const workspace = result.workspace!

    // Verify all production rooms and central are fully staffed with backups
    for (const room of Object.values(workspace.mainPlan.facilities)) {
      if (['manufacture', 'trading', 'power', 'central'].includes(room.type)) {
        const cap = room.type === 'central' ? 5 : room.type === 'power' ? 1 : room.level
        expect(room.slots.slice(0, cap).every((s) => s.occupant.kind === 'operator')).toBe(true)
        expect(room.slots.slice(0, cap).every((s) => s.replacements.filter(x => isOrdinaryReplacementCandidate(x, room.type)).length === 1)).toBe(true)
      }
    }

    // Check backups are unique and do not overlap with mains in working facilities
    const workingRooms = Object.values(workspace.mainPlan.facilities).filter((r) => r.type !== 'dormitory')
    const backups = workingRooms.flatMap((r) =>
      r.slots.flatMap((s) => s.replacements.map(id).filter(x => isOrdinaryReplacementCandidate(x, r.type)))
    )
    expect(new Set(backups).size).toBe(backups.length)
    const mainList = mains(workspace)
    expect(backups.every((b) => !mainList.includes(b))).toBe(true)

    // Verify Fiammetta in dormitory has 3 swap targets from active production rooms
    const fiamSlot = Object.values(workspace.mainPlan.facilities)
      .filter((r) => r.type === 'dormitory')
      .flatMap((r) => r.slots)
      .find((s) => s.occupant.kind === 'operator' && id(s.occupant.operatorId) === 'char_300_phenxi')
    if (fiamSlot) {
      expect(fiamSlot.replacements.length).toBe(3)
      expect(fiamSlot.replacements.every((rep) => mainList.includes(id(rep)))).toBe(true)
    }

    // Verify physical validity
    expect(validatePhysicalRoster(workspace)).toEqual([])

    // Verify simulation score was computed
    expect(result.score).toBeGreaterThan(0)
    expect(result.phases.simulation).not.toBeNull()
    expect(result.phases.simulation!.candidates.length).toBeGreaterThanOrEqual(1)

    // Progress logs should have recorded phases
    expect(progressLogs.some((p) => p.phase === 'building')).toBe(true)
    expect(progressLogs.some((p) => p.phase === 'simulating')).toBe(true)
    expect(progressLogs.some((p) => p.phase === 'done')).toBe(true)
  }, 60000)

  it('preserves user-locked operators when starting from a partial layout', () => {
    const base = createDefaultWorkspace()
    // Pre-place Texas and Lappland in room_1_1 (trading)
    base.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('德克萨斯') }
    base.mainPlan.facilities.room_1_1.slots[1]!.occupant = { kind: 'operator', operatorId: id('拉普兰德') }

    const result = runSmartRoster(base, allOwned, {
      branchCount: 1,
      simulationTopK: 1,
      simulationWarmupHours: 6,
      simulationSampleHours: 18,
      enableDeepSearch: false,
      seed: 123,
    })

    expect(result.status).toBe('draft')
    const workspace = result.workspace!

    // Verify Texas and Lappland remain in room_1_1 slot 0 and 1
    expect(workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant).toEqual({
      kind: 'operator',
      operatorId: id('德克萨斯'),
    })
    expect(workspace.mainPlan.facilities.room_1_1.slots[1]!.occupant).toEqual({
      kind: 'operator',
      operatorId: id('拉普兰德'),
    })

    // Verify all other production rooms are staffed
    expect(workspace.mainPlan.facilities.room_1_2.slots.every((s) => s.occupant.kind === 'operator')).toBe(true)
  }, 60000)

  it('adapts to 252 layout with two-seat trading room', () => {
    const base = createDefaultWorkspace()
    // Standard 252 layout: 2 trading, 5 manufacture, 2 power; dormitories and auxiliary rooms level 1 to balance power
    base.mainPlan.facilities.room_3_3 = {
      roomId: 'room_3_3',
      type: 'manufacture',
      level: 3,
      product: 'exp',
      slots: Array.from({ length: 3 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
    }
    base.mainPlan.facilities.room_3_1.level = 2
    for (const room of Object.values(base.mainPlan.facilities)) {
      if (room.type === 'dormitory' || room.type === 'contact' || room.type === 'factory' || room.type === 'train') {
        room.level = 1
      }
    }

    const result = runSmartRoster(base, allOwned, {
      branchCount: 1,
      simulationTopK: 1,
      simulationWarmupHours: 6,
      simulationSampleHours: 18,
      enableDeepSearch: false,
      seed: 777,
    })

    expect(result.status).toBe('draft')
    const workspace = result.workspace!
    expect(workspace.mainPlan.facilities.room_3_1.slots.slice(0, 2).every((s) => s.occupant.kind === 'operator')).toBe(true)
    expect(workspace.mainPlan.facilities.room_3_3.slots.slice(0, 3).every((s) => s.occupant.kind === 'operator')).toBe(true)
  }, 60000)

  it('handles user inventory with unmaxed/low-level operators without simulation abort or unsupported diagnostics', () => {
    const base = createDefaultWorkspace()
    // Clone allOwned but degrade the 8 operators from user report to E0 Lv1 / unmaxed
    const degradedNames = new Set(['贝娜', '雪雉', '缪尔赛思', '虎狼丸', '响石', '小满', '隐德来希', '寒檀'])
    const mixedInventory = allOwned.map((entry) => {
      if (degradedNames.has(entry.operator)) {
        return { operator: entry.operator, elitePhase: 0, level: 1 }
      }
      return entry
    })

    const result = runSmartRoster(base, mixedInventory, {
      branchCount: 1,
      simulationTopK: 1,
      simulationWarmupHours: 6,
      simulationSampleHours: 18,
      enableDeepSearch: false,
      seed: 42,
    })

    expect(result.status).toBe('draft')
    expect(result.score).toBeGreaterThan(0)

    // Verify none of the degraded operators were placed into any facility, backup, or dormitory
    const ws = result.workspace!
    const placedOps = new Set<string>()
    for (const fac of Object.values(ws.mainPlan.facilities)) {
      for (const s of fac.slots) {
        if (s.occupant.kind === 'operator') placedOps.add(s.occupant.operatorId)
        for (const rep of s.replacements) placedOps.add(rep)
      }
    }
    for (const name of degradedNames) {
      expect(placedOps.has(id(name))).toBe(false)
    }

    // Verify calculation bridge with mixedInventory does not produce INVENTORY_SKILL_STAGE_UNSUPPORTED
    const calc = runCalculationBridge(ws, {
      engine: 'simulation',
      simulationOptions: {
        warmupHours: 6,
        sampleHours: 18,
        operatorInventory: mixedInventory,
      },
    })
    expect(calc.success).toBe(true)
    const unsupportedDiags = (calc.simulationReport?.diagnostics ?? []).filter(
      (d) => d.code === 'INVENTORY_SKILL_STAGE_UNSUPPORTED',
    )
    expect(unsupportedDiags).toEqual([])
  }, 60000)
})
