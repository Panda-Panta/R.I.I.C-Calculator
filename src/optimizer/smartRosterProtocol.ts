import type { RosterWorkspace } from '../domain/roster'
import type { OwnedOperatorInput } from '../domain/operatorInventory'
import type { SmartRosterOptions, SmartRosterProgress, SmartRosterResult } from './smartRoster'

/** Pure types shared by the generation Worker and its workbench caller. */
export interface SmartRosterWorkerRequest {
  base: RosterWorkspace
  entries: OwnedOperatorInput[]
  options?: SmartRosterOptions
}

export type SmartRosterWorkerResponse =
  | { type: 'progress'; progress: Omit<SmartRosterProgress, 'incumbent'> }
  | { type: 'incumbent'; report: SmartRosterResult }
  | { type: 'complete'; report: SmartRosterResult }
  | { type: 'error'; error: string }
