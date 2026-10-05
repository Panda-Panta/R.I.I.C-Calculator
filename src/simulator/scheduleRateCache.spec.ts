import {expect,it,vi} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {resolveOperatorCharId} from '../workbench/compat/mowerJson'
import {currentMoraleRates} from '../engine/morale'
import {simulateSchedule} from './scheduleSimulation'

vi.mock('../engine/morale',async importOriginal=>{
 const actual=await importOriginal<typeof import('../engine/morale')>()
 return {...actual,currentMoraleRates:vi.fn(actual.currentMoraleRates)}
})

it('reuses physical rates across native I/O wakes with unchanged occupancy and morale bands',()=>{
 const workspace=createDefaultWorkspace(),gravel=resolveOperatorCharId('砾')
 for(const facility of Object.values(workspace.mainPlan.facilities))for(const slot of facility.slots){slot.occupant={kind:'empty'};slot.replacements=[];slot.groupId=null}
 workspace.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:gravel},groupId:null,replacements:[]}]
 workspace.mainPlan.conf.workaholic=[gravel]
 const schedule=compileRosterSchedule(workspace,{idleOperators:[]})
 vi.mocked(currentMoraleRates).mockClear()
 const result=simulateSchedule(schedule,{sampleHours:1,maxStepHours:.25,recordSegments:true,consumptionOverrides:{[gravel]:0},production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42}})
 expect(result.success,JSON.stringify(result.diagnostics)).toBe(true)
 expect(result.elapsedHours).toBe(1)
 expect(result.segments.length).toBeGreaterThan(3)
 expect(result.operators.find(op=>op.operatorId===gravel)?.finalMorale).toBe(24)
 expect(vi.mocked(currentMoraleRates).mock.calls.length).toBeLessThanOrEqual(2)
})
