/**
 * @vitest-environment jsdom
 *
 * Derivative work based on arknights-mower (Plan.vue / PlanEditor.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GlobalReplaceModal from './GlobalReplaceModal.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'

describe('GlobalReplaceModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function mountModal(props: Record<string, unknown> = {}) {
    return mount(GlobalReplaceModal, {
      props: {
        visible: true,
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
  }

  it('previews changes in additional bindings, native backup tasks, mood limits and advanced settings before applying them', async () => {
    const store = useRosterWorkbenchStore()
    store.updateSlot('room_1_1', 0, { occupant: { kind: 'operator', operatorId: 'char_002_amiya' }, groupId: 'A', replacements: [],
      groupBindings: [{ groupId: 'B', replacements: ['char_002_amiya'], metadata: { keep: 1 } }] })
    store.workspace.mainPlan.conf.operator_mood_limits = { 阿米娅: { lower: 1, upper: 20 } }
    store.workspace.compatibility.backupPlans = [{ name: 'native backup', trigger: 'True', task: { dormitory_1: ['阿米娅', 'Current'] }, extension: { keep: '阿米娅' } }]
    store.workspace.compatibility.unrecognizedFields.advanced_settings = { favorite: '阿米娅', extension: { keep: '阿米娅' } }
    const wrapper = mountModal()
    await wrapper.get('[data-test="source-select"]').setValue('char_002_amiya')
    await wrapper.get('[data-test="target-select"]').setValue('char_102_texas')
    expect(wrapper.get('[data-test="impact-total-count"]').text()).toContain('5')
    expect(wrapper.get('[data-test="impact-extra-list"]').text()).toContain('native backup')
    expect(wrapper.get('[data-test="impact-extra-list"]').text()).toContain('operator_mood_limits')
    expect(wrapper.get('[data-test="impact-extra-list"]').text()).toContain('favorite')
    await wrapper.get('[data-test="confirm-btn"]').trigger('click')
    expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupBindings).toEqual([{ groupId: 'B', replacements: ['char_102_texas'], metadata: { keep: 1 } }])
    expect(store.workspace.mainPlan.conf.operator_mood_limits).toEqual({ 德克萨斯: { lower: 1, upper: 20 } })
    expect(store.workspace.compatibility.backupPlans[0]).toMatchObject({ task: { dormitory_1: ['德克萨斯', 'Current'] }, extension: { keep: '阿米娅' } })
    expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toEqual({ favorite: '德克萨斯', extension: { keep: '阿米娅' } })
    expect((wrapper.emitted('replaced')?.[0]?.[0] as { impact: { totalCount: number } }).impact.totalCount).toBe(5)
    wrapper.unmount()
  })

  describe('Modal Rendering and Title', () => {
    it('renders Naive card modal titled 一键替换干员 when visible or open is true', () => {
      const wrapper = mountModal({ visible: true })
      expect(wrapper.text()).toContain('一键替换干员')
      expect(wrapper.find('.mower-global-replace-modal').exists()).toBe(true)
      expect(wrapper.find('[data-test="source-select"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="target-select"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="target-search-input"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="confirm-btn"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="cancel-btn"]').exists()).toBe(true)
    })

    it('supports open prop in addition to visible prop', () => {
      const wrapper = mountModal({ open: true, visible: undefined })
      expect(wrapper.text()).toContain('一键替换干员')
      expect(wrapper.find('[data-test="source-select"]').exists()).toBe(true)
    })
  })

  describe('Source Filtering (only main primary slot assigned operators)', () => {
    it('filters source choices to only operators currently assigned in main primary slots', () => {
      const store = useRosterWorkbenchStore()

      // Primary slots assignment:
      // room_1_1 slot 0: operator Amiya
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }
      // room_1_1 slot 1: free
      store.workspace.mainPlan.facilities.room_1_1.slots[1] = {
        occupant: { kind: 'free' },
        groupId: null,
        replacements: [],
      }
      // room_1_1 slot 2: current
      store.workspace.mainPlan.facilities.room_1_1.slots[2] = {
        occupant: { kind: 'current' },
        groupId: null,
        replacements: [],
      }
      // room_1_2 slot 0: empty
      store.workspace.mainPlan.facilities.room_1_2.slots[0] = {
        occupant: { kind: 'empty' },
        groupId: null,
        replacements: [],
      }
      // room_1_2 slot 1: operator Free pseudo-id
      store.workspace.mainPlan.facilities.room_1_2.slots[1] = {
        occupant: { kind: 'operator', operatorId: 'Free' },
        groupId: null,
        replacements: [],
      }
      // room_1_2 slot 2: operator Current pseudo-id
      store.workspace.mainPlan.facilities.room_1_2.slots[2] = {
        occupant: { kind: 'operator', operatorId: 'Current' },
        groupId: null,
        replacements: [],
      }
      // room_2_1 slot 0: Texas, with Angel in replacements
      store.workspace.mainPlan.facilities.room_2_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_102_texas' },
        groupId: null,
        replacements: ['char_103_angel'],
      }
      // Conf policy list with SilverAsh (not in primary slot)
      store.workspace.mainPlan.conf.workaholic = ['char_172_svrash']

      const wrapper = mountModal()

      const sourceSelect = wrapper.find<HTMLSelectElement>('[data-test="source-select"]')
      const options = sourceSelect.findAll('option')
      const optionValues = options.map((opt) => opt.element.value).filter(Boolean)

      // Only Amiya and Texas should be in the source options!
      expect(optionValues).toContain('char_002_amiya')
      expect(optionValues).toContain('char_102_texas')

      // Must NOT contain Free, Current, empty
      expect(optionValues).not.toContain('Free')
      expect(optionValues).not.toContain('free')
      expect(optionValues).not.toContain('Current')
      expect(optionValues).not.toContain('current')
      expect(optionValues).not.toContain('empty')

      // Must NOT contain Angel (only in replacement list, not primary slot)
      expect(optionValues).not.toContain('char_103_angel')

      // Must NOT contain SilverAsh (only in conf list, not primary slot)
      expect(optionValues).not.toContain('char_172_svrash')

      // Must NOT contain unassigned game operators (e.g. Kal'tsit)
      expect(optionValues).not.toContain('char_003_kalts')
    })

    it('shows empty hint when no operators are assigned to primary slots', () => {
      const store = useRosterWorkbenchStore()
      store.resetWorkspace()

      const wrapper = mountModal()
      expect(wrapper.find('[data-test="no-source-operators"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('当前排班中没有配置任何主力干员')
    })
  })

  describe('Target Operator Search (Chinese / Full Pinyin / Initials / English)', () => {
    it('searches target operators by Chinese character name', async () => {
      const wrapper = mountModal()
      const searchInput = wrapper.find('[data-test="target-search-input"]')

      await searchInput.setValue('银灰')

      const items = wrapper.findAll('.target-item')
      expect(items.length).toBeGreaterThan(0)
      const names = items.map((i) => i.attributes('data-op-name'))
      expect(names).toContain('银灰')
      expect(wrapper.find('.target-item[data-op-id="char_172_svrash"]').exists()).toBe(true)
    })

    it('searches target operators by full pinyin (e.g. yinhui / texas)', async () => {
      const wrapper = mountModal()
      const searchInput = wrapper.find('[data-test="target-search-input"]')

      await searchInput.setValue('yinhui')
      let names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('银灰')

      await searchInput.setValue('texas')
      names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('德克萨斯')
    })

    it('searches target operators by pinyin initials (e.g. yh / dks)', async () => {
      const wrapper = mountModal()
      const searchInput = wrapper.find('[data-test="target-search-input"]')

      await searchInput.setValue('yh')
      let names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('银灰')

      await searchInput.setValue('dks')
      names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('德克萨斯')
    })

    it('searches target operators by English appellation (e.g. SilverAsh / Texas)', async () => {
      const wrapper = mountModal()
      const searchInput = wrapper.find('[data-test="target-search-input"]')

      await searchInput.setValue('SilverAsh')
      let names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('银灰')

      await searchInput.setValue('Texas')
      names = wrapper.findAll('.target-item').map((i) => i.attributes('data-op-name'))
      expect(names).toContain('德克萨斯')
    })

    it('allows selecting target operator by clicking search result card', async () => {
      const wrapper = mountModal()
      const searchInput = wrapper.find('[data-test="target-search-input"]')
      await searchInput.setValue('德克萨斯')

      const texasItem = wrapper.find('.target-item[data-op-id="char_102_texas"]')
      expect(texasItem.exists()).toBe(true)
      await texasItem.trigger('click')

      // Selected card gets is-selected class and checkmark
      expect(texasItem.classes()).toContain('is-selected')
      expect(texasItem.find('.selected-badge').text()).toBe('✓')

      // Target select value is in sync
      const targetSelect = wrapper.find<HTMLSelectElement>('[data-test="target-select"]')
      expect(targetSelect.element.value).toBe('char_102_texas')

      // Explicit target display is updated
      const targetDisplay = wrapper.find('[data-test="target-display"]')
      expect(targetDisplay.text()).toContain('德克萨斯')
    })
  })

  describe('Impact Summary and Explicit Source ➔ Target Display', () => {
    it('computes exact impact counts across main slots, replacement entries, and conf policies', async () => {
      const store = useRosterWorkbenchStore()

      // Primary slots (2 locations)
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }
      store.workspace.mainPlan.facilities.room_2_1.slots[1] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }

      // Replacements (1 location)
      store.workspace.mainPlan.facilities.room_3_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_102_texas' },
        groupId: null,
        replacements: ['char_002_amiya'],
      }

      // Conf policy lists (2 locations)
      store.workspace.mainPlan.conf.exhaust_require = ['char_002_amiya']
      store.workspace.mainPlan.conf.resting_priority = ['char_002_amiya']

      const wrapper = mountModal()

      // Before source selection, shows prompt
      expect(wrapper.find('[data-test="prompt-missing-choice"]').exists()).toBe(true)

      // Select source operator
      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')

      // Verify explicit source ➔ target visual comparison
      const sourceDisplay = wrapper.find('[data-test="source-display"]')
      expect(sourceDisplay.text()).toContain('阿米娅')
      expect(wrapper.find('[data-test="replacement-arrow"]').exists()).toBe(true)

      // Impact summary container
      expect(wrapper.find('[data-test="impact-summary"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="impact-total-count"]').text()).toContain('5')
      expect(wrapper.find('[data-test="impact-main-count"]').text()).toContain('2')
      expect(wrapper.find('[data-test="impact-replacement-count"]').text()).toContain('1')
      expect(wrapper.find('[data-test="impact-conf-count"]').text()).toContain('2')

      // Impact lists content
      const mainList = wrapper.find('[data-test="impact-main-list"]')
      expect(mainList.text()).toContain('B101')
      expect(mainList.text()).toContain('B201')

      const repList = wrapper.find('[data-test="impact-replacement-list"]')
      expect(repList.text()).toContain('B301')

      const confList = wrapper.find('[data-test="impact-conf-list"]')
      expect(confList.text()).toContain('exhaust_require')
      expect(confList.text()).toContain('resting_priority')
    })
  })

  describe('Validation and Disabled Confirm', () => {
    it('disables confirm button when source or target is missing', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }

      const replaceSpy = vi.spyOn(store, 'replaceOperatorGlobally')
      const wrapper = mountModal()

      const confirmBtn = wrapper.find('[data-test="confirm-btn"]')

      // Neither selected
      expect(confirmBtn.attributes('disabled')).toBeDefined()
      await confirmBtn.trigger('click')
      expect(replaceSpy).not.toHaveBeenCalled()

      // Only source selected
      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      expect(confirmBtn.attributes('disabled')).toBeDefined()
      await confirmBtn.trigger('click')
      expect(replaceSpy).not.toHaveBeenCalled()

      // Reset and select only target
      await wrapper.find('[data-test="source-select"]').setValue('')
      await wrapper.find('[data-test="target-select"]').setValue('char_102_texas')
      expect(confirmBtn.attributes('disabled')).toBeDefined()
      await confirmBtn.trigger('click')
      expect(replaceSpy).not.toHaveBeenCalled()
    })

    it('refuses and disables confirm button when source and target are the same operator', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }

      const replaceSpy = vi.spyOn(store, 'replaceOperatorGlobally')
      const wrapper = mountModal()

      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      await wrapper.find('[data-test="target-select"]').setValue('char_002_amiya')

      const confirmBtn = wrapper.find('[data-test="confirm-btn"]')
      expect(confirmBtn.attributes('disabled')).toBeDefined()

      const errorBanner = wrapper.find('[data-test="error-same-operator"]')
      expect(errorBanner.exists()).toBe(true)
      expect(errorBanner.text()).toContain('原干员与目标干员相同')

      await confirmBtn.trigger('click')
      expect(replaceSpy).not.toHaveBeenCalled()
    })
  })

  describe('Cancel Behavior', () => {
    it('makes no mutation to store on cancel and emits close and update:open events', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }

      const replaceSpy = vi.spyOn(store, 'replaceOperatorGlobally')
      const wrapper = mountModal()

      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      await wrapper.find('[data-test="target-select"]').setValue('char_102_texas')

      // Click cancel
      const cancelBtn = wrapper.find('[data-test="cancel-btn"]')
      await cancelBtn.trigger('click')

      // Store was not mutated
      expect(replaceSpy).not.toHaveBeenCalled()
      expect(store.workspace.mainPlan.facilities.room_1_1.slots[0].occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_002_amiya',
      })

      // Close events emitted
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('update:open')).toEqual([[false]])
      expect(wrapper.emitted('update:visible')).toEqual([[false]])
    })
  })

  describe('Exact Global Mutation Across Main, Replacements, and Conf', () => {
    it('transactionally mutates all primary slots, replacements, and conf policy lists on confirm', async () => {
      const store = useRosterWorkbenchStore()

      // Primary slot
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'group-a',
        replacements: [],
      }
      // Another room primary slot
      store.workspace.mainPlan.facilities.room_2_2.slots[1] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }

      // Replacements list
      store.workspace.mainPlan.facilities.room_1_2.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_103_angel' },
        groupId: null,
        replacements: ['char_002_amiya', 'char_172_svrash'],
      }

      // Conf policies
      store.workspace.mainPlan.conf.workaholic = ['char_002_amiya']
      store.workspace.mainPlan.conf.refresh_trading = ['char_002_amiya', 'char_103_angel']
      store.workspace.mainPlan.conf.exhaust_require = ['char_002_amiya']

      const wrapper = mountModal()
      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      await wrapper.find('[data-test="target-select"]').setValue('char_102_texas')

      const confirmBtn = wrapper.find('[data-test="confirm-btn"]')
      expect(confirmBtn.attributes('disabled')).toBeUndefined()
      await confirmBtn.trigger('click')

      // Verify primary slots mutated
      expect(store.workspace.mainPlan.facilities.room_1_1.slots[0].occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_102_texas',
      })
      expect(store.workspace.mainPlan.facilities.room_2_2.slots[1].occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_102_texas',
      })

      // Verify replacement list mutated
      expect(store.workspace.mainPlan.facilities.room_1_2.slots[0].replacements).toEqual([
        'char_102_texas',
        'char_172_svrash',
      ])

      // Verify conf policies mutated
      expect(store.workspace.mainPlan.conf.workaholic).toEqual(['char_102_texas'])
      expect(store.workspace.mainPlan.conf.refresh_trading).toEqual(['char_102_texas', 'char_103_angel'])
      expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_102_texas'])
    })
  })

  describe('One Call and Useful Replaced Event Payload for WorkbenchShell', () => {
    it('calls store.replaceOperatorGlobally exactly once and emits replaced payload', async () => {
      const store = useRosterWorkbenchStore()
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: ['char_002_amiya'],
      }

      const replaceSpy = vi.spyOn(store, 'replaceOperatorGlobally')
      const wrapper = mountModal()

      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      await wrapper.find('[data-test="target-select"]').setValue('char_102_texas')

      await wrapper.find('[data-test="confirm-btn"]').trigger('click')

      // Exactly once
      expect(replaceSpy).toHaveBeenCalledTimes(1)
      expect(replaceSpy).toHaveBeenCalledWith('char_002_amiya', 'char_102_texas')

      // Replaced event payload
      expect(wrapper.emitted('replaced')).toHaveLength(1)
      const payload = wrapper.emitted('replaced')?.[0]?.[0] as any
      expect(payload).toBeDefined()
      expect(payload).toMatchObject({
        sourceId: 'char_002_amiya',
        targetId: 'char_102_texas',
        sourceOperatorId: 'char_002_amiya',
        targetOperatorId: 'char_102_texas',
        sourceName: '阿米娅',
        targetName: '德克萨斯',
      })
      expect(payload.impact).toBeDefined()
      expect(payload.impact.totalCount).toBeGreaterThanOrEqual(2)

      // Close & update:open emitted
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('update:open')).toEqual([[false]])
      expect(wrapper.emitted('update:visible')).toEqual([[false]])
    })
  })

  describe('Metadata Preservation', () => {
    it('preserves slot groupId, custom slot metadata, and custom conf fields through replacement', async () => {
      const store = useRosterWorkbenchStore()

      // Primary slot with custom metadata and groupId
      store.workspace.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'special-priority-group',
        replacements: ['char_103_angel'],
        metadata: {
          customTag: 'preserved-meta',
          priorityIndex: 99,
          nested: { flag: true },
        },
      }

      // Slot occupant with extra property
      const occupant = store.workspace.mainPlan.facilities.room_1_1.slots[0].occupant as any
      occupant.extraProperty = 'must-not-be-lost'

      // Custom fields on conf
      const conf = store.workspace.mainPlan.conf as any
      conf.unknown_custom_envelope = { version: 'mower-v2', author: 'tester' }
      conf.free_blacklist = ['char_285_medic2']

      const wrapper = mountModal()
      await wrapper.find('[data-test="source-select"]').setValue('char_002_amiya')
      await wrapper.find('[data-test="target-select"]').setValue('char_102_texas')
      await wrapper.find('[data-test="confirm-btn"]').trigger('click')

      const updatedSlot = store.workspace.mainPlan.facilities.room_1_1.slots[0]

      // Occupant operatorId updated
      expect(updatedSlot.occupant?.kind).toBe('operator')
      if (updatedSlot.occupant && updatedSlot.occupant.kind === 'operator') {
        expect(updatedSlot.occupant.operatorId).toBe('char_102_texas')
      }
      // Occupant extra property preserved
      expect((updatedSlot.occupant as any).extraProperty).toBe('must-not-be-lost')

      // GroupId preserved!
      expect(updatedSlot.groupId).toBe('special-priority-group')

      // Slot metadata preserved!
      expect(updatedSlot.metadata).toEqual({
        customTag: 'preserved-meta',
        priorityIndex: 99,
        nested: { flag: true },
      })

      // Replacements preserved!
      expect(updatedSlot.replacements).toEqual(['char_103_angel'])

      // Unknown conf fields preserved!
      expect(conf.unknown_custom_envelope).toEqual({ version: 'mower-v2', author: 'tester' })
      expect(conf.free_blacklist).toEqual(['char_285_medic2'])
    })
  })
})
