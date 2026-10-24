import { describe, expect, it } from 'vitest'
import { reactive, toRaw } from 'vue'
import { createDefaultWorkspace } from './defaults'
import { exportMowerJson, importMowerJson } from './compat/mowerJson'
import { addBackupGroup, backupGroupsForEditor, moveBackupGroup, removeBackupGroup, updateBackupGroup, normalizeBackupMembership } from './backupGroupHelpers'

describe('backup group editing preserves imported documents', () => {
  it('does not materialize defaults while reading an old plan', () => {
    const workspace = createDefaultWorkspace(), before = JSON.stringify(workspace)
    expect(backupGroupsForEditor(workspace)).toEqual([{ id: 'default', name: '默认分组', trigger: undefined }])
    expect(JSON.stringify(workspace)).toBe(before)
    removeBackupGroup(workspace, 'default')
    expect(JSON.stringify(workspace)).toBe(before)
  })

  it('keeps group and plan AST/extensions through renaming, ordering, deletion and JSON roundtrip', () => {
    const ast = { left: 'True', operator: 'and', right: 'False', extension: { untouched: [1, 2] } }
    const workspace = importMowerJson(JSON.stringify({ default: 'plan1', plan1: {}, backup_groups: [
      { id: 'a', name: 'A', trigger: ast, extra: { retained: true } },
      { id: 'b', name: 'B', trigger: 'True' },
    ], backup_plans: [
      { name: 'only A', group_ids: ['a'], trigger: ast, extra: 'keep' },
      { name: 'shared', group_ids: ['a', 'b'], type: 'exclusive', trigger: ast },
      { name: 'legacy', trigger: ast },
    ] }))
    updateBackupGroup(workspace, 'a', { name: '重命名' })
    moveBackupGroup(workspace, 'a', 1)
    expect(backupGroupsForEditor(workspace).map(group => group.id)).toEqual(['default', 'b', 'a'])
    const exported = JSON.parse(exportMowerJson(workspace))
    expect(exported.backup_groups[1]).toEqual({ id: 'a', name: '重命名', trigger: ast, extra: { retained: true } })
    removeBackupGroup(workspace, 'b')
    expect((workspace.compatibility.backupPlans[1] as { group_ids: string[] }).group_ids).toEqual(['a'])
    removeBackupGroup(workspace, 'a')
    const restored = importMowerJson(exportMowerJson(workspace))
    expect(restored.compatibility.backupPlans).toEqual([
      { name: 'only A', group_ids: ['default'], trigger: ast, extra: 'keep' },
      { name: 'shared', group_ids: ['default'], type: 'exclusive', trigger: ast },
      { name: 'legacy', trigger: ast },
    ])
  })

  it('keeps the default group protected and chooses unused IDs with inactive new conditions', () => {
    const workspace = createDefaultWorkspace()
    workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'group_1', name: 'Existing', trigger: 'True' }]
    expect(addBackupGroup(workspace)).toBe('group_2')
    expect(backupGroupsForEditor(workspace)[2]).toMatchObject({ id: 'group_2', trigger: 'False' })
    updateBackupGroup(workspace, 'default', { name: '兜底', trigger: 'False' })
    const before = JSON.stringify(workspace)
    moveBackupGroup(workspace, 'default', 1)
    removeBackupGroup(workspace, 'default')
    expect(JSON.stringify(workspace)).toBe(before)
    expect(backupGroupsForEditor(workspace)[0]).toEqual({ id: 'default', name: '兜底', trigger: undefined })
    expect(() => updateBackupGroup(workspace, 'group_1', { name: '  ' })).toThrow('分组名称不能为空')
  })

  it('does not replace malformed imported groups when attempting an edit', () => {
    const workspace = createDefaultWorkspace()
    workspace.compatibility.unrecognizedFields.backup_groups = { source: 'opaque' }
    expect(() => addBackupGroup(workspace)).toThrow('副表分组必须为列表')
    expect(workspace.compatibility.unrecognizedFields.backup_groups).toEqual({ source: 'opaque' })
  })

  it('keeps at least one membership and preserves explicit order', () => {
    expect(normalizeBackupMembership([])).toEqual(['default'])
    expect(normalizeBackupMembership(['b', 'a', 'b'])).toEqual(['b', 'a'])
  })

  it('keeps edited reactive documents cloneable for subsequent plan edits and worker requests', () => {
    const workspace = reactive(createDefaultWorkspace())
    const ast = { left: 'True', operator: 'and', right: 'False' }
    workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'a', name: 'A', trigger: ast, extra: { keep: true } }]
    workspace.compatibility.backupPlans = [{ name: 'plan', trigger: ast, group_ids: ['a'], extra: { keep: true } }]
    addBackupGroup(workspace)
    updateBackupGroup(workspace, 'a', { name: 'renamed' })
    moveBackupGroup(workspace, 'a', 1)
    expect(() => structuredClone(toRaw(workspace))).not.toThrow()
    removeBackupGroup(workspace, 'a')
    expect(() => structuredClone(toRaw(workspace))).not.toThrow()
    expect(structuredClone(toRaw(workspace.compatibility.backupPlans[0]))).toMatchObject({ group_ids: ['default'], trigger: ast, extra: { keep: true } })
  })
})
