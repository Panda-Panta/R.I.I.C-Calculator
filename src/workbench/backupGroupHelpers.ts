import type { RosterWorkspace } from '../domain/roster'
import { readBackupGroups, type BackupGroup } from '../scheduler/backupGroups'

type GroupDocument = BackupGroup & Record<string, unknown>
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Reading a legacy plan must not materialize its implicit default group. */
export function backupGroupsForEditor(workspace: RosterWorkspace): BackupGroup[] {
  const groups = readBackupGroups(workspace)
  return [...groups.filter(group => group.id === 'default'), ...groups.filter(group => group.id !== 'default')]
}

function groupDocuments(workspace: RosterWorkspace): GroupDocument[] {
  readBackupGroups(workspace)
  return (workspace.compatibility.unrecognizedFields.backup_groups ?? []) as GroupDocument[]
}

export function addBackupGroup(workspace: RosterWorkspace): string {
  const documents = groupDocuments(workspace)
  const ids = new Set(documents.map(group => group.id))
  let index = 1
  while (ids.has(`group_${index}`)) index++
  const id = `group_${index}`
  documents.push({ id, name: `分组 ${index}`, trigger: 'False' })
  workspace.compatibility.unrecognizedFields.backup_groups ??= documents
  return id
}

/** Patch only the explicitly edited field; preserve imported AST and extensions. */
export function updateBackupGroup(workspace: RosterWorkspace, id: string, patch: { name?: string; trigger?: string }): void {
  const documents = groupDocuments(workspace)
  const index = documents.findIndex(group => group.id === id)
  if (index < 0 && id !== 'default') return
  const name = patch.name?.trim()
  if (name !== undefined && !name) throw new Error('分组名称不能为空')
  const changes: Record<string, unknown> = {}
  if (name !== undefined) changes.name = name
  if (id !== 'default' && patch.trigger !== undefined) changes.trigger = patch.trigger
  if (!Object.keys(changes).length) return
  if (index < 0) documents.unshift({ id: 'default', name: name!, trigger: undefined })
  else Object.assign(documents[index]!, changes)
  workspace.compatibility.unrecognizedFields.backup_groups ??= documents
}

export function moveBackupGroup(workspace: RosterWorkspace, id: string, direction: -1 | 1): void {
  if (id === 'default') return
  const documents = groupDocuments(workspace)
  const custom = documents.filter(group => group.id !== 'default')
  const index = custom.findIndex(group => group.id === id)
  const target = custom[index + direction]
  if (index < 0 || !target) return
  const from = documents.findIndex(group => group.id === id), to = documents.findIndex(group => group.id === target.id)
  documents.splice(to, 0, documents.splice(from, 1)[0]!)
}

/** Only plans referring to the removed group change; remaining memberships keep their order. */
export function removeBackupGroup(workspace: RosterWorkspace, id: string): void {
  if (id === 'default') return
  const documents = groupDocuments(workspace)
  if (!documents.some(group => group.id === id)) return
  documents.splice(documents.findIndex(group => group.id === id), 1)
  for (const plan of workspace.compatibility.backupPlans) {
    if (!isRecord(plan) || !Array.isArray(plan.group_ids) || !plan.group_ids.includes(id)) continue
    const remaining = plan.group_ids.filter(groupId => groupId !== id)
    plan.group_ids = remaining.length ? remaining : ['default']
  }
}

export function backupPlanMembership(groupIds: readonly string[] | undefined): string[] {
  return groupIds ? [...groupIds] : ['default']
}

export function normalizeBackupMembership(groupIds: readonly string[]): string[] {
  return groupIds.length ? [...new Set(groupIds)] : ['default']
}
