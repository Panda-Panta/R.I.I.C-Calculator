/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MobileFacilityNav from './MobileFacilityNav.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'

describe('MobileFacilityNav.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders category tabs and defaults to output facilities', () => {
    const wrapper = mount(MobileFacilityNav)
    const tabs = wrapper.findAll('.cat-tab-btn')
    expect(tabs.length).toBe(3)
    expect(tabs[0]!.text()).toContain('产出')
    expect(tabs[1]!.text()).toContain('中枢与宿舍')
    expect(tabs[2]!.text()).toContain('副设施')

    const chips = wrapper.findAll('.facility-chip')
    expect(chips.length).toBe(9) // B1 ~ B9
    expect(chips[0]!.text()).toContain('B1')
  })

  it('switches categories when category tab is clicked', async () => {
    const wrapper = mount(MobileFacilityNav)

    // Switch to Central & Dorms
    const dormTab = wrapper.find('[data-test="cat-tab-central_dorm"]')
    await dormTab.trigger('click')

    let chips = wrapper.findAll('.facility-chip')
    expect(chips.length).toBe(5) // Central + 4 dorms
    expect(chips[0]!.text()).toContain('中枢')
    expect(chips[1]!.text()).toContain('宿1')

    // Switch to Support facilities
    const supportTab = wrapper.find('[data-test="cat-tab-support"]')
    await supportTab.trigger('click')

    chips = wrapper.findAll('.facility-chip')
    expect(chips.length).toBe(4) // Meeting, Factory, Contact, Train
    expect(chips[0]!.text()).toContain('会客')
  })

  it('selects room in store and emits select-room when chip is clicked', async () => {
    const wrapper = mount(MobileFacilityNav)
    const store = useRosterWorkbenchStore()

    const b2Chip = wrapper.find('[data-test="facility-chip-room_1_2"]')
    expect(b2Chip.exists()).toBe(true)

    await b2Chip.trigger('click')

    expect(store.selectedRoomId).toBe('room_1_2')
    expect(wrapper.emitted('select-room')?.[0]).toEqual(['room_1_2'])
  })

  it('displays the current selected room label', async () => {
    const wrapper = mount(MobileFacilityNav)
    const store = useRosterWorkbenchStore()

    store.selectRoom('central')
    await wrapper.vm.$nextTick()

    const currentLabel = wrapper.find('.current-selected-label')
    expect(currentLabel.text()).toContain('中枢')
  })
})
