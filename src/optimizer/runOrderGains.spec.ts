import { expect, it } from 'vitest'
import { calculateRunOrderGains } from './runOrderGains'

it.each([
  ['pair00', 44.827586], ['pair02', 72.413793], ['pair20', 62.068966], ['pair22', 89.655172],
  ['proviso0', 27.586207], ['proviso2', 55.172414], ['tequila0', 17.241379], ['tequila2', 34.482759],
  ['closure0', 0], ['closure2', 94.827586], ['pepe0', 0], ['pepe2', 29.885057],
])('reproduces the independently calculated normal-quality gain %s', (key, want) => {
  expect(calculateRunOrderGains(3, 'normal', 2).find(r => r.key === key)!.gainPercent).toBeCloseTo(want, 4)
})
it('uses high-quality probabilities without stacking Tequila on breached orders', () => {
  expect(calculateRunOrderGains(3, 'beta', 2).find(r => r.key === 'pair22')!.gainPercent).toBeCloseTo(119.736842, 4)
})
it('reports absolute profit when the baseline objective is zero', () => {
  const row = calculateRunOrderGains(2, 'normal', 2, { gold: 1, orders: 0 }).find(r => r.key === 'closure2')!
  expect(row.gainPercent).toBeNull()
  expect(row.delta).toBe(4000)
})

it.each([1,2,3].flatMap(level => [
  {quality:'alpha' as const,minutes:236.4,face:1700,proviso0Face:1925,proviso2Face:2150,closureGain:93.137255},
  {quality:'beta' as const,minutes:262.8,face:1900,proviso0Face:1975,proviso2Face:2050,closureGain:92.105263},
].map(distribution => ({level,...distribution}))))
('uses the full fixed $quality distribution at station level $level without truncating four-gold orders', ({level,quality,minutes,face,proviso0Face,proviso2Face,closureGain}) => {
  const rows = calculateRunOrderGains(level, quality, 2)
  const baseline = .2*face*2880/minutes
  expect(rows.find(row=>row.key==='proviso2')!.baselineScore).toBeCloseTo(baseline, 6)
  expect(rows.find(row=>row.key==='proviso0')!.score).toBeCloseTo(.2*proviso0Face*2880/minutes, 6)
  expect(rows.find(row=>row.key==='proviso2')!.score).toBeCloseTo(.2*proviso2Face*2880/minutes, 6)
  expect(rows.find(row=>row.key==='closure2')!.gainPercent).toBeCloseTo(closureGain, 4)
  const tequilaChoices = rows.filter(row=>row.names.includes('龙舌兰'))
  expect(tequilaChoices.every(row=>row.allowed === (level===3))).toBe(true)
  if (level<3) {
    for (const row of tequilaChoices) {
      expect(row.delta).toBe(0)
      expect(row.score).toBeCloseTo(baseline, 6)
    }
  } else {
    expect(rows.find(row=>row.key==='pair22')!.gainPercent).toBeCloseTo(quality==='alpha'?107.352941:119.736842,4)
  }
})
