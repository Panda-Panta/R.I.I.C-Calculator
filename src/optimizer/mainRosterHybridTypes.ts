import type { OwnedOperatorInput } from '../domain/operatorInventory'
import type { RosterWorkspace } from '../domain/roster'

/** Research-only, JSON-serializable inputs. User constraints precede generated initial choices. */
export interface MainRosterHybridInput {
  sceneId: string
  userBase: RosterWorkspace
  incumbent: RosterWorkspace
  entries: OwnedOperatorInput[]
  lockedPositions?: string[]
  lockedOperators?: string[]
  constructionSeed?: number
  maxVectors?: number
}

export interface MainRosterHybridVariable {
  id: string
  family: 'construction' | 'rest-policy' | 'fiammetta-policy' | 'other'
  options: { id: string; label: string }[]
}

/** Compatible with the existing methods' public common.Problem contract; no native F labels. */
export interface MainRosterHybridPublicSpec {
  id: string
  domains: number[]
  initial: number[]
  unary: number[][]
  factors: { vars: number[]; table: Record<string, number> }[]
  forbidden: { vars: number[]; values: number[] }[]
  resources: { name: string; capacity: number; usage: number[][] }[]
  metadata: Record<string, unknown>
}

export interface MainRosterHybridMaterialization {
  vector: number[]
  status: 'ready' | 'rejected' | 'unknown'
  workspace?: RosterWorkspace
  primaryHourlyScore: number | null
  diagnostics: string[]
  changedFacilities: string[]
  changedOperators: string[]
}

export interface MainRosterHybridDomain {
  schemaVersion: 1
  sceneId: string
  variables: MainRosterHybridVariable[]
  initial: number[]
  publicSpec: MainRosterHybridPublicSpec
  /** Actual decoded rosters are held outside the algorithms' public model. */
  materializations: Record<string, MainRosterHybridMaterialization>
  evidence: {
    declaredVectors: number
    ready: number
    rejected: number
    unknown: number
    gCalls: number
    elapsedMs: number
    diagnostics: string[]
  }
}
