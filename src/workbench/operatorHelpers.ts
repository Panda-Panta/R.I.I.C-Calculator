/**
 * Derivative work based on arknights-mower (PlanEditor.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { match, pinyin } from 'pinyin-pro'
import { OPERATOR_MAP, type OperatorRecord } from '../domain/operators'
import { findOperatorByName } from '../domain/operatorIdentifiers'
import { getRoomDisplayName } from '../domain/roomNames'
import type { MowerCompatibilityEnvelope, MowerMainPlan, MowerRoomId } from '../domain/roster'
import { operatorReplacementLocations } from './operatorReplacement'
import { resolveAssetUrl } from '../utils/assets'
export { resolveAssetUrl, getRoomDisplayName }
export { getOperatorName } from '../domain/operatorIdentifiers'
export { isRunOrderOperator, isProviso, isFiammetta } from '../domain/operatorRoles'

export interface OperatorSearchItem extends OperatorRecord {
  fullPinyin: string
  firstLetters: string
}

export function buildOperatorSearchIndex(operators: OperatorRecord[]): OperatorSearchItem[] {
  return operators.map((op) => {
    const domainOp = OPERATOR_MAP.get(op.charId) || findOperatorByName(op.name)
    const appellation = op.appellation || domainOp?.appellation || ''
    const fullPinyin = pinyin(op.name, { toneType: 'none', separator: '' }).toLowerCase()
    const firstLetters = pinyin(op.name, { pattern: 'first', toneType: 'none', separator: '' }).toLowerCase()
    return {
      ...op,
      appellation,
      fullPinyin,
      firstLetters,
    }
  })
}

export function searchOperators(
  query: string,
  index: OperatorSearchItem[],
  limit: number = 60,
): OperatorSearchItem[] {
  const rawQ = query.trim().toLowerCase()
  if (!rawQ) {
    return limit > 0 ? index.slice(0, limit) : index
  }

  const qPinyin = rawQ.replace(/v/g, 'ü')
  const rawClean = rawQ.replace(/[\s\-_'.]/g, '')

  const matched: Array<{ item: OperatorSearchItem; score: number }> = []

  for (const item of index) {
    const nameLower = item.name.toLowerCase()
    const appLower = (item.appellation || '').toLowerCase()
    const appClean = appLower.replace(/[\s\-_'.]/g, '')
    const charIdLower = item.charId.toLowerCase()
    const pinyinLower = item.fullPinyin.toLowerCase()
    const pinyinV = pinyinLower.replace(/ü/g, 'v')
    const firstLower = item.firstLetters.toLowerCase()

    let score = -1

    if (nameLower === rawQ) {
      score = 100
    } else if (nameLower.startsWith(rawQ)) {
      score = 80
    } else if (nameLower.includes(rawQ)) {
      score = 60
    } else if (firstLower === rawQ || firstLower === qPinyin) {
      score = 55
    } else if (firstLower.startsWith(rawQ) || firstLower.startsWith(qPinyin)) {
      score = 45
    } else if (firstLower.includes(rawQ) || firstLower.includes(qPinyin)) {
      score = 35
    } else if (pinyinLower === rawQ || pinyinLower === qPinyin || pinyinV === rawQ) {
      score = 50
    } else if (pinyinLower.startsWith(rawQ) || pinyinLower.startsWith(qPinyin) || pinyinV.startsWith(rawQ)) {
      score = 40
    } else if (pinyinLower.includes(rawQ) || pinyinLower.includes(qPinyin) || pinyinV.includes(rawQ)) {
      score = 30
    } else if (appLower === rawQ || (appClean.length > 0 && appClean === rawClean)) {
      score = 48
    } else if (appLower.startsWith(rawQ) || (rawClean.length >= 2 && appClean.startsWith(rawClean))) {
      score = 38
    } else if (appLower.includes(rawQ) || (rawClean.length >= 2 && appClean.includes(rawClean))) {
      score = 28
    } else if (charIdLower.includes(rawQ)) {
      score = 20
    } else {
      const pMatch = match(item.name, rawQ, { v: true }) ?? match(item.name, qPinyin)
      if (pMatch !== null && pMatch.length > 0) {
        score = 25
      }
    }

    if (score >= 0) {
      matched.push({ item, score })
    }
  }

  matched.sort((a, b) => b.score - a.score || b.item.rarity - a.item.rarity)
  const res = matched.map((m) => m.item)
  return limit > 0 ? res.slice(0, limit) : res
}

export function getOperatorAvatarUrl(identifier: string): string {
  if (!identifier) return ''
  if (identifier === 'Free') return resolveAssetUrl('avatar/Free.webp')
  if (identifier === 'Current') return resolveAssetUrl('avatar/Current.webp')
  const op = OPERATOR_MAP.get(identifier)
  const name = op ? op.name : identifier
  return resolveAssetUrl(`avatar/${encodeURI(name)}.webp`)
}

export function getAssignedSummaryMap(mainPlan: MowerMainPlan): Map<string, string> {
  const map = new Map<string, string>()
  if (!mainPlan || !mainPlan.facilities) return map

  for (const roomId of Object.keys(mainPlan.facilities) as MowerRoomId[]) {
    const facility = mainPlan.facilities[roomId]
    if (!facility) continue
    const roomName = getRoomDisplayName(facility.roomId, facility.type)
    for (const slot of facility.slots) {
      if (slot.occupant.kind === 'operator' && slot.occupant.operatorId) {
        map.set(slot.occupant.operatorId, roomName)
        const op = OPERATOR_MAP.get(slot.occupant.operatorId)
        if (op) {
          map.set(op.name, roomName)
        }
      }
    }
  }

  return map
}

export interface OperatorScopeLocation {
  roomId: MowerRoomId
  roomName: string
  slotIndex: number
}

export interface ReplacementScopeResult {
  totalCount: number
  mainLocations: OperatorScopeLocation[]
  replacementLocations: OperatorScopeLocation[]
  confLocations: string[]
  additionalLocations?: string[]
}

export function computeReplacementScope(
  mainPlan: MowerMainPlan,
  operatorId: string,
  compatibility?: MowerCompatibilityEnvelope,
): ReplacementScopeResult {
  const locations = mainPlan ? operatorReplacementLocations(mainPlan, operatorId, compatibility) : []
  const slotLocation = (location: (typeof locations)[number]): OperatorScopeLocation => ({
    roomId: location.roomId!, slotIndex: location.slotIndex!,
    roomName: getRoomDisplayName(location.roomId!, mainPlan.facilities[location.roomId!]?.type),
  })
  return {
    totalCount: locations.length,
    mainLocations: locations.filter(location => location.kind === 'main').map(slotLocation),
    replacementLocations: locations.filter(location => location.kind === 'replacement').map(slotLocation),
    confLocations: locations.filter(location => location.kind === 'conf').map(location => location.label),
    additionalLocations: locations.filter(location => location.kind === 'additional').map(location => location.label),
  }
}
