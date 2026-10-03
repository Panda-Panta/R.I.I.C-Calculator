import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { calculate } from '../engine/calculate'
import { validatePhysicalRoster } from '../optimizer/rosterDraft'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { compileMainPlanToAppConfig } from './adapter'
import { importMowerJson, exportMowerJson } from './compat/mowerJson'
import { createDefaultWorkspace } from './defaults'
import { inferFacilityLevels } from './levelInference'
import { applyFacilityLayout, captureFacilityLayout, isValidFacilityLayout } from './layoutPresets'
import { runCalculationBridge } from './calculationBridge'
import { validateRosterWorkspace } from './validate'
import { migrateAppConfigToWorkspace } from './migrate'
import { applySmartDormitoryPolicy } from '../scheduler/smartDormitoryPolicy'

function source() {
  return JSON.parse(readFileSync(resolve('src/workbench/compat/fixtures/mower-252-3gold.json'), 'utf8'))
}
function reducedRoster() {
  const raw = source()
  delete raw[raw.default].dormitory_4
  delete raw[raw.default].train
  return importMowerJson(JSON.stringify(raw))
}

describe('unbuilt facilities', () => {
  it('imports three staffed dorms and no training room without phantom power, beds or operators', () => {
    const ws = reducedRoster()
    expect(ws.mainPlan.facilities.dormitory_4).toMatchObject({ level: 0, slots: [] })
    expect(ws.mainPlan.facilities.train).toMatchObject({ level: 0, slots: [] })
    expect(validatePhysicalRoster(ws)).toEqual([])
    expect(validateRosterWorkspace(ws).power).toMatchObject({ generation: 540, consumption: 470, margin: 70 })
    const schedule = compileRosterSchedule(ws)
    expect(schedule.rooms.filter(r => r.type === 'dormitory')).toHaveLength(3)
    expect(schedule.rooms.some(r => r.roomId === 'train' || r.roomId === 'dormitory_4')).toBe(false)
    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, createDefaultConfig())
    expect(config.facilities.dormitories).toEqual([1, 1, 1, 0])
    expect(config.facilities.training).toBe(0)
    expect(config.facilityOperatorIds.training).toEqual([])
    expect(calculate(config).power.consumption).toBe(470)
    const roundtrip = importMowerJson(exportMowerJson(ws))
    expect(compileRosterSchedule(roundtrip).rooms.map(r => r.roomId)).toEqual(schedule.rooms.map(r => r.roomId))
  })

  it('uses actual dorm residents to infer construction, never Free placeholders', () => {
    const raw = source()
    raw[raw.default].dormitory_4.plans = Array.from({ length: 5 }, () => ({ agent: 'Free', group: '', replacement: [] }))
    const ws = importMowerJson(JSON.stringify(raw))
    expect(ws.mainPlan.facilities.dormitory_4).toMatchObject({ level: 0, slots: [] })
    expect(compileRosterSchedule(ws).restPools.some(p => p.roomId === 'dormitory_4')).toBe(false)
    expect(ws.mainPlan.facilities.dormitory_1.slots.some(s => s.occupant.kind === 'operator')).toBe(true)
  })

  it('accepts omitted records and exports them as absent rather than throwing', () => {
    const ws = importMowerJson(JSON.stringify(source()))
    delete (ws.mainPlan.facilities as Partial<typeof ws.mainPlan.facilities>).dormitory_4
    delete (ws.mainPlan.facilities as Partial<typeof ws.mainPlan.facilities>).train
    expect(validatePhysicalRoster(ws)).toEqual([])
    expect(() => exportMowerJson(ws)).not.toThrow()
    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, createDefaultConfig())
    expect(config.facilities.training).toBe(0)
    expect(config.facilities.dormitories[3]).toBe(0)
    expect(() => captureFacilityLayout(ws)).not.toThrow()
    expect(captureFacilityLayout(ws).dormitory_4.level).toBe(0)
  })

  it('retains per-room calculation settings after omitting an earlier production room', () => {
    const ws = reducedRoster()
    ws.mainPlan.facilities.room_1_1.level = 0
    ws.mainPlan.facilities.room_1_1.slots = []
    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, createDefaultConfig())
    config.rooms[0]!.skillBonus = 17
    const recompiled = compileMainPlanToAppConfig(ws.mainPlan, ws, config)
    expect(recompiled.rooms[0]!.id).toBe(config.rooms[0]!.id)
    expect(recompiled.rooms[0]!.skillBonus).toBe(17)
    expect(recompiled.rooms[1]!.skillBonus).toBe(0)
  })

  it('supports omitted production and auxiliary facilities without counting them as built', () => {
    const raw = source()
    for (const room of ['room_1_1', 'meeting', 'contact', 'factory']) delete raw[raw.default][room]
    const ws = importMowerJson(JSON.stringify(raw))
    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, createDefaultConfig())
    expect(config.rooms).toHaveLength(8)
    expect(config.facilities).toMatchObject({ reception: 0, office: 0, workshop: 0 })
    expect(validatePhysicalRoster(ws)).toEqual([])
    expect(calculate(config).power).toEqual(validateRosterWorkspace(ws).power)
  })

  it('does not resurrect unbuilt rooms when inferring levels or applying a layout preset', () => {
    const ws = reducedRoster()
    inferFacilityLevels(ws.mainPlan.facilities)
    expect(ws.mainPlan.facilities.train.level).toBe(0)
    expect(ws.mainPlan.facilities.dormitory_4.level).toBe(0)
    const layout = captureFacilityLayout(ws)
    expect(isValidFacilityLayout(layout)).toBe(true)
    const applied = applyFacilityLayout(createDefaultWorkspace(), layout).workspace
    expect(applied.mainPlan.facilities.train.slots).toEqual([])
    expect(applied.mainPlan.facilities.dormitory_4.slots).toEqual([])
  })

  it('rejects staffing an explicitly unbuilt facility', () => {
    const ws = reducedRoster()
    ws.mainPlan.facilities.train.slots = [{ occupant: { kind: 'operator', operatorId: 'char_123_fang' }, replacements: [], groupId: null }]
    expect(validateRosterWorkspace(ws).isValid).toBe(false)
  })

  it('retains omitted output room positions and unbuilt auxiliary levels across legacy migration', () => {
    const ws = reducedRoster()
    ws.mainPlan.facilities.room_1_1.level = 0
    ws.mainPlan.facilities.room_1_1.slots = []
    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, createDefaultConfig())
    const restored = migrateAppConfigToWorkspace(config)
    expect(restored.mainPlan.facilities.room_1_1.level).toBe(0)
    expect(restored.mainPlan.facilities.room_1_2.type).toBe(ws.mainPlan.facilities.room_1_2.type)
    expect(restored.mainPlan.facilities.dormitory_4).toMatchObject({ level: 0, slots: [] })
    expect(restored.mainPlan.facilities.train).toMatchObject({ level: 0, slots: [] })
  })

  it('never places keepers or Fiammetta into an unbuilt dorm when applying automatic dorm policy', () => {
    const ws = reducedRoster()
    const report = applySmartDormitoryPolicy(ws, { force: true, candidateOperatorIds: ['char_300_phenxi'] })
    expect(report.fiammettaRoomId).not.toBe('dormitory_4')
    expect(ws.mainPlan.facilities.dormitory_4).toMatchObject({ level: 0, slots: [] })
    expect(ws.mainPlan.facilities.train).toMatchObject({ level: 0, slots: [] })
  })

  it('completes actual 24-hour simulation with three staffed dorms and no training room', () => {
    const result = runCalculationBridge(reducedRoster(), {
      engine: 'simulation', simulationOptions: { warmupHours: 0, sampleHours: 24, maxEvents: 10000, production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 } },
    })
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(result.simulationReport?.observedHours).toBeCloseTo(24, 5)
    expect(result.simulationReport?.inputs.schedule.rooms.filter(r => r.type === 'dormitory')).toHaveLength(3)
    expect(result.report?.power.consumption).toBe(470)
  }, 30000)
})
