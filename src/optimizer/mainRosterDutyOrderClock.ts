import type { CompiledSchedule } from '../scheduler/types'
import type { RuntimeRates, RuntimeState } from '../scheduler/rosterRuntime'
import type { ProductionFrame } from '../simulator/productionTimeline'
import { getOrderDistribution, type OrderMode } from '../rules/orderRules'
import { hasOperatorSkill } from '../domain/operatorContext'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import { toMowerMicros } from '../scheduler/mowerTaskQueue'

interface OrderClockState { remainingBaseMinutes: number; mode: OrderMode; efficiencyAffected: boolean; completedOrders: number }

export function createMainRosterDutyOrderClock(
  schedule: CompiledSchedule, state: RuntimeState, frame: () => ProductionFrame,
): { rates: Pick<RuntimeRates, 'mowerRunOrderIO'>; advance: (hours: number, frame: ProductionFrame) => void; snapshot: () => Record<string, OrderClockState> } {
  // An expected-work clock only: no sampled orders, income, capacity or ledger.
  // Each completion immediately starts another mean order in the supplied frame.
  const fail = (reason: string): never => { throw new Error(`DUTY_ORDER_CLOCK_UNKNOWN: ${reason}`) }
  const rooms = new Map(schedule.rooms.filter(room => room.type === 'trading' && room.level > 0).map(room => [room.roomId, room]))
  const products = new Map<string, string>()
  let orders = new Map<string, OrderClockState>()
  const trade = (roomId: string, current: ProductionFrame) => {
    const source = rooms.get(roomId), matches = current.config.rooms.filter(room => room.id === roomId)
    const room = matches[0]
    if (!source || matches.length !== 1 || !room || room.type !== 'trading' || room.level !== source.level ||
      !['gold', 'orundum'].includes(room.strategy)) return fail(`unsupported trading room ${roomId}`)
    const desired = current.desiredProducts?.[roomId]
    if (products.has(roomId) && products.get(roomId) !== room.strategy || desired !== undefined && desired !== (room.strategy === 'orundum' ? 'orundum' : 'lmd')) return fail(`product switching ${roomId}`)
    return room
  }
  const skill = (current: ProductionFrame, actor: string, buff: string) => {
    const id = resolveOperatorCharId(actor)
    if (!current.config.operatorRecords?.[id]) return fail(`actual skill stage is missing for ${actor}`)
    return hasOperatorSkill(current.config, id, buff)
  }
  const acquire = (roomId: string, current: ProductionFrame, completedOrders: number): OrderClockState => {
    const room = trade(roomId, current), evaluation = current.evaluations[roomId]
    if (!evaluation || !['normal', 'alpha', 'beta'].includes(evaluation.quality) || evaluation.unquantifiedSkills.length) return fail(`unknown order distribution ${roomId}`)
    let mode: OrderMode = 'orundum'
    if (room.strategy !== 'orundum') {
      const physical = room.operatorIds.filter(actor => current.active.has(actor))
      const references = (state.config.runOrderPolicies ?? schedule.runOrderPolicies).find(policy => policy.roomId === roomId)?.orderedOperatorIds ?? []
      const actors = [...physical, ...references]
      const pepe = actors.some(actor => skill(current, actor, 'trade_ord_pepe[000]'))
      const closure = actors.some(actor => skill(current, actor, 'trade_ord_closure[000]'))
      mode = pepe ? 'pepe' : closure ? 'closure' : 'gold'
    }
    const distribution = getOrderDistribution(room.level, evaluation.quality, mode)
    const baseMinutes = distribution.reduce((sum, item) => sum + item.probability * item.baseMinutes, 0)
    const probability = distribution.reduce((sum, item) => sum + item.probability, 0)
    if (!Number.isFinite(baseMinutes) || baseMinutes <= 0 || Math.abs(probability - 1) > 1e-9) return fail(`invalid mean order ${roomId}`)
    return { remainingBaseMinutes: baseMinutes, mode, efficiencyAffected: mode !== 'pepe', completedOrders }
  }
  const efficiency = (roomId: string, order: OrderClockState, current: ProductionFrame): number => {
    trade(roomId, current)
    if (!order.efficiencyAffected) return 1
    const percent = current.evaluations[roomId]?.efficiencyPercent
    if (percent === undefined || !Number.isFinite(percent) || percent < 0) return fail(`unknown order efficiency ${roomId}`)
    return percent / 100
  }
  const initial = frame()
  for (const roomId of rooms.keys()) {
    products.set(roomId, trade(roomId, initial).strategy)
    orders.set(roomId, acquire(roomId, initial, 0))
  }
  const advance = (hours: number, current: ProductionFrame) => {
    if (!Number.isFinite(hours) || hours < 0) return fail('invalid elapsed hours')
    if (!hours) return
    // Commit all rooms together so an unknown frame cannot partially advance time.
    const next = new Map<string, OrderClockState>()
    for (const [roomId, previous] of orders) {
      const rate = efficiency(roomId, previous, current), work = hours * 60 * rate
      if (!Number.isFinite(work)) return fail(`order work overflow ${roomId}`)
      if (!rate || work < previous.remainingBaseMinutes - 1e-9) {
        next.set(roomId, { ...previous, remainingBaseMinutes: previous.remainingBaseMinutes - work }); continue
      }
      const unusedHours = Math.max(0, work - previous.remainingBaseMinutes) / rate / 60
      const opened = acquire(roomId, current, previous.completedOrders + 1), openedRate = efficiency(roomId, opened, current)
      const extraWork = unusedHours * 60 * openedRate, baseMinutes = opened.remainingBaseMinutes
      if (!Number.isFinite(extraWork)) return fail(`order work overflow ${roomId}`)
      // Within this constant joint frame every later expected order is identical;
      // skip complete mean cycles analytically instead of simulating production.
      let complete = Math.floor(extraWork / baseMinutes), residual = extraWork - complete * baseMinutes
      if (baseMinutes - residual <= 1e-9) { complete++; residual = 0 }
      opened.completedOrders += complete
      if (!Number.isSafeInteger(opened.completedOrders)) return fail(`order count overflow ${roomId}`)
      opened.remainingBaseMinutes = baseMinutes - residual
      next.set(roomId, opened)
    }
    orders = next
  }
  const rates: Pick<RuntimeRates, 'mowerRunOrderIO'> = { mowerRunOrderIO: request => {
    const delayMicros = request.kind === 'return-main' ? state.config.mowerDeviceTiming?.roomReturnMicros ?? 0 : 0
    if (!Number.isSafeInteger(delayMicros) || delayMicros < 0) return fail('invalid room return duration')
    return { delayMicros, observe: () => {
      if (!Number.isFinite(state.time) || state.time < 0) return fail('invalid observation clock')
      const observedAtMicros = toMowerMicros(state.time)
      if (request.kind === 'enter-room' || request.kind === 'return-main') {
        const ui = state.mowerUI ??= { scene: 'INFRA_MAIN', lastRoom: '' }
        ui.scene = request.kind === 'enter-room' ? 'INFRA_DETAILS' : 'INFRA_MAIN'
        if (request.kind === 'enter-room') ui.lastRoom = request.room
      }
      if (request.kind !== 'read-order') return { observedAtMicros }
      const order = orders.get(request.room)
      if (!order) return fail(`order timer unavailable ${request.room}`)
      const rate = efficiency(request.room, order, frame())
      if (rate <= 0) return fail(`order timer unavailable at zero efficiency ${request.room}`)
      const absoluteDueMicros = observedAtMicros + toMowerMicros(order.remainingBaseMinutes / rate / 60)
      if (!Number.isSafeInteger(absoluteDueMicros)) return fail(`order deadline overflow ${request.room}`)
      return { observedAtMicros, absoluteDueMicros }
    } }
  } }
  return { rates, advance, snapshot: () => Object.fromEntries([...orders].map(([roomId, order]) => [roomId, { ...order }])) }
}
