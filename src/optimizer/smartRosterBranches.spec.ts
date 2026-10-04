import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { setTimeout as yieldToRunner } from 'node:timers/promises'

// annotate flushes pending task updates and awaits the IPC acknowledgement.
// A fixed delay cannot guarantee this before a long synchronous generation.
beforeEach(() => yieldToRunner(5))
afterEach(() => yieldToRunner(5))
import { OPERATORS } from '../domain/operators'
import { createDefaultWorkspace } from '../workbench/defaults'
import { runSmartRoster } from './smartRoster'
import * as synthesis from './molecularSynthesis'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
vi.mock('../workbench/scheduleSimulationBridge',()=>({runScheduleSimulationBridge:vi.fn((_workspace,options)=>({report:{success:true,observedHours:72,elapsedHours:96,assumptions:{warmupHours:24},inputs:{options},operators:[],diagnostics:[],production:{success:true,events:[],manufacturing:[],sample:{completed:{exp:1000,gold:100,orderLmd:5000}}}}}))}))
const owned=OPERATORS.map(o=>({operator:o.name,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}))
describe('complete branch admission before any simulation',()=>{
 it('ignores old trial and top-K truncation and simulates all ten distinct branches in ideal mode', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  vi.mocked(runScheduleSimulationBridge).mockClear()
  const result=runSmartRoster(createDefaultWorkspace(),owned,{seed:20260919,trials:1,simulationTopK:1,enableDeepSearch:false},p=>{
   if(p.phase==='simulating'&&p.phaseProgress===0){expect(p.totalTrials).toBe(10);expect(runScheduleSimulationBridge).not.toHaveBeenCalled()}
  })
  expect(result.phases.simulation!.candidates).toHaveLength(10)
  const calls=vi.mocked(runScheduleSimulationBridge).mock.calls.slice(0,10)
  expect(calls).toHaveLength(10)
  expect(new Set(calls.map(c=>JSON.stringify(c[0].mainPlan))).size).toBe(10)
  expect(calls.every(c=>c[1]?.production?.runOrderMode==='ideal')).toBe(true)
 },300000)
 it('does not rank a partial simulation even when its incomplete production is very high', async ({ annotate }) => {
   await annotate('同步计算前确认测试进度已送达')
  vi.mocked(runScheduleSimulationBridge).mockClear()
  const complete=vi.mocked(runScheduleSimulationBridge).getMockImplementation()!(createDefaultWorkspace(),{})
  vi.mocked(runScheduleSimulationBridge).mockReturnValueOnce({...complete,report:{...complete.report!,success:false,observedHours:13,production:{...complete.report!.production!,sample:{...complete.report!.production!.sample,completed:{exp:1e9,gold:1e9,orderLmd:1e9}}}}})
  const result=runSmartRoster(createDefaultWorkspace(),owned,{seed:20260919,enableDeepSearch:false})
  const firstInput=vi.mocked(runScheduleSimulationBridge).mock.calls[0]![0]
  const failed=result.phases.simulation!.candidates.find(c=>JSON.stringify(c.workspace.mainPlan)===JSON.stringify(firstInput.mainPlan))!
  expect(failed.simScore).toBeNull()
  expect(result.phases.simulation!.candidates[0]!.id).not.toBe(failed.id)
 },180000)
 it('does not start simulation if the required set cannot be constructed', async ({ annotate }) => {
   await annotate('同步计算前确认测试进度已送达')
  vi.mocked(runScheduleSimulationBridge).mockClear()
  const spy=vi.spyOn(synthesis,'generateMolecularCandidates').mockReturnValue([])
  try{
   const result=runSmartRoster(createDefaultWorkspace(),owned,{enableDeepSearch:false})
   expect(result.status).toBe('blocked')
   expect(result.diagnostics.some(d=>d.code==='INSUFFICIENT_STAFF')).toBe(true)
   expect(runScheduleSimulationBridge).not.toHaveBeenCalled()
  }finally{spy.mockRestore()}
 },120000)
})
