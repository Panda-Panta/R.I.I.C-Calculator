/**
 * Derivative work based on arknights-mower (PlanEditor.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { OPERATOR_MAP, OPERATORS, type OperatorRecord } from './operators'

const OPERATOR_BY_NAME = new Map<string, OperatorRecord>()
const OPERATOR_BY_APPELLATION = new Map<string, OperatorRecord>()

for (const op of OPERATORS) {
  OPERATOR_BY_NAME.set(op.name, op)
  OPERATOR_BY_APPELLATION.set(op.appellation.toLowerCase(), op)
}

/** Exact catalog-name lookup, without appellation or placeholder normalization. */
export function findOperatorByName(name: string): OperatorRecord | undefined {
  return OPERATOR_BY_NAME.get(name)
}

export function getOperatorName(identifier: string | null | undefined): string {
  if (!identifier) return ''
  if (identifier === 'Free' || identifier === 'free') return 'Free'
  if (identifier === 'Current' || identifier === 'current') return 'Current'
  const op =
    OPERATOR_MAP.get(identifier) ||
    OPERATOR_BY_NAME.get(identifier) ||
    OPERATOR_BY_APPELLATION.get(identifier.toLowerCase())
  return op ? op.name : identifier
}

export function resolveOperatorCharId(identifier: string): string {
  if (OPERATOR_MAP.has(identifier)) return identifier
  const byName = OPERATOR_BY_NAME.get(identifier)
  if (byName) return byName.charId
  const byAppellation = OPERATOR_BY_APPELLATION.get(identifier.toLowerCase())
  if (byAppellation) return byAppellation.charId
  return identifier
}

export function restoreOperatorMowerName(charIdOrName: string): string {
  const op = OPERATOR_MAP.get(charIdOrName)
  return op ? op.name : charIdOrName
}
