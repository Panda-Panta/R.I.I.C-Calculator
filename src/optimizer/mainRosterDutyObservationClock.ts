import { hasOperatorSkill } from '../domain/operatorContext'
import { parseProduct, serializeProduct } from '../domain/mowerProducts'
import { evaluateManufacturingCapacity } from '../engine/operatorRules'
import { evaluateTradeOrderCapacity } from '../engine/orderCapacity'
import { evaluateRecycleEfficiency } from '../engine/supportFacilitySkills'
import type { CompiledSchedule } from '../scheduler/types'
import type { RuntimeState } from '../scheduler/rosterRuntime'
import { getOrderDistribution, selectBaseOrder, type OrderMode } from '../rules/orderRules'
import { advanceOrder, startOrder, type ActiveOrder } from '../simulator/orderTimeline'
import {
  MANUFACTURING_FORMULAS, advanceManufacturing, authorizeManufacturingBatch, collectManufacturing,
  nextManufacturingEvent, startManufacturing, updateManufacturingCapacity,
  type ManufacturingFormulaId, type ManufacturingState,
} from '../simulator/manufacturingTimeline'
import { createRecycleTimeline } from '../simulator/recycleTimeline'
import { createMowerClueIO } from '../simulator/mowerNativeClueIO'
import { createMowerProductionIO, type MowerProductionObservationSource } from '../simulator/mowerNativeProductionIO'
import type { ProductionFrame, ProductionOptions } from '../simulator/productionTimeline'
import type { ScheduleOrderClock } from '../simulator/scheduleSimulation'

interface TradeClock {
  roomId: string; product: 'lmd' | 'orundum'; active: ActiveOrder | null
  pending: number; completed: number; limit: number; rng: number
}
interface ManufactureClock { roomId: string; state: ManufacturingState }

/** Facility observations only: no resource balances, earnings, or production report. */
export function createMainRosterDutyObservationClock(
  schedule: CompiledSchedule, state: RuntimeState, frame: () => ProductionFrame,
  options: { seed: number; fragmentFormulaByRoom?: ProductionOptions['fragmentFormulaByRoom'] },
) {
  const EPS = 1e-8
  const fail = (reason: string): never => { throw new Error(`DUTY_OBSERVATION_CLOCK_UNSUPPORTED: ${reason}`) }
  const seed = options.seed
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) fail('invalid observation seed')
  const sources = new Map(schedule.rooms.filter(room => room.level > 0 && ['manufacture', 'trading'].includes(room.type)).map(room => [room.roomId, room]))
  const trades = new Map<string, TradeClock>(), manufactures = new Map<string, ManufactureClock>()
  const original = frame(), recycleLevel = original.config.facilities.recycle ?? 0
  const recycle = recycleLevel ? createRecycleTimeline(recycleLevel) : undefined
  const products = new Map(original.config.rooms.filter(room => sources.has(room.id)).map(room => [room.id, {
    product: room.type === 'trading' ? room.strategy : room.product, desired: original.desiredProducts?.[room.id],
  }]))
  const capacityCache = new WeakMap<ProductionFrame['evaluations'], Map<string, { moodBand: string; bonus: number }>>()
  const roomAt = (roomId: string, current: ProductionFrame) => current.config.rooms.find(room => room.id === roomId) ?? fail(`missing facility ${roomId}`)
  const efficiency = (roomId: string, current: ProductionFrame) => {
    const value = current.evaluations[roomId]?.efficiencyPercent
    if (value === undefined || !Number.isFinite(value) || value < 0) return fail(`unknown efficiency ${roomId}`)
    return value / 100
  }
  const validate = (current: ProductionFrame) => {
    if ((current.config.facilities.recycle ?? 0) !== recycleLevel) fail('recycle level changed')
    const seen = new Set<string>()
    for (const room of current.config.rooms) if (room.type === 'manufacture' || room.type === 'trading') {
      const source = sources.get(room.id), product = products.get(room.id)
      if (!source || !product || source.type !== room.type || source.level !== room.level || seen.has(room.id)) fail(`unsupported facility ${room.id}`)
      seen.add(room.id)
      const desired = current.desiredProducts?.[room.id]
      if ((room.type === 'trading' ? room.strategy : room.product) !== product!.product ||
        desired !== undefined && product!.desired !== undefined && desired !== product!.desired) fail(`product switching ${room.id}`)
      const expected = room.type === 'trading' ? (room.strategy === 'orundum' ? 'orundum' : 'money') : room.product
      if (desired !== undefined && parseProduct(desired) !== expected) fail(`unknown product ${room.id}`)
      if (!current.evaluations[room.id] || current.evaluations[room.id]!.unquantifiedSkills.length) fail(`unknown facility evaluation ${room.id}`)
      efficiency(room.id, current)
    }
    if (seen.size !== sources.size) fail('missing production facility')
  }
  const synchronize = (current: ProductionFrame) => {
    validate(current)
    for (const room of current.config.rooms) {
      if (room.type === 'manufacture') {
        let m = manufactures.get(room.id)
        if (!m) {
          const formula: ManufacturingFormulaId = room.product === 'exp' ? 'exp-medium' : room.product === 'fragment'
            ? options.fragmentFormulaByRoom?.[room.id] ?? (schedule.sourceWorkspace.compatibility.facilityMetadata?.[room.id]?.rawProduct === 'orirock_device' ? 'fragment-device' : 'fragment-orirock') : 'gold'
          if (room.level < MANUFACTURING_FORMULAS[formula].requiredRoomLevel) fail(`manufacturing formula level ${room.id}`)
          m = { roomId: room.id, state: startManufacturing({ formula, capacityWeight: 0, paymentAuthorized: false }) }
          manufactures.set(room.id, m)
        }
        let cachedRooms = capacityCache.get(current.evaluations)
        if (!cachedRooms) { cachedRooms = new Map(); capacityCache.set(current.evaluations, cachedRooms) }
        const moodBand = room.operatorIds.map(id => Number((current.morale.get(id) ?? 24) < 12)).join('')
        let cached = cachedRooms.get(room.id)
        if (!cached || cached.moodBand !== moodBand) {
          cached = { moodBand, bonus: evaluateManufacturingCapacity(room, current.config, current.active, current.morale) }
          cachedRooms.set(room.id, cached)
        }
        m.state = updateManufacturingCapacity(m.state, Math.max(0, [24, 36, 54][room.level - 1]! + cached.bonus))
      } else if (room.type === 'trading') {
        let t = trades.get(room.id)
        if (!t) {
          if (!['gold', 'orundum'].includes(room.strategy)) fail(`unknown trade product ${room.id}`)
          let hash = seed
          for (const character of room.id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
          t = { roomId: room.id, product: room.strategy === 'orundum' ? 'orundum' : 'lmd', active: null, pending: 0, completed: 0, limit: 0, rng: hash }
          trades.set(room.id, t)
        }
        const capacity = evaluateTradeOrderCapacity(room, current.config, current.active, current.evaluations[room.id]!)
        if (capacity.limit === null) fail(`unknown trade capacity ${room.id}: ${capacity.unquantified.join('; ')}`)
        t.limit = capacity.limit!
      }
    }
  }
  const hasSkill = (current: ProductionFrame, actor: string, buff: string) => {
    if (!current.config.operatorRecords?.[actor]) return fail(`actual skill stage is missing for ${actor}`)
    return hasOperatorSkill(current.config, actor, buff)
  }
  const finish = () => {
    for (const t of trades.values()) if (t.active && t.active.remainingBaseMinutes <= EPS) {
      t.pending++; t.completed++; t.active = null
    }
  }
  const openWork = (current: ProductionFrame) => {
    for (const m of manufactures.values()) if (m.state.awaitingPayment && m.state.storedWeight + m.state.formula.storageWeight <= m.state.capacityWeight + EPS) {
      m.state = authorizeManufacturingBatch(m.state, true).state
    }
    for (const t of trades.values()) if (!t.active && t.pending < t.limit) {
      const room = roomAt(t.roomId, current), evaluation = current.evaluations[t.roomId]!
      if (!['normal', 'alpha', 'beta'].includes(evaluation.quality)) fail(`unknown order distribution ${t.roomId}`)
      const references = (state.config.runOrderPolicies ?? schedule.runOrderPolicies).find(policy => policy.roomId === t.roomId)?.orderedOperatorIds ?? []
      const actors = [...room.operatorIds.filter(actor => current.active.has(actor)), ...references]
      const mode: OrderMode = t.product === 'orundum' ? 'orundum' : actors.some(actor => hasSkill(current, actor, 'trade_ord_pepe[000]')) ? 'pepe'
        : actors.some(actor => hasSkill(current, actor, 'trade_ord_closure[000]')) ? 'closure' : 'gold'
      t.rng = (Math.imul(1664525, t.rng) + 1013904223) >>> 0
      const base = selectBaseOrder(getOrderDistribution(room.level, evaluation.quality, mode), t.rng / 4294967296)
      t.active = startOrder({ id: `${t.roomId}:${t.completed + 1}`, startedAt: state.time, base })
    }
  }
  const settle = (current: ProductionFrame) => {
    synchronize(current); finish(); synchronize(current); openWork(current)
  }
  const nextStep = (maximum: number, getFrame: (offset: number) => ProductionFrame) => {
    if (!Number.isFinite(maximum) || maximum < 0) return fail('invalid next interval')
    let dt = maximum
    const zero = getFrame(0)
    if (recycle) dt = Math.min(dt, recycle.nextEventHours(evaluateRecycleEfficiency(zero.config, { activeIds: zero.active }).efficiencyPercent))
    const crosses = (hours: number) => {
      const current = getFrame(hours / 2)
      for (const m of manufactures.values()) {
        const remaining = nextManufacturingEvent(m.state)
        if (remaining !== null && hours * 60 * efficiency(m.roomId, current) >= remaining) return true
      }
      for (const t of trades.values()) if (t.active && hours * 60 * (t.active.base.efficiencyAffected ? efficiency(t.roomId, current) : 1) >= Math.max(0, t.active.remainingBaseMinutes)) return true
      return false
    }
    if (crosses(dt)) {
      let lo = 0, hi = dt
      for (let n = 0; n < 48; n++) { const mid = (lo + hi) / 2; if (crosses(mid)) hi = mid; else lo = mid }
      dt = hi
    }
    return dt
  }
  const advance = (hours: number, current: ProductionFrame) => {
    if (!Number.isFinite(hours) || hours < 0) fail('invalid elapsed hours')
    validate(current)
    for (const roomId of sources.keys()) if (!Number.isFinite(hours * 60 * efficiency(roomId, current))) fail(`work overflow ${roomId}`)
    for (const m of manufactures.values()) m.state = advanceManufacturing(m.state, hours * 60 * efficiency(m.roomId, current)).state
    for (const t of trades.values()) if (t.active) t.active = advanceOrder(t.active, { elapsedMinutes: hours * 60, efficiency: efficiency(t.roomId, current) }).order
    if (recycle) recycle.advance(hours, evaluateRecycleEfficiency(current.config, { activeIds: current.active }).efficiencyPercent)
  }
  const noDrones = (): never => fail('drone task requested in none-drone observation calendar')
  const source: MowerProductionObservationSource = {
    nativeRemainingSeconds: (roomId, current) => {
      const t = trades.get(roomId) ?? fail(`trade timer unavailable ${roomId}`)
      if (!t.active) return 0
      const speed = t.active.base.efficiencyAffected ? efficiency(roomId, current) : 1
      if (!speed) return fail(`trade timer unavailable at zero efficiency ${roomId}`)
      return Math.max(0, t.active.remainingBaseMinutes / speed * 60)
    },
    nativePendingTradeOrders: roomId => [...trades.values()].filter(t => roomId === undefined || t.roomId === roomId).reduce((count, t) => count + t.pending, 0),
    nativePendingManufacturingItems: () => [...manufactures.values()].reduce((count, m) => count + m.state.pendingItems, 0),
    nativePendingRecycleItems: () => recycle?.report().pendingItems ?? 0,
    nativeCollectTradeOrders: current => { finish(); for (const t of trades.values()) t.pending = 0; openWork(current) },
    nativeCollectManufacturingItems: current => { finish(); for (const m of manufactures.values()) m.state = collectManufacturing(m.state).state; openWork(current) },
    nativeCollectRecycleItems: () => { recycle?.collect() },
    nativeAcceptOrder: (roomId, current) => {
      finish()
      const t = trades.get(roomId) ?? fail(`trade receipt unavailable ${roomId}`), accepted = t.pending > 0
      if (accepted) t.pending--
      openWork(current); return accepted
    },
    nativeHasTrade: roomId => trades.has(roomId), nativeHasManufacture: roomId => manufactures.has(roomId), nativeDroneCount: () => 0,
    nativeManufactureDroneMaximum: noDrones, nativeSpendManufacturingDrones: noDrones,
    nativeTradeDroneAvailable: noDrones, nativeTradeRequiredDrones: noDrones, nativeSpendTradeDrones: noDrones,
  }
  const facilityProducts = Object.fromEntries(Object.values(schedule.sourceWorkspace.mainPlan.facilities).map(room => {
    const raw = schedule.sourceWorkspace.compatibility.facilityMetadata?.[room.roomId]?.rawProduct
    return [room.roomId, typeof raw === 'string' && parseProduct(raw) === room.product ? raw : serializeProduct(room.type, room.product) ?? null]
  }))
  Object.defineProperties(state, {
    mowerFacilityProducts: { configurable: true, enumerable: true, get: () => ({ ...facilityProducts }) },
    mowerFacilityTypes: { configurable: true, enumerable: true, get: () => Object.fromEntries(frame().config.rooms.map(room => [room.id, room.type === 'trading' ? 'trade' : room.type])) },
  })
  settle(original)
  const clock = {
    rates: { ...createMowerClueIO(state), ...createMowerProductionIO(state, source, frame) }, advance, settle, nextStep,
    diagnostics: [
      { code: 'DUTY_SAMPLED_OBSERVATION_CALENDAR', message: 'Seeded facility timers, finite queues and shared native notification/clue observations; infinite materials and no drones. No income ledger or complete production report; Native parity is not established.' },
      { code: 'DUTY_OBSERVATION_SEED', message: String(seed) },
    ],
    snapshot: () => ({
      trading: Object.fromEntries([...trades].map(([roomId, t]) => [roomId, { product: t.product, completedOrders: t.completed, pendingOrders: t.pending, capacity: t.limit, mode: t.active?.base.mode ?? null, remainingBaseMinutes: t.active?.remainingBaseMinutes ?? null, baseMinutes: t.active?.base.baseMinutes ?? null }])),
      manufacturing: Object.fromEntries([...manufactures].map(([roomId, m]) => [roomId, structuredClone(m.state)])),
      ...(recycle ? { recycle: recycle.report() } : {}),
    }),
  } satisfies ScheduleOrderClock & { snapshot(): unknown }
  return clock
}
