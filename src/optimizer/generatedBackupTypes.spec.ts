import { describe, expect, it } from 'vitest'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { createRosterRuntime } from '../scheduler/rosterRuntime'
import { evaluateBackupExpression } from '../scheduler/backupPlans'
import { generatedBackupTriggerExpression, type GeneratedBackupTrigger } from './generatedBackupTypes'

describe('generated backup condition contract', () => {
  it('observes actual rooms and distinguishes active support from zero-morale presence', () => {
    const trigger: GeneratedBackupTrigger = { activeWhen: 'all-present', observers: [
      { operatorId: '森蚺', roomId: 'central', requirePositiveMood: true },
      { operatorId: 'Lancet-2', roomId: 'room_1_3' },
    ] }
    const state = createRosterRuntime({ positions: [
      { id: 'control', roomId: 'central', primary: id('森蚺'), candidates: [] },
      { id: 'power', roomId: 'room_1_3', primary: id('Lancet-2'), candidates: [] },
    ], beds: [] })
    state.morale[id('Lancet-2')] = 0
    const on = generatedBackupTriggerExpression(trigger)
    const off = generatedBackupTriggerExpression({ ...trigger, activeWhen: 'not-all-present' })
    expect(evaluateBackupExpression(on, state)).toBe(true)
    expect(evaluateBackupExpression(off, state)).toBe(false)
    state.morale[id('森蚺')] = 0
    expect(evaluateBackupExpression(on, state)).toBe(false)
    expect(evaluateBackupExpression(off, state)).toBe(true)
    state.morale[id('森蚺')] = 24
    state.occupants.power = id('Castle-3')
    expect(evaluateBackupExpression(on, state)).toBe(false)
  })

  it('rejects undeclared condition fields instead of silently ignoring them', () => {
    const unknownTrigger = JSON.parse('{"activeWhen":"all-present","observers":[{"operatorId":"森蚺","roomId":"central"}],"customExpression":"True"}')
    const unknownObserver = JSON.parse('{"activeWhen":"all-present","observers":[{"operatorId":"森蚺","roomId":"central","customMood":99}]}')
    expect(() => generatedBackupTriggerExpression(unknownTrigger)).toThrow()
    expect(() => generatedBackupTriggerExpression(unknownObserver)).toThrow()
  })

  it('rejects duplicate aliases and observations beyond the declared template', () => {
    expect(() => generatedBackupTriggerExpression({ activeWhen: 'all-present', observers: [
      { operatorId: '森蚺', roomId: 'central' }, { operatorId: id('森蚺'), roomId: 'room_1_3' },
    ] })).toThrow()
    expect(() => generatedBackupTriggerExpression(JSON.parse('{"activeWhen":"all-present","observers":[]}'))).toThrow()
    expect(() => generatedBackupTriggerExpression(JSON.parse('{"activeWhen":"all-present","observers":[{"operatorId":"森蚺","roomId":"dormitory_1"}]}'))).toThrow()
  })
})
