import { describe, expect, it } from 'vitest'
import { advanceRoster, createRosterRuntime, settleRoster } from './rosterRuntime'
import { simulateMoraleTimeline } from '../simulator/moraleTimeline'

const rates = { workRate: () => 1, recoveryRate: () => 2 }
describe('event roster runtime', () => {
  it('restarts integration after charging and consumption-rate changes', () => {
    const s = createRosterRuntime({ positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: [] }], beds: [], initialMorale: { A: 20 } })
    advanceRoster(s, 1, rates)
    expect(s.morale.A).toBe(19)
    s.morale.A = 24
    advanceRoster(s, 2, rates)
    expect(s.morale.A).toBe(22)
    advanceRoster(s, 1, { ...rates, workRate: () => 2 })
    expect(s.morale.A).toBe(20)
    expect(s.time).toBe(4)
  })
  it('uses dorm bed order, not main-plan slot order, for the first high-priority return member', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'a', roomId: 'manufacture', primary: 'A', candidates: ['X'], group: 'g' },
      { id: 'b', roomId: 'manufacture', primary: 'B', candidates: ['Y'], group: 'g' },
    ], beds: [{ id: 'first', roomId: 'd', vip: true }, { id: 'second', roomId: 'd', vip: true }],
    initialMorale: { A: 20, B: 16 }, mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] } })
    s.occupants = { a: 'X', b: 'Y' }; s.bedOccupants = { first: 'B', second: 'A' }
    settleRoster(s, rates)
    // Mower scheduler_task.py: the first dorm needs 4 h, versus 2 h for the next;
    // the >1.5 h mismatch protects the first dorm's full recovery time.
    expect(s.returnDeadlines?.['group:g']).toBe(4)
  })
  it('returns low-priority peers below the planning threshold when the high-priority member is ready', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'high', roomId: 'manufacture', primary: 'A', candidates: ['X'], group: 'g', lowerLimit: 12, shiftOffThreshold: 19.8 },
      { id: 'low', roomId: 'manufacture', primary: 'B', candidates: ['Y'], group: 'g', lowerLimit: 12, shiftOffThreshold: 19.8, restingPriority: 'low' },
    ], beds: [{ id: 'a', roomId: 'd', vip: true }, { id: 'b', roomId: 'd', vip: false }],
    initialMorale: { A: 24, B: 16 }, mowerPolicy: { restingThreshold: .65, powerPlantCount: 3, opeRestingPriority: [] } })
    s.occupants = { high: 'X', low: 'Y' }; s.bedOccupants = { a: 'A', b: 'B' }
    settleRoster(s, rates)
    expect(s.occupants).toEqual({ high: 'A', low: 'B' })
    expect(s.events.filter(e => e.type === 'shift-on')).toHaveLength(1)
    expect(s.morale.B).toBe(16)
  })
  it('corrects a misplaced permanent operator without scheduling an empty return group', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'work', roomId: 'manufacture', primary: 'A', candidates: [], permanent: true },
    ], beds: [{ id: 'bed', roomId: 'dormitory_1', vip: true }],
    initialMorale: { A: 10 }, mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] } })
    delete s.occupants.work; s.bedOccupants.bed = 'A'
    expect(() => settleRoster(s, rates)).not.toThrow()
    // alpha not_valid restores workaholics outside their planned room.
    expect(s.occupants.work).toBe('A')
    expect(s.bedOccupants.bed).toBeUndefined()
    expect(s.returnDeadlines).toEqual({})
  })
  it('does not let a full-morale passive group member return a still-tired producer', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'producer', roomId: 'manufacture', primary: 'A', candidates: ['B'], group: 'g', lowerLimit: 15 },
      { id: 'pendant', roomId: 'factory', primary: 'P', candidates: ['Q'], group: 'g', lowerLimit: 15 },
    ], beds: [{ id: 'a', roomId: 'd', vip: true }, { id: 'p', roomId: 'd', vip: false }],
    initialMorale: { A: 15, P: 24 }, mowerPolicy: { restingThreshold: .65, powerPlantCount: 3, opeRestingPriority: [] } })
    s.occupants = { producer: 'B', pendant: 'Q' }; s.bedOccupants = { a: 'A', p: 'P' }
    settleRoster(s, { workRate: (_, room) => room === 'factory' ? 0 : 1, recoveryRate: () => 2 })
    expect(s.occupants.producer).toBe('B')
    expect(s.events.filter(e => e.type === 'shift-on')).toEqual([])
  })
  it('recalls a positive-mood ordinary owner during alpha exhaustion support without an invented return floor', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'tired', roomId: 'manufacture', primary: 'A', candidates: ['B'], lowerLimit: 15 },
      { id: 'exhausted', roomId: 'manufacture2', primary: 'C', candidates: ['D'], exhaustRequired: true },
    ], beds: [{ id: 'a', roomId: 'd', vip: true }], initialMorale: { A: 15, C: 0 },
    mowerPolicy: { restingThreshold: .65, powerPlantCount: 3, opeRestingPriority: [] } })
    s.occupants.tired = 'B'; s.bedOccupants.a = 'A'
    settleRoster(s, rates)
    // Actual exhaust support protects full+exhaust; an ordinary owner can release the bed at positive mood.
    expect(s.occupants).toEqual({ tired: 'A', exhausted: 'D' })
    expect(s.bedOccupants.a).toBe('C')
    expect(s.morale.A).toBe(15)
  })
  it('keeps recurring shifts when recovery and fatigue happen simultaneously', () => {
    const result = simulateMoraleTimeline({
      positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: ['B'] }],
      beds: [{ id: 'bed', roomId: 'd', vip: true }],
    }, 100, { workRate: () => 1, recoveryRate: () => 1 })
    expect(result.finalState.events.map(e => [e.time, e.type])).toEqual([
      [24, 'shift-off'], [48, 'shift-on'], [72, 'shift-off'], [96, 'shift-on'],
    ])
    expect(result.finalState.morale.A).toBe(20)
  })

  it('reuses a recovered substitute and its bed at the same timestamp', () => {
    const s = createRosterRuntime({
      positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: ['B'] }],
      beds: [{ id: 'bed', roomId: 'd', vip: true }],
      initialMorale: { A: 0, B: 24 },
    })
    s.bedOccupants.bed = 'B'
    settleRoster(s)
    expect(s.occupants.a).toBe('B')
    expect(s.bedOccupants).toEqual({ bed: 'A' })
    expect(s.events).toHaveLength(1)
    settleRoster(s)
    expect(s.events).toHaveLength(1)
  })
  it('selects the next available candidate and reserves shared candidates atomically', () => {
    const s = createRosterRuntime({ positions: [
      { id: 'a', roomId: 'r', primary: 'A', candidates: ['X', 'Y'], group: 'g' },
      { id: 'b', roomId: 'r', primary: 'B', candidates: ['X'], group: 'g' },
    ], beds: [{ id: 'd1', roomId: 'd', vip: true }, { id: 'd2', roomId: 'd', vip: false }], initialMorale: { A: 0, B: 0 } })
    settleRoster(s)
    // Ordered greedy reservation fails: group must stay unchanged, never half commit.
    expect(s.occupants).toEqual({ a: 'A', b: 'B' })
    expect(s.diagnostics.some(d => d.code === 'group-blocked')).toBe(true)
  })
  it('skips occupied candidates, fills an actual bed and returns at the upper limit', () => {
    const r = simulateMoraleTimeline({ positions: [
      { id: 'a', roomId: 'r', primary: 'A', candidates: ['X', 'Y'], upperLimit: 4 },
      { id: 'x', roomId: 'x', primary: 'X', candidates: [], permanent: true },
    ], beds: [{ id: 'd', roomId: 'd', vip: true }], initialMorale: { A: 0 } }, 2, rates)
    expect(r.segments[0]?.occupants.a).toBe('Y')
    expect(r.finalState.occupants.a).toBe('A')
    expect(r.finalState.morale.A).toBe(4)
  })
  it('does not manufacture recovery without a bed; permanent workers remain at zero', () => {
    const r = simulateMoraleTimeline({ positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: ['B'], permanent: true }], beds: [], initialMorale: { A: 0, B: 2 } }, 100, rates)
    expect(r.finalState.occupants.a).toBe('A')
    expect(r.finalState.morale).toEqual({ A: 0, B: 2 })
  })
  it('assigns low priority to ordinary beds and enforces bounded monotonic long timelines', () => {
    const r = simulateMoraleTimeline({ positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: ['B'], restingPriority: 'low' }], beds: [{ id: 'vip', roomId: 'd', vip: true }, { id: 'normal', roomId: 'd', vip: false }], initialMorale: { A: 0 } }, 1000, rates)
    expect(r.finalState.events.find(e => e.type === 'shift-off')?.beds).toEqual(['normal'])
    expect(r.segments.length).toBeLessThan(1000)
    expect(r.segments.every(s => s.end > s.start)).toBe(true)
    for (const segment of r.segments) expect(new Set(Object.values(segment.occupants)).size).toBe(Object.values(segment.occupants).length)
  })
  it('terminates cleanly on zero-duration and sub-epsilon without infinite loop', () => {
    const config = {
      positions: [{ id: 'a', roomId: 'r', primary: 'A', candidates: ['B'] }],
      beds: [{ id: 'b1', roomId: 'd', vip: false }],
      initialMorale: { A: 12, B: 24 },
    }
    const r0 = simulateMoraleTimeline(config, 0, rates)
    expect(r0.segments).toHaveLength(0)
    expect(r0.finalState.time).toBe(0)

    const rEps = simulateMoraleTimeline(config, 1e-9, rates)
    expect(rEps.segments).toHaveLength(0)

    expect(() => simulateMoraleTimeline(config, -5, rates)).toThrow(/Invalid timeline duration/)
  })
  it('guarantees candidate uniqueness: no operator is ever in two places simultaneously', () => {
    const config = {
      positions: [
        { id: 'p1', roomId: 'r1', primary: 'A', candidates: ['S1', 'S2'], group: 'g' },
        { id: 'p2', roomId: 'r2', primary: 'B', candidates: ['S1', 'S2'], group: 'g' },
      ],
      beds: [
        { id: 'bed1', roomId: 'd1', vip: true },
        { id: 'bed2', roomId: 'd1', vip: false },
      ],
      initialMorale: { A: 0, B: 0, S1: 24, S2: 24 },
    }
    const r = simulateMoraleTimeline(config, 50, rates)
    for (const seg of r.segments) {
      const occs = Object.values(seg.occupants)
      const beds = Object.values(seg.bedOccupants)
      expect(new Set(occs).size).toBe(occs.length)
      expect(new Set(beds).size).toBe(beds.length)
      for (const occ of occs) {
        expect(beds.includes(occ)).toBe(false)
      }
    }
  })
  it('preserves config immutability across runtime execution', () => {
    const config = {
      positions: [
        { id: 'p1', roomId: 'r1', primary: 'A', candidates: ['S1'] },
      ],
      beds: [{ id: 'bed1', roomId: 'd1', vip: true }],
      initialMorale: { A: 0, S1: 24 },
    }
    const clone = structuredClone(config)
    simulateMoraleTimeline(config, 10, rates)
    expect(config).toEqual(clone)
  })
})
