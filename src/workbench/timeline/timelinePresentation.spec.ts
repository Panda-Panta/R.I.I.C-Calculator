import { describe, expect, it } from 'vitest'
import {
  buildTimelineExportLayout,
  createTimelineAxis,
  type TimelineExportOptions,
} from './timelinePresentation'

function exportOptions(overrides: Partial<TimelineExportOptions> = {}): TimelineExportOptions {
  return {
    scopeMode: 'full',
    volumeDays: 3,
    selectedVolumeIndex: 0,
    customStart: 0,
    customEnd: 72,
    scaleMode: 'standard',
    ...overrides,
  }
}

describe('createTimelineAxis', () => {
  it('clips interval widths and positions to the selected window', () => {
    const axis = createTimelineAxis(24, 48, 'screen')
    expect(axis.duration).toBe(24)
    expect([axis.offsetPercent(12), axis.offsetPercent(30), axis.offsetPercent(72)]).toEqual([0, 25, 100])
    expect(axis.widthPercent(12, 30)).toBe(25)
    expect(axis.widthPercent(42, 60)).toBe(25)
    expect(axis.widthPercent(12, 60)).toBe(100)
    expect(axis.widthPercent(0, 12)).toBe(0)
    expect(axis.widthPercent(40, 36)).toBe(0)
  })

  it('retains different screen and export ruler density and day labels', () => {
    const screen = createTimelineAxis(24, 72, 'screen')
    const exported = createTimelineAxis(24, 72, 'export')
    expect(screen.ticks.map(tick => tick.time)).toEqual([24, 30, 36, 42, 48, 54, 60, 66, 72])
    expect(exported.ticks).toHaveLength(25)
    expect(exported.ticks[1]).toMatchObject({ time: 26, label: '02:00', isMajorDay: false })
    expect(exported.ticks[1]?.percent).toBeCloseTo(100 / 24)
    expect(screen.ticks[0]).toEqual({ time: 24, percent: 0, label: 'D2 00:00', isMajorDay: true })
    expect(screen.ticks[screen.ticks.length - 1]).toEqual({ time: 72, percent: 100, label: 'D4 00:00', isMajorDay: true })
    expect(createTimelineAxis(0, 336, 'screen').ticks).toHaveLength(15)
    expect(createTimelineAxis(0, 336, 'export').ticks).toHaveLength(43)
  })

  it('adds an export endpoint only after an existing tick with a gap over half an hour', () => {
    expect(createTimelineAxis(1, 7, 'screen').ticks.map(tick => tick.time)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const exported = createTimelineAxis(1, 7, 'export')
    expect(exported.ticks.map(tick => tick.time)).toEqual([2, 4, 6, 7])
    expect(exported.ticks[exported.ticks.length - 1]).toEqual({ time: 7, percent: 100, label: 'T+7h', isMajorDay: false })
    expect(createTimelineAxis(1, 6.5, 'export').ticks.map(tick => tick.time)).toEqual([2, 4, 6])
    expect(createTimelineAxis(0.1, 0.2, 'export').ticks).toEqual([])
  })

  it('keeps the minimum duration without moving an inverted or empty window', () => {
    const empty = createTimelineAxis(12, 12, 'screen')
    expect(empty.duration).toBe(0.1)
    expect(empty.widthPercent(0, 24)).toBe(0)
    const inverted = createTimelineAxis(48, 24, 'export')
    expect(inverted.duration).toBe(0.1)
    expect(inverted.ticks).toEqual([])
    expect(inverted.widthPercent(0, 72)).toBe(0)
  })
})

describe('buildTimelineExportLayout', () => {
  it.each([
    { hours: 48, pixelsPerHour: 100, trackWidthPx: 4800, totalWidthPx: 4990, pixelRatio: 2 },
    { hours: 336, pixelsPerHour: 41, trackWidthPx: 13776, totalWidthPx: 13966, pixelRatio: 1 },
  ])('lays out the full $hours-hour sampling period', ({ hours, ...expected }) => {
    const layout = buildTimelineExportLayout(hours, exportOptions())
    expect(layout).toMatchObject({ start: 0, end: hours, duration: hours, ...expected })
    expect(layout.filename).toBe(`基建排班甘特图_设施分道_采样全周期_0h-${hours}h.png`)
  })

  it('preserves the last partial volume and its day range and filename', () => {
    const layout = buildTimelineExportLayout(336, exportOptions({ scopeMode: 'volume', selectedVolumeIndex: 4 }))
    expect(layout.volumes.map(volume => [volume.start, volume.end])).toEqual([
      [0, 72], [72, 144], [144, 216], [216, 288], [288, 336],
    ])
    expect(layout.volumes[4]).toEqual({
      index: 4, start: 288, end: 336,
      label: '第 5 卷：第 13~14 天 (T+288h ~ T+336h)',
    })
    expect(layout).toMatchObject({ start: 288, end: 336, duration: 48, pixelsPerHour: 100, pixelRatio: 2 })
    expect(layout.filename).toBe('基建排班甘特图_设施分道_第5卷_T+288h-336h.png')
  })

  it('retains 12-hour minimum volumes and leaves selection correction to the caller', () => {
    const layout = buildTimelineExportLayout(30, exportOptions({
      scopeMode: 'volume', volumeDays: 0, selectedVolumeIndex: 5,
    }))
    expect(layout.volumes.map(volume => [volume.start, volume.end])).toEqual([[0, 12], [12, 24], [24, 30]])
    expect(layout).toMatchObject({ start: 0, end: 30, duration: 30 })
    expect(layout.filename).toBe('基建排班甘特图_设施分道_第6卷_T+0h-30h.png')
  })

  it('bounds custom endpoints while retaining the existing out-of-range start behavior', () => {
    const options = exportOptions({ scopeMode: 'custom', customStart: -5, customEnd: 400 })
    expect(buildTimelineExportLayout(336, options)).toMatchObject({ start: 0, end: 336, duration: 336 })
    const oneHour = buildTimelineExportLayout(336, { ...options, customStart: 24, customEnd: 12 })
    expect(oneHour).toMatchObject({ start: 24, end: 25, duration: 1 })
    expect(oneHour.filename).toBe('基建排班甘特图_设施分道_时段_T+24h-25h.png')
    expect(buildTimelineExportLayout(336, { ...options, customStart: 400, customEnd: 500 }))
      .toMatchObject({ start: 400, end: 336, duration: 0.1, trackWidthPx: 10 })
  })

  it('keeps scale density, image pixel ratio thresholds, and the 20px-per-hour floor', () => {
    expect(buildTimelineExportLayout(48, exportOptions({ scaleMode: 'compact' })))
      .toMatchObject({ pixelsPerHour: 50, trackWidthPx: 2400, totalWidthPx: 2590, pixelRatio: 2 })
    expect(buildTimelineExportLayout(96, exportOptions()))
      .toMatchObject({ pixelsPerHour: 100, totalWidthPx: 9790, pixelRatio: 1.5 })
    expect(buildTimelineExportLayout(1000, exportOptions()))
      .toMatchObject({ pixelsPerHour: 20, trackWidthPx: 20000, totalWidthPx: 20190, pixelRatio: 1 })
  })
})
