import { describe, expect, it } from 'vitest'
import { rankRecoverySupportProposals, type RecoverySupportProposal } from './mainRosterRecoveryPriorities'

const row = (candidate: string, supportScore: number | null, primaryScore: number | null): RecoverySupportProposal<string> =>
  ({ candidate, supportScore, primaryScore })
const labels = (rows: readonly RecoverySupportProposal<string>[]) => rows.map(entry => entry.candidate)

describe('bounded recovery proposal priorities', () => {
  it('retains the no-primary-loss alternative before exploring the highest recovery snapshot', () => {
    const base = 3891.6519174
    const rows = [row('myrtle-to-ice', 18.94, base - 17.10914454),
      row('myrtle-to-podenco', 18.69, base - 17.10914454), row('schwarz-to-podenco', 18.69, base)]
    expect(labels(rankRecoverySupportProposals(rows, base)))
      .toEqual(['schwarz-to-podenco', 'myrtle-to-ice', 'myrtle-to-podenco'])
  })

  it('ranks equal known recovery by higher global primary output when the baseline is unknown', () => {
    const rows = [row('lower', 18.69, 3800), row('higher', 18.69, 3900), row('unknown', 18.69, null)]
    expect(labels(rankRecoverySupportProposals(rows, null))).toEqual(['higher', 'lower', 'unknown'])
  })

  it.each([
    { baseline: 1_000_000, tolerated: 0.0005, loss: 0.005 },
    { baseline: 0.01, tolerated: 0.00000005, loss: 0.000001 },
  ])('uses the primary-loss tolerance at baseline $baseline', ({ baseline, tolerated, loss }) => {
    const rows = [row('highest-recovery-loss', 20, baseline - loss), row('within-tolerance', 10, baseline - tolerated)]
    expect(labels(rankRecoverySupportProposals(rows, baseline))).toEqual(['within-tolerance', 'highest-recovery-loss'])
  })

  it('uses global output to break recovery differences within the snapshot tolerance', () => {
    const rows = [row('noisy-high', 18.69 + 0.00000005, 3800), row('better-primary', 18.69, 3900)]
    expect(labels(rankRecoverySupportProposals(rows, null))).toEqual(['better-primary', 'noisy-high'])
  })

  it('selects the same best row once when it is both the safe and maximum-recovery proposal', () => {
    const rows = [row('best', 20, 100), row('second', 10, 90)]
    const ranked = rankRecoverySupportProposals(rows, 100)
    expect(ranked).toEqual(rows)
    expect(ranked.filter(entry => entry === rows[0])).toHaveLength(1)
  })

  it('retains another proposal with unknown primary score as a recovery exploration', () => {
    const rows = [row('unknown-primary', 20, null), row('safe', 10, 100), row('loss', 9, 90)]
    expect(labels(rankRecoverySupportProposals(rows, 100))).toEqual(['safe', 'unknown-primary', 'loss'])
  })

  it('never promotes nonfinite primary scores into the no-loss slot', () => {
    const rows = [row('positive-infinity', 50, Infinity), row('not-a-number', 40, NaN),
      row('negative-infinity', 30, -Infinity), row('safe', 10, 100)]
    expect(labels(rankRecoverySupportProposals(rows, 100)))
      .toEqual(['safe', 'positive-infinity', 'not-a-number', 'negative-infinity'])
  })

  it('does not replace an unknown primary score with zero at a negative baseline', () => {
    const rows = [row('highest', 10, -110), row('unknown-primary', 9, null)]
    expect(labels(rankRecoverySupportProposals(rows, -100))).toEqual(['highest', 'unknown-primary'])
  })

  it('does not replace unknown recovery with zero ahead of a known zero recovery', () => {
    const rows = [row('unknown-recovery', null, 1000), row('known-zero', 0, 100)]
    expect(labels(rankRecoverySupportProposals(rows, 100))).toEqual(['known-zero', 'unknown-recovery'])
  })

  it('keeps unknown recovery rows in their original relative order behind known recovery', () => {
    const rows = [row('null', null, 500), row('nan', NaN, 900), row('infinity', Infinity, 800),
      row('negative-infinity', -Infinity, 700), row('known', 10, 90)]
    expect(labels(rankRecoverySupportProposals(rows, null)))
      .toEqual(['known', 'null', 'nan', 'infinity', 'negative-infinity'])
  })

  it.each([null, NaN, Infinity, -Infinity])('does not classify losses against an unknown baseline %s', baseline => {
    const rows = [row('highest', 20, -1000), row('lower', 10, 1000)]
    expect(labels(rankRecoverySupportProposals(rows, baseline))).toEqual(['highest', 'lower'])
  })

  it('keeps fully unknown or tied rows stable', () => {
    const unknown = [row('first', null, 100), row('second', NaN, 500), row('third', Infinity, null)]
    expect(rankRecoverySupportProposals(unknown, 100)).toEqual(unknown)
    const tied = [row('a', 10, 100), row('b', 10, 100), row('c', 10, 100)]
    expect(rankRecoverySupportProposals(tied, 100)).toEqual(tied)
  })

  it('returns an immutable-input permutation preserving row and candidate identities', () => {
    const first = Object.freeze({ candidate: Object.freeze({ name: 'first', extra: 1 }), supportScore: 20, primaryScore: 90 })
    const second = Object.freeze({ candidate: Object.freeze({ name: 'second', extra: 2 }), supportScore: 10, primaryScore: 100 })
    const source: readonly RecoverySupportProposal<Readonly<{ name: string; extra: number }>>[] = Object.freeze([first, second])
    const before = JSON.stringify(source)
    const ranked = rankRecoverySupportProposals(source, 100)
    expect(ranked).not.toBe(source)
    expect(ranked[0]).toBe(second)
    expect(ranked[1]).toBe(first)
    expect(ranked[0]?.candidate).toBe(second.candidate)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('retains every input position even if the same row object occurs more than once', () => {
    const shared = row('shared', 10, 100), rows = [shared, row('explore', 20, 90), shared]
    const ranked = rankRecoverySupportProposals(rows, 100)
    expect(ranked).toHaveLength(3)
    expect(ranked.filter(entry => entry === shared)).toHaveLength(2)
    expect(labels(ranked)).toEqual(['shared', 'explore', 'shared'])
  })

  it('handles no candidates and a single unknown candidate without inventing scores', () => {
    expect(rankRecoverySupportProposals([], 100)).toEqual([])
    const single = [row('single', null, null)]
    expect(rankRecoverySupportProposals(single, null)).toEqual(single)
  })
})
