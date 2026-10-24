/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RosterPosterModal from './RosterPosterModal.vue'
import { createDefaultWorkspace } from '../../workbench/defaults'
import type { CalculationReport } from '../../domain/types'

vi.hoisted(() => {
  class ResizeObserverStub {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
  if (typeof window !== 'undefined') {
    window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  }
  if (typeof global !== 'undefined') {
    if (typeof (global as any).removeEventListener !== 'function') {
      (global as any).removeEventListener = () => {}
    }
    if (typeof (global as any).addEventListener !== 'function') {
      (global as any).addEventListener = () => {}
    }
  }
})

vi.mock('html-to-image', () => ({
  toPng: vi.fn(async () => 'data:image/png;base64,fake-png-data'),
  toBlob: vi.fn(async () => new Blob(['fake-blob'], { type: 'image/png' })),
}))

describe('RosterPosterModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('labels a supported fragment manufacturing recipe as source fragments in the exported poster', () => {
    const workspace = createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.product = 'fragment'
    const wrapper = mount(RosterPosterModal, { props: { open: true, workspace, calculationReport: null }, global: { stubs: { teleport: true } } })
    expect(wrapper.get('.product-badge.fragment').text()).toBe('源石碎片')
    wrapper.unmount()
  })

  it('renders poster title, layout badge, and facilities overview when open', () => {
    const workspace = createDefaultWorkspace()
    workspace.name = '主力243测试排班'

    const wrapper = mount(RosterPosterModal, {
      props: {
        open: true,
        workspace,
        calculationReport: null,
      },
      global: {
        stubs: { teleport: true },
      },
    })

    expect(wrapper.find('[data-test="roster-poster"]').exists()).toBe(true)
    expect(wrapper.find('.poster-title').text()).toBe('主力243测试排班')
    expect(wrapper.find('.brand-badge').text()).toContain('模式')
    expect(wrapper.findAll('.manufacture-card').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.trading-card').length).toBeGreaterThan(0)
    expect(wrapper.find('[data-test="download-poster-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="copy-poster-btn"]').exists()).toBe(true)
  })

  it('renders income metrics and optional sampled clues without inventing old-report zeros', async () => {
    const workspace = createDefaultWorkspace()
    const mockReport: CalculationReport = {
      power: { generation: 810, consumption: 810, margin: 0, sufficient: true },
      layoutValid: true,
      validationMessages: [],
      drones: 240,
      manufacture: [],
      trading: [],
      morale: [],
      roomShiftDetails: {},
      summary: {
        exp: 35000,
        goldCount: 80,
        goldValue: 40000,
        orderLmd: 33000,
        fragments: 0,
        orundum: 0,
        goldConsumed: 60,
        fragmentsConsumed: 0,
        netGoldCount: 20,
        netGoldValue: 10000,
        virtualGoldCount: 0,
        virtualGoldValue: 0,
        totalScore82: 78500,
        totalEquivalentLmd: 82000,
      },
    }

    const wrapper = mount(RosterPosterModal, {
      props: {
        open: true,
        workspace,
        calculationReport: mockReport,
      },
      global: {
        stubs: { teleport: true },
      },
    })

    const incomeCard = wrapper.find('.poster-income-card')
    expect(incomeCard.exists()).toBe(true)
    expect(incomeCard.text()).toContain('78,500')
    expect(incomeCard.text()).toContain('35,000')
    expect(incomeCard.text()).toContain('33,000')
    expect(incomeCard.text()).toContain('20.0')
    expect(wrapper.find('[data-test="poster-clues"]').exists()).toBe(false)
    await wrapper.setProps({ calculationReport: {
      ...mockReport, summary: { ...mockReport.summary!, clueCount: 7 / 3, clueTotal: 7 },
    } })
    expect(wrapper.get('[data-test="poster-clues"]').text()).toContain('2.33')
    expect(wrapper.get('[data-test="poster-clues"]').text()).toContain('采样完成 7 条')
    expect(wrapper.get('.clue-assumption').text()).toContain('全程开启交流')
    expect(wrapper.get('.clue-assumption').text()).toContain('不计信用和加权收入')
    await wrapper.setProps({ calculationReport: {
      ...mockReport, summary: { ...mockReport.summary!, clueCount: 0, clueTotal: 0 },
    } })
    expect(wrapper.get('[data-test="poster-clues"] .m-val').text()).toBe('0')
    wrapper.unmount()
  })

  it('includes an actually built recycle room and its operator in the exported poster', async () => {
    const workspace = createDefaultWorkspace()
    const wrapper = mount(RosterPosterModal, {
      props: { open: true, workspace, calculationReport: null },
      global: { stubs: { teleport: true } },
    })
    expect(wrapper.findAll('.support-card').some(card => card.text().includes('回收站'))).toBe(false)
    const built = structuredClone(workspace)
    built.mainPlan.facilities.recycle.level = 1
    built.mainPlan.facilities.recycle.slots = [{
      occupant: { kind: 'operator', operatorId: 'char_4232_hbound' }, groupId: null, replacements: [],
    }]
    await wrapper.setProps({ workspace: built })
    const recycle = wrapper.findAll('.support-card').find(card => card.text().includes('回收站'))
    expect(recycle?.text()).toContain('旅骨')
    expect(recycle?.findAll('img')).toHaveLength(1)
    wrapper.unmount()
  })

  it('triggers download when download button clicked', async () => {
    const workspace = createDefaultWorkspace()
    const wrapper = mount(RosterPosterModal, {
      props: {
        open: true,
        workspace,
        calculationReport: null,
      },
      global: {
        stubs: { teleport: true },
      },
    })

    const downloadBtn = wrapper.find('[data-test="download-poster-btn"]')
    await downloadBtn.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.status-msg.success').text()).toContain('已开始下载')
  })

  it('triggers copy when copy button clicked and clipboard supported', async () => {
    const workspace = createDefaultWorkspace()
    const writeMock = vi.fn(async () => {})
    Object.assign(navigator, {
      clipboard: {
        write: writeMock,
      },
    })
    // Mock global ClipboardItem
    if (typeof globalThis.ClipboardItem === 'undefined') {
      ;(globalThis as any).ClipboardItem = class ClipboardItem {
        constructor(public data: Record<string, Blob>) {}
      }
    }

    const wrapper = mount(RosterPosterModal, {
      props: {
        open: true,
        workspace,
        calculationReport: null,
      },
      global: {
        stubs: { teleport: true },
      },
    })

    const copyBtn = wrapper.find('[data-test="copy-poster-btn"]')
    await copyBtn.trigger('click')
    await wrapper.vm.$nextTick()

    expect(writeMock).toHaveBeenCalled()
    expect(wrapper.find('.status-msg.success').text()).toContain('复制到剪贴板')
  })
})
