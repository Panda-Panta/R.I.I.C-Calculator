import {describe,expect,it} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {runCalculationBridge} from '../workbench/calculationBridge'

const options={engine:'simulation' as const,simulationOptions:{warmupHours:0,sampleHours:.001,production:{outputMode:'potential' as const,runOrderMode:'ideal' as const,droneTarget:'none' as const,seed:1}}}
describe('native condition execution errors stay local to the condition',()=>{
  it.each(['1 / 0 > 0',"op_data.group_min_mood('absent') < 12",'not (1 / 0)',
    'abs(1,2)','any(1,2)','sum([1],0,0)','max()',
    "op_data.facility_type('missing')",'op_data.facility_type([1])',
    'op_data.inventory_count()',"op_data.inventory_count('赤金','装置')",'op_data.facility_product_type_count(1)',
    "op_data.operators['unknown'].current_mood() > 0",'op_data.operators[1].current_mood() > 0',
    "not op_data.operators['德克萨斯'].is_resting()",
  ])('disables %s while another backup still activates',trigger=>{
    const workspace=createDefaultWorkspace()
    workspace.compatibility.backupPlans=[{name:'bad condition',trigger},{name:'working condition',trigger:'True'}]
    const result=runCalculationBridge(workspace,options)
    expect(result.success,result.error).toBe(true)
    expect(result.simulationReport?.events.filter(event=>event.type==='backup-plan'&&event.active).map(event=>event.backupName)).toEqual(['working condition'])
    expect(result.simulationReport?.diagnostics).toContainEqual(expect.objectContaining({code:'MOWER_BACKUP_CONDITION_ERROR'}))
    expect(result.simulationReport?.diagnostics.some(item=>item.code==='BACKUP_EXECUTION_FAILED')).toBe(false)
  })
  it('falls back to the default group when a custom group condition fails',()=>{
    const workspace=createDefaultWorkspace()
    workspace.compatibility.unrecognizedFields.backup_groups=[{id:'bad',name:'Bad',trigger:'1 / 0'}]
    workspace.compatibility.backupPlans=[{name:'default',trigger:'True'},{name:'custom',group_ids:['bad'],trigger:'True'}]
    const result=runCalculationBridge(workspace,options)
    expect(result.success,result.error).toBe(true)
    expect(result.simulationReport?.events.filter(event=>event.type==='backup-plan'&&event.active).map(event=>event.backupName)).toEqual(['default'])
  })
  it('still rejects invalid syntax before a report can succeed',()=>{
    const workspace=createDefaultWorkspace()
    workspace.compatibility.backupPlans=[{name:'invalid',trigger:'1 +'}]
    const result=runCalculationBridge(workspace,options)
    expect(result.success).toBe(false)
    expect(result.report).toBeNull()
    expect(result.simulationReport?.diagnostics.some(item=>item.code==='INVALID_RUNTIME')).toBe(true)
  })
})
