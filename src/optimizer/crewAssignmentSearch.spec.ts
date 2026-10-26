import { describe, expect, it } from 'vitest'
import { solveCrewAssignment } from './crewAssignmentSearch'
import type { CrewAssignmentModel, ScalarCrewColumn } from './crewAssignmentKernel'

const main = (id: string, groupOrigin: string, roomId: string, score: number, person = id): ScalarCrewColumn =>
  ({ id, groupOrigin, roomId, role: 'main', score, ids: [person], retainedCores: [], u: 1, restHours: 1 })
const backup = (id: string, groupOrigin: string, roomId: string): ScalarCrewColumn =>
  ({ id, groupOrigin, roomId, role: 'backup', score: 0, ids: [id], retainedCores: [], lower: 0, maximumCoverHours: null })
const fixture = (): CrewAssignmentModel => ({ id: 'conflict', groups: ['a', 'b'], rooms: ['1', '2'], requiredCores: [], objective: { kind: 'scalar', id: 'G-test' },
  rows: [main('a-high', 'a', '1', 100, 'shared'), main('a-low', 'a', '1', 10), backup('ab', 'a', '1'),
    main('b-high', 'b', '2', 90, 'shared'), main('b-low', 'b', '2', 80), backup('bb', 'b', '2')] })
const warmStartIds = ['a-low', 'ab', 'b-low', 'bb']

describe('crew assignment personnel search', () => {
  it('proves the globally best feasible assignment when greedy local maxima conflict', () => {
    const input = fixture(), before = structuredClone(input), result = solveCrewAssignment(input)
    expect(result).toMatchObject({ status: 'optimal', objective: 180, upperBound: 180, absoluteGap: 0, optimalityProven: true, modelId: 'conflict', objectiveId: 'G-test' })
    expect(result.selectedIds).toEqual(['a-high', 'ab', 'b-low', 'bb'])
    expect(result.visitedNodes).toBeGreaterThan(1)
    expect(input).toEqual(before)
  })
  it('keeps a verified warm start and valid unresolved upper under a node limit', () => {
    expect(solveCrewAssignment(fixture(), { warmStartIds, maxNodes: 1 })).toMatchObject({ status: 'feasible', termination: 'nodeLimit',
      objective: 90, upperBound: 190, absoluteGap: 100, optimalityProven: false, selectedIds: warmStartIds })
  })
  it('cannot shrink an emptied group away after a personnel-conflict branch', () => {
    const base = fixture(), input = { ...base, rows: base.rows.filter(row => !row.id.endsWith('-low')) } as CrewAssignmentModel
    expect(solveCrewAssignment(input)).toMatchObject({ status: 'infeasible', feasible: false, objective: null, selectedIds: [], optimalityProven: false })
  })
  it('enforces locked rows independently from the warm start', () => {
    expect(solveCrewAssignment({ ...fixture(), lockedRowIds: ['a-low'] })).toMatchObject({ status: 'optimal', objective: 100 })
    expect(() => solveCrewAssignment(fixture(), { warmStartIds: ['a-high', 'ab', 'b-high', 'bb'] })).toThrow(/warm start/i)
  })
  it('checks time before reading or cloning the large row library', () => {
    const input = fixture()
    Object.defineProperty(input, 'rows', { get: () => { throw new Error('library accessed after deadline') } })
    expect(solveCrewAssignment(input, { timeLimitMs: 0 })).toMatchObject({ status: 'unknown', termination: 'timeLimit', objective: null, upperBound: null, optimalityProven: false })
  })
  it('budget interruption during input copying never validates a partial warm start', () => {
    expect(solveCrewAssignment(fixture(), { warmStartIds, maxOperations: 10, timeLimitMs: Infinity })).toMatchObject({ status: 'unknown',
      termination: 'workLimit', objective: null, selectedIds: [], upperBound: null, optimalityProven: false })
  })
  it('stops state growth explicitly without turning a partial DP maximum into a proof', () => {
    const input: CrewAssignmentModel = { id: 'states', groups: ['a'], rooms: ['1'], coreIds: ['c'], requiredCores: [], objective: { kind: 'scalar', id: 'states-G' },
      rows: [main('no-core', 'a', '1', 10), { ...main('with-core', 'a', '1', 20), retainedCores: ['c'] }, backup('b', 'a', '1')] }
    const result = solveCrewAssignment(input, { maxStates: 1, warmStartIds: ['no-core', 'b'] })
    expect(result).toMatchObject({ status: 'feasible', termination: 'stateLimit', objective: 10, optimalityProven: false })
    expect(result.upperBound).toBeGreaterThanOrEqual(20)
  })
  it('keeps prepared identities and coefficients isolated from observation callbacks', () => {
    const input = fixture()
    const result = solveCrewAssignment(input, { onNode: () => {
      Object.assign(input, { id: 'mutated' }); Object.assign(input.objective, { id: 'mutated' }); Object.assign(input.rows[0]!, { score: 100000 })
      throw new Error('observation failed')
    } })
    expect(result).toMatchObject({ status: 'optimal', objective: 180, modelId: 'conflict', objectiveId: 'G-test' })
    expect(result.observerErrors.length).toBeGreaterThan(0)
  })
  it.each([0, -40, 10])('matches an independent exhaustive two-room oracle with offset %s', offset => {
    const rows: ScalarCrewColumn[] = []
    for (const group of ['a', 'b']) for (const room of ['1', '2']) {
      rows.push(main(`${group}${room}-shared`, group, room, offset + (room === '1' ? 20 : 30), 'shared'))
      rows.push(main(`${group}${room}-private`, group, room, offset + (group === 'a' ? 12 : 18)))
      rows.push(backup(`${group}${room}-backup`, group, room))
    }
    const oracle: number[] = []
    for (const aRoom of ['1', '2']) {
      const bRoom = aRoom === '1' ? '2' : '1'
      for (const a of rows.filter(row => row.role === 'main' && row.groupOrigin === 'a' && row.roomId === aRoom))
        for (const b of rows.filter(row => row.role === 'main' && row.groupOrigin === 'b' && row.roomId === bRoom))
          if (a.ids[0] !== b.ids[0]) oracle.push(a.score + b.score)
    }
    expect(solveCrewAssignment({ id: 'oracle', groups: ['a', 'b'], rooms: ['1', '2'], requiredCores: [], rows, objective: { kind: 'scalar', id: 'exhaustive' } }))
      .toMatchObject({ status: 'optimal', objective: Math.max(...oracle), upperBound: Math.max(...oracle) })
  })
})
