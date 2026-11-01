import { describe, expect, it } from 'vitest'
import { getRoomDisplayName } from './roomNames'

describe('room display names', () => {
  it('formats output room coordinates with the existing facility labels', () => {
    const labels: Record<string, string> = {
      manufacture: '制造站', trading: '贸易站', power: '发电站', dormitory: '宿舍',
      central: '控制中枢', meeting: '会客室', factory: '加工站', contact: '办公室',
      train: '训练室', recycle: '回收站', gaming: '活动室',
    }
    for (const [type, label] of Object.entries(labels)) {
      expect(getRoomDisplayName('room_2_3', type)).toBe(`B203 (${label})`)
    }
    expect(getRoomDisplayName('room_1_1')).toBe('B101')
    expect(getRoomDisplayName('room_1_1', 'unknown')).toBe('B101')
  })

  it('preserves functional facility names and numbered room aliases', () => {
    const labels = {
      central: '控制中枢', dormitory_2: '宿舍2', dorm_3: '宿舍3', meeting: '会客室',
      factory: '加工站', contact: '办公室', train: '训练室', recycle: '回收站', gaming_2: '活动室2',
    }
    for (const [room, label] of Object.entries(labels)) expect(getRoomDisplayName(room)).toBe(label)
  })

  it('returns unknown and differently cased room identifiers unchanged', () => {
    for (const room of ['', 'custom_room', 'Central', 'Room_1_1', 'gaming']) {
      expect(getRoomDisplayName(room)).toBe(room)
    }
  })
})
