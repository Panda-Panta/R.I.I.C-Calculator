import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { calculate } from './calculate'
import type { QualityRule, SpecialOrder } from '../domain/types'

function perOrder(specialOrder: SpecialOrder, quality: QualityRule = 'normal') {
  const config = createDefaultConfig()
  const room = config.rooms.find((value) => value.type === 'trading')!
  room.specialOrder = specialOrder
  room.quality = quality
  const trade = calculate(config).trading.find((value) => value.roomId === room.id)!
  return { gold: trade.goldConsumed / trade.orders, lmd: trade.lmd / trade.orders }
}

describe('source-backed mutually exclusive order transforms', () => {
  it('applies Proviso only below four base gold and Tequila only to the remaining four-gold order', () => {
    // Ordinary L3 probabilities: .3/.5/.2. Contracts: 4/2000, 5/2500, 4/2500.
    expect(perOrder('shiftRun')).toEqual({ gold: 4.5, lmd: 2350 })
  })
  it('leaves base four-gold orders unchanged for Proviso alone', () => {
    const result = perOrder('provisoBeta')
    expect(result.gold).toBeCloseTo(4.5)
    expect(result.lmd).toBeCloseTo(2250)
  })
  it('adds Tequila reward only to base orders above three gold', () => {
    const result = perOrder('tequilaBeta')
    expect(result.gold).toBeCloseTo(2.9)
    expect(result.lmd).toBeCloseTo(1550)
  })
  it('uses the base quality probabilities before mutually exclusive transformations', () => {
    const result = perOrder('shiftRun', 'beta')
    expect(result.gold).toBeCloseTo(4.1)
    expect(result.lmd).toBeCloseTo(2475)
  })
  it('reports Pepe fixed throughput without applying room efficiency or unverified trading drones', () => {
    const config = createDefaultConfig()
    const room = config.rooms.find(value => value.type === 'trading')!
    room.specialOrder = 'pepe'
    room.skillBonus = 80
    config.droneTarget = room.id
    const result = calculate(config).trading.find(value => value.roomId === room.id)!
    expect(result.efficiency).toBe(1)
    expect(result.orders).toBeCloseTo(1440 / 270)
    expect(result.droneExtraOrders).toBe(0)
    expect(result.goldConsumed).toBe(0)
    expect(result.virtualGold! / result.orders).toBeCloseTo(2)
  })
  it.each([
    ['closure', .4],
    ['tequilaAlpha', .1],
    ['tequilaBeta', .2],
  ] as const)('converts %s order premium to report-only gold', (special, virtualPerOrder) => {
    const config = createDefaultConfig()
    const room = config.rooms.find(value => value.type === 'trading')!
    room.specialOrder = special
    const trade = calculate(config).trading.find(value => value.roomId === room.id)!
    expect(trade.virtualGold! / trade.orders).toBeCloseTo(virtualPerOrder)
  })
  it('keeps U-Official base duration distribution with fixed two-gold rewards', () => {
    const result = perOrder('uofficial')
    expect(result.gold).toBeCloseTo(2)
    expect(result.lmd).toBeCloseTo(1000)
  })
})
