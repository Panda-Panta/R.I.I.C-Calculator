import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as resolveId } from '../domain/operatorIdentifiers'
import { facilityCapacity } from '../domain/facilities'
import type { MowerFacilityType, MowerRoomId, RosterWorkspace } from '../domain/roster'
import { isWarmupSkill } from '../engine/timeDependentSkills'
import { isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'

const skillFacilities: Partial<Record<MowerFacilityType, string>> = {
  manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', central: 'CONTROL',
  meeting: 'MEETING', factory: 'WORKSHOP', contact: 'HIRE', train: 'TRAINING',
  dormitory: 'DORMITORY', recycle: 'RECYCLE',
}

/** Only this inventory's unlocked skills in the actual working facility count. */
export function isWarmupOperatorInFacility(operatorId: string, facilityType: MowerFacilityType, inventory: OperatorInventory): boolean {
  if (!inventory.valid) return false
  const id = resolveId(operatorId)
  const operator = inventory.operators.find(operator => operator.charId === id)
  return Boolean(operator?.skills.some(skill => skill.roomType === skillFacilities[facilityType] && isWarmupSkill(skill.buffId)))
}

export interface WarmupPolicyPosition {
  operatorId: string
  roomId: MowerRoomId
  slotIndex: number
}
export interface GeneratedWarmupPolicyResult {
  valid: boolean
  addedExhaustOperatorIds: string[]
  skippedPermanentOperatorIds: string[]
  unsupportedWarmupBackups: WarmupPolicyPosition[]
  unsupportedMultiGroupPrimaries: WarmupPolicyPosition[]
  diagnostics: { code: string; message: string; severity: 'error' | 'warning' }[]
}

/**
 * Opt an actual primary into native exhaustion without changing its physical group.
 * Group exhaustion uses the earliest mandatory member; it does not promise that
 * every peer reaches zero or that a low replacement can resist its primary's return.
 * Explicit workaholic policy is skipped. Current depletion is not an admission
 * condition: native scheduling rechecks rates as the working state changes.
 */
export function applyGeneratedWarmupPolicy(workspace: RosterWorkspace, inventory: OperatorInventory): GeneratedWarmupPolicyResult {
  const result: GeneratedWarmupPolicyResult = {
    valid: true, addedExhaustOperatorIds: [], skippedPermanentOperatorIds: [],
    unsupportedWarmupBackups: [], unsupportedMultiGroupPrimaries: [], diagnostics: [],
  }
  const reject = (code: string, message: string) => {
    result.valid = false
    result.diagnostics.push({ code, message, severity: 'error' })
  }
  if (!inventory.valid) {
    reject('WARMUP_INVALID_INVENTORY', '干员库无效，无法按实际解锁技能配置暖机耗尽策略。')
    return result
  }
  const positions = Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
    .flatMap(room => room.slots.slice(0, facilityCapacity(room.type, room.level)).map((slot, slotIndex) => ({ room, slot, slotIndex })))
  const primaries = new Set(positions.flatMap(({ slot }) => slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : []))
  const permanent = new Set(workspace.mainPlan.conf.workaholic.map(resolveId))
  const exhaust = new Set<string>()
  // Preserve the first spelling and every unrelated existing policy entry.
  const merged = workspace.mainPlan.conf.exhaust_require.filter(ref => {
    const id = resolveId(ref)
    if (exhaust.has(id)) return false
    exhaust.add(id)
    return true
  })
  for (const { room, slot, slotIndex } of positions) {
    if (room.type !== 'dormitory') {
      const refs = new Map<string, Array<string | null>>()
      for (const binding of [{ groupId: slot.groupId, replacements: slot.replacements }, ...(slot.groupBindings ?? [])]) {
        for (const ref of binding.replacements) {
          const operatorId = resolveId(ref)
          refs.set(operatorId, [...refs.get(operatorId) ?? [], binding.groupId?.trim() || null])
        }
      }
      for (const [operatorId, groups] of refs) {
        if (!isOrdinaryReplacementCandidate(operatorId, room.type) ||
          !isWarmupOperatorInFacility(operatorId, room.type, inventory)) continue
        if (primaries.has(operatorId)) {
          const primary = positions.find(position => position.slot.occupant.kind === 'operator' && resolveId(position.slot.occupant.operatorId) === operatorId)!
          const group = primary.slot.groupId?.trim()
          // A primary elsewhere is not automatically covered in this relief role.
          // Permit only a same-facility/group primary whose exhaustion we can apply.
          if (primary.room.type === room.type && group && groups.every(value => value === group) &&
            !primary.slot.groupBindings?.length && !permanent.has(operatorId) &&
            isWarmupOperatorInFacility(operatorId, primary.room.type, inventory)) continue
          result.unsupportedWarmupBackups.push({ operatorId, roomId: room.roomId, slotIndex })
          reject('UNSUPPORTED_WARMUP_PRIMARY_REPLACEMENT', `${room.roomId} 第 ${slotIndex + 1} 位的暖机替换引用 ${operatorId} 虽有主班身份，但其主位耗尽策略未覆盖此设施与绑定组，无法确认该替换角色满足暖机策略。`)
          continue
        }
        result.unsupportedWarmupBackups.push({ operatorId, roomId: room.roomId, slotIndex })
        reject('UNSUPPORTED_WARMUP_BACKUP', `${room.roomId} 第 ${slotIndex + 1} 位的暖机普通替班 ${operatorId} 会受原主班回岗回收，无法仅用耗尽策略保证完整工作时长。`)
      }
    }
    if (slot.occupant.kind !== 'operator') continue
    const operatorId = resolveId(slot.occupant.operatorId)
    if (!isWarmupOperatorInFacility(operatorId, room.type, inventory)) continue
    if (permanent.has(operatorId)) {
      result.skippedPermanentOperatorIds.push(operatorId)
      continue
    }
    // The compiler prepends the ordinary binding: one extra binding is multiGroup.
    if (slot.groupBindings?.length) {
      result.unsupportedMultiGroupPrimaries.push({ operatorId, roomId: room.roomId, slotIndex })
      reject('UNSUPPORTED_WARMUP_MULTI_GROUP', `${room.roomId} 第 ${slotIndex + 1} 位的暖机主班 ${operatorId} 有多个绑定组，现有耗尽策略不能约束其全部绑定组。`)
      continue
    }
    if (!exhaust.has(operatorId)) {
      exhaust.add(operatorId)
      merged.push(operatorId)
      result.addedExhaustOperatorIds.push(operatorId)
    }
  }
  workspace.mainPlan.conf.exhaust_require = merged
  const grouped = new Map<string, string[]>()
  for (const { room, slot } of positions) {
    if (room.type === 'dormitory' || slot.occupant.kind !== 'operator' || slot.groupBindings?.length || !slot.groupId?.trim()) continue
    const id = resolveId(slot.occupant.operatorId)
    if (!exhaust.has(id) || permanent.has(id)) continue
    const members = grouped.get(slot.groupId.trim()) ?? []
    members.push(id)
    grouped.set(slot.groupId.trim(), members)
  }
  for (const [group, members] of grouped) if (members.length > 1 && positions.some(({ room, slot }) =>
    slot.groupId?.trim() === group && slot.occupant.kind === 'operator' && members.includes(resolveId(slot.occupant.operatorId)) &&
    isWarmupOperatorInFacility(slot.occupant.operatorId, room.type, inventory))) {
    result.diagnostics.push({ code: 'WARMUP_GROUP_EARLIEST_EXHAUST', severity: 'warning',
      message: `换班组「${group}」保留整组耗尽策略，由最早需要耗尽休息的成员触发；不保证每位暖机成员都达到自身耗尽或暖机时长。` })
  }
  return result
}
