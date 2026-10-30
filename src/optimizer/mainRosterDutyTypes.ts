import type { OperatorInventory } from '../domain/operatorInventory'
import type { ProductionScore, CompletedProduction } from '../domain/productionScore'
import type { ProductionWeights } from '../domain/productionWeights'
import type { AppConfig } from '../domain/types'
import type { TimeContext } from '../engine/timeDependentSkills'
import type { RunOrderPolicy } from '../scheduler/types'
import type { CandidateSimulationJob } from './candidateSimulation'

export const DUTY_RESOURCE_KEYS = ['exp', 'gold', 'orderLmd', 'virtualGold', 'fragments', 'orundum'] as const
export type DutyResourceKey = typeof DUTY_RESOURCE_KEYS[number]
/** Resource units per hour, before the shared score weights. Unknown is explicit. */
export type DutyResourceRates = Record<DutyResourceKey, number | null>

export interface MainRosterDutyRateInput {
  config: AppConfig
  inventory: OperatorInventory
  /** Joint-state efficiency, including the scheduler's actual session/warmup calculation. */
  efficiencyPercentByRoom: Readonly<Record<string, number>>
  /** Original ideal order policies, kept separate from physical on-duty occupants. */
  runOrderPolicies?: readonly RunOrderPolicy[]
  timeContext?: TimeContext
  outputMode: 'potential'
  inventoryMode: 'infinite'
  droneTarget: 'none'
}
export interface MainRosterDutyRateResult {
  status: 'quantified' | 'unquantified'
  rates: DutyResourceRates
  diagnostics: string[]
  assumptions: string[]
}
export interface MainRosterDutyPhase {
  start: number
  end: number
  /** Joint occupancy ledger identity; not a sufficient production-cache key. */
  jointStateKey: string
  /** Lossless state evidence when supplied by a trajectory adapter. */
  jointState?: {
    occupants: Readonly<Record<string, string>>
    bedOccupants: Readonly<Record<string, string>>
    morale: Readonly<Record<string, number>>
    efficiencyPercent: Readonly<Record<string, number>>
  }
  output: MainRosterDutyRateResult
}
export interface MainRosterDutyOperatorTimes {
  operatorId: string
  mainWorkHours: number
  substituteWorkHours: number
  workHours: number
  exhaustedHours: number
  restHours: number
  idleHours: number
}
export interface MainRosterDutyTrajectory {
  status: 'complete' | 'incomplete' | 'unsupported'
  window: { warmupHours: number; sampleHours: number; maxStepHours: number }
  phases: MainRosterDutyPhase[]
  operators: MainRosterDutyOperatorTimes[]
  sourceKind: 'predicted-schedule' | 'observed-replay' | 'synthetic-oracle'
  nativeScheduleParity: 'not-established' | 'subset-validated'
  diagnostics: string[]
  assumptions: string[]
  cost: { scheduleOnlyCalls: number; elapsedMs: number; cpuMs: number | null; phaseEvaluations: number }
}
export interface MainRosterDutyProjection {
  status: 'estimated' | 'unquantified' | 'incomplete' | 'invalid'
  amounts: CompletedProduction | null
  score: ProductionScore | null
  coverageHours: number
  operatorDuty: Array<MainRosterDutyOperatorTimes & {
    physicalWorkHours: number
    workRestRatio: number | null
    workFraction: number
    physicalWorkFraction: number
    noRestObserved: boolean
  }>
  jointStateHours: Record<string, number>
  predictionEligible: boolean
  nativeScheduleParity: MainRosterDutyTrajectory['nativeScheduleParity']
  diagnostics: string[]
  assumptions: string[]
  integrationElapsedMs: number
}
export interface MainRosterDutyModelInput {
  job: CandidateSimulationJob
  /** Explicit prediction calendar; neither mode is a full production simulation. */
  calendarModel?: 'production-off' | 'expected-orders'
  /** Optional caller budget for the H calendar; no production F is permitted in this stage. */
  limits?: { maxEvents?: number; maxPhases?: number }
}
export type MainRosterDutyWeights = Partial<ProductionWeights>
