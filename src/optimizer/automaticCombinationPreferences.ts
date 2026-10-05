import type { RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { ATOMIC_UNITS, type AtomicMember } from './riicAtomicUnits'
import { physicalBackupOperatorIds, type CombinationVariant, type RosterRole } from './combinationModel'

interface Preference { priority: number; optionalCount: number }
const ordinary: Preference = { priority: 0, optionalCount: 0 }
const preferred = ATOMIC_UNITS.filter(a => (a.allocationPriority ?? 0) > 0)

/** Positive means a is preferred. Efficiency breaks ties after this user policy. */
function compare(a: Preference, b: Preference): number {
  return a.priority - b.priority || a.optionalCount - b.optionalCount
}

function variantPreference(variant: CombinationVariant): Preference {
  const unit = preferred.find(a => a.id === variant.definitionId)
  return unit ? { priority: unit.allocationPriority!, optionalCount:
    (unit.preferredNonCoreMembers ?? []).filter(name => variant.optionalOperatorIds.includes(id(name))).length } : ordinary
}

export function compareVariantPreference(a: CombinationVariant, b: CombinationVariant): number {
  return compare(variantPreference(a), variantPreference(b))
}

/** Count a system only when its cores actually work in the same main/relief snapshot. */
function workspacePreference(workspace: RosterWorkspace): Preference {
  const permanent = new Set(workspace.mainPlan.conf.workaholic.map(id))
  const present = (member: AtomicMember, role: RosterRole) => Object.values(workspace.mainPlan.facilities).some(room =>
    room.level > 0 && room.type === (member.roomType === 'office' ? 'contact' : member.roomType) &&
    room.level >= (member.minLevel ?? 1) && (!member.product || room.product === member.product) && room.slots.some(slot => {
      const primary = slot.occupant.kind === 'operator' ? id(slot.occupant.operatorId) : undefined
      const actor = role === 'main' || room.type === 'dormitory' || primary && permanent.has(primary) ? primary : physicalBackupOperatorIds(room, slot)[0]
      return actor === id(member.name)
    }))
  let best = ordinary
  for (const unit of preferred) for (const role of ['main', 'backup'] as const) {
    if (!unit.coreMembers.every(member => present(member, role))) continue
    const value = { priority: unit.allocationPriority!, optionalCount:
      (unit.nonCoreMembers ?? []).filter(member => unit.preferredNonCoreMembers?.includes(member.name) && present(member, role)).length }
    if (compare(value, best) > 0) best = value
  }
  return best
}

export function compareWorkspacePreference(a: RosterWorkspace, b: RosterWorkspace): number {
  return compare(workspacePreference(a), workspacePreference(b))
}
