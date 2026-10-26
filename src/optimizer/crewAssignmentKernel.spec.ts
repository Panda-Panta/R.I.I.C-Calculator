import { describe, expect, it } from 'vitest'
import { CrewAssignmentBudget, CrewAssignmentInterrupted, inspectCrewSelection, prepareCrewAssignmentModel, relaxCrewAssignment, type CrewAssignmentModel } from './crewAssignmentKernel'

const main = (id: string, groupOrigin: string, roomId: string, score: number, ids = [id], retainedCores: string[] = []) =>
  ({ id, groupOrigin, roomId, role: 'main' as const, score, ids, retainedCores, u: 1, restHours: 1 })
const backup = (id: string, groupOrigin: string, roomId: string, score = 0) =>
  ({ id, groupOrigin, roomId, role: 'backup' as const, score, ids: [id], retainedCores: [], lower: 0, maximumCoverHours: null })
const conflict: CrewAssignmentModel = { id: 'shared-person', groups: ['a', 'b'], rooms: ['1', '2'], requiredCores: [],
  objective: { kind: 'scalar', id: 'additive-fixture' }, rows: [main('a-high', 'a', '1', 100, ['person']), main('a-low', 'a', '1', 10), backup('ab', 'a', '1'),
    main('b-high', 'b', '2', 90, ['person']), main('b-low', 'b', '2', 80), backup('bb', 'b', '2')] }

describe('crew assignment relaxation', () => {
  it('returns a genuine upper witness while independently rejecting repeated personnel', () => {
    const model = prepareCrewAssignmentModel(conflict), relaxed = relaxCrewAssignment(model)
    expect(relaxed).toMatchObject({ complete: true, feasible: true, upperBound: 190 })
    expect(inspectCrewSelection(model, relaxed.witnessIds)).toMatchObject({ feasible: false, relaxedValid: true, objective: 190 })
    expect(inspectCrewSelection(model, ['a-high', 'ab', 'b-low', 'bb'])).toMatchObject({ feasible: true, objective: 180 })
  })
  it('retains the declared group and room domain when no row can fill it', () => {
    const model = prepareCrewAssignmentModel({ ...conflict, rows: conflict.rows.filter(row => row.groupOrigin === 'a') } as CrewAssignmentModel)
    expect(relaxCrewAssignment(model)).toMatchObject({ complete: true, feasible: false, upperBound: -Infinity, witnessIds: [] })
  })
  it.each([false, true])('keeps optional cores exclusive with required=%s', required => {
    const input: CrewAssignmentModel = { id: 'optional', groups: ['a', 'b'], rooms: ['1', '2'], coreIds: ['core', 'unused'], requiredCores: required ? ['core'] : [],
      objective: { kind: 'scalar', id: 'optional-core-fixture' }, rows: [main('a-core', 'a', '1', 10, undefined, ['core']), main('a-other', 'a', '1', 9), backup('ab', 'a', '1'),
        main('b-core', 'b', '2', 10, undefined, ['core']), main('b-other', 'b', '2', 8), backup('bb', 'b', '2')] }
    const model = prepareCrewAssignmentModel(input), result = relaxCrewAssignment(model)
    expect(result.upperBound).toBe(19)
    expect(inspectCrewSelection(model, result.witnessIds).feasible).toBe(true)
    expect(inspectCrewSelection(model, ['a-core', 'ab', 'b-core', 'bb']).feasible).toBe(false)
  })
  it('may omit an optional core entirely, while requiring it changes the optimum', () => {
    const input: CrewAssignmentModel = { id: 'omit-core', groups: ['a'], rooms: ['1'], coreIds: ['core'], requiredCores: [],
      objective: { kind: 'scalar', id: 'omit-core-G' }, rows: [main('core', 'a', '1', -10, undefined, ['core']), main('plain', 'a', '1', 8), backup('b', 'a', '1')] }
    expect(relaxCrewAssignment(prepareCrewAssignmentModel(input)).upperBound).toBe(8)
    expect(relaxCrewAssignment(prepareCrewAssignmentModel({ ...input, requiredCores: ['core'] })).upperBound).toBe(-10)
  })
  it('resolves backup coefficients and admission by exact main cycle key', () => {
    const input: CrewAssignmentModel = { id: 'cycle-table', groups: ['a'], rooms: ['1'], requiredCores: [], objective: { kind: 'cycle-table', id: 'G2-fixture' }, rows: [
      { ...main('m0', 'a', '1', 10), u: 0.5, cycleKey: 'k0' }, { ...main('m1', 'a', '1', 9), u: 0.5, cycleKey: 'k1' },
      { ...backup('b0', 'a', '1'), compatibleCycleKeys: ['k0', 'k1'], scoreByCycleKey: { k0: 100, k1: 0 } },
      { ...backup('b1', 'a', '1'), compatibleCycleKeys: ['k0', 'k1'], scoreByCycleKey: { k0: 0, k1: 200 } },
    ] }
    expect(relaxCrewAssignment(prepareCrewAssignmentModel(input))).toMatchObject({ upperBound: 104.5, witnessIds: ['m1', 'b1'] })
    const restricted = { ...input, rows: input.rows.map(row => row.id === 'b1' ? { ...row, compatibleCycleKeys: ['k0'] } : row) } as CrewAssignmentModel
    expect(relaxCrewAssignment(prepareCrewAssignmentModel(restricted))).toMatchObject({ upperBound: 55, witnessIds: ['m0', 'b0'] })
  })
  it('does not silently tolerate a failed cycle coverage condition', () => {
    const input: CrewAssignmentModel = { id: 'cover', groups: ['a'], rooms: ['1'], requiredCores: [], objective: { kind: 'scalar', id: 'coverage' },
      rows: [{ ...main('m', 'a', '1', 100), u: 0.5 }, { ...backup('b', 'a', '1', 10), lower: 0.500000001 }] }
    expect(relaxCrewAssignment(prepareCrewAssignmentModel(input)).feasible).toBe(false)
    expect(relaxCrewAssignment(prepareCrewAssignmentModel({ ...input, cycleTolerance: 1e-7 })).upperBound).toBe(55)
  })
  it('copies input coefficients and identities before solving', () => {
    const input = structuredClone(conflict), model = prepareCrewAssignmentModel(input)
    Object.assign(input.rows[0]!, { score: 100000 })
    expect(relaxCrewAssignment(model).upperBound).toBe(190)
  })
  it('returns no partial DP upper or witness when its work budget ends', () => {
    const model = prepareCrewAssignmentModel(conflict)
    const result = relaxCrewAssignment(model, undefined, new CrewAssignmentBudget({ maxOperations: 9, timeLimitMs: Infinity }))
    expect(result).toMatchObject({ complete: false, feasible: null, upperBound: null, witnessIds: [] })
  })
  it('does not reuse a completed first room permutation as the upper for unfinished alternatives', () => {
    const rows = ['a', 'b'].flatMap(group => ['1', '2'].flatMap(room => [
      main(`${group}${room}m`, group, room, group === 'a' ? room === '1' ? 1 : 100 : room === '1' ? 100 : 1), backup(`${group}${room}b`, group, room),
    ]))
    const model = prepareCrewAssignmentModel({ ...conflict, rows })
    class StopAfterFirst extends CrewAssignmentBudget {
      private sawFinal = false
      override check(stage: string): void {
        super.check(stage)
        if (this.sawFinal && stage === 'relax:placement-room') throw new CrewAssignmentInterrupted('workLimit', stage)
        if (stage === 'relax:final-mask') this.sawFinal = true
      }
    }
    expect(relaxCrewAssignment(model).upperBound).toBe(200)
    expect(relaxCrewAssignment(model, undefined, new StopAfterFirst())).toMatchObject({ complete: false, upperBound: null, witnessIds: [] })
  })
  it.each([0, 1])('handles exact work fraction %s without introducing another objective term', u => {
    const model = prepareCrewAssignmentModel({ id: `u-${u}`, groups: ['a'], rooms: ['1'], requiredCores: [], objective: { kind: 'scalar', id: 'u-boundary' },
      rows: [{ ...main('m', 'a', '1', 100), u }, backup('b', 'a', '1', 8)] })
    expect(relaxCrewAssignment(model).upperBound).toBe(u === 0 ? 8 : 100)
  })
  it('rejects nonfinite, undeclared and sparse input data', () => {
    expect(() => prepareCrewAssignmentModel({ ...conflict, coreIds: [], requiredCores: ['missing'] })).toThrow()
    expect(() => prepareCrewAssignmentModel({ ...conflict, groups: new Array<string>(2) })).toThrow()
    expect(() => prepareCrewAssignmentModel({ ...conflict, rows: [{ ...main('bad', 'a', '1', NaN) }] })).toThrow()
    const invalid: CrewAssignmentModel = { id: 'missing-cycle-score', groups: ['a'], rooms: ['1'], requiredCores: [], objective: { kind: 'cycle-table', id: 'G2' }, rows: [
      { ...main('m', 'a', '1', 1), cycleKey: 'k' }, { ...backup('b', 'a', '1'), compatibleCycleKeys: ['k'], scoreByCycleKey: {} },
    ] }
    expect(() => prepareCrewAssignmentModel(invalid)).toThrow()
  })
})
