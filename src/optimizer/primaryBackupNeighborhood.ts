import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { OPERATOR_MAP } from '../domain/operators'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import type { MowerRoomId, MowerSlot, RosterWorkspace } from '../workbench/model'
import { validatePhysicalRoster } from './rosterDraft'
import { applySingletonWorkPolicy } from './productionSingletons'

export interface PrimaryBackupNeighbor {
  workspace: RosterWorkspace
  label: string
  move: { kind: 'primary-backup'; positions: string[] }
}

/** Reverse complete ordinary shifts; leave named policies and virtual runners attached to their owners. */
export function generatePrimaryBackupNeighbors(workspace: RosterWorkspace, entries: OwnedOperatorInput[], limit = 20,
  options: { lockedPositions?: readonly string[]; protectedIds?: string[]; includeControl?: boolean; includeProduction?: boolean } = {},
): PrimaryBackupNeighbor[] {
  const inventory = compileOperatorInventory(entries)
  if (!inventory.valid || !Number.isSafeInteger(limit) || limit < 0 || limit > 21) throw new Error('无效的主替互换参数')
  if (!limit || workspace.compatibility.backupPlans.length) return []
  const locked = new Set((options.lockedPositions ?? []).map(key => key.replace(/:(\d+)$/, '_$1')))
  const protectedIds = new Set<string>()
  const protect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const token of [value, ...value.split(/[,，;；\s"'()[\]{}:=<>!&|]+/)]) {
        const id = resolveId(token.trim())
        if (OPERATOR_MAP.has(id)) protectedIds.add(id)
      }
    } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { protect(key); protect(child) }
  }
  protect(options.protectedIds)
  protect(workspace.mainPlan.conf)
  protect(workspace.compatibility)
  type Position = { roomId: MowerRoomId; index: number; slot: MowerSlot }
  const groups = new Map<string, Position[]>()
  const types: Record<string, string> = { manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', central: 'CONTROL', contact: 'HIRE', meeting: 'MEETING', factory: 'WORKSHOP', train: 'TRAINING' }
  for (const room of Object.values(workspace.mainPlan.facilities)) for (const [index, slot] of room.slots.entries()) {
    protect(slot.metadata)
    if (slot.occupant.kind === 'operator' && OPERATOR_MAP.get(resolveId(slot.occupant.operatorId))?.name === '菲亚梅塔') protect(slot.replacements)
    if (slot.metadata && Object.keys(slot.metadata).length && slot.occupant.kind === 'operator') protectedIds.add(resolveId(slot.occupant.operatorId))
    if (!(room.type in types) || slot.occupant.kind !== 'operator') continue
    const group = slot.groupId?.trim() || `${room.roomId}:${index}`
    groups.set(group, [...(groups.get(group) ?? []), { roomId: room.roomId, index, slot }])
  }
  const owned = new Map(inventory.operators.map(o => [o.charId, o]))
  const results: PrimaryBackupNeighbor[] = []
  for (const [group, positions] of groups) {
    if (positions.some(p => locked.has(`${p.roomId}_${p.index}`))) continue
    if (positions.some(p => {
      const type = workspace.mainPlan.facilities[p.roomId].type
      return type === 'central' ? options.includeControl === false :
        ['manufacture', 'trading', 'power'].includes(type) ? options.includeProduction === false : true
    })) continue
    const edits = positions.flatMap(p => {
      if (p.slot.occupant.kind !== 'operator') return []
      const main = resolveId(p.slot.occupant.operatorId)
      const room = workspace.mainPlan.facilities[p.roomId]
      const backups = p.slot.replacements.map((value, index) => ({ id: resolveId(value), index })).filter(b => isOrdinaryReplacementCandidate(b.id, room.type))
      if (backups.length !== 1 || isShiftRunOperator(main) || protectedIds.has(main) || protectedIds.has(backups[0]!.id)) return []
      const backup = backups[0]!
      if (![main, backup.id].every(id => owned.get(id)?.matchesMaximumSkills && owned.get(id)?.skills.some(s => s.roomType === types[room.type]))) return []
      return [{ ...p, main, backup }]
    })
    if (edits.length !== positions.length) continue
    const copy = structuredClone(workspace)
    for (const p of edits) {
      const slot = copy.mainPlan.facilities[p.roomId].slots[p.index]!
      slot.occupant = { kind: 'operator', operatorId: p.backup.id }
      slot.replacements[p.backup.index] = p.main
      applySingletonWorkPolicy(copy, p.roomId, p.index)
    }
    if (validatePhysicalRoster(copy).length) continue
    results.push({ workspace: copy, label: `${group}：整组主替互换`, move: { kind: 'primary-backup', positions: edits.map(p => `${p.roomId}_${p.index}`) } })
    if (results.length === limit) break
  }
  return results
}
