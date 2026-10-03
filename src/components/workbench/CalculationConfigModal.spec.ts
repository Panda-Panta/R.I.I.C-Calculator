// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CalculationConfigModal from './CalculationConfigModal.vue'
import { createDefaultWorkspace } from '../../workbench/defaults'

afterEach(() => { document.body.innerHTML = '' })
it('edits and confirms the shared weights including zero', async () => {
  const wrapper = mount(CalculationConfigModal, {
    props: { open: true, workspace: createDefaultWorkspace(), initial: { droneTarget: 'none', droneTradingRoomId: '', productionWeights: { exp: 2, gold: .5, orders: .3, fragments: 4, orundum: 5 } } },
    global: { stubs: { teleport: true } },
  })
  try {
    expect(wrapper.get<HTMLInputElement>('[data-test="weight-exp"]').element.value).toBe('2')
    await wrapper.get('[data-test="weight-exp"]').setValue('0')
    await wrapper.get('[data-test="confirm-calculation"]').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ productionWeights: { exp: 0, gold: .5, orders: .3, fragments: 4, orundum: 5 } })
  } finally { wrapper.unmount() }
})
it('restores the saved target and drops a stale trading room when switching targets', async () => {
  const wrapper = mount(CalculationConfigModal, {
    props: { open: true, workspace: createDefaultWorkspace(), initial: { droneTarget: 'trading', droneTradingRoomId: 'room_3_2' } },
    global: { stubs: { teleport: true } },
  })
  try {
    expect(wrapper.get<HTMLSelectElement>('[data-test="calculation-drone-target"]').element.value).toBe('room_3_2')
    expect(wrapper.text()).toContain('B101')
    expect(wrapper.text()).toContain('B302')
    await wrapper.get('[data-test="calculation-drone-target"]').setValue('none')
    await wrapper.get('[data-test="confirm-calculation"]').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([{ droneTarget: 'none', droneTradingRoomId: '', droneRoomId: '', useOperatorInventory: true, jayeElite0: false, productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 } }])
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true, initial: { droneTarget: 'trading', droneTradingRoomId: 'room_1_3' } })
    expect(wrapper.get<HTMLSelectElement>('[data-test="calculation-drone-target"]').element.value).toBe('none')
  } finally { wrapper.unmount() }
})

it('selects a concrete manufacturing facility and can opt out of inventory', async () => {
 const wrapper=mount(CalculationConfigModal,{props:{open:true,workspace:createDefaultWorkspace(),initial:{droneTarget:'gold',droneTradingRoomId:''}},global:{stubs:{teleport:true}}})
 try {
  await wrapper.get('[data-test="calculation-drone-target"]').setValue('room_1_2')
  await wrapper.get('[data-test="calculation-use-inventory"]').setValue(false)
  await wrapper.get('[data-test="confirm-calculation"]').trigger('click')
  expect(wrapper.emitted('confirm')?.[0]).toEqual([{droneTarget:'gold',droneRoomId:'room_1_2',droneTradingRoomId:'',useOperatorInventory:false,jayeElite0:false,productionWeights:{exp:1,gold:.8,orders:.2,fragments:0,orundum:0}}])
 } finally { wrapper.unmount() }
})

it('can toggle jayeElite0 option in calculation config', async () => {
 const wrapper = mount(CalculationConfigModal, {
  props: { open: true, workspace: createDefaultWorkspace(), initial: { droneTarget: 'none', droneTradingRoomId: '', jayeElite0: true } },
  global: { stubs: { teleport: true } },
 })
 try {
  const checkbox = wrapper.get<HTMLInputElement>('[data-test="calculation-jaye-elite0"]')
  expect(checkbox.element.checked).toBe(true)
  await checkbox.setValue(false)
  await wrapper.get('[data-test="confirm-calculation"]').trigger('click')
  expect(wrapper.emitted('confirm')?.[0]).toEqual([{ droneTarget: 'none', droneRoomId: '', droneTradingRoomId: '', useOperatorInventory: true, jayeElite0: false, productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 } }])
 } finally { wrapper.unmount() }
})
