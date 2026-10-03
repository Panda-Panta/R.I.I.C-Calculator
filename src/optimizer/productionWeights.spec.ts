import { describe, expect, it } from 'vitest'
import { scoreProduction } from './productionObjective'

describe('shared production weights', () => {
  const completed = { exp: 1000, gold: 2, orderLmd: 2000, virtualGold: 1, fragments: 3, orundum: 20 }
  it('weights all five outputs and the order premium with the gold coefficient', () => {
    const score = scoreProduction(completed, 24, { exp: 2, gold: .5, orders: .3, fragments: 4, orundum: 5 })
    expect(score.total).toBe(3462)
    expect(score.weightedGold).toBe(750)
    expect(score.weightedFragments).toBe(12)
    expect(score.weightedOrundum).toBe(100)
  })
  it('retains the 82 default including virtual gold and daily normalization', () => {
    expect(scoreProduction(completed, 24).total).toBe(2600)
    expect(scoreProduction(completed, 12).total).toBe(5200)
  })
  it('permits a zero objective without silently restoring defaults', () => {
    expect(scoreProduction(completed, 24, { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 }).total).toBe(0)
  })
  it.each([-1, NaN, Infinity])('rejects invalid coefficients (%s)', exp => {
    expect(() => scoreProduction(completed, 24, { exp })).toThrow()
  })
})
