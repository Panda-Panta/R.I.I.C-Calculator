/**
 * Derivative work based on arknights-mower (PlanEditor.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { getOperatorName } from './operatorIdentifiers'
import { isTradeRunOrderOperator } from './shiftRunPolicy'

export function isRunOrderOperator(identifier: string | null | undefined): boolean {
  if (!identifier) return false
  return isTradeRunOrderOperator(getOperatorName(identifier))
}

export function isProviso(identifier: string | null | undefined): boolean {
  if (!identifier) return false
  const name = getOperatorName(identifier)
  return name === '但书'
}

export function isFiammetta(identifier: string | null | undefined): boolean {
  if (!identifier) return false
  const name = getOperatorName(identifier)
  return name === '菲亚梅塔'
}
