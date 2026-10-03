// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RunOrderGainsPanel from './RunOrderGainsPanel.vue'
import { DEFAULT_PRODUCTION_WEIGHTS } from '../../domain/productionWeights'
import { createDefaultWorkspace } from '../../workbench/defaults'
import { OPERATORS } from '../../domain/operators'
import { selectUnlockedSkills } from '../../domain/operatorInventory'

describe('RunOrderGainsPanel', () => {
  it('shows all theoretical combinations and recomputes gains when shared weights change', async () => {
    const wrapper = mount(RunOrderGainsPanel, { props: { weights: { ...DEFAULT_PRODUCTION_WEIGHTS } } })
    expect(wrapper.findAll('[data-test="run-order-gain-row"]')).toHaveLength(12)
    expect(wrapper.get('[data-choice="pair22"]').text()).toContain('+89.66%')
    expect(wrapper.get('[data-choice="closure2"]').text()).toContain('+94.83%')
    expect(wrapper.text()).toContain('佩佩仅在没有其他已解锁可用跑单干员时自动兜底')
    expect(wrapper.text()).toContain('可露希尔的 +10% 接单效率不计入理想替补')
    await wrapper.setProps({ weights: { ...DEFAULT_PRODUCTION_WEIGHTS, gold: 0 } })
    expect(wrapper.get('[data-choice="pair22"]').text()).toContain('+62.07%')
    wrapper.unmount()
  })

  it('lets an empty/default workspace preview station levels and total efficiency without mutating it', async () => {
    const workspace = createDefaultWorkspace()
    const original = JSON.stringify(workspace)
    const wrapper = mount(RunOrderGainsPanel, { props: { workspace } })
    expect(wrapper.find('[data-test="manual-run-order-preview"]').exists()).toBe(true)
    await wrapper.get('[data-test="preview-level"]').setValue('2')
    expect(wrapper.get('[data-choice="pair22"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('[data-choice="tequila2"]').text()).toContain('仅三级站')
    expect(wrapper.get('[data-choice="proviso2"]').attributes('aria-disabled')).toBe('false')
    expect(wrapper.get('[data-choice="proviso2"]').text()).toContain('+83.33%')
    await wrapper.get('[data-test="preview-level"]').setValue('3')
    await wrapper.get('[data-test="preview-efficiency"]').setValue('300')
    expect(wrapper.get('[data-choice="pepe2"]').text()).toContain('-13.41%')
    const previous = wrapper.get('[data-choice="pepe2"]').text()
    await wrapper.get('[data-test="preview-efficiency"]').setValue('0')
    expect(wrapper.get('[data-choice="pepe2"]').text()).toBe(previous)
    expect(wrapper.find('[data-test="preview-efficiency-error"]').exists()).toBe(true)
    expect(JSON.stringify(workspace)).toBe(original)
    wrapper.unmount()
  })

  it('uses actual main station level, operator quality and total efficiency, reactively', async () => {
    const workspace = createDefaultWorkspace()
    const bibeak = OPERATORS.find(operator => operator.name === '柏喙')!
    const facility = workspace.mainPlan.facilities.room_3_1
    facility.level = 3
    facility.slots[0]!.occupant = { kind: 'operator', operatorId: bibeak.charId }
    const wrapper = mount(RunOrderGainsPanel, { props: { workspace } })
    const station = wrapper.get('[data-station="B301"]')
    expect(station.text()).toContain('柏喙')
    expect(station.text()).toContain('3 级')
    expect(station.text()).toContain('β')
    expect(station.text()).toContain('E = 101.0%')
    expect(station.get('[data-choice="pair22"]').attributes('aria-disabled')).toBe('false')
    expect(wrapper.find('[data-test="manual-run-order-preview"]').exists()).toBe(false)
    await wrapper.setProps({ operatorContext: { operatorRecords: {
      [bibeak.charId]: { ...bibeak, skills: selectUnlockedSkills(bibeak, 0, 1) },
    } } })
    expect(wrapper.get('[data-station="B301"]').text()).toContain('α')
    wrapper.unmount()
  })

  it.each([
    [1, 'alpha', '+26.47%'], [1, 'beta', '+7.89%'],
    [2, 'alpha', '+26.47%'], [2, 'beta', '+7.89%'],
  ])('keeps manual quality %s/%s and computes the selected fixed distribution', async (level, quality, gain) => {
    const wrapper = mount(RunOrderGainsPanel)
    await wrapper.get('[data-test="preview-quality"]').setValue(quality)
    await wrapper.get('[data-test="preview-level"]').setValue(String(level))
    expect(wrapper.get('[data-test="preview-quality"]').attributes('disabled')).toBeUndefined()
    expect((wrapper.get('[data-test="preview-quality"]').element as HTMLSelectElement).value).toBe(quality)
    expect(wrapper.findAll('[data-test="run-order-gain-row"]')).toHaveLength(12)
    expect(wrapper.get('[data-choice="proviso2"]').text()).toContain(gain)
    expect(wrapper.get('[data-choice="pair22"]').attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('[data-test="low-level-quality-model"]').text()).toContain('固定模型')
    expect(wrapper.get('[data-test="low-level-quality-model"]').text()).toContain('未经游戏实测核验')
    await wrapper.get('[data-test="preview-quality"]').setValue('normal')
    expect(wrapper.get('[data-choice="proviso2"]').text()).toContain(level === 1 ? '+100.00%' : '+83.33%')
    expect(wrapper.find('[data-test="low-level-quality-model"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each([1, 2])('shows actual low-level station %s quality using the fixed model and updates when stages change', async level => {
    const workspace = createDefaultWorkspace()
    const bibeak = OPERATORS.find(operator => operator.name === '柏喙')!
    workspace.mainPlan.facilities.room_3_1.level = level
    workspace.mainPlan.facilities.room_3_1.slots[0]!.occupant = { kind: 'operator', operatorId: bibeak.charId }
    const wrapper = mount(RunOrderGainsPanel, { props: { workspace } })
    const station = wrapper.get('[data-station="B301"]')
    expect(station.text()).toContain('β品质')
    expect(station.get('.baseline-score').text()).toContain('2103.01 分/日')
    expect(station.findAll('[data-test="run-order-gain-row"]')).toHaveLength(12)
    expect(station.get('[data-choice="proviso2"]').text()).toContain('+7.89%')
    expect(station.get('[data-test="low-level-quality-model"]').text()).toContain('5% / 10% / 85%')
    await wrapper.setProps({ operatorContext: { operatorRecords: {
      [bibeak.charId]: { ...bibeak, skills: selectUnlockedSkills(bibeak, 0, 1) },
    } } })
    expect(station.text()).toContain('α品质')
    expect(station.get('.baseline-score').text()).toContain('2091.78 分/日')
    expect(station.get('[data-choice="proviso2"]').text()).toContain('+26.47%')
    expect(station.get('[data-test="low-level-quality-model"]').text()).toContain('15% / 30% / 55%')
    wrapper.unmount()
  })

  it('shows absolute weighted gain when the baseline is zero instead of a percentage', () => {
    const wrapper = mount(RunOrderGainsPanel, { props: { weights: { exp: 0, gold: 1, orders: 0, fragments: 0, orundum: 0 } } })
    expect(wrapper.get('[data-choice="pair22"]').text()).toContain('+1415.93 分/日')
    expect(wrapper.get('[data-choice="pair22"]').text()).not.toContain('%')
    expect(wrapper.text()).toContain('基础加权分为 0')
    expect(wrapper.text()).not.toContain('NaN')
    expect(wrapper.text()).not.toContain('Infinity')
    wrapper.unmount()
  })
})
