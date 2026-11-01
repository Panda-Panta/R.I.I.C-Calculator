export interface TimelineRulerTick {
  time: number
  percent: number
  label: string
  isMajorDay: boolean
}

export interface TimelineAxis {
  duration: number
  ticks: TimelineRulerTick[]
  offsetPercent(time: number): number
  widthPercent(start: number, end: number): number
}

export interface TimelineExportVolume {
  index: number
  start: number
  end: number
  label: string
}

export interface TimelineExportOptions {
  scopeMode: 'full' | 'volume' | 'custom'
  volumeDays: number
  selectedVolumeIndex: number
  customStart: number
  customEnd: number
  scaleMode: 'standard' | 'compact'
}

export interface TimelineExportLayout {
  volumes: TimelineExportVolume[]
  start: number
  end: number
  duration: number
  pixelsPerHour: number
  trackWidthPx: number
  totalWidthPx: number
  pixelRatio: number
  filename: string
}

/** Coordinates and ruler labels for an already-selected display window. */
export function createTimelineAxis(start: number, end: number, mode: 'screen' | 'export'): TimelineAxis {
  const duration = Math.max(0.1, end - start)
  const offsetPercent = (time: number): number => {
    const relative = time - start
    return Math.max(0, Math.min(100, (relative / duration) * 100))
  }
  const widthPercent = (intervalStart: number, intervalEnd: number): number => {
    const clippedStart = Math.max(start, intervalStart)
    const clippedEnd = Math.min(end, intervalEnd)
    if (clippedEnd <= clippedStart) return 0
    return ((clippedEnd - clippedStart) / duration) * 100
  }

  let step: number
  if (mode === 'export') {
    step = duration <= 72 ? 2 : duration <= 168 ? 4 : duration <= 336 ? 8 : 12
  } else {
    step = duration <= 6 ? 1 : duration <= 12 ? 2 : duration <= 24 ? 3 : duration <= 48 ? 6 : duration <= 120 ? 12 : 24
  }

  const ticks: TimelineRulerTick[] = []
  const firstTick = Math.ceil(start / step) * step
  for (let time = firstTick; time <= end; time += step) {
    const isMajorDay = time % 24 === 0
    const day = Math.floor(time / 24) + 1
    const hourInDay = time % 24
    const label = isMajorDay
      ? `D${day} 00:00`
      : `${hourInDay < 10 ? '0' + hourInDay : hourInDay}:00`
    ticks.push({ time, percent: offsetPercent(time), label, isMajorDay })
  }

  const lastTick = ticks[ticks.length - 1]
  if (mode === 'export' && lastTick && end - lastTick.time > 0.5) {
    ticks.push({
      time: end,
      percent: 100,
      label: `T+${end.toFixed(0)}h`,
      isMajorDay: end % 24 === 0,
    })
  }
  return { duration, ticks, offsetPercent, widthPercent }
}

/** Export sizing and labels; selected-volume state remains owned by the caller. */
export function buildTimelineExportLayout(observedHours: number, options: TimelineExportOptions): TimelineExportLayout {
  const volumeHours = Math.max(12, options.volumeDays * 24)
  const volumeCount = Math.ceil(observedHours / volumeHours)
  const volumes: TimelineExportVolume[] = []
  for (let index = 0; index < volumeCount; index++) {
    const start = index * volumeHours
    const end = Math.min(observedHours, start + volumeHours)
    const startDay = Math.floor(start / 24) + 1
    const endDay = Math.ceil(end / 24)
    volumes.push({
      index,
      start,
      end,
      label: `第 ${index + 1} 卷：第 ${startDay}~${endDay} 天 (T+${start.toFixed(0)}h ~ T+${end.toFixed(0)}h)`,
    })
  }

  let start = 0
  let end = observedHours
  if (options.scopeMode === 'volume') {
    const volume = volumes[options.selectedVolumeIndex]
    start = volume ? volume.start : 0
    end = volume ? volume.end : observedHours
  } else if (options.scopeMode === 'custom') {
    start = Math.max(0, options.customStart)
    end = Math.min(observedHours, Math.max(start + 1, options.customEnd))
  }

  const duration = Math.max(0.1, end - start)
  const base = options.scaleMode === 'compact' ? 50 : 100
  const maxTrackWidth = 14000
  const pixelsPerHour = duration * base > maxTrackWidth
    ? Math.max(20, Math.floor(maxTrackWidth / duration))
    : base
  const trackWidthPx = Math.round(duration * pixelsPerHour)
  const totalWidthPx = 190 + trackWidthPx
  const pixelRatio = totalWidthPx * 2 <= 16000 ? 2 : totalWidthPx * 1.5 <= 16000 ? 1.5 : 1

  let filename: string
  if (options.scopeMode === 'volume') {
    filename = `基建排班甘特图_设施分道_第${options.selectedVolumeIndex + 1}卷_T+${start.toFixed(0)}h-${end.toFixed(0)}h.png`
  } else if (options.scopeMode === 'custom') {
    filename = `基建排班甘特图_设施分道_时段_T+${start.toFixed(0)}h-${end.toFixed(0)}h.png`
  } else {
    filename = `基建排班甘特图_设施分道_采样全周期_0h-${observedHours.toFixed(0)}h.png`
  }

  return { volumes, start, end, duration, pixelsPerHour, trackWidthPx, totalWidthPx, pixelRatio, filename }
}
