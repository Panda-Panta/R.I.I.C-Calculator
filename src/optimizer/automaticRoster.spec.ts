import {afterEach,describe,expect,it,vi} from 'vitest'
import {setTimeout as yieldToRunner} from 'node:timers/promises'

// annotate flushes pending task updates and awaits the IPC acknowledgement.
// A fixed delay cannot guarantee this before a long synchronous generation.
afterEach(()=>yieldToRunner(5))
import {OPERATORS} from '../domain/operators'
import {compileOperatorInventory,type OwnedOperatorInput} from '../domain/operatorInventory'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id,exportMowerJson,importMowerJson} from '../workbench/compat/mowerJson'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {validateScheduleInventory} from './inventoryAdmission'
import {validatePhysicalRoster} from './rosterDraft'
import {generateAutomaticRoster} from './automaticRoster'
import * as controlImpact from './controlImpact'
import {MOWER_OUTPUT_ROOM_IDS} from '../workbench/model'

const allOwned:OwnedOperatorInput[]=OPERATORS.map(o=>({operator:o.name,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}))
const mains=(w:ReturnType<typeof createDefaultWorkspace>)=>Object.values(w.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>s.occupant.kind==='operator'?[id(s.occupant.operatorId)]:[]))

describe('bounded complete automatic roster drafts',()=>{
 it('does not require preserved auxiliary staff in the imported idle-only library',()=>{
  const base=createDefaultWorkspace()
  base.mainPlan.facilities.factory.slots[0]!.occupant={kind:'operator',operatorId:id('杜宾')}
  const result=generateAutomaticRoster(base,allOwned.filter(entry=>entry.operator!=='杜宾'),{trials:1,maxStates:1})
  expect(result.diagnostics.some(d=>d.code==='INVENTORY_OPERATOR_NOT_OWNED')).toBe(false)
 })
 it('builds complete 243 mains with unique backups and retains the source layout', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const base=createDefaultWorkspace()
  base.compatibility.importedPresentRooms=[...MOWER_OUTPUT_ROOM_IDS,'central']
  const before=JSON.stringify(base)
  const result=generateAutomaticRoster(base,allOwned,{trials:1})
  expect(result.status,JSON.stringify(result.diagnostics)+JSON.stringify(result.trials)).toBe('draft')
  const draft=result.draft!,workspace=draft.workspace!
  for(const room of Object.values(workspace.mainPlan.facilities))if(['manufacture','trading','power','central'].includes(room.type)){
   const cap=room.type==='central'?5:room.type==='power'?1:room.level
   expect(room.slots.slice(0,cap).every(s=>s.occupant.kind==='operator')).toBe(true)
   expect(room.slots.slice(0,cap).every(s=>s.replacements.length===1)).toBe(true)
   expect([room.level,room.type,room.product]).toEqual([base.mainPlan.facilities[room.roomId].level,base.mainPlan.facilities[room.roomId].type,base.mainPlan.facilities[room.roomId].product])
  }
  const backups=Object.values(workspace.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>s.replacements))
  expect(new Set(backups).size).toBe(backups.length)
  expect(backups.every(value=>!mains(workspace).includes(id(value)))).toBe(true)
  expect(draft.restResources.freeBeds).toBeGreaterThanOrEqual(draft.restResources.minimumFreeBedsForNewGroup)
  expect(Object.values(workspace.mainPlan.facilities).filter(r=>r.type==='dormitory').every(r=>r.slots.every(s=>s.occupant.kind!=='empty'))).toBe(true)
  expect(validatePhysicalRoster(workspace)).toEqual([])
  expect(validateScheduleInventory(compileRosterSchedule(workspace),compileOperatorInventory(allOwned)).valid).toBe(true)
  expect(draft.statesVisited).toBeLessThanOrEqual(2000)
  expect(result.trials[0]).toMatchObject({complete:true,status:'draft'})
  expect(result.trials[0]!.refinement).toBeDefined()
  expect(result.trials[0]!.refinement!.afterRanking).toBeGreaterThanOrEqual(result.trials[0]!.refinement!.beforeRanking)
  expect(draft.diagnostics.some(d=>d.code==='CONDITIONAL_DRAFT')).toBe(true)
  expect(JSON.stringify(base)).toBe(before)
  const exported=importMowerJson(exportMowerJson(workspace))
  const free=(w:typeof workspace)=>Object.values(w.mainPlan.facilities).flatMap(r=>r.slots).filter(s=>s.occupant.kind==='free').length
  expect(free(exported)).toBe(free(workspace))
 },120000)
 it('uses actual dorm residents rather than Free beds in every static projection', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const spy=vi.spyOn(controlImpact,'projectControlOutput')
  try{
   const result=generateAutomaticRoster(createDefaultWorkspace(),allOwned,{trials:1})
   expect(result.status).toBe('draft');expect(spy).toHaveBeenCalled()
   for(const [config]of spy.mock.calls){
    expect(config.dormitoryOccupantCount).toBe(config.facilityOperatorIds.dormitories.flat().length)
    expect(config.rooms.every(r=>r.skillBonus===0&&r.specialOrder==='none')).toBe(true)
    expect(config.droneTarget).toBe('none')
   }
  }finally{spy.mockRestore()}
 },30000)
 it('is repeatable and selects the highest complete pair ranking score among trials', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const base=createDefaultWorkspace(),options={seed:901,trials:2}
  const result=generateAutomaticRoster(base,allOwned,options)
  expect(result).toEqual(generateAutomaticRoster(base,allOwned,options))
  expect(result.status,JSON.stringify(result.diagnostics)+JSON.stringify(result.trials)).toBe('draft')
  expect(result.trials[result.selectedTrial!]!.duty!.rankingScore).toBe(Math.max(...result.trials.flatMap(t=>t.complete?[t.duty!.rankingScore!]:[])))
  expect(new Set(result.trials.map(t=>t.seed)).size).toBe(2)
 },90000)
 it('preserves a learned cross-room group and its chosen backups after filling and optimization', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const base=createDefaultWorkspace();for(const r of Object.values(base.mainPlan.facilities))if(r.type==='manufacture')r.product='gold'
  // Updated special-order scoring can favor the ordinary trial over an early
  // cross-room trial. Five fixed starts select a complete cross-room draft.
  const result=generateAutomaticRoster(base,allOwned,{seed:901,trials:5})
  const selections=result.trials[result.selectedTrial!]!.crossRoomSelections
  expect(selections?.length).toBeGreaterThan(0)
  const workspace=result.draft!.workspace!,compiled=compileRosterSchedule(workspace)
  for(const selection of selections!){
   const slots=compiled.rooms.flatMap(r=>r.slots).filter(s=>s.groupId===selection.groupId)
   expect(slots).toHaveLength(selection.members.length)
   expect(new Set(slots.map(s=>s.roomId)).size).toBeGreaterThan(1)
   for(const m of selection.members){
    const slot=workspace.mainPlan.facilities[m.roomId].slots[m.slotIndex]!
    expect(slot.occupant).toEqual({kind:'operator',operatorId:m.operatorId})
    expect(slot.replacements).toEqual([m.selectedCandidate])
    expect(m.orderedCandidates).toContain(m.selectedCandidate)
   }
  }
 },30000)
 it('adapts to a 252 layout with two-seat trade and keeps fixed auxiliary occupants and Free', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const base=createDefaultWorkspace()
  base.mainPlan.facilities.room_3_3={roomId:'room_3_3',type:'manufacture',level:3,product:'exp',slots:Array.from({length:3},()=>({occupant:{kind:'empty'},groupId:null,replacements:[]}))}
  base.mainPlan.facilities.room_3_1.level=2
  for(const room of Object.values(base.mainPlan.facilities))if(room.type==='dormitory'||room.type==='contact'||room.type==='factory'||room.type==='train')room.level=1
  base.mainPlan.facilities.meeting.slots[0]!.occupant={kind:'operator',operatorId:'陈'}
  base.mainPlan.facilities.dormitory_4.slots[4]!.occupant={kind:'free'}
  const result=generateAutomaticRoster(base,allOwned,{trials:1,seed:73})
  expect(result.status,JSON.stringify(result.diagnostics)+JSON.stringify(result.trials)).toBe('draft')
  const w=result.draft!.workspace!
  expect(w.mainPlan.facilities.meeting.slots[0]).toEqual(base.mainPlan.facilities.meeting.slots[0])
  expect(w.mainPlan.facilities.dormitory_4.slots[4]).toEqual(base.mainPlan.facilities.dormitory_4.slots[4])
  expect(w.mainPlan.facilities.room_3_1.slots[2]!.occupant.kind).toBe('empty')
  expect(w.mainPlan.facilities.room_3_3.slots.filter(s=>s.occupant.kind==='operator')).toHaveLength(3)
 },30000)
 it('builds from a reduced owned roster without borrowing missing or locked high-efficiency staff', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const missing=new Set(['鸿雪','图耶','Mon3tr','凯尔希','斩业星熊','诗怀雅','蕾缪安','能天使','推进之王','摩根','戴菲恩'])
  const inventory=allOwned.filter(o=>!missing.has(o.operator)).map(o=>o.operator==='白面鸮'?{...o,elitePhase:0,level:1}:o)
  const result=generateAutomaticRoster(createDefaultWorkspace(),inventory,{trials:2,seed:1337})
  expect(result.status,JSON.stringify(result.trials)).toBe('draft')
  const compiled=compileOperatorInventory(inventory),eligible=new Set(compiled.operators.filter(o=>o.matchesMaximumSkills).map(o=>o.charId))
  const w=result.draft!.workspace!,participants=[...mains(w),...Object.values(w.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>s.replacements))]
  expect(participants.every(operator=>eligible.has(id(operator)))).toBe(true)
 },30000)
 it('never returns a half-filled draft for an insufficient inventory or state budget', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  for(const options of [{trials:1,maxStates:1},{trials:1,maxStates:20}]){
   const result=generateAutomaticRoster(createDefaultWorkspace(),allOwned,options)
   expect(result.status).toBe('blocked');expect(result.draft).toBeNull()
  }
  const result=generateAutomaticRoster(createDefaultWorkspace(),allOwned.filter(o=>['砾','芬'].includes(o.operator)),{trials:1})
  expect(result.status).toBe('blocked');expect(result.draft).toBeNull()
 })
 it('protects occupied policies and generates a main-only draft without modifying imported backups', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  for(const change of ['main','control','conf','metadata','backup','group'] as const){
   const base=createDefaultWorkspace()
   if(change==='main')base.mainPlan.facilities.room_1_1.slots[0]!.occupant={kind:'operator',operatorId:id('砾')}
   if(change==='control')base.mainPlan.facilities.central.slots[0]!.occupant={kind:'operator',operatorId:id('杜宾')}
   if(change==='conf')base.mainPlan.conf.workaholic=['砾']
   if(change==='metadata')base.mainPlan.facilities.contact.slots[0]!.metadata={custom:true}
   if(change==='backup')base.compatibility.backupPlans.push({custom:true})
   if(change==='group')base.mainPlan.facilities.room_1_1.slots[0]!.groupId='custom'
   const before=JSON.stringify(base)
   const result=generateAutomaticRoster(base,allOwned,{trials:1})
   if(change==='backup'){
    expect(result.status).toBe('draft')
    expect(result.draft?.workspace?.compatibility.backupPlans).toEqual([])
   }else expect(result.status).toBe('blocked')
   expect(JSON.stringify(base)).toBe(before)
  }
 },60000)
 it('rejects unsupported product and invalid options without gating preserved staff on idle-library stage', async ({ annotate }) => {

   await annotate('同步计算前确认测试进度已送达')
  const base=createDefaultWorkspace();base.mainPlan.facilities.room_1_1.product='fragment'
  expect(generateAutomaticRoster(base,allOwned).diagnostics[0]!.code).toBe('UNSUPPORTED_PRODUCT')
  base.mainPlan.facilities.room_1_1.product='gold';base.mainPlan.facilities.meeting.slots[0]!.occupant={kind:'operator',operatorId:id('陈')}
  const low=allOwned.map(o=>o.operator==='陈'?{...o,elitePhase:0,level:1}:o)
  expect(generateAutomaticRoster(base,low).status).toBe('draft')
  for(const options of [{seed:-1},{seed:2**32},{trials:0},{trials:9},{maxStates:0},{maxStates:100001}])expect(generateAutomaticRoster(createDefaultWorkspace(),allOwned,options).diagnostics[0]!.code).toBe('INVALID_OPTIONS')
 },60000)
})
