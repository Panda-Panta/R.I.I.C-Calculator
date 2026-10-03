import { describe, expect, it } from 'vitest'
import { captureOrder, getOrderDistribution, selectBaseOrder } from './orderRules'

describe('order rules', () => {
  it('exposes finite probabilities and deterministic boundary choices', () => {
    const choices = getOrderDistribution(3)
    expect(choices.map(x => x.probability)).toEqual([0.3, 0.5, 0.2])
    expect(choices.reduce((n, x) => n + x.probability * x.baseMinutes, 0)).toBeCloseTo(203.4)
    expect(selectBaseOrder(choices, 0.3).goldCost).toBe(3)
    expect(selectBaseOrder(choices, 0.8).goldCost).toBe(4)
    expect(() => selectBaseOrder(choices, 1)).toThrow()
    expect(() => selectBaseOrder(choices, NaN)).toThrow()
  })
  it('preserves ordinary distributions for each station level', () => {
    expect(getOrderDistribution(1)[0]?.goldCost).toBe(2)
    expect(getOrderDistribution(2).map(x => x.probability)).toEqual([0.6, 0.4])
    expect(getOrderDistribution(3, 'beta').map(x => x.probability)).toEqual([0.05, 0.1, 0.85])
  })
  it.each([1, 2])('uses the requested fixed tailoring model at level %i', (level) => {
    for (const [quality, probabilities] of [['alpha', [.15, .3, .55]], ['beta', [.05, .1, .85]]] as const) {
      const choices = getOrderDistribution(level, quality)
      expect(choices.map(x => x.probability)).toEqual(probabilities)
      expect(choices.map(x => x.goldCost)).toEqual([2, 3, 4])
      expect(choices.reduce((sum, x) => sum + x.probability, 0)).toBeCloseTo(1)
      expect(selectBaseOrder(choices, .99)).toMatchObject({ goldCost: 4, lmdReward: 2000, baseMinutes: 276 })
      expect(getOrderDistribution(level, quality, 'closure')).toMatchObject([{ probability: 1, goldCost: 2, lmdReward: 1200, baseMinutes: 144 }])
      expect(getOrderDistribution(level, quality, 'pepe')).toMatchObject([{ probability: 1, goldCost: 0, lmdReward: 1000, baseMinutes: 270 }])
      expect(() => getOrderDistribution(level, quality, 'orundum')).toThrow(/level 3/)
    }
  })
  it.each([[0, 4, 2000, 'proviso'], [0.3, 5, 2500, 'proviso'], [0.8, 4, 2500, 'tequila']] as const)(
    'applies mutually exclusive capture for choice %s', (choice, goldCost, lmdReward, kind) => {
      const base = selectBaseOrder(getOrderDistribution(3), choice)
      const result = captureOrder(base, { proviso: 2, tequila: 2 }, 100)
      expect(result).toMatchObject({ goldCost, lmdReward, kind, completedAt: 100, baseMinutes: base.baseMinutes })
    },
  )
  it('gates special effects by explicit rank and keeps source orders separate', () => {
    const base = selectBaseOrder(getOrderDistribution(3), 0)
    expect(captureOrder(base, { proviso: 1 }, 1).lmdReward).toBe(1500)
    expect(captureOrder(base, { proviso: 0 }, 1).kind).toBe('gold')
    const source = getOrderDistribution(3, 'normal', 'orundum')[0]!
    expect(captureOrder(source, { proviso: 2, tequila: 2, uOfficial: true }, 1)).toMatchObject({ kind: 'orundum', fragmentCost: 2, orundumReward: 20, lmdReward: 0 })
    expect(() => getOrderDistribution(2, 'normal', 'orundum')).toThrow()
  })
  it('respects special priority and fixes duration-changing modes at acquisition start', () => {
    const base = getOrderDistribution(3)[0]!
    expect(captureOrder(base, { uOfficial: true, proviso: 2 }, 10)).toMatchObject({ kind: 'uOfficial', goldCost: 2, lmdReward: 1000 })
    const closure = getOrderDistribution(3, 'normal', 'closure')[0]!
    expect(captureOrder(closure, { closure: true, uOfficial: true }, 10)).toMatchObject({ kind: 'closure', lmdReward: 1200, baseMinutes: 144 })
    const pepe = getOrderDistribution(3, 'normal', 'pepe')[0]!
    expect(captureOrder(pepe, { pepe: true, closure: true }, 10)).toMatchObject({ kind: 'pepe', goldCost: 0, baseMinutes: 270, efficiencyAffected: false })
    expect(() => captureOrder(base, { closure: true }, 10)).toThrow(/mode/)
    expect(() => captureOrder(base, { pepe: true }, 10)).toThrow(/mode/)
    expect(() => captureOrder(pepe, {}, 10)).toThrow(/mode/)
  })
})
