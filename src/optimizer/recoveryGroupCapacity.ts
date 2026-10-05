import type { RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'

/** A whole shift must fit even when every usable recovery bed is vacant. */
export function recoveryGroupCapacityIssues(workspace: RosterWorkspace, preparingDorms = false): { code: string; message: string }[] {
  const conf = workspace.mainPlan.conf
  const permanent = new Set(conf.workaholic.map(id))
  const standby = new Set(Array.isArray(conf.resting_standby) ? conf.resting_standby.map(id) : [])
  const mandatory = new Set([...conf.exhaust_require, ...conf.rest_in_full].map(id))
  const groups = new Map<string, number>()
  let beds = 0
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.level <= 0) continue
    if (room.type === 'dormitory') {
      let free = 0, resident = false
      for (const slot of room.slots) {
        resident ||= slot.occupant.kind === 'operator'
        if (slot.occupant.kind === 'free' || preparingDorms && slot.occupant.kind === 'empty' ||
          slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) !== id('菲亚梅塔') && slot.groupId && slot.replacements.includes('Free')) free++
      }
      // finishSkeleton keeps each built dorm identifiable with at least one resident.
      beds += Math.max(0, free - (preparingDorms && !resident ? 1 : 0))
      continue
    }
    for (const slot of room.slots) {
      if (slot.occupant.kind !== 'operator' || !slot.groupId?.trim()) continue
      const operator = id(slot.occupant.operatorId)
      if (permanent.has(operator) || standby.has(operator) && !mandatory.has(operator)) continue
      const group = slot.groupId.trim()
      groups.set(group, (groups.get(group) ?? 0) + 1)
    }
  }
  return [...groups].filter(([, size]) => size > beds).map(([group, size]) => ({
    code: 'RECOVERY_GROUP_CAPACITY',
    message: `换班组「${group}」需要 ${size} 个恢复床位，当前最多 ${beds} 个；无法执行整组休息。`,
  }))
}
