import { resolveOperatorCharId, restoreOperatorMowerName } from '../domain/operatorIdentifiers'
import { MOWER_OPERATOR_LIST_FIELDS, type MowerCompatibilityEnvelope, type MowerMainPlan, type MowerRoomId, type RosterWorkspace } from '../domain/roster'

export interface OperatorReplacementLocation {
  kind: 'main' | 'replacement' | 'conf' | 'additional'
  label: string
  roomId?: MowerRoomId
  slotIndex?: number
}
type Visitor = (location: OperatorReplacementLocation, apply: (replacementId: string) => void) => void
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The supported reference traversal is shared by the preview and the mutation. */
function visitReferences(mainPlan: MowerMainPlan, sourceId: string, compatibility: MowerCompatibilityEnvelope | undefined, visit: Visitor): void {
  if (!sourceId) return
  const source = resolveOperatorCharId(sourceId)
  function local(value: string, write: (next: string) => void, location: OperatorReplacementLocation): void {
    if (value === sourceId) visit(location, replacement => write(replacement))
  }
  function native(value: unknown, write: (next: string) => void, location: OperatorReplacementLocation): void {
    if (typeof value !== 'string') return
    const suffix = value.indexOf('(')
    const name = suffix < 0 ? value : value.slice(0, suffix)
    if (resolveOperatorCharId(name.trim()) !== source) return
    visit(location, replacement => {
      const nextName = name.trim().startsWith('char_') ? replacement : restoreOperatorMowerName(replacement)
      write((name.match(/^\s*/)?.[0] ?? '') + nextName + (name.match(/\s*$/)?.[0] ?? '') + (suffix < 0 ? '' : value.slice(suffix)))
    })
  }
  function list(value: unknown, write: (next: unknown) => void, location: OperatorReplacementLocation): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => native(entry, next => { value[index] = next }, { ...location, label: location.kind === 'conf' ? location.label : `${location.label} [${index + 1}]` }))
    } else if (typeof value === 'string') {
      // Retain separators and surrounding whitespace in native list strings.
      const parts = value.split(/([,，])/)
      parts.forEach((entry, index) => {
        if (index % 2 === 0) native(entry, next => { parts[index] = next; write(parts.join('')) }, { ...location, label: location.kind === 'conf' ? location.label : `${location.label} [${index / 2 + 1}]` })
      })
    }
  }
  function conf(value: Record<string, unknown>, label: string, main = false): void {
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
      list(value[field], next => { value[field] = next }, { kind: main ? 'conf' : 'additional', label: main ? field : `${label} · ${field}` })
    }
    const removed = value.removed_operators
    if (record(removed)) for (const field of MOWER_OPERATOR_LIST_FIELDS) {
      list(removed[field], next => { removed[field] = next }, { kind: 'additional', label: `${label} · removed_operators.${field}` })
    }
    if (record(value.operator_mood_limits)) {
      const entries = Object.entries(value.operator_mood_limits)
      entries.forEach(([name], index) => native(name, next => {
        entries[index]![0] = next
        value.operator_mood_limits = Object.fromEntries(entries)
      }, { kind: 'additional', label: `${label} · operator_mood_limits.${name}` }))
    }
  }

  for (const [roomId, facility] of Object.entries(mainPlan.facilities) as [MowerRoomId, MowerMainPlan['facilities'][MowerRoomId]][]) {
    facility.slots.forEach((slot, slotIndex) => {
      const position = { roomId, slotIndex }
      const occupant = slot.occupant
      if (occupant.kind === 'operator') local(occupant.operatorId, next => { occupant.operatorId = next }, { kind: 'main', label: roomId, ...position })
      slot.replacements.forEach((value, index) => local(value, next => { slot.replacements[index] = next }, { kind: 'replacement', label: roomId, ...position }))
      slot.groupBindings?.forEach((binding, bindingIndex) => binding.replacements.forEach((value, index) => local(value, next => { binding.replacements[index] = next }, {
        kind: 'additional', label: `${roomId} 第${slotIndex + 1}位 · 关联组 ${binding.groupId ?? bindingIndex + 2} 替班 [${index + 1}]`, ...position,
      })))
    })
  }
  conf(mainPlan.conf, '主表', true)
  const advanced = compatibility?.unrecognizedFields.advanced_settings
  if (record(advanced)) {
    if (Array.isArray(advanced.dorm_isolation)) advanced.dorm_isolation.forEach((group, index) => {
      if (Array.isArray(group)) list(group, () => {}, { kind: 'additional', label: `宿舍隔离 dorm_isolation [${index + 1}]` })
    })
    list(advanced.favorite, next => { advanced.favorite = next }, { kind: 'additional', label: '特别关注干员 favorite' })
  }
  compatibility?.backupPlans.forEach((backup, backupIndex) => {
    if (!record(backup)) return
    const label = `副表 ${typeof backup.name === 'string' && backup.name ? backup.name : `#${backupIndex + 1}`}`
    if (record(backup.conf)) conf(backup.conf, label)
    if (record(backup.task)) for (const [room, value] of Object.entries(backup.task)) {
      const tasks = backup.task
      list(value, next => { tasks[room] = next }, { kind: 'additional', label: `${label} · task.${room}` })
    }
    if (!record(backup.plan)) return
    for (const [room, facility] of Object.entries(backup.plan)) {
      if (!record(facility) || !Array.isArray(facility.plans)) continue
      facility.plans.forEach((slot: unknown, slotIndex: number) => {
        if (!record(slot)) return
        const prefix = `${label} · plan.${room} 第${slotIndex + 1}位`
        native(slot.agent, next => { slot.agent = next }, { kind: 'additional', label: `${prefix} 主班` })
        list(slot.replacement, next => { slot.replacement = next }, { kind: 'additional', label: `${prefix} 替班` })
        if (Array.isArray(slot.group_bindings)) slot.group_bindings.forEach((binding, index) => {
          if (record(binding)) list(binding.replacement, next => { binding.replacement = next }, { kind: 'additional', label: `${prefix} 关联组 ${index + 2} 替班` })
        })
      })
    }
  })
}

export function operatorReplacementLocations(mainPlan: MowerMainPlan, sourceId: string, compatibility?: MowerCompatibilityEnvelope): OperatorReplacementLocation[] {
  const locations: OperatorReplacementLocation[] = []
  visitReferences(mainPlan, sourceId, compatibility, location => { locations.push(location) })
  return locations
}

export function replaceWorkspaceOperator(workspace: RosterWorkspace, sourceId: string, replacementId: string): Set<MowerRoomId> {
  const changedRooms = new Set<MowerRoomId>()
  if (!sourceId || !replacementId || sourceId === replacementId) return changedRooms
  visitReferences(workspace.mainPlan, sourceId, workspace.compatibility, (location, apply) => {
    apply(replacementId)
    if (location.roomId) changedRooms.add(location.roomId)
  })
  return changedRooms
}
