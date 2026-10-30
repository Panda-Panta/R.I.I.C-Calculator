import { normalizeProductionWeights, type ProductionWeights } from '../domain/productionWeights'
import type { SimulationInventory } from '../domain/simulationInventory'

export interface SimulationSettings {
  initialInventory?: SimulationInventory
  sampleDays: number
  warmupDays: number
  step: number
  seed: number
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneTradingRoomId?: string
  droneRoomId?: string
  useOperatorInventory?: boolean
  jayeElite0?: boolean
  fiammettaFool?: boolean
  fiammettaThreshold?: number
  restingThreshold?: number
  rescueThreshold?: number
  freeRoom?: boolean
  productionWeights?: ProductionWeights
}

export interface CalculationConfig {
  initialInventory?: SimulationInventory
  productionWeights?: ProductionWeights
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneTradingRoomId: string
  droneRoomId?: string
  useOperatorInventory?: boolean
  jayeElite0?: boolean
}

export interface SmartRosterConfig {
  productionWeights?: ProductionWeights
  trials: number
  maxStaticEvals: number
  simulationTopK: number
  simulationSampleHours: number
  simulationWarmupHours: number
  enableDeepSearch: boolean
  /** Missing legacy preferences leave conditional backup generation disabled. */
  enableBackupGeneration?: boolean
  /** Explicit opt-ins; absent legacy preferences keep the fast generation path. */
  enableMainOptimization?: boolean
  allowFreeCombinations?: boolean
  optimizationMaxSimulations?: number
  optimizationTimeBudgetMs?: number
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneRoomId?: string
  seed: number
}

type SmartRosterOptimizationConfig = Pick<SmartRosterConfig,
  'enableMainOptimization' | 'allowFreeCombinations' | 'optimizationMaxSimulations' | 'optimizationTimeBudgetMs'>

export const SMART_ROSTER_OPTIMIZATION_DEFAULTS: Required<SmartRosterOptimizationConfig> = {
  enableMainOptimization: false,
  allowFreeCombinations: false,
  optimizationMaxSimulations: 3,
  optimizationTimeBudgetMs: 30000,
}

/** Share persisted-preference and request bounds without rewriting existing storage. */
export function normalizeSmartRosterOptimizationOptions(config: SmartRosterOptimizationConfig = {}): Required<SmartRosterOptimizationConfig> {
  function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback
  }
  return {
    enableMainOptimization: config.enableMainOptimization === true,
    allowFreeCombinations: config.allowFreeCombinations === true,
    optimizationMaxSimulations: boundedInteger(config.optimizationMaxSimulations, SMART_ROSTER_OPTIMIZATION_DEFAULTS.optimizationMaxSimulations, 1, 8),
    optimizationTimeBudgetMs: boundedInteger(config.optimizationTimeBudgetMs, SMART_ROSTER_OPTIMIZATION_DEFAULTS.optimizationTimeBudgetMs, 1000, 300000),
  }
}

export function createDefaultSimulationSettings(): SimulationSettings {
  return {
    productionWeights: normalizeProductionWeights(),
    sampleDays: 7,
    warmupDays: 3,
    step: 0.25,
    seed: -1,
    droneTarget: 'gold',
    droneTradingRoomId: '',
    jayeElite0: false,
    fiammettaFool: true,
    fiammettaThreshold: .9,
    restingThreshold: .65,
    rescueThreshold: .75,
    freeRoom: false,
  }
}
