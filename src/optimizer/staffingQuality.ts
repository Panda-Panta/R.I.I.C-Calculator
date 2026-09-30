import { inventoryOperatorRecords } from '../domain/operatorContext'
import type { OperatorInventory } from '../domain/operatorInventory'
import type { AppConfig } from '../domain/types'
import { currentMoraleRates } from '../engine/morale'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { type MowerRoomId, type MowerSlot, type RosterWorkspace } from '../workbench/model'
import { projectControlOutput } from './controlImpact'
import { projectRosterConfig } from './rosterProjection'
import { isProductionSingletonCandidate, productionColleagueBonus, productionRoomId, singletonTheory } from './productionSingletons'

export interface StaffingPosition { roomId: MowerRoomId; slotIndex: number }
type Quality = { output: number; power: number; consumption: number }
type StaffingContext = { config: AppConfig; insertionIndex: number }
const facilitySkills: Record<string, string> = {
  manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', central: 'CONTROL',
  contact: 'HIRE', meeting: 'MEETING', factory: 'WORKSHOP', train: 'TRAINING',
}
const key = (roomId: string, index: number, slot: MowerSlot) => slot.groupId?.trim() || `${roomId}:${index}`
const ordinaryBackup = (slot: MowerSlot, roomType: string) => slot.replacements.map(resolveId).find(id => isOrdinaryReplacementCandidate(id, roomType))

/** Planning snapshots only. They rank proposals; completed simulations decide income gains. */
function assignmentContexts(workspace: RosterWorkspace, position: StaffingPosition, role: 'main' | 'backup', theoretical = false): StaffingContext[] {
  const room = workspace.mainPlan.facilities[position.roomId]
  const target = key(position.roomId, position.slotIndex, room.slots[position.slotIndex]!)
  const peers = [...new Set(room.slots.map((slot, index) => key(room.roomId, index, slot)))].filter(group => group !== target)
  const allGroups = Object.values(workspace.mainPlan.facilities).filter(r => r.type !== 'dormitory')
    .flatMap(r => r.slots.map((slot, index) => key(r.roomId, index, slot)))
  const scenarios: Set<string>[] = []
  // Enumerate local mixed shifts, plus all other groups resting for cross-room dependencies.
  const masks: number[] = []
  if (theoretical) {
    masks.push(0)
  } else if (peers.length <= 2) {
    for (let mask = 0; mask < 2 ** peers.length; mask++) masks.push(mask)
  } else {
    // For large rooms (like 5-slot central), test: all on-duty, each individual peer resting, and all peers resting
    masks.push(0)
    for (let i = 0; i < peers.length; i++) masks.push(1 << i)
    masks.push((1 << peers.length) - 1)
  }
  for (const mask of masks) {
    scenarios.push(new Set([...peers.filter((_, i) => mask & (1 << i)), ...(role === 'backup' ? [target] : [])]))
  }
  if (!theoretical) scenarios.push(new Set(allGroups.filter(group => role === 'backup' || group !== target)))
  const seen = new Set<string>()
  return scenarios.flatMap(resting => {
    const snapshot = structuredClone(workspace)
    for (const r of Object.values(snapshot.mainPlan.facilities)) {
      if (r.type === 'dormitory') continue
      r.slots.forEach((slot, index) => {
        if (slot.occupant.kind !== 'operator' || !resting.has(key(r.roomId, index, slot))) return
        const primary = resolveId(slot.occupant.operatorId)
        if (snapshot.mainPlan.conf.workaholic?.some(id => resolveId(id) === primary)) return
        const backup = ordinaryBackup(slot, r.type)
        // The entire group leaves together. A not-yet-assigned backup is an
        // empty planning seat, not permission to retain the outgoing main's skills.
        slot.occupant = backup ? { kind: 'operator', operatorId: backup } : { kind: 'empty' }
      })
    }
    // Candidate is inserted below. Removing this slot makes every candidate's marginal comparable.
    snapshot.mainPlan.facilities[position.roomId].slots[position.slotIndex]!.occupant = { kind: 'empty' }
    const occupants = Object.values(snapshot.mainPlan.facilities).flatMap(r => r.slots.flatMap(s => s.occupant.kind === 'operator' ? [resolveId(s.occupant.operatorId)] : []))
    if (new Set(occupants).size !== occupants.length) return []
    const fingerprint = JSON.stringify(Object.values(snapshot.mainPlan.facilities).map(r => r.slots.map(s => s.occupant)))
    if (seen.has(fingerprint)) return []
    seen.add(fingerprint)
    const insertionIndex = snapshot.mainPlan.facilities[position.roomId].slots.slice(0, position.slotIndex)
      .filter(slot => slot.occupant.kind === 'operator').length
    return [{ config: projectRosterConfig(snapshot), insertionIndex }]
  })
}

function insertOperator(config: AppConfig, workspace: RosterWorkspace, position: StaffingPosition, insertionIndex: number, id: string) {
  const type = workspace.mainPlan.facilities[position.roomId].type
  // The adapter preserves the fixed output-room order and names its rooms B101..B303.
  // Look up that ID, not the index in the filtered projection or the Mower room ID.
  if (['manufacture', 'trading', 'power'].includes(type)) {
    const room = config.rooms.find(r => r.id === productionRoomId(position.roomId))
    if (!room) throw new Error(`候选工位无法映射到计算设施：${position.roomId}`)
    room.operatorIds.splice(insertionIndex, 0, id)
    room.operatorCount = room.operatorIds.length
    if (room.type === 'power') room.powerStaffed = true
    return
  }
  if (type === 'central') { config.controlOperatorIds.splice(insertionIndex, 0, id); return }
  const auxiliary = { contact: 'office', meeting: 'reception', factory: 'workshop', train: 'training' } as const
  if (type in auxiliary) config.facilityOperatorIds[auxiliary[type as keyof typeof auxiliary]].splice(insertionIndex, 0, id)
  if (type === 'train') config.efficiencyResources.trainingOperatorIds = [...config.facilityOperatorIds.training]
}

function removeOperator(config: AppConfig, workspace: RosterWorkspace, position: StaffingPosition, insertionIndex: number, previousPowerStaffed = false) {
  const type = workspace.mainPlan.facilities[position.roomId].type
  if (['manufacture', 'trading', 'power'].includes(type)) {
    const room = config.rooms.find(r => r.id === productionRoomId(position.roomId))
    if (!room) return
    room.operatorIds.splice(insertionIndex, 1)
    room.operatorCount = room.operatorIds.length
    if (room.type === 'power') room.powerStaffed = previousPowerStaffed
    return
  }
  if (type === 'central') { config.controlOperatorIds.splice(insertionIndex, 1); return }
  const auxiliary = { contact: 'office', meeting: 'reception', factory: 'workshop', train: 'training' } as const
  if (type in auxiliary) config.facilityOperatorIds[auxiliary[type as keyof typeof auxiliary]].splice(insertionIndex, 1)
  if (type === 'train') config.efficiencyResources.trainingOperatorIds = [...config.facilityOperatorIds.training]
}

const qualityCache = new Map<string, Quality>()

function qualityKey(c: AppConfig): string {
  const { operatorRecords, ...configuration } = c
  const present = [...new Set([...c.controlOperatorIds, ...c.rooms.flatMap(r => r.operatorIds),
    ...Object.values(c.facilityOperatorIds).flat(2)])]
  // The same IDs can have different unlocked skills, room levels or products.
  // Include the planning configuration and only the records that can act in it.
  return JSON.stringify([configuration, present.map(id => [id, operatorRecords?.[id]?.skills.map(s => s.buffId)])])
}

function quality(config: AppConfig): Quality {
  const key = qualityKey(config)
  const cached = qualityCache.get(key)
  if (cached) return cached
  // A short relief shift cannot be assumed to have completed 5/10/12 hours of warm-up.
  const present = [...config.controlOperatorIds, ...config.rooms.flatMap(r => r.operatorIds)]
  const projection = projectControlOutput(config, { timeContext: { workHoursByOperator: new Map(present.map(id => [id, 0])) } })
  const consumption = Object.values(currentMoraleRates(config).rates).reduce((sum, rate) => sum + rate, 0)
  const result: Quality = { output: projection.daily.score, power: projection.powerBonusPercent, consumption }
  qualityCache.set(key, result)
  return result
}

export function clearQualityCache() {
  qualityCache.clear()
}

/** Actual conditional skills and global dependencies replace inventory-order backup selection. */
export function rankStaffingCandidates(
  workspace: RosterWorkspace, inventory: OperatorInventory, position: StaffingPosition,
  candidates: readonly string[], role: 'main' | 'backup',
  options: { completingReliefTeam?: boolean; allowNeutral?: boolean } = {},
): string[] {
  const type = workspace.mainPlan.facilities[position.roomId].type
  const production = type === 'manufacture' || type === 'trading'
  const records = inventoryOperatorRecords(inventory)
  const owned = new Set(inventory.operators.map(o => o.charId))
  const pool = [...new Set(candidates.map(resolveId))].filter(id => owned.has(id) &&
    (records[id]?.skills.some(s => s.roomType === facilitySkills[type]) || options.allowNeutral))
  if (!production && pool.length < 2) return pool
  const contexts = assignmentContexts(workspace, position, role, production || role === 'main')
  if (production) {
    // The first snapshot is the relevant main/relief team. Ordinary production
    // candidates are ordered by their own theoretical skill, not whole-base gain.
    const context = contexts[0]
    if (!context) return []
    const neutral = (id: string) => options.allowNeutral && !records[id]?.skills.some(s => s.roomType === facilitySkills[type])
    const cfg = context.config
    cfg.operatorRecords = records
    const targetRoom = cfg.rooms.find(r => r.id === productionRoomId(position.roomId))
    return pool.filter(id => isProductionSingletonCandidate(workspace, position.roomId, records[id]?.skills ?? []) || neutral(id)).flatMap(id => {
      insertOperator(cfg, workspace, position, context.insertionIndex, id)
      let efficiency = singletonTheory(cfg, position.roomId, id)
      // Initial matching constructs a complete relief team. Do not eliminate
      // count-based 吉星 just because her future colleagues are not assigned yet.
      // improveBackups re-evaluates the resulting team with actual occupants.
      const colleagueBonus = productionColleagueBonus(records[id]?.skills ?? [])
      if (role === 'backup' && options.completingReliefTeam && colleagueBonus > 0) {
        const room = targetRoom ?? cfg.rooms.find(r => r.id === productionRoomId(position.roomId))!
        const cleared = room.operatorIds.some(other => other !== id && records[other]?.skills.some(s => s.buffId === 'trade_ord_vodfox[000]'))
        if (!cleared) efficiency = Math.max(0, workspace.mainPlan.facilities[position.roomId].slots.filter(s => s.occupant.kind === 'operator').length - 1) * colleagueBonus
      }
      removeOperator(cfg, workspace, position, context.insertionIndex)
      return efficiency !== undefined && (efficiency > 0 || options.allowNeutral && efficiency === 0) ? [{ id, efficiency }] : []
    }).sort((a, b) => b.efficiency - a.efficiency).map(item => item.id)
  }
  if (!contexts.length) return pool
  contexts.forEach(({ config }) => { config.operatorRecords = records })
  const baselines = contexts.map(({ config }) => quality(config))
  const ranked = pool.map(id => {
    const deltas = contexts.map(({ config: contextCfg, insertionIndex }, index) => {
      const room = contextCfg.rooms.find(r => r.id === productionRoomId(position.roomId))
      const prevPower = room?.powerStaffed ?? false
      insertOperator(contextCfg, workspace, position, insertionIndex, id)
      const value = quality(contextCfg), baseline = baselines[index]!
      removeOperator(contextCfg, workspace, position, insertionIndex, prevPower)
      return { output: value.output - baseline.output, power: value.power - baseline.power, consumption: value.consumption - baseline.consumption }
    })
    return { id, worst: Math.min(...deltas.map(d => d.output)), mean: deltas.reduce((n, d) => n + d.output, 0) / deltas.length,
      power: deltas.reduce((n, d) => n + d.power, 0) / deltas.length, consumption: deltas.reduce((n, d) => n + d.consumption, 0) / deltas.length }
  })
  // Avoid gains that rely on another group always being on duty. Morale is a tie-break, not a made-up duty ratio.
  ranked.sort((a, b) => b.worst - a.worst || b.mean - a.mean || b.power - a.power || a.consumption - b.consumption)
  return ranked.map(r => r.id)
}
