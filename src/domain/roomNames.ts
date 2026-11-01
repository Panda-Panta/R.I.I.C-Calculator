/**
 * Derivative work based on arknights-mower (PlanEditor.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import type { MowerFacilityType } from './roster'

const FACILITY_TYPE_NAMES: Record<string, string> = {
  manufacture: '制造站',
  trading: '贸易站',
  power: '发电站',
  dormitory: '宿舍',
  central: '控制中枢',
  meeting: '会客室',
  factory: '加工站',
  contact: '办公室',
  train: '训练室',
  recycle: '回收站',
  gaming: '活动室',
}

export function getRoomDisplayName(roomId: string, type?: MowerFacilityType | string): string {
  if (roomId.startsWith('room_')) {
    const parts = roomId.split('_')
    const floor = parts[1]
    const col = parts[2]
    const baseCode = `B${floor}0${col}`
    if (type && FACILITY_TYPE_NAMES[type]) {
      return `${baseCode} (${FACILITY_TYPE_NAMES[type]})`
    }
    return baseCode
  }
  if (roomId === 'central') return '控制中枢'
  if (roomId.startsWith('dormitory_') || roomId.startsWith('dorm_')) {
    const num = roomId.replace(/^(dormitory_|dorm_)/, '')
    return `宿舍${num}`
  }
  if (roomId === 'meeting') return '会客室'
  if (roomId === 'factory') return '加工站'
  if (roomId === 'contact') return '办公室'
  if (roomId === 'train') return '训练室'
  if (roomId === 'recycle') return '回收站'
  if (roomId.startsWith('gaming_')) {
    const num = roomId.replace('gaming_', '')
    return `活动室${num}`
  }
  return roomId
}
