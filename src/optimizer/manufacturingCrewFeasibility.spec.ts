import { describe, expect, it } from 'vitest'
import { screenManufacturingCrewColumns, type ManufacturingCrewFeasibilityInput } from './manufacturingCrewFeasibility'
import type { ManufacturingCrewColumn } from './manufacturingCrewDomain'
import type { MowerRoomId } from '../domain/roster'

const g1 = 'room_1_1', g2 = 'room_1_2'
function row(id: string, group: MowerRoomId, room: MowerRoomId, role: 'main' | 'backup', cores: string[] = [], people = [id]): ManufacturingCrewColumn {
  return { id, groupId: group, groupOrigin: group, roomId: room, role, retainedCores: cores, ids: people, seatOperatorIds: people }
}
function model(rows: ManufacturingCrewColumn[], requiredCores: string[] = [], coreIds = ['a', 'b'], groups = [g1, g2], rooms = [g1, g2]): ManufacturingCrewFeasibilityInput {
  return { rows, groups, rooms, coreIds, requiredCores }
}

// Independent exhaustive complete-assignment oracle. It never constructs masks,
// categories, DP states, or the forward/backward transitions used by the screen.
function oracle(input: ManufacturingCrewFeasibilityInput, respectPeople = false) {
  const participating = new Set<ManufacturingCrewColumn>()
  let completions = 0
  const visit = (groupIndex: number, selected: ManufacturingCrewColumn[]) => {
    if (groupIndex === input.groups.length) {
      if (input.requiredCores.some(core => !selected.some(column => column.retainedCores.includes(core)))) return
      completions++
      selected.forEach(column => participating.add(column))
      return
    }
    const group = input.groups[groupIndex]
    const usedRooms = selected.filter(column => column.role === 'main').map(column => column.roomId)
    const usedCores = selected.flatMap(column => column.retainedCores)
    const usedPeople = selected.flatMap(column => column.ids)
    for (const main of input.rows.filter(column => column.groupOrigin === group && column.role === 'main')) {
      if (usedRooms.includes(main.roomId)) continue
      for (const backup of input.rows.filter(column => column.groupOrigin === group && column.role === 'backup' && column.roomId === main.roomId)) {
        const cores = [...usedCores, ...main.retainedCores, ...backup.retainedCores]
        if (new Set(cores).size !== cores.length) continue
        const people = [...usedPeople, ...main.ids, ...backup.ids]
        if (respectPeople && new Set(people).size !== people.length) continue
        visit(groupIndex + 1, [...selected, main, backup])
      }
    }
  }
  visit(0, [])
  return { rows: input.rows.filter(column => participating.has(column)), completions }
}

describe('structural manufacturing crew feasibility screen', () => {
  it('removes only columns absent from every complete room/core assignment and preserves row order and identity', () => {
    const input = model([
      row('dead-main', g1, g1, 'main', ['a']), row('dead-backup', g1, g1, 'backup'),
      row('live-main', g1, g2, 'main'), row('live-backup', g1, g2, 'backup', ['b']),
      row('fixed-main', g2, g1, 'main', ['a']), row('fixed-backup', g2, g1, 'backup'),
    ], ['a', 'b'])
    const before = structuredClone(input)
    const result = screenManufacturingCrewColumns(input)
    expect(result.complete).toBe(true)
    expect(result.feasible).toBe(true)
    expect(result.rows.map(column => column.id)).toEqual(['live-main', 'live-backup', 'fixed-main', 'fixed-backup'])
    expect(result.rows).toEqual(oracle(input).rows)
    result.rows.forEach(column => expect(input.rows.includes(column)).toBe(true))
    expect(input).toEqual(before)
  })

  it('retains every main/backup decomposition of a reachable union, including all equivalent rows', () => {
    const input = model([
      row('m-empty', g1, g1, 'main'), row('b-ab', g1, g1, 'backup', ['a', 'b']),
      row('m-a', g1, g1, 'main', ['a']), row('b-b', g1, g1, 'backup', ['b']),
      row('m-a-equivalent', g1, g1, 'main', ['a']),
    ], ['a', 'b'], ['a', 'b'], [g1], [g1])
    expect(screenManufacturingCrewColumns(input).rows).toEqual(input.rows)
    expect(oracle(input).completions).toBe(3)
  })

  it.each([{ required: [] }, { required: ['a'] }])('requires only the declared subset $required while keeping optional cores mutually exclusive', ({ required }) => {
    const input = model([
      row('m1', g1, g1, 'main', ['a']), row('b1', g1, g1, 'backup'),
      row('m2', g2, g2, 'main'), row('b2', g2, g2, 'backup'),
      row('duplicate-a', g2, g2, 'backup', ['a']), row('optional-b', g2, g2, 'backup', ['b']),
    ], required)
    const result = screenManufacturingCrewColumns(input)
    expect(result.rows).toEqual(oracle(input).rows)
    expect(result.rows.some(column => column.id === 'duplicate-a')).toBe(false)
    expect(result.rows.some(column => column.id === 'optional-b')).toBe(true)
    expect(result.rows.some(column => column.id === 'b2')).toBe(true)
  })

  it('does not shrink the declared group/room domain when a whole group has no rows', () => {
    const input = model([row('m', g1, g1, 'main'), row('b', g1, g1, 'backup')])
    const result = screenManufacturingCrewColumns(input)
    expect(result).toMatchObject({ complete: true, feasible: false, reason: 'infeasible', rows: [] })
  })

  it('reports structural infeasibility when mandatory cores cannot be covered exactly once', () => {
    const input = model([
      row('m1', g1, g1, 'main', ['a']), row('b1', g1, g1, 'backup'),
      row('m2', g2, g2, 'main', ['a']), row('b2', g2, g2, 'backup', ['b']),
    ], ['a', 'b'])
    expect(screenManufacturingCrewColumns(input)).toMatchObject({ complete: true, feasible: false, rows: [] })
  })

  it('relaxes personnel conflicts and does not claim the retained structure is an executable roster', () => {
    const input = model([
      row('m1', g1, g1, 'main', [], ['same-person']), row('b1', g1, g1, 'backup'),
      row('m2', g2, g2, 'main', [], ['same-person']), row('b2', g2, g2, 'backup'),
    ])
    expect(oracle(input, true).completions).toBe(0)
    expect(screenManufacturingCrewColumns(input)).toMatchObject({ complete: true, feasible: true, rows: input.rows })
  })

  it.each(Array.from({ length: 18 }, (_, index) => index + 1))('matches independent complete enumeration for deterministic small domain %i', seed => {
    let state = seed
    const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state }
    const rows: ManufacturingCrewColumn[] = []
    for (const group of [g1, g2] as const) for (const room of [g1, g2] as const) for (const role of ['main', 'backup'] as const) {
      for (let variant = 0; variant < 2; variant++) {
        const bits = (next() >>> 24) % 4
        rows.push(row(`${group}-${room}-${role}-${variant}`, group, room, role, ['a', 'b'].filter((_, index) => bits & (1 << index))))
      }
    }
    const input = model(rows, seed % 3 === 0 ? ['a', 'b'] : seed % 3 === 1 ? ['a'] : [])
    const expected = oracle(input), actual = screenManufacturingCrewColumns(input)
    expect(actual.complete).toBe(true)
    expect(actual.feasible).toBe(expected.completions > 0)
    expect(actual.rows).toEqual(expected.rows)
  })

  const budgetFixture = () => model([
    row('m11', g1, g1, 'main', ['a']), row('b11', g1, g1, 'backup'),
    row('m12', g1, g2, 'main'), row('b12', g1, g2, 'backup', ['a']),
    row('m21', g2, g1, 'main', ['b']), row('b21', g2, g1, 'backup'),
    row('m22', g2, g2, 'main'), row('b22', g2, g2, 'backup', ['b']),
  ], ['a', 'b'])

  it.each(['maxStates', 'maxTransitions'] as const)('returns the original full library on every limited %s threshold', key => {
    const input = budgetFixture(), finished = screenManufacturingCrewColumns(input)
    const cap = key === 'maxStates' ? finished.stats.storedItems : finished.stats.transitions
    expect(cap).toBeGreaterThan(0)
    for (let limit = 0; limit <= cap; limit++) {
      const result = screenManufacturingCrewColumns(input, { [key]: limit })
      if (!result.complete) {
        expect(result.rows).toBe(input.rows)
        expect(result.feasible).toBeNull()
        expect(result.stats.removedRows).toBe(0)
      } else expect(result.rows).toEqual(oracle(input).rows)
    }
  })

  it('checks the time budget through compilation, pair construction, both DP directions, and output without partial pruning', () => {
    const input = budgetFixture()
    let clock = 0
    const full = screenManufacturingCrewColumns(input, { now: () => clock++, timeLimitMs: 1e6 })
    expect(full.complete).toBe(true)
    const totalChecks = clock, stoppedStages = new Set<string>()
    for (let cutoff = 0; cutoff < totalChecks; cutoff++) {
      clock = 0
      const result = screenManufacturingCrewColumns(input, { now: () => clock++, timeLimitMs: cutoff })
      if (!result.complete) {
        expect(result.rows).toBe(input.rows)
        expect(result.stats.removedRows).toBe(0)
        stoppedStages.add(result.stats.stopStage!)
      } else expect(result.rows).toEqual(oracle(input).rows)
    }
    for (const prefix of ['validate', 'rows', 'pairs', 'forward', 'backward', 'retain']) {
      expect([...stoppedStages].some(stage => stage.startsWith(prefix)), prefix).toBe(true)
    }
  })

  it('rejects invalid declared domains and malformed row resources rather than silently dropping them', () => {
    const input = budgetFixture()
    expect(() => screenManufacturingCrewColumns({ ...input, groups: [g1, g1] })).toThrow()
    expect(() => screenManufacturingCrewColumns({ ...input, rooms: [g1] })).toThrow()
    expect(() => screenManufacturingCrewColumns({ ...input, requiredCores: ['unknown'] })).toThrow()
    expect(() => screenManufacturingCrewColumns({ ...input, rows: [row('bad', g1, 'room_3_3', 'main')] })).toThrow()
    expect(() => screenManufacturingCrewColumns({ ...input, rows: [row('bad', g1, g1, 'main', ['unknown'])] })).toThrow()
    expect(() => screenManufacturingCrewColumns({ ...input, rows: [row('bad', g1, g1, 'main', ['a', 'a'])] })).toThrow()
    expect(() => screenManufacturingCrewColumns(input, { maxStates: Number.NaN })).toThrow()
  })
})
