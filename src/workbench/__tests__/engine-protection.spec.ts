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
    // Authorized special-order engine baseline (2026-09-29), normalized LF; default arithmetic stays unchanged.
    expect(fileSha256('engine/calculate.ts')).toBe('96aafb7086aeec4eef85bc7fdc5f8d8bebeee28d304fb1560721f760f06870d3')
    expect(fileSha256('engine/morale.ts')).toBe('aa42b6ca643cb1f61d1a5904ba1c0e4190a890ff2b82c66a9937119e6063c7de')
    expect(fileSha256('engine/operatorRules.ts')).toBe('03780885b1af56d45ff88e472805923ec7151dfb687f727d23b113d37391284f')
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
      totalEquivalentLmd: expect.closeTo(42831.86, 1),
    })
  })
})
