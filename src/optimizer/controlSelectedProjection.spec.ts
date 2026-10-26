import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, createRoom } from '../domain/defaults'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import * as rules from '../engine/operatorRules'
import { projectControlOutput } from './controlImpact'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const config = createDefaultConfig()
  const manufacture = createRoom('selected', 'manufacture')
  manufacture.operatorIds = [id('温蒂')]
  const power = createRoom('support', 'power')
  power.operatorIds = [id('Lancet-2')]
  const trade = createRoom('other', 'trading')
  trade.specialOrder = 'none'; trade.operatorIds = [id('能天使')]
  config.rooms = [manufacture, power, trade]
  config.controlOperatorIds = [id('森蚺')]
  return config
}

describe('selected output keeps the complete base as its causal context', () => {
  it('prices only requested rooms while retaining support in all other rooms', () => {
    const config = fixture(), before = structuredClone(config)
    const full = projectControlOutput(config)
    const selected = projectControlOutput(config, { selectedRoomIds: ['selected'] })
    expect(selected.rooms).toEqual(full.rooms.filter(room => room.roomId === 'selected'))
    expect(selected.daily).toEqual(full.rooms[0]!.daily)
    expect(selected.complete).toBe(true)
    config.rooms[1]!.operatorIds = []
    const noSupport = projectControlOutput(config, { selectedRoomIds: ['selected'] })
    expect(noSupport.rooms[0]!.efficiencyPercent).toBeLessThan(selected.rooms[0]!.efficiencyPercent)
    config.rooms[1]!.operatorIds = before.rooms[1]!.operatorIds
    expect(config).toEqual(before)
  })

  it.each([0, 11.999, 12, 18])('retains the full-projection warmup value at %s hours', hours => {
    const config = fixture()
    config.rooms[0]!.product = 'exp'
    config.rooms[0]!.operatorIds = [id('机械师')]
    const timeContext = { workHoursByOperator: new Map([[id('机械师'), hours]]) }
    const full = projectControlOutput(config, { timeContext })
    const selected = projectControlOutput(config, { timeContext, selectedRoomIds: ['selected'] })
    expect(selected.rooms).toEqual(full.rooms.filter(room => room.roomId === 'selected'))
    expect(selected.daily).toEqual(full.rooms[0]!.daily)
  })

  it('does not evaluate unrelated outputs or report their unquantified production as the selected room', () => {
    const config = fixture()
    config.rooms[2]!.operatorIds = [id('铎铃')]
    const full = projectControlOutput(config)
    expect(full.complete).toBe(false)
    const evaluate = vi.spyOn(rules, 'evaluateOperators')
    const selected = projectControlOutput(config, { selectedRoomIds: ['selected'] })
    expect(evaluate.mock.calls.map(call => call[0].id)).toEqual(['selected'])
    expect(selected.rooms).toEqual([full.rooms[0]!])
    expect(selected.complete).toBe(true)
    expect(selected.diagnostics).toEqual([])
  })

  it('rejects an unknown output identity instead of accepting an empty zero-valued objective', () => {
    expect(() => projectControlOutput(fixture(), { selectedRoomIds: ['typo'] })).toThrow('未知投影设施')
  })
})
