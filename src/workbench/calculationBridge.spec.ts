import { describe, expect, it } from 'vitest'
import { createDefaultWorkspace } from './defaults'
import { runCalculationBridge } from './calculationBridge'

describe('runCalculationBridge engine options', () => {
  it('defaults to legacy engine and returns a valid report', () => {
    const ws = createDefaultWorkspace()
    const result = runCalculationBridge(ws)

    expect(result.success).toBe(true)
    expect(result.engine).toBe('legacy')
    expect(result.report).not.toBeNull()
    expect(result.report?.power.sufficient).toBe(true)
  })

  it('runs legacy engine explicitly when options.engine is legacy', () => {
    const ws = createDefaultWorkspace()
    const result = runCalculationBridge(ws, { engine: 'legacy' })

    expect(result.success).toBe(true)
    expect(result.engine).toBe('legacy')
    expect(result.report).not.toBeNull()
  })

  it('stops before calculation if validation fails', () => {
    const ws = createDefaultWorkspace()
    // Introduce critical error: duplicate primary operator in central
    ws.mainPlan.facilities.central.slots = [
      { occupant: { kind: 'operator', operatorId: '阿米娅' }, groupId: null, replacements: [] },
      { occupant: { kind: 'operator', operatorId: '阿米娅' }, groupId: null, replacements: [] },
    ]

    const result = runCalculationBridge(ws, { engine: 'legacy' })
    expect(result.success).toBe(false)
    expect(result.report).toBeNull()
    expect(result.validation.isValid).toBe(false)
  })

  it('runs simulation engine and returns converted report with 82 score', () => {
    const ws = createDefaultWorkspace()
    const result = runCalculationBridge(ws, {
      engine: 'simulation',
      simulationOptions: {
        warmupHours: 0,
        sampleHours: 24,
        warmupModel: 'hourly',
        production: {
          outputMode: 'potential',
          runOrderMode: 'ideal',
          droneTarget: 'gold',
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.engine).toBe('simulation')
    expect(result.report).not.toBeNull()
    expect(result.simulationReport).toBeDefined()
    expect(result.report?.summary?.totalScore82).toBeGreaterThan(0)
    expect(result.report?.power.sufficient).toBe(true)
  })
})

it('does not convert an incomplete simulation into a successful zero output report',()=>{
 const r=runCalculationBridge(createDefaultWorkspace(),{engine:'simulation',simulationOptions:{sampleHours:24,maxEvents:1,production:{outputMode:'potential'}}})
 expect(r.success).toBe(false)
 expect(r.report).toBeNull()
 expect(r.simulationReport?.success).toBe(false)
 expect(r.error).toContain('未完成')
})

it('enables production when calculation callers supply only simulation timing options', () => {
  const r = runCalculationBridge(createDefaultWorkspace(), { engine: 'simulation', simulationOptions: { sampleHours: 24 } })
  expect(r.success).toBe(true)
  expect(r.simulationReport?.production?.success).toBe(true)
  expect(r.report?.summary?.orderLmd).toBeGreaterThan(0)
})

it('reports zero accepted drone charge when the simulated stock stays full', () => {
  const result = runCalculationBridge(createDefaultWorkspace(), {
    engine: 'simulation',
    simulationOptions: {
      sampleHours: 1,
      production: { outputMode: 'potential', droneTarget: 'none', initialResources: { drone: 235 } },
    },
  })
  expect(result.success).toBe(true)
  expect(result.simulationReport!.production!.sample.inflows.drone ?? 0).toBe(0)
  expect(result.report!.drones).toBe(0)
})
