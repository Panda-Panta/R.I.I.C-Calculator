import type { RosterWorkspace } from './roster'

export interface MowerBackupGroupTask {
  group: string
  action: 'on' | 'off'
  mode: 'once' | 'while_active' | 'forced'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** These are shift bindings declared by slots, independent of backup table membership. */
export function declaredMowerGroups(workspace: RosterWorkspace): Set<string> {
  const groups = new Set<string>()
  const addGroup = (name: unknown) => {
    if (typeof name === 'string' && name) groups.add(name)
  }

  for (const facility of Object.values(workspace.mainPlan.facilities)) {
    for (const slot of facility.slots) {
      addGroup(slot.groupId)
      for (const binding of slot.groupBindings ?? []) addGroup(binding.groupId)
    }
  }

  for (const backup of workspace.compatibility.backupPlans) {
    if (!isRecord(backup) || !isRecord(backup.plan)) continue
    for (const room of Object.values(backup.plan)) {
      if (!isRecord(room) || !Array.isArray(room.plans)) continue
      for (const slot of room.plans) {
        if (!isRecord(slot)) continue
        addGroup(slot.group)
        if (!Array.isArray(slot.group_bindings)) continue
        for (const binding of slot.group_bindings) {
          if (isRecord(binding)) addGroup(binding.group)
        }
      }
    }
  }

  return groups
}

/** Parse the Mower GroupTask schema without rewriting the original backup document. */
export function readMowerBackupGroupTasks(value: unknown, groups?: ReadonlySet<string>): MowerBackupGroupTask[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('绑组任务必须为列表')

  const seen = new Set<string>()
  return value.map(row => {
    if (!isRecord(row)) throw new Error('绑组任务必须为对象')
    const { group, action = 'off', mode = 'once' } = row
    if (typeof group !== 'string' || !group || group !== group.trim()) throw new Error('绑组任务须填写有效组名')
    if (action !== 'on' && action !== 'off') throw new Error('绑组任务上下班类型无效')
    if (mode !== 'once' && mode !== 'while_active' && mode !== 'forced') throw new Error('绑组任务执行方式无效')
    if (action === 'on' && mode !== 'once') throw new Error('上班任务只执行一次，后续沿用正常轮换')
    if (seen.has(group)) throw new Error(`同一副表不能重复安排同一绑组：${group}`)
    if (groups && !groups.has(group)) throw new Error(`绑组任务组名不存在：${group}`)
    seen.add(group)
    return { group, action, mode }
  })
}
