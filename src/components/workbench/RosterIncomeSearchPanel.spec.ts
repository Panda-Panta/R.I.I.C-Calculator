/** @vitest-environment jsdom */
import {describe,it,expect,vi,afterEach} from 'vitest'
import {mount} from '@vue/test-utils'
import {createDefaultWorkspace} from '../../workbench/defaults'
import {resolveOperatorCharId as id} from '../../workbench/compat/mowerJson'
import RosterIncomeSearchPanel from './RosterIncomeSearchPanel.vue'
const workers:any[]=[]
class MockWorker {onmessage:any;onerror:any;postMessage=vi.fn();terminate=vi.fn();constructor(){workers.push(this)}}
const props=()=>({workspace:createDefaultWorkspace(),inventory:{enabled:true,valid:true,entries:[{operator:'砾',elitePhase:1,level:1}]},options:{maxStepHours:.25,production:{seed:42,runOrderMode:'ideal' as const,droneTarget:'none' as const,initialResources:{gold:10}}},assumptions:{idleOperators:[],restingThreshold:.65}})
afterEach(()=>{workers.length=0;vi.unstubAllGlobals()})
describe('income search worker ownership',()=>{
 it('uses common production settings with a separate window and explicit idle roster',async()=>{
  vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
  await w.get('[data-test=search-income]').trigger('click')
  expect(workers[0].postMessage.mock.calls[0][0]).toMatchObject({mode:'hill-climb',maxDepth:3,objective:'composite',maxCandidates:4,options:{warmupHours:24,sampleHours:48,production:{seed:42,droneTarget:'none',outputMode:'potential',initialResources:{drone:0}}},assumptions:{idleOperators:[]}})
  w.unmount();expect(workers[0].terminate).toHaveBeenCalled()
 })
 it('retains completed candidates on cancellation and rejects stale worker delivery',async()=>{
  vi.stubGlobal('Worker',MockWorker);const p=props(),w=mount(RosterIncomeSearchPanel,{props:p})
  await w.get('[data-test=search-income]').trigger('click')
  workers[0].onmessage({data:{type:'progress',progress:{completedScenarios:4,completedCandidates:1,totalCandidates:4,label:'原排班',completed:{id:'baseline',label:'原排班',workspace:p.workspace,cases:[],comparison:null}}}})
  await w.vm.$nextTick();await w.get('[data-test=cancel-income-search]').trigger('click')
  expect(w.text()).toContain('已取消');expect(w.text()).toContain('原排班基线')
  workers[0].onmessage({data:{type:'error',error:'不应出现'}});await w.vm.$nextTick();expect(w.text()).not.toContain('不应出现')
  await w.get('[data-test=search-objective]').setValue('exp');expect(w.text()).not.toContain('原排班基线');w.unmount()
 })
 it('invalidates results when source settings change and rejects invalid budgets before creating a worker',async()=>{
  vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
  await w.get('[data-test=search-budget]').setValue('21');await w.get('[data-test=search-income]').trigger('click');expect(workers).toHaveLength(0)
  await w.get('[data-test=search-budget]').setValue('2');await w.get('[data-test=search-income]').trigger('click')
  await w.setProps({options:{production:{seed:7}}});expect(workers[0].terminate).toHaveBeenCalled();expect(w.text()).toContain('尚未运行');w.unmount()
 })
 it('uses the full catalog when no idle operator library is imported',async()=>{
  vi.stubGlobal('Worker',MockWorker);const p=props();p.inventory.enabled=false;p.inventory.entries=[]
  const w=mount(RosterIncomeSearchPanel,{props:p})
  expect(w.get('[data-test=search-income]').attributes('disabled')).toBeUndefined()
  await w.get('[data-test=search-income]').trigger('click')
  const sent=workers[0].postMessage.mock.calls[0][0]
  expect(sent.inventory).toHaveLength(429)
  expect(sent.inventory.some((entry:{operator:string})=>entry.operator===id('阿'))).toBe(true)
  w.unmount()
 })
})

it('rejects nonfinite shared values before JSON serialization can turn them into defaults',async()=>{
 vi.stubGlobal('Worker',MockWorker);const p=props();p.options.production.seed=NaN
 const w=mount(RosterIncomeSearchPanel,{props:p});await w.get('[data-test=search-income]').trigger('click')
 expect(workers).toHaveLength(0);expect(w.get('[role=alert]').text()).toContain('有限数值');w.unmount()
})

it('clears an active multi-step search when the depth or strategy changes',async()=>{
 vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
 await w.get('[data-test=search-income]').trigger('click');await w.get('[data-test=search-depth]').setValue('2')
 expect(workers[0].terminate).toHaveBeenCalled();expect(w.text()).toContain('尚未运行')
 await w.get('[data-test=search-mode]').setValue('single-pass');expect(w.get('[data-test=search-depth]').attributes('disabled')).toBeDefined()
 await w.get('[data-test=search-income]').trigger('click');expect(workers[1].postMessage.mock.calls[0][0].mode).toBe('single-pass');w.unmount()
})


describe('multi-start search controls',()=>{
 it('keeps the legacy request unchanged and submits independent multi-start settings',async()=>{
  vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
  expect(w.find('[data-test=search-seed]').exists()).toBe(false)
  await w.get('[data-test=search-income]').trigger('click')
  expect(workers[0].postMessage.mock.calls[0][0]).not.toHaveProperty('searchSeed')
  await w.get('[data-test=search-mode]').setValue('multi-start')
  expect(workers[0].terminate).toHaveBeenCalled()
  expect(w.get('[data-test=search-budget]').attributes('max')).toBe('200')
  expect(w.get('[data-test=search-depth]').attributes('disabled')).toBeUndefined()
  await w.get('[data-test=search-seed]').setValue('17')
  await w.get('[data-test=search-restarts]').setValue('5')
  await w.get('[data-test=search-income]').trigger('click')
  expect(workers[1].postMessage.mock.calls[0][0]).toMatchObject({mode:'multi-start',searchSeed:17,restarts:5,includeControlMains:true,includeProductionMains:true,options:{production:{seed:42}}})
  expect(w.text()).toContain('候选预算不含最终复核');w.unmount()
 })
 it.each(['search-seed','search-restarts','search-control-mains','search-production-mains'])('cancels and clears an active run when %s changes',async(field)=>{
  vi.stubGlobal('Worker',MockWorker);const p=props(),w=mount(RosterIncomeSearchPanel,{props:p})
  await w.get('[data-test=search-mode]').setValue('multi-start')
  await w.get('[data-test=search-income]').trigger('click')
  workers[0].onmessage({data:{type:'progress',progress:{completedScenarios:4,completedCandidates:1,totalCandidates:4,label:'正在复核',bestCandidateId:'baseline',completed:{id:'baseline',label:'原排班',workspace:p.workspace,cases:[],comparison:null}}}})
  await w.vm.$nextTick();expect(w.text()).toContain('搜索候选');expect(w.text()).toContain('正在复核')
  await w.get(`[data-test=${field}]`).setValue(field.includes('mains')?false:'2')
  expect(workers[0].terminate).toHaveBeenCalled();expect(w.text()).toContain('尚未运行');expect(w.text()).not.toContain('搜索候选')
  workers[0].onmessage({data:{type:'error',error:'过时结果'}});await w.vm.$nextTick();expect(w.text()).not.toContain('过时结果');w.unmount()
 })
 it('accepts multi-start budget 200, rejects 201, and restores the old budget limit',async()=>{
  vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
  await w.get('[data-test=search-mode]').setValue('multi-start')
  await w.get('[data-test=search-budget]').setValue('201');await w.get('[data-test=search-income]').trigger('click');expect(workers).toHaveLength(0)
  expect(w.get('[role=alert]').text()).toContain('1–200')
  await w.get('[data-test=search-budget]').setValue('200');await w.get('[data-test=search-income]').trigger('click');expect(workers).toHaveLength(1)
  await w.get('[data-test=search-mode]').setValue('hill-climb');await w.get('[data-test=search-income]').trigger('click');expect(workers).toHaveLength(1)
  expect(w.get('[role=alert]').text()).toContain('1–20');w.unmount()
 })
 it.each([['search-seed','-1'],['search-seed','4294967296'],['search-seed','1.5'],['search-restarts','0'],['search-restarts','21']])('rejects invalid %s %s before launching',async(field,value)=>{
  vi.stubGlobal('Worker',MockWorker);const w=mount(RosterIncomeSearchPanel,{props:props()})
  await w.get('[data-test=search-mode]').setValue('multi-start');await w.get(`[data-test=${field}]`).setValue(value)
  await w.get('[data-test=search-income]').trigger('click');expect(workers).toHaveLength(0);expect(w.find('[role=alert]').exists()).toBe(true);w.unmount()
 })
 it.each([['passed','最终复核通过'],['no-improvement','最终复核未确认改进'],['failed','最终复核失败']])('shows final validation %s and discards the provisional winner',async(status,label)=>{
  vi.stubGlobal('Worker',MockWorker);const p=props(),w=mount(RosterIncomeSearchPanel,{props:p})
  await w.get('[data-test=search-mode]').setValue('multi-start');await w.get('[data-test=search-income]').trigger('click')
  const candidate=(id:string)=>({id,label:id,workspace:p.workspace,cases:[],comparison:null})
  workers[0].onmessage({data:{type:'progress',progress:{completedScenarios:8,completedCandidates:2,totalCandidates:4,label:'正在复核',bestCandidateId:'trial'}}})
  workers[0].onmessage({data:{type:'complete',report:{candidates:[candidate('baseline'),candidate('trial')],bestCandidateId:'baseline',issues:[],validation:{status,selectedId:'baseline',reasons:['使用新的抽单种子复核']}}}})
  await w.vm.$nextTick();expect(w.get('[data-test=income-final-validation]').text()).toContain(label)
  expect(w.text()).toContain('使用新的抽单种子复核');expect(w.text()).not.toContain('搜索候选')
  const rows=w.findAll('tbody tr');expect(rows[0]!.text()).toContain('当前保留');expect(rows[1]!.text()).not.toContain('当前保留');w.unmount()
 })
})


it('keeps exploratory multi-start comparisons separate from legacy parent acceptance',async()=>{
 vi.stubGlobal('Worker',MockWorker);const p=props(),w=mount(RosterIncomeSearchPanel,{props:p})
 const candidate={id:'trial',label:'随机候选',workspace:p.workspace,cases:[],depth:1,comparison:{status:'improved',minGain:1,maxGain:1,reasons:[]},parentComparison:{status:'unchanged',minGain:0,maxGain:0,reasons:[]}}
 await w.get('[data-test=search-income]').trigger('click')
 const progress={completedScenarios:4,completedCandidates:1,totalCandidates:4,label:'随机候选',completed:candidate}
 workers[0].onmessage({data:{type:'progress',progress}});await w.vm.$nextTick();expect(w.text()).toContain('上一步检查未通过')
 await w.get('[data-test=search-mode]').setValue('multi-start');await w.get('[data-test=search-income]').trigger('click')
 workers[1].onmessage({data:{type:'progress',progress}});await w.vm.$nextTick()
 expect(w.text()).toContain('搜索阶段改进');expect(w.text()).not.toContain('上一步检查未通过');w.unmount()
})


it.each(['composite','exp'])('shows %s final income from validation cases instead of short search samples',async(objective)=>{
 vi.stubGlobal('Worker',MockWorker);const p=props(),w=mount(RosterIncomeSearchPanel,{props:p})
 await w.get('[data-test=search-mode]').setValue('multi-start');await w.get('[data-test=search-objective]').setValue(objective)
 await w.get('[data-test=search-income]').trigger('click')
 const cases=(value:number)=>Array.from({length:4},()=>({eligible:true,issues:[],assumptions:[],output:{daily:{total:value,exp:value,goldValue:0,orderValue:0}},daily:{exp:value,lmd:0,gold:0}}))
 const comparison={status:'improved',minGain:123,maxGain:456,reasons:[]}
 workers[0].onmessage({data:{type:'complete',report:{candidates:[{id:'trial',label:'复核候选',workspace:p.workspace,cases:cases(999999),comparison}],bestCandidateId:'trial',issues:[],validation:{status:'passed',selectedId:'trial',reasons:[],seeds:[100,101],steps:[.125,.0625],sampleHours:168,warmupHours:24,candidates:[{id:'trial',cases:cases(100000),comparison}]}}}})
 await w.vm.$nextTick()
 expect(w.get('[data-test=income-final-value]').text()).toContain('100,000')
 expect(w.get('[data-test=income-final-value]').text()).not.toContain('999,999')
 expect(w.get('[data-test=income-final-gain]').text()).toContain('123 ~ 456')
 expect(w.get('[data-test=income-final-window]').text()).toContain('预热 24 小时，采样 168 小时')
 expect(w.get('[data-test=income-final-window]').text()).toContain('100 / 101')
 expect(w.get('[data-test=income-final-window]').text()).toContain('0.125 / 0.0625')
 expect(w.get('[data-test=income-search-stage]').text()).toContain('搜索阶段结果')
 expect(w.get('tbody').text()).toContain('999,999');w.unmount()
})


it('preserves assigned staff when the imported library contains only idle candidates',async()=>{
 vi.stubGlobal('Worker',MockWorker)
 const p=props(),draft={workspace:createDefaultWorkspace(),uncheckedConditions:['条件']} as any
 const w=mount(RosterIncomeSearchPanel,{props:{...p,draft}})
 await w.get('[data-test=search-mode]').setValue('multi-start')
 expect(w.find('[data-test=search-repair-seed]').exists()).toBe(false)
 await w.get('[data-test=search-income]').trigger('click')
 const sent=workers[0].postMessage.mock.calls[0][0]
 expect(sent.baseline).toEqual(p.workspace)
 expect(sent.draft).toEqual(draft.workspace)
 expect(sent.inventory).toEqual(p.inventory.entries)
 expect(w.text()).not.toContain('缺员起点修复')
 w.unmount()
})
