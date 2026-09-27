import { describe, expect, it } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { calculate } from './calculate'

describe('base income calculator', () => {
  it('accepts a workaholic primary without an ordinary backup', () => {
    const config = createDefaultConfig()
    config.rooms[7]!.operatorIds = ['char_285_medic2']
    config.workaholicOperatorIds = ['char_285_medic2']

    const result = calculate(config)

    expect(result.layoutValid).toBe(true)
    expect(result.validationMessages).not.toContain('char_285_medic2 尚未设置替补干员。')
  })
  it('balances a fully upgraded 243 layout at 810 power', () => {
    const report = calculate(createDefaultConfig())
    expect(report.power).toEqual({ generation: 810, consumption: 810, margin: 0, sufficient: true })
    expect(report.summary).not.toBeNull()
  })

  it('produces 20 gold bars per day at 100 percent efficiency', () => {
    const config = createDefaultConfig()
    config.rooms[0] = { ...createRoom('B101', 'manufacture'), operatorCount: 0, product: 'gold' }
    const result = calculate(config).manufacture.find((room) => room.roomId === 'B101')
    expect(result?.count).toBeCloseTo(20)
    expect(result?.value).toBeCloseTo(10000)
  })

  it('reports a daily average independently of the simulation horizon', () => {
    const config = createDefaultConfig()
    config.hours = 24 * 30
    config.rooms[0] = { ...createRoom('B101', 'manufacture'), operatorCount: 0, product: 'gold' }
    const result = calculate(config).manufacture.find((room) => room.roomId === 'B101')
    expect(result?.count).toBeCloseTo(20)
    expect(result?.value).toBeCloseTo(10000)
  })

  it('uses a warmed-up long-term rotation for the daily efficiency', () => {
    const config = createDefaultConfig()
    const room = config.rooms[0]!
    room.operatorIds = ['char_4106_bryota']
    config.operatorBackups = { char_4106_bryota: 'char_502_nblade' }

    const result = calculate(config).manufacture.find((item) => item.roomId === room.id)!

    expect(result.efficiency).toBeCloseTo(1.26, 2)
  })

  it('produces 8000 EXP per day at 100 percent efficiency', () => {
    const config = createDefaultConfig()
    config.rooms[0] = { ...createRoom('B101', 'manufacture'), operatorCount: 0, product: 'exp' }
    const result = calculate(config).manufacture.find((room) => room.roomId === 'B101')
    expect(result?.count).toBeCloseTo(8)
    expect(result?.value).toBeCloseTo(8000)
  })

  it('produces 240 orundum from a level 3 source order post at 100 percent', () => {
    const config = createDefaultConfig()
    config.rooms[4] = { ...createRoom('B202', 'trading'), operatorCount: 0, strategy: 'orundum' }
    const result = calculate(config).trading.find((room) => room.roomId === 'B202')
    expect(result?.orders).toBeCloseTo(12)
    expect(result?.orundum).toBeCloseTo(240)
    expect(result?.fragmentsConsumed).toBeCloseTo(24)
  })

  it('blocks income when electricity is insufficient while retaining room results', () => {
    const config = createDefaultConfig()
    config.rooms[8] = createRoom('B303', 'manufacture')
    const report = calculate(config)
    expect(report.power.sufficient).toBe(false)
    expect(report.summary).toBeNull()
    expect(report.manufacture.length).toBeGreaterThan(0)
  })

  it('derives power-plant staffing and charging bonuses from selected operators', () => {
    const config = createDefaultConfig()
    expect(calculate(config).drones).toBeCloseTo(240)
    config.rooms.find((room) => room.type === 'power')!.operatorIds = ['char_377_gdglow']
    config.operatorBackups.char_377_gdglow = 'char_253_greyy'
    expect(calculate(config).drones).toBeCloseTo(300)
  })

  it('requires a unique backup for every configured primary operator', () => {
    const config = createDefaultConfig()
    config.rooms[0]!.operatorIds = ['char_4106_bryota', 'char_237_gravel']
    config.operatorBackups = { char_4106_bryota: 'char_502_nblade' }
    const report = calculate(config)
    expect(report.layoutValid).toBe(false)
    expect(report.summary).toBeNull()
    expect(report.validationMessages).toContain('char_237_gravel 尚未设置替补干员。')

    config.operatorBackups.char_237_gravel = 'char_502_nblade'
    expect(calculate(config).validationMessages).toContain('同一替补干员不能同时接替多个主力工位。')
  })

  it('combines Proviso beta and Tequila beta for level 3 shift-running orders', () => {
    const config = createDefaultConfig()
    const room = config.rooms[4]!
    room.specialOrder = 'shiftRun'
    const result = calculate(config).trading.find((item) => item.roomId === room.id)!
    expect(result.orders).toBeCloseTo(1440 / 203.4)
    // .3*(4 gold,2000) + .5*(5 gold,2500) + .2*(4 gold,2500).
    // Tequila does not also apply to Proviso's contract orders.
    expect(result.lmd / result.orders).toBeCloseTo(2350)
    expect(result.goldConsumed / result.orders).toBeCloseTo(4.5)
  })

  it('uses Proviso alone for level 1 and 2 shift-running orders', () => {
    const config = createDefaultConfig()
    const room = config.rooms[4]!
    room.level = 2
    room.specialOrder = 'shiftRun'
    const result = calculate(config).trading.find((item) => item.roomId === room.id)!
    expect(result.lmd / result.orders).toBeCloseTo(2200)
    expect(result.goldConsumed / result.orders).toBeCloseTo(4.4)
  })

  it('accounts Tequila bonus as virtual pure gold and includes it in 82 score', () => {
    const config = createDefaultConfig()
    const room = config.rooms[4]!
    room.level = 3
    room.specialOrder = 'shiftRun'
    const report = calculate(config)
    const trade = report.trading.find((item) => item.roomId === room.id)!

    // For level 3 standard quality: .2 of orders are 4-gold orders yielding +500 LMD without consuming gold
    expect(trade.virtualGold).toBeGreaterThan(0)
    expect(trade.virtualGoldValue).toBeCloseTo(trade.virtualGold! * 500)

    expect(report.summary).not.toBeNull()
    if (report.summary) {
      const expectedTotalVirtualGold = report.trading.reduce((sum, item) => sum + (item.virtualGold ?? 0), 0)
      expect(report.summary.virtualGoldCount).toBeCloseTo(expectedTotalVirtualGold)
      expect(report.summary.totalScore82).toBeCloseTo(
        report.summary.exp +
          0.8 * (report.summary.goldValue + report.summary.virtualGoldValue) +
          0.2 * report.summary.orderLmd,
      )
    }
  })
})
