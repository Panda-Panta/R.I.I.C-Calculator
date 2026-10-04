import { it, expect } from 'vitest'
import entries from './fixtures/mixed-level-inventory.json'
import { createDefaultWorkspace } from '../workbench/defaults'
import { runSmartRoster } from './smartRoster'
import { validatePhysicalRoster } from './rosterDraft'

it('validates mixed actual levels through 24h warmup and 72h dynamic roster simulation', async ({annotate}) => {
  await annotate('实际练度完整模拟回归')
  const base=createDefaultWorkspace(),before=structuredClone(base),originalEntries=structuredClone(entries)
  const result=runSmartRoster(base,entries,{branchCount:1,enableDeepSearch:false})
  expect(result.status, JSON.stringify({diagnostics:result.diagnostics,candidates:result.phases.simulation?.candidates.map(c=>({score:c.simScore,diagnostics:c.diagnostics}))})).toBe('draft')
  expect(result.score).toBeGreaterThan(0)
  expect(validatePhysicalRoster(result.workspace!)).toEqual([])
  expect(base).toEqual(before)
  expect(entries).toEqual(originalEntries)
},300000)
