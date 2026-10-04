import { afterEach, describe, expect, it, vi } from 'vitest'
import { mowerAlphaDormCandidates } from './mowerAlphaCandidates'
import * as dorm from './mowerAlphaDorm'
import { MowerOperatorState } from './mowerOperatorState'
import { MowerSchedulingData } from './mowerSchedulingData'

afterEach(() => vi.restoreAllMocks())

function inventoryData() {
  const operators = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
    const name = `idle-${index}`
    return [name, new MowerOperatorState({ name, mood: 24, timeStampMicros: 0 })]
  }))
  operators.owner = new MowerOperatorState({ name: 'owner', room: 'room_1_1', currentRoom: 'room_1_1',
    operatorType: 'high', replacement: ['idle-150'] })
  return new MowerSchedulingData({ alpha: true, operators, plan: { train: ['', ''], dormitory_1: Array(5).fill('Free') }, dorms: [], nowMicros: 0 })
}

describe('large-library dorm candidate ordering', () => {
  it('computes each candidate tier at most twice in one selection pass', () => {
    const data = inventoryData()
    const replacement = data.operators.owner!.replacement
    let membershipReads = 0
    Object.defineProperty(data.operators.owner!, 'replacement', { get: () => { membershipReads++; return replacement } })
    const tier = vi.spyOn(dorm, 'alphaRestingTier')
    const candidates = mowerAlphaDormCandidates(data)
    expect(candidates.filling).toHaveLength(200)
    expect(candidates.filling[0]).toBe('idle-150')
    expect(candidates.filling.slice(1, 4)).toEqual(['idle-0', 'idle-1', 'idle-2'])
    expect(tier.mock.calls.length).toBeLessThanOrEqual(400)
    expect(membershipReads).toBeLessThanOrEqual(3)
  })

  it('recomputes ordering after policy, replacement membership and observed mood change', () => {
    const data = inventoryData()
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-150')
    data.operators.owner!.replacement = []
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-0')
    data.restingPriorityNames.push('idle-90')
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-90')
    data.operators['idle-80']!.mood = 12
    expect(mowerAlphaDormCandidates(data).recovering).toEqual(['idle-80'])
    expect(mowerAlphaDormCandidates(data).filling[0]).toBe('idle-80')
    expect(mowerAlphaDormCandidates(data, new Set(['idle-80'])).filling[0]).toBe('idle-90')
  })
})
