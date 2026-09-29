/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ScheduleTimelineGantt from './ScheduleTimelineGantt.vue'
import type { ScheduleSimulationReport } from '../../simulator/scheduleSimulation'
import { buildTimelineData } from '../../workbench/timeline/timelineModel'

vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,mockpng'),
  toBlob: vi.fn().mockResolvedValue(new Blob(['mock'])),
}))

function createSampleReport(): ScheduleSimulationReport {
  return {
    schemaVersion: 1,
    engine: 'mower-morale-v1',
    success: true,
    elapsedHours: 48,
    observedHours: 48,
    assumptions: {
      sampleHours: 48,
      warmupHours: 0,
      maxStepHours: 0.25,
      warmupModel: 'continuous',
      restingThreshold: 0.65,
      operationDurationHours: 0,
      dormAtmosphere: '',
      singleRecoveryTarget: '',
    },
    inputs: {
      schedule: {
        schemaVersion: 1,
        rooms: [
          {
            roomId: 'room_1_1',
            type: 'manufacture',
            level: 3,
            capacity: 2,
            slots: [
              {
                roomId: 'room_1_1',
                slotIndex: 0,
                occupant: { kind: 'operator', operatorId: 'char_102_texas' },
                primaryOperatorId: 'char_102_texas',
                orderedCandidates: ['char_198_blackd'],
                groupId: null,
                role: 'work',
              },
              {
                roomId: 'room_1_1',
                slotIndex: 1,
                occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
                primaryOperatorId: 'char_002_amiya',
                orderedCandidates: [],
                groupId: null,
                role: 'work',
              },
            ],
          },
          {
            roomId: 'room_1_3',
            type: 'trading',
            level: 3,
            capacity: 1,
            slots: [
              {
                roomId: 'room_1_3',
                slotIndex: 0,
                occupant: { kind: 'operator', operatorId: 'char_108_silent' },
                primaryOperatorId: 'char_108_silent',
                orderedCandidates: [],
                groupId: null,
                role: 'work',
              },
            ],
          },
          {
            roomId: 'dormitory_1',
            type: 'dormitory',
            level: 5,
            capacity: 1,
            slots: [
              {
                roomId: 'dormitory_1',
                slotIndex: 0,
                occupant: { kind: 'free' },
                primaryOperatorId: null,
                orderedCandidates: [],
                groupId: null,
                role: 'free-rest',
              },
            ],
          },
        ],
        operators: {},
        restPools: [],
        policies: {} as any,
        fiammettaPolicies: [],
        runOrderPolicies: [],
        diagnostics: [],
        assumptions: {} as any,
      } as any,
      options: {},
    },
    operators: [
      { operatorId: 'char_102_texas', operatorName: '德克萨斯', mainWorkHours: 24, substituteWorkHours: 0, workHours: 24, exhaustedHours: 0, restHours: 24, idleHours: 0, workFraction: 0.5, workRestRatio: 1, initialMorale: 24, finalMorale: 24 },
      { operatorId: 'char_198_blackd', operatorName: '黑角', mainWorkHours: 0, substituteWorkHours: 24, workHours: 24, exhaustedHours: 0, restHours: 0, idleHours: 24, workFraction: 0.5, workRestRatio: null, initialMorale: 24, finalMorale: 12 },
    ],
    rooms: [
      { roomId: 'room_1_1', roomType: 'manufacture', averageEfficiencyPercent: 130, efficiencyPercentHours: 6240, occupiedHours: 48, teams: [] },
      { roomId: 'room_1_3', roomType: 'trading', averageEfficiencyPercent: 100, efficiencyPercentHours: 4800, occupiedHours: 48, teams: [] },
      { roomId: 'dormitory_1', roomType: 'dormitory', averageEfficiencyPercent: 100, efficiencyPercentHours: 4800, occupiedHours: 48, teams: [] },
    ],
    events: [
      { time: 24, type: 'shift-off', operators: ['char_102_texas'] },
      { time: 24, type: 'shift-on', operators: ['char_198_blackd'] },
    ],
    segments: [
      { start: 0, end: 24, occupants: { room_1_1_0: 'char_102_texas', room_1_1_1: 'char_002_amiya', room_1_3_0: 'char_108_silent' }, bedOccupants: {}, morale: { char_102_texas: 12, char_198_blackd: 24 }, efficiencyPercent: { room_1_1: 130, room_1_3: 100 } },
      { start: 24, end: 48, occupants: { room_1_1_0: 'char_198_blackd', room_1_1_1: 'char_002_amiya', room_1_3_0: 'char_108_silent' }, bedOccupants: { dormitory_1_0: 'char_102_texas' }, morale: { char_102_texas: 24, char_198_blackd: 12 }, efficiencyPercent: { room_1_1: 130, room_1_3: 100 } },
    ],
    diagnostics: [],
  }
}

describe('ScheduleTimelineGantt.vue', () => {
  it('reveals worker-prepared timeline data without rebuilding it on expansion', async () => {
    const report = createSampleReport()
    const timelineData = buildTimelineData(report)
    report.segments = []
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report, timelineData, initiallyCollapsed: true },
    })
    expect(wrapper.find('.gantt-container').exists()).toBe(false)
    await wrapper.find('[data-test="toggle-gantt-visibility"]').trigger('click')
    expect(wrapper.find('.gantt-container').exists()).toBe(true)
    expect(wrapper.text()).toContain('德克萨斯')
  })
  it('renders empty state when report is null', () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: null },
    })

    expect(wrapper.find('.gantt-empty-state').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无时间轴数据')
  })

  it('renders gantt container and tracks when report is present', () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    expect(wrapper.find('.gantt-empty-state').exists()).toBe(false)
    expect(wrapper.find('.gantt-container').exists()).toBe(true)
    expect(wrapper.findAll('.facility-group').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('制造站')
    expect(wrapper.text()).toContain('德克萨斯')
  })

  it('switches between facility view and operator view', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    // Initially in facility view
    expect(wrapper.findAll('.facility-group').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.operator-track-row').length).toBe(0)

    // Switch to operator view
    await wrapper.find('[data-test="view-mode-operator"]').trigger('click')
    expect(wrapper.findAll('.facility-group').length).toBe(0)
    expect(wrapper.findAll('.operator-track-row').length).toBeGreaterThan(0)

    // Switch back to facility view
    await wrapper.find('[data-test="view-mode-facility"]').trigger('click')
    expect(wrapper.findAll('.facility-group').length).toBeGreaterThan(0)
  })

  it('filters facilities by chip category', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const chips = wrapper.findAll('.chip-btn')
    const tradeChip = chips.find((c) => c.text().includes('贸易站'))
    expect(tradeChip).toBeDefined()

    await tradeChip!.trigger('click')
    const groups = wrapper.findAll('.facility-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.text()).toContain('贸易站')
  })

  it('filters tracks by search input', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const searchInput = wrapper.find('.gantt-search-input')
    await searchInput.setValue('黑角')

    // Only facilities containing Black Horn should remain
    const groups = wrapper.findAll('.facility-group')
    expect(groups.every((g) => g.text().includes('黑角'))).toBe(true)
  })

  it('updates time zoom window on preset buttons', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const zoomBtns = wrapper.findAll('.zoom-btn')
    const btn24 = zoomBtns.find((b) => b.text() === '24h')
    expect(btn24).toBeDefined()

    await btn24!.trigger('click')
    expect(wrapper.find('.time-window-info').text()).toContain('24.0h')
  })

  it('navigates timeline windows forward and backward', async () => {
    // Report has 48 hours total
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    // Switch to 24h window
    const btn24 = wrapper.findAll('.zoom-btn').find((b) => b.text() === '24h')
    await btn24!.trigger('click')

    // Initial window: T+0.0h to T+24.0h
    expect(wrapper.find('.time-window-info').text()).toContain('T+0.0h 至 T+24.0h')

    // Next window button
    const nextBtn = wrapper.find('[data-test="nav-next-window"]')
    expect(nextBtn.attributes('disabled')).toBeUndefined()
    await nextBtn.trigger('click')

    // Should now be T+24.0h to T+48.0h
    expect(wrapper.find('.time-window-info').text()).toContain('T+24.0h 至 T+48.0h')

    // Next window button should now be disabled (reached end of 48h)
    expect(nextBtn.attributes('disabled')).toBeDefined()

    // Previous window button
    const prevBtn = wrapper.find('[data-test="nav-prev-window"]')
    expect(prevBtn.attributes('disabled')).toBeUndefined()
    await prevBtn.trigger('click')

    // Back to T+0.0h to T+24.0h
    expect(wrapper.find('.time-window-info').text()).toContain('T+0.0h 至 T+24.0h')
    expect(prevBtn.attributes('disabled')).toBeDefined()
  })

  it('jumps to start and end with jump buttons', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const btn24 = wrapper.findAll('.zoom-btn').find((b) => b.text() === '24h')
    await btn24!.trigger('click')

    // Jump to end
    const jumpEndBtn = wrapper.find('[data-test="nav-jump-end"]')
    await jumpEndBtn.trigger('click')
    expect(wrapper.find('.time-window-info').text()).toContain('T+24.0h 至 T+48.0h')

    // Jump to start
    const jumpStartBtn = wrapper.find('[data-test="nav-jump-start"]')
    await jumpStartBtn.trigger('click')
    expect(wrapper.find('.time-window-info').text()).toContain('T+0.0h 至 T+24.0h')
  })

  it('switches window via cycle dropdown selector', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const btn24 = wrapper.findAll('.zoom-btn').find((b) => b.text() === '24h')
    await btn24!.trigger('click')

    const cycleSelect = wrapper.find('[data-test="cycle-select"]')
    expect(cycleSelect.exists()).toBe(true)

    // Select cycle 1 (second day, index 1)
    await cycleSelect.setValue('1')
    expect(wrapper.find('.time-window-info').text()).toContain('T+24.0h 至 T+48.0h')
  })

  it('controls window duration via range slider from 6h to total hours', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const slider = wrapper.find('[data-test="window-size-slider"]')
    expect(slider.exists()).toBe(true)
    expect(slider.attributes('min')).toBe('6')
    expect(slider.attributes('max')).toBe('48')

    // Slide window to 12h
    await slider.setValue('12')
    expect(wrapper.find('.time-window-info').text()).toContain('共 12.0 小时')

    // Slide window to minimum 6h
    await slider.setValue('6')
    expect(wrapper.find('.time-window-info').text()).toContain('共 6.0 小时')
  })

  it('supports interactive dragging on overview track', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    // Set window to 12h so overview scrubber is rendered
    const slider = wrapper.find('[data-test="window-size-slider"]')
    await slider.setValue('12')

    const scrubber = wrapper.find('[data-test="gantt-overview-scrubber"]')
    expect(scrubber.exists()).toBe(true)
    expect(scrubber.text()).toContain('支持拖拽滑块实时滑动预览')
  })

  it('opens export modal for full sampling phase facility swimlane gantt chart and handles download', async () => {
    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report: createSampleReport() },
    })

    const exportBtn = wrapper.find('[data-test="export-gantt-btn"]')
    expect(exportBtn.exists()).toBe(true)

    await exportBtn.trigger('click')
    const modal = wrapper.find('[data-test="gantt-export-modal"]')
    expect(modal.exists()).toBe(true)
    expect(modal.text()).toContain('导出设施甘特图 (采样阶段完整长图)')
    expect(modal.text()).toContain('全周期共 48 小时')

    const scaleBtn = wrapper.find('[data-test="scale-btn-compact"]')
    expect(scaleBtn.exists()).toBe(true)
    await scaleBtn.trigger('click')

    const downloadBtn = wrapper.find('[data-test="download-gantt-btn"]')
    expect(downloadBtn.exists()).toBe(true)
    await downloadBtn.trigger('click')
  })

  it('renders backup plan event markers and allows jumping to backup events', async () => {
    const report = createSampleReport()
    report.events.push({
      time: 18.5,
      type: 'backup-plan' as any,
      operators: ['char_002_amiya'],
      active: true,
      backupName: '测试副表A',
      timing: 'AFTER_PLANNING',
    } as any)

    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report },
    })

    const jumpBtn = wrapper.find('[data-test="jump-backup-event-btn"]')
    expect(jumpBtn.exists()).toBe(true)
    expect(jumpBtn.text()).toContain('副表事件 (1次)')

    // Click jump to backup event
    await jumpBtn.trigger('click')
    expect(wrapper.find('.time-window-info').exists()).toBe(true)

    // Ruler marker exists
    const markers = wrapper.findAll('.event-marker')
    expect(markers.some(m => m.text().includes('🔄'))).toBe(true)
  })

  it('supports volume mode and adaptive scaling for 14-day (336h) long timelines', async () => {
    const report = createSampleReport()
    report.observedHours = 336
    report.elapsedHours = 336

    const wrapper = mount(ScheduleTimelineGantt, {
      props: { report },
    })

    const exportBtn = wrapper.find('[data-test="export-gantt-btn"]')
    await exportBtn.trigger('click')

    const modal = wrapper.find('[data-test="gantt-export-modal"]')
    expect(modal.exists()).toBe(true)
    expect(modal.text()).toContain('全周期共 336 小时')

    // Long cycle scope selector exists (>72h)
    const scopeSelector = wrapper.find('[data-test="scope-mode-selector"]')
    expect(scopeSelector.exists()).toBe(true)

    // Switch to volume mode (分卷超清)
    const volumeBtn = wrapper.find('[data-test="scope-btn-volume"]')
    await volumeBtn.trigger('click')

    const volumeSelect = wrapper.find('[data-test="volume-select"]')
    expect(volumeSelect.exists()).toBe(true)

    // Change volume
    await volumeSelect.setValue('1')
    expect(modal.text()).toContain('第 2 卷')
  })
})
