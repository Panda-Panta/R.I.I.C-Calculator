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
  droneTarget: 'gold' | 'exp' | 'trading' | 'none'
  droneRoomId?: string
  seed: number
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
