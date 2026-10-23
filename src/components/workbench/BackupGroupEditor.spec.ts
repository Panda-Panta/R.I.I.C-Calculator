/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NPopconfirm } from 'naive-ui'
import BackupGroupEditor from './BackupGroupEditor.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'

const wrappers: VueWrapper[] = []
const render = () => { const wrapper = mount(BackupGroupEditor); wrappers.push(wrapper); return wrapper }
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

describe('backup group controls', () => {
  it('shows the implicit default without writing to a legacy document and adds inactive groups', async () => {
    const store = useRosterWorkbenchStore(), before = JSON.stringify(store.workspace)
    const wrapper = render()
    expect(wrapper.text()).toContain('一次只启用一个分组')
    expect(wrapper.find('[data-test="group-delete-default"]').exists()).toBe(false)
    expect(JSON.stringify(store.workspace)).toBe(before)
    await wrapper.get('[data-test="add-backup-group"]').trigger('click')
    expect(store.workspace.compatibility.unrecognizedFields.backup_groups).toEqual([{ id: 'group_1', name: '分组 1', trigger: 'False' }])
    expect(wrapper.get('[data-test="group-validation-group_1"]').text()).toBe('语法有效')
  })

  it('preserves imported AST while renaming and reordering, then edits only its chosen condition', async () => {
    const store = useRosterWorkbenchStore()
    const ast = { left: 'True', operator: 'and', right: 'False' }
    store.workspace.compatibility.unrecognizedFields.backup_groups = [
      { id: 'a', name: 'A', trigger: ast, extension: { keep: 1 } },
      { id: 'b', name: 'B', trigger: 'True' },
    ]
    const wrapper = render()
    await wrapper.get('[data-test="group-name-a"] input').setValue('改名')
    await wrapper.get('[data-test="group-name-a"] input').trigger('blur')
    await wrapper.get('[data-test="group-down-a"]').trigger('click')
    const groups = store.workspace.compatibility.unrecognizedFields.backup_groups as Record<string, unknown>[]
    expect(groups.map(group => group.id)).toEqual(['b', 'a'])
    expect(groups[1]).toEqual({ id: 'a', name: '改名', trigger: ast, extension: { keep: 1 } })
    const input = wrapper.get('[data-test="group-trigger-a"] textarea')
    await input.setValue('True and ')
    expect((input.element as HTMLTextAreaElement).value).toBe('True and ')
    expect(wrapper.get('[data-test="group-validation-a"]').text()).toContain('语法错误')
    await input.setValue('True and False')
    expect(wrapper.get('[data-test="group-validation-a"]').text()).toBe('语法有效')
    expect((store.workspace.compatibility.unrecognizedFields.backup_groups as Record<string, unknown>[])[1]).toEqual({ id: 'a', name: '改名', trigger: 'True and False', extension: { keep: 1 } })
  })

  it('repairs removed memberships after confirmation without changing legacy plans', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'a', name: 'A', trigger: 'False' }]
    store.workspace.compatibility.backupPlans = [
      { name: 'sole', group_ids: ['a'], trigger: 'True', extra: 1 },
      { name: 'shared', group_ids: ['a', 'default'], trigger: 'False' },
      { name: 'legacy', trigger: 'True' },
    ]
    const wrapper = render()
    expect(wrapper.find('[data-test="group-delete-a"]').exists()).toBe(true)
    wrapper.getComponent(NPopconfirm).vm.$emit('positive-click')
    await wrapper.vm.$nextTick()
    expect(store.workspace.compatibility.backupPlans).toEqual([
      { name: 'sole', group_ids: ['default'], trigger: 'True', extra: 1 },
      { name: 'shared', group_ids: ['default'], trigger: 'False' },
      { name: 'legacy', trigger: 'True' },
    ])
    expect(wrapper.find('[data-test="backup-group-a"]').exists()).toBe(false)
  })

  it('retains the valid stored name while displaying an empty draft error', async () => {
    const store = useRosterWorkbenchStore()
    store.workspace.compatibility.unrecognizedFields.backup_groups = [{ id: 'a', name: 'A', trigger: 'False' }]
    const wrapper = render()
    await wrapper.get('[data-test="group-name-a"] input').setValue('')
    await wrapper.get('[data-test="group-name-a"] input').trigger('blur')
    expect(wrapper.text()).toContain('分组名称不能为空')
    expect(store.workspace.compatibility.unrecognizedFields.backup_groups).toEqual([{ id: 'a', name: 'A', trigger: 'False' }])
  })
})
