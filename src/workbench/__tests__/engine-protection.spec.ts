import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { calculate } from '../../engine/calculate'
import { createDefaultConfig } from '../../domain/defaults'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fileSha256(relativePath: string): string {
  const fullPath = resolve(__dirname, '../../', relativePath)
  const content = readFileSync(fullPath, 'utf-8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(content).digest('hex')
}

describe('Engine Protection & Calculation Equivalence', () => {
  it('protects engine source files against unauthorized modifications', () => {
    // Authorized 2026-10-14 changes reuse PR10 exhausted Abyssal grants and add
    // the 45/90% Gladiia stage cap. Mainline 1092f3f also incorporates PR20's
    // Ling/Sui consumption reset. The current Mower import preserves all three
    // engine files from that accepted baseline. Hashes are normalized to LF.
    expect(fileSha256('engine/calculate.ts')).toBe('34739fc18ac6f96af10dda40d03e3b0fe92a698b8556dd4dfd905998ce345c4a')
    expect(fileSha256('engine/morale.ts')).toBe('26e1e6f229430619eed7ef31cfaf1fa334380bce5270d2ffe5692099bfcf338f')
    expect(fileSha256('engine/operatorRules.ts')).toBe('c07812ea02bed35cf503e2acbcba399cf1915b0413e7c72d59befb9e70fa26a0')
  })

  it('produces deterministic baseline report for default configuration', () => {
    const config = createDefaultConfig()
    const report1 = calculate(config)
    const report2 = calculate(config)

    expect(report2).toEqual(report1)
    expect(report1.power).toEqual({ generation: 810, consumption: 810, margin: 0, sufficient: true })
    expect(report1.layoutValid).toBe(true)
    expect(report1.validationMessages).toEqual([])
    expect(report1.drones).toBe(240)
    expect(report1.manufacture).toHaveLength(4)
    expect(report1.trading).toHaveLength(2)
    expect(report1.morale).toEqual([])
    expect(Object.keys(report1.roomShiftDetails)).toEqual(['B101', 'B102', 'B103', 'B201', 'B202', 'B203', 'B301', 'B302', 'B303'])
    expect(report1.summary).toEqual({
      exp: 0,
      goldCount: 80,
      goldValue: 40000,
      orderLmd: expect.closeTo(33274.34, 1),
      fragments: 0,
      orundum: 0,
      goldConsumed: expect.closeTo(63.72, 1),
      fragmentsConsumed: 0,
      netGoldCount: expect.closeTo(16.28, 1),
      netGoldValue: expect.closeTo(8141.59, 1),
      virtualGoldCount: expect.closeTo(2.83, 1),
      virtualGoldValue: expect.closeTo(1415.93, 1),
      totalScore82: expect.closeTo(39787.61, 1),
      scoreBreakdown: {
        exp: 0,
        goldValue: 40000,
        orderValue: expect.closeTo(33274.34, 1),
        weightedExp: 0,
        weightedGold: expect.closeTo(33132.74, 1),
        weightedOrders: expect.closeTo(6654.87, 1),
        weightedFragments: 0,
        weightedOrundum: 0,
        total: expect.closeTo(39787.61, 1),
      },
      totalEquivalentLmd: expect.closeTo(42831.86, 1),
    })
  })
})
