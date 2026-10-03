import type { RosterWorkspace } from '../workbench/model'
import { normalizeMissingFacilities } from '../workbench/facilityState'

/** Automatic generation may use ordinary replacements, never conditional plans. */
export function mainPlanOnly(source: RosterWorkspace): RosterWorkspace {
  const copy = structuredClone(source)
  normalizeMissingFacilities(copy)
  copy.compatibility.backupPlans = []
  return copy
}
