// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProductionWeightsEditor from './ProductionWeightsEditor.vue'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../../domain/productionWeights'

function lastEvent(events: unknown[][] | undefined): unknown[] | undefined {
  return events?.[events.length - 1]
}

describe('ProductionWeightsEditor', () => {
  it('emits a complete weight set for valid input, including zero', async () => {
    const wrapper = mount(ProductionWeightsEditor, { props: { modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS } } })
    expect(wrapper.emitted('validity-change')?.[0]).toEqual([true])
    await wrapper.get('[data-test="weight-gold"]').setValue('1.25')
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual({
      exp: 1, gold: 1.25, orders: .2, fragments: 0, orundum: 0,
    })
    await wrapper.setProps({ modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS, gold: 1.25 } })
    await wrapper.get('[data-test="weight-orders"]').setValue('0')
    expect(wrapper.emitted('update:modelValue')?.[1]?.[0]).toMatchObject({ gold: 1.25, orders: 0 })
    expect(wrapper.text()).toContain('500')
    expect(wrapper.text()).toContain('每点经验')
    wrapper.unmount()
  })

  it.each(['', '-1', 'Infinity', 'NaN'])('rejects invalid input %s without changing shared settings', async value => {
    const wrapper = mount(ProductionWeightsEditor, { props: { modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS } } })
    await wrapper.get('[data-test="weight-exp"]').setValue(value)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([false])
    expect(wrapper.get('[data-test="weight-exp"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-test="weight-exp-error"]').text()).toContain('有限的非负数')
    wrapper.unmount()
  })

  it('resets all five weights and clears invalid drafts, and follows external settings updates', async () => {
    const wrapper = mount(ProductionWeightsEditor, { props: { modelValue: { exp: 2, gold: 3, orders: 4, fragments: 5, orundum: 6 } } })
    await wrapper.get('[data-test="weight-exp"]').setValue('')
    await wrapper.get('[data-test="reset-production-weights"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(DEFAULT_PRODUCTION_WEIGHTS)
    expect((wrapper.get('[data-test="weight-exp"]').element as HTMLInputElement).value).toBe('1')
    expect(wrapper.find('[data-test="weight-exp-error"]').exists()).toBe(false)
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([true])
    await wrapper.setProps({ modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS, fragments: .5 } })
    expect((wrapper.get('[data-test="weight-fragments"]').element as HTMLInputElement).value).toBe('0.5')
    wrapper.unmount()
  })

  it('keeps the whole draft invalid until every invalid coefficient is corrected', async () => {
    const wrapper = mount(ProductionWeightsEditor, { props: { modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS } } })
    await wrapper.get('[data-test="weight-exp"]').setValue('')
    await wrapper.get('[data-test="weight-gold"]').setValue('-2')
    await wrapper.get('[data-test="weight-exp"]').setValue('2')
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([false])
    await wrapper.get('[data-test="weight-gold"]').setValue('0')
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([true])
    wrapper.unmount()
  })

  it('preserves an invalid draft when a different coefficient is saved by the parent', async () => {
    const wrapper = mount(ProductionWeightsEditor, { props: { modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS } } })
    await wrapper.get('[data-test="weight-exp"]').setValue('')
    await wrapper.get('[data-test="weight-gold"]').setValue('.5')
    await wrapper.setProps({ modelValue: { ...DEFAULT_PRODUCTION_WEIGHTS, gold: .5 } })
    expect((wrapper.get('[data-test="weight-exp"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-test="weight-exp"]').attributes('aria-invalid')).toBe('true')
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([false])
    await wrapper.get('[data-test="weight-exp"]').setValue('0')
    expect(lastEvent(wrapper.emitted('update:modelValue'))?.[0]).toMatchObject({ exp: 0, gold: .5 })
    expect(lastEvent(wrapper.emitted('validity-change'))).toEqual([true])
    wrapper.unmount()
  })
})
