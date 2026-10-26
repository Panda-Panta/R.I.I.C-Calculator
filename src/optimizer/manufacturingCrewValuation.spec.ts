import { describe, expect, it, vi } from 'vitest'
import { compileOperatorInventory, fullCatalogIdleInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import type { MowerSlot } from '../domain/roster'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { createDefaultWorkspace } from '../workbench/defaults'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { enumerateManufacturingCrewColumns, prepareManufacturingCrewDomain, type ManufacturingCrewDomain } from './manufacturingCrewDomain'
import { projectRosterConfig } from './rosterProjection'
import { projectControlOutput } from './controlImpact'
import { valueManufacturingCrewColumns } from './manufacturingCrewValuation'
import * as morale from '../engine/morale'

function fixture(main = '砾', backup = '斑点', product: 'gold' | 'exp' = 'gold', elitePhase?: number): ManufacturingCrewDomain {
  const initial = createDefaultWorkspace()
  for (const room of Object.values(initial.mainPlan.facilities)) room.slots = []
  initial.mainPlan.facilities.dormitory_1.slots = [
    { occupant: { kind: 'operator', operatorId: id('闪灵') }, groupId: null, replacements: [] },
    ...Array.from({ length: 4 }, (): MowerSlot => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] })),
  ]
  const userBase = structuredClone(initial), room = initial.mainPlan.facilities.room_3_2
  room.type = 'manufacture'; room.level = 1; room.product = product
  room.slots = [{ occupant: { kind: 'operator', operatorId: id(main) }, replacements: [id(backup)], groupId: 'local' }]
  const wanted = new Set([main, backup, '闪灵', '夜烟', '香草', '机械师'].map(id))
  const entries = fullCatalogIdleInventory().filter(row => wanted.has(row.operator)).map(row => row.operator === id(main) && elitePhase !== undefined ? { ...row, elitePhase, level: 1 } : row)
  const inventory = compileOperatorInventory(entries)
  expect(applyGeneratedWarmupPolicy(initial, inventory).valid).toBe(true)
  const prepared = prepareManufacturingCrewDomain({ userBase, initial, inventory, lockedPositions: new Set(), lockedOperators: new Set() })
  if (!prepared.domain) throw new Error(JSON.stringify(prepared.diagnostics))
  return prepared.domain
}
const ample = { timeLimitMs: 10_000, maxOperations: 1_000_000 }

describe('finite manufacturing crew valuation', () => {
  it('values a complete main/backup pair without changing the owned domain, seats or input', () => {
    const domain = fixture(), before = structuredClone(domain)
    const result = valueManufacturingCrewColumns(domain, domain.initialColumns, { ...ample, includeDetails: true })
    expect(result.status).toBe('complete')
    expect(result.completeDomain).toBe(true)
    expect(result.rows).toHaveLength(2)
    const main = result.rows.find(row => row.role === 'main')!, backup = result.rows.find(row => row.role === 'backup')!
    expect(main.role === 'main' && main.u).toBeGreaterThan(0)
    expect(main.role === 'main' && main.u).toBeLessThan(1)
    if (main.role !== 'main' || backup.role !== 'backup') throw new Error('Wrong row roles')
    expect(backup.compatibleCycleKeys).toContain(main.cycleKey)
    expect(Number.isFinite(backup.scoreByCycleKey[main.cycleKey])).toBe(true)
    expect(domain).toEqual(before)
  })

  it('honors the supplied finite window and delayed warmup rather than using maximum skill output', () => {
    const domain = fixture('机械师', '红豆', 'exp')
    const config = projectRosterConfig(domain.initial); config.operatorRecords = inventoryOperatorRecords(domain.inventory)
    const at = (hours: number) => projectControlOutput(config, { selectedRoomIds: ['B302'], timeContext: { workHoursByOperator: new Map([[id('机械师'), hours]]), warmupModel: 'continuous' } }).rooms[0]!.daily.score
    const short = valueManufacturingCrewColumns(domain, domain.initialColumns, { ...ample, warmupHours: 0, sampleHours: 6, includeDetails: true })
    const long = valueManufacturingCrewColumns(domain, domain.initialColumns, { ...ample, warmupHours: 0, sampleHours: 13.5 })
    expect(short.status).toBe('complete'); expect(long.status).toBe('complete')
    const shortMain = short.rows.find(row => row.role === 'main')!, longMain = long.rows.find(row => row.role === 'main')!
    expect(shortMain.role === 'main' && shortMain.score).toBeCloseTo(at(0), 8)
    expect(longMain.role === 'main' && longMain.score).toBeCloseTo(at(0) + (at(13) - at(0)) * 1.5 / 13.5, 8)
    expect(short.window).toEqual({ warmupHours: 0, sampleHours: 6, maxIntegrationStepHours: .25 })
  })

  it('uses actual unlocked stages and never supplies an absent inventory actor', () => {
    const low = fixture('砾', '斑点', 'gold', 0), high = fixture('砾', '斑点', 'gold', 1)
    const a = valueManufacturingCrewColumns(low, low.initialColumns, ample), b = valueManufacturingCrewColumns(high, high.initialColumns, ample)
    expect(a.status).toBe('complete'); expect(b.status).toBe('complete')
    expect(b.rows.find(r => r.role === 'main')!.score).toBeGreaterThan(a.rows.find(r => r.role === 'main')!.score)
    const missing = { ...low.initialColumns[0]!, id: 'unowned', ids: [id('阿米娅')], seatOperatorIds: [id('阿米娅')] }
    const rejected = valueManufacturingCrewColumns(low, [missing, low.initialColumns[1]!], ample)
    expect(rejected.completeDomain).toBe(false)
    expect(rejected.rows.some(row => row.id === 'unowned')).toBe(false)
    expect(rejected.diagnostics.some(d => d.columnId === 'unowned' && d.code === 'CREW_UNOWNED_ACTOR')).toBe(true)
  })

  it('can assign an initially primary cold actor to a low backup role', () => {
    const domain = fixture(), rows = [...enumerateManufacturingCrewColumns(domain)]
    const main = rows.find(row => row.role === 'main' && row.ids[0] === id('斑点'))!, backup = rows.find(row => row.role === 'backup' && row.ids[0] === id('砾'))!
    expect(main).toBeTruthy(); expect(backup).toBeTruthy()
    const result = valueManufacturingCrewColumns(domain, [main, backup], ample)
    expect(result.status).toBe('complete'); expect(result.rows).toHaveLength(2)
    expect(result.diagnostics).toEqual([])
  })

  it('reports invalid windows and budget stops before or during preparation/integration', () => {
    const domain = fixture()
    expect(valueManufacturingCrewColumns(domain, domain.initialColumns, { sampleHours: 0 }).status).toBe('invalid')
    const before = valueManufacturingCrewColumns(domain, domain.initialColumns, { timeLimitMs: 0 })
    expect(before.status).toBe('incomplete'); expect(before.rows).toEqual([])
    let calls = 0
    const cancelled = valueManufacturingCrewColumns(domain, domain.initialColumns, { ...ample, check: () => ++calls < 20 })
    expect(cancelled.status).toBe('incomplete'); expect(cancelled.completeDomain).toBe(false)
    expect(cancelled.stopReason).toBe('cancelled')
  })

  it('does not silently value a warmup backup as if its flag could prevent primary recall', () => {
    const domain = fixture('机械师', '红豆', 'exp')
    const bad = { ...domain.initialColumns[1]!, id: 'warmup-backup', ids: [id('机械师')], seatOperatorIds: [id('机械师')] }
    const result = valueManufacturingCrewColumns(domain, [domain.initialColumns[0]!, bad], ample)
    expect(result.rows.some(row => row.id === bad.id)).toBe(false)
    expect(result.diagnostics.some(d => d.columnId === bad.id && d.code === 'CREW_WARMUP_BACKUP')).toBe(true)
  })

  it('retains a fully valued initial pair when expansion exhausts the budget', () => {
    const domain = fixture(), baseline = valueManufacturingCrewColumns(domain, domain.initialColumns, ample)
    const more = Array.from({ length: 40 }, (_, index) => ({ ...domain.initialColumns[0]!, id: `extra-${index}` }))
    const result = valueManufacturingCrewColumns(domain, [...domain.initialColumns, ...more], { ...ample, maxOperations: baseline.stats.operations + 100 })
    expect(result.status).toBe('incomplete'); expect(result.completeDomain).toBe(false)
    expect(result.initialColumnsQuantified).toBe(true)
    const main = result.rows.find(row => row.id === domain.initialColumns[0]!.id)!, backup = result.rows.find(row => row.id === domain.initialColumns[1]!.id)!
    if (main.role !== 'main' || backup.role !== 'backup') throw new Error('Wrong row roles')
    expect(backup.compatibleCycleKeys).toContain(main.cycleKey)
  })

  it('closes each new primary clock against the existing initial cover before the backup sweep', () => {
    const domain = fixture('砾', '斑点', 'exp')
    const extra = { ...domain.initialColumns[0]!, id: 'new-warmup-clock', ids: [id('机械师')], seatOperatorIds: [id('机械师')] }
    const complete = valueManufacturingCrewColumns(domain, [...domain.initialColumns, extra], ample)
    const padding = Array.from({ length: 40 }, (_, index) => ({ ...domain.initialColumns[0]!, id: `later-main-${index}` }))
    const result = valueManufacturingCrewColumns(domain, [...domain.initialColumns, extra, ...padding], { ...ample, maxOperations: complete.stats.operations + 200 })
    expect(result.status).toBe('incomplete')
    const main = result.rows.find(row => row.id === extra.id)!, backup = result.rows.find(row => row.id === domain.initialColumns[1]!.id)!
    if (main.role !== 'main' || backup.role !== 'backup') throw new Error('Wrong row roles')
    expect(backup.compatibleCycleKeys).toContain(main.cycleKey)
    expect(result.initialColumnsQuantified).toBe(true)
  })

  it('shares a bounded expansion between main and backup roles even when input mains come first', () => {
    const domain = fixture(), main = { ...domain.initialColumns[0]!, id: 'first-main' }
    const backup = { ...domain.initialColumns[1]!, id: 'early-backup', ids: [id('夜烟')], seatOperatorIds: [id('夜烟')] }
    const small = valueManufacturingCrewColumns(domain, [...domain.initialColumns, main, backup], ample)
    const more = Array.from({ length: 40 }, (_, index) => ({ ...main, id: `queued-main-${index}` }))
    const result = valueManufacturingCrewColumns(domain, [...domain.initialColumns, main, ...more, backup], { ...ample, maxOperations: small.stats.operations + 100 })
    expect(result.status).toBe('incomplete')
    expect(result.initialColumnsQuantified).toBe(true)
    expect(result.rows.some(row => row.id === backup.id)).toBe(true)
    expect(result.rows.some(row => row.id === more[more.length - 1]!.id)).toBe(false)
    const actual = result.rows.find(row => row.id === backup.id)!, expected = small.rows.find(row => row.id === backup.id)!
    expect(actual).toEqual(expected)
  })

  it('visits another context before exhausting a long first-context queue', () => {
    const prior = fixture(), initial = structuredClone(prior.initial)
    const second = Object.values(initial.mainPlan.facilities).find(room => room.type === 'manufacture' && room.roomId !== 'room_3_2')!
    second.level = 1
    second.slots = [{ occupant: { kind: 'operator', operatorId: id('夜烟') }, groupId: 'other', replacements: [id('香草')] }]
    const prepared = prepareManufacturingCrewDomain({ ...prior, initial })
    if (!prepared.domain) throw new Error(JSON.stringify(prepared.diagnostics))
    const domain = prepared.domain, mainRows = domain.initialColumns.filter(row => row.role === 'main')
    const first = { ...mainRows[0]!, id: 'first-context' }, next = { ...mainRows[1]!, id: 'next-context' }
    const small = valueManufacturingCrewColumns(domain, [...domain.initialColumns, first, next], ample)
    const padding = Array.from({ length: 40 }, (_, index) => ({ ...first, id: `queued-context-${index}` }))
    const result = valueManufacturingCrewColumns(domain, [...domain.initialColumns, first, ...padding, next], { ...ample, maxOperations: small.stats.operations + 100 })
    expect(result.status).toBe('incomplete'); expect(result.initialColumnsQuantified).toBe(true)
    expect(result.rows.some(row => row.id === next.id)).toBe(true)
    expect(result.rows.some(row => row.id === padding[padding.length - 1]!.id)).toBe(false)
  })

  it('finishes earlier backup tables and preserves all coefficients after role visitation changes', () => {
    const domain = fixture('砾', '斑点', 'exp'), initialMain = domain.initialColumns[0]!, initialBackup = domain.initialColumns[1]!
    const cold = { ...initialMain, id: 'cold', ids: [id('夜烟')], seatOperatorIds: [id('夜烟')] }
    const warm = { ...initialMain, id: 'warm', ids: [id('机械师')], seatOperatorIds: [id('机械师')] }
    const backup = { ...initialBackup, id: 'other-cover', ids: [id('香草')], seatOperatorIds: [id('香草')] }
    const first = valueManufacturingCrewColumns(domain, [...domain.initialColumns, cold, warm, backup], ample)
    const reverse = valueManufacturingCrewColumns(domain, [backup, warm, cold, ...domain.initialColumns], ample)
    expect(first.completeDomain).toBe(true); expect(reverse.completeDomain).toBe(true)
    const normalize = (result: typeof first) => result.rows.map(row => row.role === 'main'
      ? { id: row.id, role: row.role, u: row.u, score: row.score, restHours: row.restHours }
      : { id: row.id, role: row.role, scores: Object.fromEntries(result.rows.filter(main => main.role === 'main').map(main => [main.id, main.role === 'main' ? row.scoreByCycleKey[main.cycleKey] ?? null : null]).sort(([a], [b]) => String(a).localeCompare(String(b)))) })
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(normalize(first)).toEqual(normalize(reverse))
    const lateMain = first.rows.find(row => row.id === warm.id)!, earlyBackup = first.rows.find(row => row.id === backup.id)!
    if (lateMain.role !== 'main' || earlyBackup.role !== 'backup') throw new Error('Wrong roles')
    expect(earlyBackup.compatibleCycleKeys).toContain(lateMain.cycleKey)
    expect(first.diagnostics).toEqual([]); expect(reverse.diagnostics).toEqual([])
  })

  it('does not interpret an active member with a missing rate as permanent work', () => {
    const domain = fixture(), missing = vi.spyOn(morale, 'currentMoraleRates').mockReturnValue({ rates: {}, details: {}, unquantified: [] })
    try {
      const result = valueManufacturingCrewColumns(domain, domain.initialColumns, ample)
      expect(result.completeDomain).toBe(false)
      expect(result.diagnostics.some(d => d.code === 'CREW_DEPLETION_RATE')).toBe(true)
      expect(result.rows.some(row => row.role === 'main')).toBe(false)
    } finally { missing.mockRestore() }
  })

  it('retains a fixed non-resting support while honoring its group full-recovery margin', () => {
    const prior = fixture('机械师', '斑点', 'exp'), initial = structuredClone(prior.initial)
    const support = Object.values(initial.mainPlan.facilities).find(room => room.type === 'power')!
    support.level = 3
    support.slots = [{ occupant: { kind: 'operator', operatorId: id('香草') }, groupId: 'local', replacements: [id('夜烟')] }]
    initial.mainPlan.conf.workaholic.push(id('香草')); initial.mainPlan.conf.rest_in_full.push(id('香草'))
    const prepared = prepareManufacturingCrewDomain({ ...prior, initial })
    if (!prepared.domain) throw new Error(JSON.stringify(prepared.diagnostics))
    const result = valueManufacturingCrewColumns(prepared.domain, prepared.domain.initialColumns, { ...ample, includeDetails: true })
    expect(result.completeDomain).toBe(true)
    const profile = Object.values(result.mainProfiles!)[0]!, first = profile.phases[0]!
    expect(profile.actors.some(actor => actor.id === id('香草'))).toBe(false)
    if (first.role !== 'main') throw new Error('Expected primary work phase')
    expect(first.marginMinutes).toBe(10)
    const fixed = structuredClone(initial)
    fixed.mainPlan.conf.exhaust_require.push(id('香草'))
    const fixedDomain = prepareManufacturingCrewDomain({ ...prior, initial: fixed })
    if (!fixedDomain.domain) throw new Error(JSON.stringify(fixedDomain.diagnostics))
    const rejected = valueManufacturingCrewColumns(fixedDomain.domain, fixedDomain.domain.initialColumns, ample)
    expect(rejected.completeDomain).toBe(false)
    expect(rejected.diagnostics.some(d => d.code === 'CREW_FIXED_EXHAUST_ANCHOR')).toBe(true)
  })

  it.each([1, 2])('preserves harmless empty placeholders beyond a level-%i room capacity', level => {
    const prior = fixture(), initial = structuredClone(prior.initial), room = initial.mainPlan.facilities.room_3_2
    room.level = level
    if (level === 2) room.slots.push({ occupant: { kind: 'operator', operatorId: id('夜烟') }, replacements: [id('香草')], groupId: 'local' })
    room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }, { occupant: { kind: 'empty' }, groupId: null, replacements: [] })
    const prepared = prepareManufacturingCrewDomain({ ...prior, initial })
    if (!prepared.domain) throw new Error(JSON.stringify(prepared.diagnostics))
    const result = valueManufacturingCrewColumns(prepared.domain, prepared.domain.initialColumns, ample)
    expect(result.status).toBe('complete'); expect(result.completeDomain).toBe(true)
    expect(result.rows).toHaveLength(2)
    expect(initial.mainPlan.facilities.room_3_2.slots.slice(level).every(slot => slot.occupant.kind === 'empty')).toBe(true)
  })

  it('prepares narrow-limit full recovery and integrates a peer reaching zero before the warmup anchor', () => {
    const prior = fixture(), initial = structuredClone(prior.initial), room = initial.mainPlan.facilities.room_3_2
    const mains = ['红云', '稀音', '铅踝'], backups = ['红豆', '霜叶', '断罪者']
    room.level = 3; room.product = 'exp'
    room.slots = mains.map((name, index) => ({ occupant: { kind: 'operator', operatorId: id(name) }, groupId: 'local', replacements: [id(backups[index]!)] }))
    const wanted = new Set([...mains, ...backups, '闪灵'].map(id)), inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(row => wanted.has(row.operator)))
    expect(applyGeneratedWarmupPolicy(initial, inventory).valid).toBe(true)
    const prepared = prepareManufacturingCrewDomain({ ...prior, initial, inventory })
    if (!prepared.domain) throw new Error(JSON.stringify(prepared.diagnostics))
    const result = valueManufacturingCrewColumns(prepared.domain, prepared.domain.initialColumns, { ...ample, includeDetails: true })
    expect(result.completeDomain).toBe(true)
    const profile = Object.values(result.mainProfiles!)[0]!
    expect(profile.actors.find(actor => actor.id === id('铅踝'))!.restInFull).toBe(true)
    const first = profile.phases[0]!
    if (first.role !== 'main') throw new Error('Expected primary working phase')
    expect(first.marginMinutes).toBe(10)
    expect(first.initial[id('铅踝')]! - first.rates[id('铅踝')]! * first.duration).toBeLessThan(0)
    expect(Number.isFinite(profile.score)).toBe(true)
  })
})
