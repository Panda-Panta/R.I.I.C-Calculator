import {OPERATORS} from '../../domain/operators'
/** @vitest-environment jsdom */
import {describe,expect,it,vi,afterEach} from 'vitest'
import {mount} from '@vue/test-utils'
import {createDefaultWorkspace} from '../../workbench/defaults'
import RosterDraftPanel from './RosterDraftPanel.vue'
const inventory={enabled:true,valid:true,entries:[{operator:'温蒂',elitePhase:2,level:1},{operator:'清流',elitePhase:1,level:1}]}
describe('roster draft preview',()=>{
 it('previews mapped rooms, leaves the original untouched and emits a separate simulation',async()=>{
  const workspace=createDefaultWorkspace(),before=JSON.stringify(workspace)
  const w=mount(RosterDraftPanel,{props:{workspace,inventory}})
  await w.get('[data-candidate=manu-gold-weedy-purestream]').setValue(true)
  await w.get('[data-test=generate-draft]').trigger('click')
  expect(w.text()).toContain('物理摆放已生成')
  expect(w.text()).toContain('候补或Free床位不足')
  expect(JSON.stringify(workspace)).toBe(before)
  await w.get('[data-test=simulate-draft]').trigger('click')
  expect(w.emitted('simulate')?.[0]?.[0]).toHaveProperty('mainPlan')
  expect(w.find('[data-test=export-draft]').exists()).toBe(true)
  await w.get('[data-candidate=manu-gold-weedy-purestream]').setValue(false)
  expect(w.find('[data-test=simulate-draft]').exists()).toBe(false)
  w.unmount()
 })
 it('invalidates previews when the workspace or inventory changes',async()=>{
  const workspace=createDefaultWorkspace(),w=mount(RosterDraftPanel,{props:{workspace,inventory}})
  await w.get('[data-candidate=manu-gold-weedy-purestream]').setValue(true)
  await w.get('[data-test=generate-draft]').trigger('click')
  await w.setProps({workspace:{...workspace,name:'modified'}})
  expect(w.text()).not.toContain('物理摆放已生成')
  expect(w.emitted('invalidate')!.length).toBeGreaterThan(0)
  await w.setProps({inventory:{...inventory,enabled:false}})
  expect(w.get('[data-test=generate-draft]').attributes('disabled')).toBeUndefined()
  w.unmount()
 })
})

it('shows the actual assigned ordinary backups in the reviewable draft',async()=>{
 const entries=['砾','阿罗玛','槐琥','调香师','雪猎'].map(operator=>({operator,elitePhase:2,level:1}))
 entries.push({operator:'芬',elitePhase:1,level:1})
 const w=mount(RosterDraftPanel,{props:{workspace:createDefaultWorkspace(),inventory:{enabled:true,valid:true,entries}}})
 await w.get('[data-candidate=manu-gold-waai-fu-copy]').setValue(true)
 await w.get('[data-test=generate-draft]').trigger('click')
 const table=w.get('[data-test=draft-roster]')
 expect(table.findAll('tbody tr')).toHaveLength(3)
 expect(table.text()).toContain('芬');expect(table.text()).toContain('雪猎');expect(table.text()).toContain('调香师')
 w.unmount()
})


describe('automatic empty layout generation UI',()=>{
 const workers:any[]=[]
 class FakeWorker {
  onmessage:any;onerror:any;postMessage=vi.fn();terminate=vi.fn()
  constructor(){workers.push(this)}
 }
 afterEach(()=>{vi.unstubAllGlobals();workers.length=0})
 const mountAuto=async()=>{
  vi.stubGlobal('Worker',FakeWorker)
  const workspace=createDefaultWorkspace(),w=mount(RosterDraftPanel,{props:{workspace,inventory}})
  await w.get('[data-test=draft-mode]').setValue('automatic')
  return {w,workspace}
 }
 it('uses the full catalog for automatic drafts when no library is imported',async()=>{
  vi.stubGlobal('Worker',FakeWorker)
  const workspace=createDefaultWorkspace(),w=mount(RosterDraftPanel,{props:{workspace,inventory:{enabled:false,valid:true,entries:[]}}})
  await w.get('[data-test=draft-mode]').setValue('automatic')
  expect(w.get('[data-test=generate-automatic]').attributes('disabled')).toBeUndefined()
  await w.get('[data-test=generate-automatic]').trigger('click')
  expect(workers[0].postMessage.mock.calls[0][0].entries).toHaveLength(429)
  w.unmount()
 })
 const completed=(workspace:any)=>({status:'draft',draft:{status:'draft',workspace,placements:[],diagnostics:[],statesVisited:1,uncheckedConditions:[{kind:'morale',text:'工休未验证'}],restResources:{freeBeds:3,minimumFreeBedsForNewGroup:3,missingReplacementIds:[]}},diagnostics:[],trials:[{seed:42,status:'draft',staticScore:120000,complete:true,candidateIds:[],diagnostics:[]}],selectedTrial:0})
 it('sends reproducible parameters without changing source, and displays static results separately',async()=>{
  const {w,workspace}=await mountAuto(),before=JSON.stringify(workspace)
  await w.get('[data-test=auto-seed]').setValue(123)
  await w.get('[data-test=auto-trials]').setValue(2)
  await w.get('[data-test=generate-automatic]').trigger('click')
  expect(workers[0].postMessage.mock.calls[0][0]).toMatchObject({base:workspace,options:{seed:123,trials:2,maxStates:2000}})
  expect(w.text()).toContain('正在生成')
  const generated=structuredClone(workspace);generated.name='auto'
  workers[0].onmessage({data:{type:'complete',report:completed(generated)}});await w.vm.$nextTick()
  expect(w.get('[data-test=automatic-trials]').text()).toContain('主班82快照')
  expect(w.get('[data-test=automatic-trials]').text()).toContain('120000.00')
  expect(w.emitted('draftChange')?.slice(-1)[0]?.[0]).toMatchObject({workspace:generated})
  await w.get('[data-test=simulate-draft]').trigger('click')
  expect(w.emitted('simulate')?.slice(-1)[0]?.[0]).toEqual(generated)
  expect(JSON.stringify(workspace)).toBe(before);w.unmount()
 })
 it('cancels generation and ignores a late worker response',async()=>{
  const {w,workspace}=await mountAuto()
  await w.get('[data-test=generate-automatic]').trigger('click')
  const worker=workers[0]
  await w.get('[data-test=cancel-automatic]').trigger('click')
  expect(worker.terminate).toHaveBeenCalled()
  worker.onmessage({data:{type:'complete',report:completed(workspace)}});await w.vm.$nextTick()
  expect(w.find('[data-test=automatic-summary]').exists()).toBe(false);w.unmount()
 })
 it('invalidates results when inputs change and blocks invalid budgets',async()=>{
  const {w,workspace}=await mountAuto()
  await w.get('[data-test=generate-automatic]').trigger('click')
  workers[0].onmessage({data:{type:'complete',report:completed(workspace)}});await w.vm.$nextTick()
  await w.get('[data-test=auto-trials]').setValue(9)
  expect(w.find('[data-test=simulate-draft]').exists()).toBe(false)
  expect(w.emitted('draftChange')?.slice(-1)[0]).toEqual([null])
  await w.get('[data-test=generate-automatic]').trigger('click')
  expect(workers).toHaveLength(1);expect(w.text()).toContain('生成次数1–8');w.unmount()
 })
 it('stops an active worker on inventory changes and protects a restarted task from old callbacks',async()=>{
  const {w,workspace}=await mountAuto();await w.get('[data-test=generate-automatic]').trigger('click')
  const old=workers[0]
  await w.setProps({inventory:{...inventory,entries:[...inventory.entries,{operator:'斑点',elitePhase:1,level:55}]}})
  expect(old.terminate).toHaveBeenCalled()
  await w.get('[data-test=generate-automatic]').trigger('click')
  const current=workers[1]
  old.onmessage({data:{type:'complete',report:completed(workspace)}});old.onerror();await w.vm.$nextTick()
  expect(current.terminate).not.toHaveBeenCalled();expect(w.find('[data-test=automatic-summary]').exists()).toBe(false)
  expect(w.text()).toContain('正在生成');expect(w.text()).not.toContain('发生错误')
  current.onmessage({data:{type:'complete',report:completed(workspace)}});await w.vm.$nextTick()
  expect(w.find('[data-test=automatic-summary]').exists()).toBe(true);w.unmount()
 })
 it('sends the ordinary duty ratio and keeps special ratios visibly pending',async()=>{
  const {w,workspace}=await mountAuto();await w.get('[data-test=auto-duty]').setValue(80)
  await w.get('[data-test=generate-automatic]').trigger('click')
  expect(workers[0].postMessage.mock.calls[0][0].options.mainDutyRatio).toBe(.8)
  const report=completed(workspace) as any
  report.trials[0].duty={ratio:.8,mainScore:120000,backupScore:80000,weightedScore:null,rankingScore:90000,ordinaryWeightedScore:20000,rows:[],specialOperators:['歌蕾蒂娅'],complete:true,diagnostics:[]}
  workers[0].onmessage({data:{type:'complete',report}});await w.vm.$nextTick()
  expect(w.get('[data-test=duty-details]').text()).toContain('特殊工休比待定')
  expect(w.get('[data-test=duty-details]').text()).toContain('歌蕾蒂娅')
  expect(w.get('[data-test=automatic-trials]').text()).toContain('搭配排序分（非日均）')
  await w.get('[data-test=auto-duty]').setValue(81)
  expect(w.find('[data-test=duty-details]').exists()).toBe(false)
  await w.get('[data-test=generate-automatic]').trigger('click');expect(workers).toHaveLength(1)
  expect(w.text()).toContain('普通主班参考占比须为75%–80%');w.unmount()
 })
 it('shows source-defined cross-room members and original replacement ordering',async()=>{
  const {w,workspace}=await mountAuto();await w.get('[data-test=generate-automatic]').trigger('click')
  const report=completed(workspace) as any
  const operator=(name:string)=>OPERATORS.find(o=>o.name===name)!.charId
  report.trials[0].crossRoomSelections=[{templateId:'source-group',groupId:'原表自动化',members:[{roomId:'room_1_1',slotIndex:0,operatorId:operator('温蒂'),selectedCandidate:operator('火神'),orderedCandidates:[operator('火神'),operator('泡泡')]}],sources:[{file:'原表.jpg'}]}]
  workers[0].onmessage({data:{type:'complete',report}});await w.vm.$nextTick()
  const details=w.get('[data-test=cross-room-details]').text()
  expect(details).toContain('原表自动化');expect(details).toContain('温蒂 → 火神')
  expect(details).toContain('火神、泡泡');expect(details).toContain('原表.jpg');w.unmount()
 })
 it('keeps a blocked run visible without offering simulation or a draft',async()=>{
  const {w}=await mountAuto();await w.get('[data-test=generate-automatic]').trigger('click')
  workers[0].onmessage({data:{type:'complete',report:{status:'blocked',draft:null,diagnostics:[{code:'NO_STAFF',message:'干员不足'}],trials:[],selectedTrial:null}}});await w.vm.$nextTick()
  expect(w.text()).toContain('干员不足');expect(w.find('[data-test=simulate-draft]').exists()).toBe(false)
  expect(w.emitted('draftChange')?.slice(-1)[0]).toEqual([null]);w.unmount()
 })
})
