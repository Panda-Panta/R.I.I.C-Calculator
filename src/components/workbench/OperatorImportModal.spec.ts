/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import OperatorImportModal from './OperatorImportModal.vue'

describe('OperatorImportModal.vue', () => {
  const mounted: Array<{ unmount: () => void }> = []
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    mounted.splice(0).forEach(wrapper => wrapper.unmount())
  })

  function mountModal(props: Record<string, unknown> = {}) {
    const wrapper = mount(OperatorImportModal, {
      props: {
        open: true,
        ...props,
      },
      attachTo: document.body,
      global: {
        stubs: {
          teleport: true,
          Teleport: true,
        },
      },
    })
    mounted.push(wrapper)
    return wrapper
  }

  it('renders modal when open is true', () => {
    const wrapper = mountModal()
    expect(wrapper.find('.operator-import-modal').exists()).toBe(true)
    expect(wrapper.find('.file-dropzone').exists()).toBe(true)
    expect(wrapper.findAll('textarea')).toHaveLength(1)
    expect(wrapper.find('.n-tabs').exists()).toBe(false)
  })

  it('parses pasted MAA CSV text and emits imported on confirm', async () => {
    const wrapper = mountModal()
    const vm = wrapper.vm as any
    await wrapper.find('textarea').setValue('干员,ID,星级,精英化等级,等级,是否拥有,潜能\n能天使,char_103_angel,6,2,90,是,2\n耀骑士临光,char_1014_nearl2,6,0,0,否,0')

    expect(wrapper.find('.recognition-panel').exists()).toBe(true)
    expect(wrapper.find('.rec-stat').text()).toContain('已排除 1 名未持有干员')

    vm.handleImport()

    const emitted = wrapper.emitted('imported')
    expect(emitted).toBeDefined()
    expect(emitted![0]![0]).toEqual([{ operator: '能天使', elitePhase: 2, level: 90 }])
    expect(emitted![0]![1]).toBe('能天使,2,90')
  })

  it('uses the same paste area for 一图流 and replaces a previously selected file', async () => {
    const wrapper = mountModal()
    const vm = wrapper.vm as any
    await vm.processFile({
      name: 'Arknights_OperBox_Export.json',
      text: async () => '[{"name":"能天使","elite":2,"level":90,"own":true}]',
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.file-loaded-banner').text()).toContain('MAA')

    await wrapper.find('textarea').setValue('干员名称,是否已招募,星级,等级,精英化等级,潜能等级\n阿米娅,1,5,80,2,6\n能天使,0,6,0,0,0')
    expect(wrapper.find('.file-loaded-banner').exists()).toBe(false)
    expect(wrapper.find('.rec-tag').text()).toContain('一图流')
    expect(wrapper.find('.rec-stat').text()).toContain('已排除 1 名未持有干员')
    vm.handleImport()
    expect(wrapper.emitted('imported')?.[0]?.[0]).toEqual([{ operator: '阿米娅', elitePhase: 2, level: 80 }])
  })

  it('rejects unrelated pasted data and prevents import', async () => {
    const wrapper = mountModal()
    await wrapper.find('textarea').setValue('{"data":{"chars":[{"name":"能天使","level":90}]}}')
    expect(wrapper.find('.error-banner').text()).toContain('未识别为 MAA 或一图流')
    expect(wrapper.find('.recognition-panel').exists()).toBe(false)
    expect((wrapper.vm as any).currentSummary).toBeNull()
  })

  it('supports merge mode preserving previous localStorage operators', async () => {
    localStorage.setItem(
      'arcinc-operator-inventory-v1',
      JSON.stringify({
        schemaVersion: 1,
        text: '德克萨斯,2,80',
        enabled: true,
      })
    )

    const wrapper = mountModal()

    const vm = wrapper.vm as any
    vm.importMode = 'merge'
    await wrapper.find('textarea').setValue('干员,ID,星级,精英化等级,等级,是否拥有,潜能\n能天使,char_103_angel,6,2,90,是,2')

    vm.handleImport()

    const emitted = wrapper.emitted('imported')
    expect(emitted).toBeDefined()
    const importedEntries = emitted![0]![0] as any[]
    expect(importedEntries).toHaveLength(2)
    expect(importedEntries.some(e => e.operator === '德克萨斯')).toBe(true)
    expect(importedEntries.some(e => e.operator === '能天使')).toBe(true)
  })
})
