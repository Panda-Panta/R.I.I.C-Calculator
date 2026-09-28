import { describe, expect, it } from 'vitest'
import { getOrderDistribution } from '../rules/orderRules'
import { advanceOrder, finishOrder, startOrder } from './orderTimeline'

describe('order acquisition timeline', () => {
  it('preserves leftover wall time for fixed-efficiency orders even when live efficiency is zero', () => {
    const initial = startOrder({ id: 'pepe-zero', startedAt: 100, base: getOrderDistribution(3, 'normal', 'pepe')[0]! })
    const result = advanceOrder(initial, { elapsedMinutes: 300, efficiency: 0 })
    expect(result.completed).toBe(true)
    expect(result.unusedMinutes).toBe(30)
  })
  it('rejects completion timestamps before acquisition starts', () => {
    const initial = startOrder({ id: 'chronology', startedAt: 100, base: getOrderDistribution(1)[0]! })
    const result = advanceOrder(initial, { elapsedMinutes: 144, efficiency: 1 })
    expect(() => finishOrder(result.order, {}, 99)).toThrow(/completion/i)
  })
  it('integrates changing live efficiency and adds drones without multiplying them', () => {
    const base = getOrderDistribution(3)[0]!
    const initial = startOrder({ id: 'a', startedAt: 0, base })
    const first = advanceOrder(initial, { elapsedMinutes: 20, efficiency: 2 })
    const second = advanceOrder(first.order, { elapsedMinutes: 20, efficiency: 1, droneBaseMinutes: 30 })
    expect(initial.remainingBaseMinutes).toBe(144)
    expect(second.order.remainingBaseMinutes).toBe(54)
    expect(() => finishOrder(second.order, {}, 40)).toThrow(/unfinished/)
    const last = advanceOrder(second.order, { elapsedMinutes: 60, efficiency: 1 })
    expect(last.unusedMinutes).toBe(6)
    const snapshot = finishOrder(last.order, { proviso: 2 }, 94)
    expect(snapshot).toMatchObject({ id: 'a', startedAt: 0, completedAt: 94, goldCost: 4, lmdReward: 2000 })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })
  it('does not advance with zero efficiency and accounts for unused drone work', () => {
    const initial = startOrder({ id: 'b', startedAt: 0, base: getOrderDistribution(3)[0]! })
    expect(advanceOrder(initial, { elapsedMinutes: 15, efficiency: 0 }).order.remainingBaseMinutes).toBe(144)
    const finished = advanceOrder(initial, { elapsedMinutes: 0, efficiency: 0, droneBaseMinutes: 150 })
    expect(finished.completed).toBe(true)
    expect(finished.unusedDroneBaseMinutes).toBe(6)
    expect(() => advanceOrder(initial, { elapsedMinutes: 1, efficiency: NaN })).toThrow()
    expect(() => advanceOrder(initial, { elapsedMinutes: -1, efficiency: 1 })).toThrow()
  })
  it('uses fixed 100 percent efficiency for Pepe and does not rewrite waiting snapshots', () => {
    const initial = startOrder({ id: 'c', startedAt: 0, base: getOrderDistribution(3, 'normal', 'pepe')[0]! })
    const result = advanceOrder(initial, { elapsedMinutes: 270, efficiency: 4 })
    expect(result.unusedMinutes).toBe(0)
    const snapshot = finishOrder(result.order, { pepe: true }, 270)
    expect(snapshot.lmdReward).toBe(1000)
    expect(() => advanceOrder(initial, { elapsedMinutes: 0, efficiency: 1, droneBaseMinutes: 3 })).toThrow(/unverified/)
  })
})
