import type { MowerRoomId } from '../domain/roster'
import { OPERATOR_MAP } from '../domain/operators'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'

/** A bounded, serializable generation contract, never written into native Mower JSON. */
export interface GeneratedBackupObserver {
  operatorId: string
  roomId: MowerRoomId
  requirePositiveMood?: boolean
}

export interface GeneratedBackupTrigger {
  observers: readonly GeneratedBackupObserver[]
  activeWhen: 'all-present' | 'not-all-present'
}

export interface GeneratedBackupDescriptor {
  version: 'joint-production-v1'
  trigger: GeneratedBackupTrigger
}

export const GENERATED_BACKUP_PLAN_NAME = '自动联动副表'
export const GENERATED_BACKUP_TIMING = 'AFTER_PLANNING'

/** Only this finite condition family is emitted by automatic generation v1. */
export function generatedBackupTriggerExpression(trigger: GeneratedBackupTrigger): string {
  if (!trigger || !Array.isArray(trigger.observers) || trigger.observers.length < 1 || trigger.observers.length > 2 ||
    Object.keys(trigger).some(key => !['observers', 'activeWhen'].includes(key)) ||
    !['all-present', 'not-all-present'].includes(trigger.activeWhen)) throw new Error('自动副表观察条件无效')
  const seen = new Set<string>()
  const conditions = trigger.observers.map(observer => {
    if (!observer || typeof observer.operatorId !== 'string' ||
      Object.keys(observer).some(key => !['operatorId', 'roomId', 'requirePositiveMood'].includes(key))) throw new Error('自动副表观察者无效')
    const id = resolveOperatorCharId(observer.operatorId)
    const operator = OPERATOR_MAP.get(id)
    if (!operator || seen.has(id) || !/^(?:room_[1-3]_[1-3]|central|meeting|factory|contact|train|recycle)$/.test(observer.roomId) ||
      observer.requirePositiveMood !== undefined && typeof observer.requirePositiveMood !== 'boolean') throw new Error('自动副表观察者无效')
    seen.add(id)
    const actor = `op_data.operators[${JSON.stringify(operator.name)}]`
    const present = `${actor}.current_room == ${JSON.stringify(observer.roomId)}`
    return observer.requirePositiveMood ? `(${present} and ${actor}.current_mood() > 0)` : `(${present})`
  })
  const expression = conditions.join(' and ')
  return trigger.activeWhen === 'all-present' ? expression : `not (${expression})`
}
