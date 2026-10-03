/**
 * @vitest-environment jsdom
 *
 * Derivative work based on arknights-mower (PlanEditor.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FacilityEditor from './FacilityEditor.vue'
import SlotRow from './SlotRow.vue'
import ReplacementList from './ReplacementList.vue'
import { useRosterWorkbenchStore } from '../../workbench/store'

function asVueWrapper<T = Record<string, unknown>>(wrapper: unknown): VueWrapper<T> {
  return wrapper as VueWrapper<T>
}

function getProps(wrapper: unknown): Record<string, unknown> {
  return (wrapper as VueWrapper).props() as Record<string, unknown>
}

describe('FacilityEditor.vue and subcomponents', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hides editor when no room is selected (无选中隐藏)', () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom(null)

    const wrapper = mount(FacilityEditor)
    expect(wrapper.find('.mower-facility-editor').exists()).toBe(false)
  })

  it('can leave a dorm or training room unbuilt, remove staffing, and rebuild empty slots', async () => {
    const store = useRosterWorkbenchStore()
    for (const roomId of ['dormitory_4', 'train'] as const) {
      store.selectRoom(roomId)
      store.updateSlotOccupant(roomId, 0, { kind: 'operator', operatorId: 'char_002_amiya' })
      const wrapper = mount(FacilityEditor)
      const levelSelect = asVueWrapper(wrapper.findComponent('.level-select'))
      levelSelect.vm.$emit('update:value', 0)
      await wrapper.vm.$nextTick()
      expect(store.selectedRoom?.level).toBe(0)
      expect(store.selectedRoom?.slots).toEqual([])
      expect(wrapper.findAllComponents(SlotRow)).toHaveLength(0)
      expect(wrapper.find('.fill-free-btn').exists()).toBe(false)
      levelSelect.vm.$emit('update:value', 1)
      await wrapper.vm.$nextTick()
      expect(store.selectedRoom?.slots).toHaveLength(roomId === 'train' ? 2 : 5)
      expect(store.selectedRoom?.slots.every(slot => slot.occupant.kind === 'empty')).toBe(true)
      wrapper.unmount()
    }
  })

  it('renders header controls and slots table when a room is selected', () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1') // manufacture level 3

    const wrapper = mount(FacilityEditor)
    expect(wrapper.find('.mower-facility-editor').exists()).toBe(true)
    expect(wrapper.find('.type-select').exists()).toBe(true)
    expect(wrapper.find('.level-select').exists()).toBe(true)
    expect(wrapper.find('.product-select').exists()).toBe(true)

    const rows = wrapper.findAllComponents(SlotRow)
    expect(rows.length).toBe(3)
  })

  it('allows selecting facility type for output rooms and shows text for non-output rooms', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')

    const wrapper = mount(FacilityEditor)
    // Left side output room has editable type-select
    expect(wrapper.find('.type-select').exists()).toBe(true)

    // Non-output room: central
    store.selectRoom('central')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('控制中枢')
  })

  it('computes level options with reasonable upper bound based on facility type', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1') // output max 3
    const wrapper = mount(FacilityEditor)

    const levelSelect = wrapper.findComponent('.level-select')
    expect(levelSelect.exists()).toBe(true)
    const outputOptions = (getProps(levelSelect)['options'] as Array<{ value: number }>).map((o) => o.value)
    expect(outputOptions).toEqual([0, 1, 2, 3])

    store.selectRoom('central') // central max 5
    await wrapper.vm.$nextTick()
    const centralSelect = wrapper.findComponent('.level-select')
    const centralOptions = (getProps(centralSelect)['options'] as Array<{ value: number }>).map((o) => o.value)
    expect(centralOptions).toEqual([0, 1, 2, 3, 4, 5])

    store.selectRoom('dormitory_1') // dorm max 5
    await wrapper.vm.$nextTick()
    const dormSelect = wrapper.findComponent('.level-select')
    const dormOptions = (getProps(dormSelect)['options'] as Array<{ value: number }>).map((o) => o.value)
    expect(dormOptions).toEqual([0, 1, 2, 3, 4, 5])

    store.selectRoom('meeting') // right-side max 3
    await wrapper.vm.$nextTick()
    const meetingSelect = wrapper.findComponent('.level-select')
    const meetingOptions = (getProps(meetingSelect)['options'] as Array<{ value: number }>).map((o) => o.value)
    expect(meetingOptions).toEqual([0, 1, 2, 3])
  })

  it('atomically adjusts slots capacity when facility type changes (e.g. manufacture to power shrinks to 1)', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    expect(store.selectedRoom?.slots.length).toBe(3)

    // Populate slot 0, 1, 2 with data to verify truncation
    store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
    store.updateSlotOccupant('room_1_1', 1, { kind: 'operator', operatorId: 'char_102_durnar' })
    store.addReplacement('room_1_1', 1, 'char_103_angel')

    const wrapper = mount(FacilityEditor)
    const typeSelect = asVueWrapper(wrapper.findComponent('.type-select'))
    // Change to power
    typeSelect.vm.$emit('update:value', 'power')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoom?.type).toBe('power')
    expect(store.selectedRoom?.slots.length).toBe(1)
    expect(store.selectedRoom?.slots[0]?.occupant).toEqual({ kind: 'operator', operatorId: 'char_002_amiya' })

    // Change back to manufacture (level 3) expands to 3
    typeSelect.vm.$emit('update:value', 'manufacture')
    await wrapper.vm.$nextTick()
    expect(store.selectedRoom?.slots.length).toBe(3)
  })

  it('atomically adjusts slots capacity when level changes and truncates slots on downscaling', async () => {
    const store = useRosterWorkbenchStore()
    // Manual levels are only meaningful outside the exact 2/3-power Mower
    // inference layouts. Use a 1-power layout to exercise slot resizing.
    store.workspace.mainPlan.facilities.room_2_3.type = 'manufacture'
    store.workspace.mainPlan.facilities.room_3_3.type = 'manufacture'
    store.selectRoom('room_1_1') // manufacture level 3, slots: 3
    store.updateSlotOccupant('room_1_1', 2, { kind: 'operator', operatorId: 'char_102_durnar' })
    store.addReplacement('room_1_1', 2, 'char_103_angel')

    const wrapper = mount(FacilityEditor)
    const levelSelect = asVueWrapper(wrapper.findComponent('.level-select'))

    // Downscale to level 1 -> capacity becomes max(1, 1) = 1
    levelSelect.vm.$emit('update:value', 1)
    await wrapper.vm.$nextTick()

    expect(store.selectedRoom?.level).toBe(1)
    expect(store.selectedRoom?.slots.length).toBe(1)

    // Upscale to level 2 -> capacity becomes 2
    levelSelect.vm.$emit('update:value', 2)
    await wrapper.vm.$nextTick()
    expect(store.selectedRoom?.level).toBe(2)
    expect(store.selectedRoom?.slots.length).toBe(2)
    expect(store.selectedRoom?.slots[1]?.occupant.kind).toBe('empty')
  })

  it('re-infers all levels when changing a power room makes the layout 2-power', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_3_3')
    expect(store.workspace.mainPlan.facilities.dormitory_1.level).toBe(5)

    const wrapper = mount(FacilityEditor)
    const typeSelect = asVueWrapper(wrapper.findComponent('.type-select'))
    typeSelect.vm.$emit('update:value', 'manufacture')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoom?.type).toBe('manufacture')
    expect(store.selectedRoom?.level).toBe(1)
    expect(store.workspace.mainPlan.facilities.dormitory_1.level).toBe(1)
    expect(store.workspace.mainPlan.facilities.dormitory_4.level).toBe(1)
    expect(store.workspace.mainPlan.facilities.room_1_3.level).toBe(3)
    expect(store.workspace.mainPlan.facilities.meeting.level).toBe(3)
    expect(store.workspace.mainPlan.facilities.central.level).toBe(5)
  })

  it('allows level edits in 2/3-power layouts and updates room level', async () => {
    const store = useRosterWorkbenchStore()
    const room = store.workspace.mainPlan.facilities.room_1_1
    store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_a' })
    store.updateSlotOccupant('room_1_1', 1, { kind: 'operator', operatorId: 'char_b' })
    store.updateSlotOccupant('room_1_1', 2, { kind: 'operator', operatorId: 'char_c' })
    store.selectRoom('room_1_1')

    const wrapper = mount(FacilityEditor)
    const levelSelect = asVueWrapper(wrapper.findComponent('.level-select'))
    expect(getProps(levelSelect)['disabled']).toBeFalsy()

    levelSelect.vm.$emit('update:value', 2)
    await wrapper.vm.$nextTick()

    expect(room.level).toBe(2)
    expect(room.slots).toHaveLength(2)

    store.updateFacility('room_3_3', { type: 'trading', product: 'money' })
    await wrapper.vm.$nextTick()
    expect(getProps(levelSelect)['disabled']).toBeFalsy()

    levelSelect.vm.$emit('update:value', 1)
    await wrapper.vm.$nextTick()
    expect(room.level).toBe(1)
    expect(room.slots).toHaveLength(1)
  })

  it('renders product select for manufacture and trading with images, hidden for power', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1') // manufacture
    const wrapper = mount(FacilityEditor)
    expect(wrapper.find('.product-select').exists()).toBe(true)

    const productSelect = wrapper.findComponent('.product-select')
    const manufactureProducts = (getProps(productSelect)['options'] as Array<{ value: string }>).map((p) => p.value)
    expect(manufactureProducts).toEqual(['gold', 'exp', 'fragment'])

    // Change to trading
    store.updateFacility('room_1_1', { type: 'trading' })
    await wrapper.vm.$nextTick()
    const tradingProducts = (getProps(productSelect)['options'] as Array<{ value: string }>).map((p) => p.value)
    expect(tradingProducts).toEqual(['money', 'orundum'])

    // Change to power
    store.updateFacility('room_1_1', { type: 'power' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.product-select').exists()).toBe(false)
  })

  it('updates product via store when product selection changes', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    const wrapper = mount(FacilityEditor)

    const productSelect = asVueWrapper(wrapper.findComponent('.product-select'))
    productSelect.vm.$emit('update:value', 'exp')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoom?.product).toBe('exp')
  })

  it('fillWithFree only modifies empty slots in dormitory and preserves other slots', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('dormitory_1')

    // Set slot 0 to operator, slot 1 to empty, slot 2 to current, slot 3 to empty, slot 4 to free
    store.updateSlotOccupant('dormitory_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
    store.updateSlotOccupant('dormitory_1', 1, { kind: 'empty' })
    store.updateSlotOccupant('dormitory_1', 2, { kind: 'current' })
    store.updateSlotOccupant('dormitory_1', 3, { kind: 'empty' })
    store.updateSlotOccupant('dormitory_1', 4, { kind: 'free' })

    const wrapper = mount(FacilityEditor)
    const fillButton = wrapper.find('.fill-free-btn')
    expect(fillButton.exists()).toBe(true)
    await fillButton.trigger('click')

    const slots = store.selectedRoom?.slots
    expect(slots).toBeDefined()
    expect(slots?.[0]?.occupant).toEqual({ kind: 'operator', operatorId: 'char_002_amiya' })
    expect(slots?.[1]?.occupant).toEqual({ kind: 'free' })
    expect(slots?.[2]?.occupant).toEqual({ kind: 'current' })
    expect(slots?.[3]?.occupant).toEqual({ kind: 'free' })
    expect(slots?.[4]?.occupant).toEqual({ kind: 'free' })
  })

  it('clear resets occupant, group, replacements but preserves slot.metadata', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')

    store.updateSlot('room_1_1', 0, {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: 'GroupA',
      replacements: ['char_102_durnar'],
      metadata: { preservedKey: 'value_123' },
    })

    const wrapper = mount(FacilityEditor)
    const clearButton = wrapper.find('.clear-btn')
    expect(clearButton.exists()).toBe(true)
    await clearButton.trigger('click')

    const clearedSlot = store.selectedRoom?.slots[0]
    expect(clearedSlot).toBeDefined()
    expect(clearedSlot?.occupant).toEqual({ kind: 'empty' })
    expect(clearedSlot?.groupId).toBeNull()
    expect(clearedSlot?.replacements).toEqual([])
    expect(clearedSlot?.metadata).toEqual({ preservedKey: 'value_123' })
  })

  it('preserves undefined keys and nested metadata in slot.metadata when adjusting capacity', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1') // manufacture level 3 -> 3 slots

    store.updateSlot('room_1_1', 0, {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: null,
      replacements: [],
      metadata: {
        undefinedField: undefined,
        nested: { innerUndefined: undefined, normalVal: 42 },
      },
    })

    const wrapper = mount(FacilityEditor)
    const levelSelect = asVueWrapper(wrapper.findComponent('.level-select'))

    // Downscale to level 2 (3 slots -> 2 slots, slot 0 is retained, trailing slot 2 is empty so no prompt)
    levelSelect.vm.$emit('update:value', 2)
    await wrapper.vm.$nextTick()

    const slot0Meta = store.selectedRoom?.slots[0]?.metadata
    expect(slot0Meta).toBeDefined()
    expect('undefinedField' in slot0Meta!).toBe(true)
    expect(slot0Meta!.undefinedField).toBeUndefined()
    expect('innerUndefined' in (slot0Meta!.nested as Record<string, unknown>)).toBe(true)
    expect((slot0Meta!.nested as Record<string, unknown>).innerUndefined).toBeUndefined()
    expect((slot0Meta!.nested as Record<string, unknown>).normalVal).toBe(42)
  })

  it('preserves undefined keys and nested metadata in slot.metadata when clearing facility', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')

    store.updateSlot('room_1_1', 0, {
      occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
      groupId: 'GroupX',
      replacements: ['char_102_durnar'],
      metadata: {
        rawUndefined: undefined,
        deep: { flag: undefined, count: 10 },
      },
    })

    const wrapper = mount(FacilityEditor)
    const clearButton = wrapper.find('.clear-btn')
    await clearButton.trigger('click')

    const clearedSlot = store.selectedRoom?.slots[0]
    expect(clearedSlot?.occupant).toEqual({ kind: 'empty' })
    const meta = clearedSlot?.metadata
    expect(meta).toBeDefined()
    expect('rawUndefined' in meta!).toBe(true)
    expect(meta!.rawUndefined).toBeUndefined()
    expect('flag' in (meta!.deep as Record<string, unknown>)).toBe(true)
    expect((meta!.deep as Record<string, unknown>).flag).toBeUndefined()
    expect((meta!.deep as Record<string, unknown>).count).toBe(10)
  })

  it('train facility displays 协助位 for slot 0, 训练位 for slot 1, others display 干员：', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('train')

    const wrapper = mount(FacilityEditor)
    const slotRows = wrapper.findAllComponents(SlotRow)
    expect(slotRows.length).toBe(2)
    const row0 = slotRows[0]
    const row1 = slotRows[1]
    expect(row0).toBeDefined()
    expect(row1).toBeDefined()
    expect(row0!.find('.select-label').text()).toContain('协助位')
    expect(row1!.find('.select-label').text()).toContain('训练位')

    store.selectRoom('room_1_1')
    await wrapper.vm.$nextTick()
    const normalRows = wrapper.findAllComponents(SlotRow)
    const normalRow0 = normalRows[0]
    expect(normalRow0).toBeDefined()
    expect(normalRow0!.find('.select-label').text()).toContain('干员：')
  })

  it('disables group input and replacement list when slot occupant is empty, enabled when not empty', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    store.updateSlotOccupant('room_1_1', 0, { kind: 'empty' })
    store.updateSlotOccupant('room_1_1', 1, { kind: 'operator', operatorId: 'char_002_amiya' })

    const wrapper = mount(FacilityEditor)
    const slotRows = wrapper.findAllComponents(SlotRow)
    const row0 = slotRows[0]
    const row1 = slotRows[1]
    expect(row0).toBeDefined()
    expect(row1).toBeDefined()

    // Slot 0 (empty): group disabled, replacement disabled
    const group0 = row0!.findComponent('.group-input')
    expect(getProps(group0)['disabled']).toBe(true)
    const repList0 = row0!.findComponent(ReplacementList)
    expect(getProps(repList0)['disabled']).toBe(true)

    // Slot 1 (operator): group enabled, replacement enabled
    const group1 = row1!.findComponent('.group-input')
    expect(getProps(group1)['disabled']).toBe(false)
    const repList1 = row1!.findComponent(ReplacementList)
    expect(getProps(repList1)['disabled']).toBe(false)
  })

  it('edits group via store when typing in group input', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    store.updateSlotOccupant('room_1_1', 0, { kind: 'free' })

    const wrapper = mount(FacilityEditor)
    const slotRows = wrapper.findAllComponents(SlotRow)
    const row0 = slotRows[0]
    expect(row0).toBeDefined()
    const groupInput = asVueWrapper(row0!.findComponent('.group-input'))
    groupInput.vm.$emit('update:value', 'MyGroup')
    await wrapper.vm.$nextTick()

    expect(store.selectedRoom?.slots[0]?.groupId).toBe('MyGroup')
  })

  it('updates slot occupant placeholder select (empty, free, current)', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')

    const wrapper = mount(FacilityEditor)
    const slotRow = wrapper.findComponent(SlotRow)
    const occupantSelect = asVueWrapper(slotRow.findComponent('.occupant-select'))

    occupantSelect.vm.$emit('update:value', 'free')
    await wrapper.vm.$nextTick()
    expect(store.selectedRoom?.slots[0]?.occupant).toEqual({ kind: 'free' })

    occupantSelect.vm.$emit('update:value', 'current')
    await wrapper.vm.$nextTick()
    expect(store.selectedRoom?.slots[0]?.occupant).toEqual({ kind: 'current' })

    occupantSelect.vm.$emit('update:value', 'empty')
    await wrapper.vm.$nextTick()
    expect(store.selectedRoom?.slots[0]?.occupant).toEqual({ kind: 'empty' })
  })

  it('emits request-picker event when operator pick button or add-replacement is clicked', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })

    const wrapper = mount(FacilityEditor)
    const slotRow = wrapper.findComponent(SlotRow)

    // Click main operator pick button
    const opBtn = slotRow.find('.operator-pick-btn')
    await opBtn.trigger('click')

    expect(wrapper.emitted('request-picker')).toBeTruthy()
    expect(wrapper.emitted('request-picker')![0]).toEqual([
      { roomId: 'room_1_1', slotIndex: 0, mode: 'main' },
    ])

    // Click add replacement button
    const repList = slotRow.findComponent(ReplacementList)
    const addBtn = repList.find('.add-replacement-btn')
    await addBtn.trigger('click')

    const emitted = wrapper.emitted('request-picker')!
    expect(emitted.length).toBe(2)
    expect(emitted[1]).toEqual([
      { roomId: 'room_1_1', slotIndex: 0, mode: 'replacement' },
    ])
  })

  it('ReplacementList displays items, supports removal and drag reordering via store', async () => {
    const store = useRosterWorkbenchStore()
    store.selectRoom('room_1_1')
    store.updateSlotOccupant('room_1_1', 0, { kind: 'operator', operatorId: 'char_002_amiya' })
    store.setReplacements('room_1_1', 0, ['char_102_durnar', 'char_103_angel'])

    const wrapper = mount(FacilityEditor)
    const repList = wrapper.findComponent(ReplacementList)
    const items = repList.findAll('.replacement-item')
    expect(items.length).toBe(2)

    // Remove item at index 0
    const removeBtn = items[0]?.find('.remove-btn')
    expect(removeBtn).toBeDefined()
    await removeBtn!.trigger('click')
    expect(store.selectedRoom?.slots[0]?.replacements).toEqual(['char_103_angel'])

    // Add back for reorder test
    store.setReplacements('room_1_1', 0, ['char_102_durnar', 'char_103_angel'])
    await wrapper.vm.$nextTick()

    // Test drag and drop reordering
    const repItems = repList.findAll('.replacement-item')
    const item0 = repItems[0]
    const item1 = repItems[1]
    expect(item0).toBeDefined()
    expect(item1).toBeDefined()

    const dataTransfer = {
      setData: () => {},
      getData: () => '0',
    }

    await item0!.trigger('dragstart', { dataTransfer })
    await item1!.trigger('drop', { dataTransfer })

    expect(store.selectedRoom?.slots[0]?.replacements).toEqual(['char_103_angel', 'char_102_durnar'])
  })
})
