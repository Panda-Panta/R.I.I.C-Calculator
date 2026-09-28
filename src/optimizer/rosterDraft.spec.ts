import {describe,expect,it} from 'vitest'
import {OPERATORS} from '../domain/operators'
import {matchesRiicIdentity} from '../domain/riicIdentity'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id,exportMowerJson,importMowerJson} from '../workbench/compat/mowerJson'
import {selectCombinationCandidates} from './combinationCandidates'
import {compileCandidateLayout,generateRosterDraft} from './rosterDraft'
import {simulateSchedule} from '../simulator/scheduleSimulation'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import type {OwnedOperatorInput} from '../domain/operatorInventory'
const owned=(names:string[]):OwnedOperatorInput[]=>names.map(operator=>{
 const o=OPERATORS.find(o=>o.name===operator)!
 return {operator,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:1+(o.rarity<3?29:0)}
})
const allOwned=owned(OPERATORS.map(o=>o.name))
const candidate=(name:string)=>selectCombinationCandidates(OPERATORS.map(o=>o.name)).available.find(c=>c.id===name)!
const mains=(ws:ReturnType<typeof createDefaultWorkspace>)=>Object.values(ws.mainPlan.facilities).flatMap(r=>r.slots.flatMap(s=>s.occupant.kind==='operator'?[id(s.occupant.operatorId)]:[]))
describe('typed candidate layout and roster drafts',()=>{
 it('compiles all 56 contracts without deriving products from candidate IDs or formulas',()=>{
  const all=selectCombinationCandidates(OPERATORS.map(o=>o.name),{includeObserved:false}).available
  expect(all).toHaveLength(56)
  for(const c of all){const contract=compileCandidateLayout(c);expect(contract.assignments).toHaveLength(1+c.supportAssignments.length);expect(contract.uncheckedConditions.length).toBeGreaterThan(0)}
  expect(compileCandidateLayout(candidate('manu-exp-p3-makoto')).assignments[0]).toMatchObject({facility:'manufacture',product:'gold',occupancy:'exact'})
  expect(compileCandidateLayout(candidate('trade-karlan-jaye')).assignments[0]).toMatchObject({product:'money'})
  expect(compileCandidateLayout(candidate('manu-originium-basic')).assignments[0]).toMatchObject({product:'fragment',minimumLevel:3})
 })
 it('shares SEES support with its target team, with six unique main operators',()=>{
  const ws=createDefaultWorkspace(),before=JSON.stringify(ws)
  const result=generateRosterDraft(ws,allOwned,['power-aigis-makoto','manu-exp-p3-makoto'])
  expect(result.status).toBe('draft')
  expect(mains(result.workspace!)).toHaveLength(6)
  expect(new Set(mains(result.workspace!)).size).toBe(6)
  const power=result.placements.find(p=>p.candidateId==='power-aigis-makoto'&&p.roomKey==='target')!
  expect(result.placements.find(p=>p.candidateId==='manu-exp-p3-makoto'&&p.roomKey==='power-1')!.roomId).toBe(power.roomId)
  const manufacture=result.placements.find(p=>p.candidateId==='manu-exp-p3-makoto'&&p.roomKey==='target')!
  expect(result.placements.find(p=>p.candidateId==='power-aigis-makoto'&&p.roomKey==='manufacture-1')!.roomId).toBe(manufacture.roomId)
  expect(JSON.stringify(ws)).toBe(before)
  expect(mains(importMowerJson(exportMowerJson(result.workspace!)))).toEqual(mains(result.workspace!))
 })
 it('rejects six distinct control supports and a one-slot office conflict',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.product='exp'
  expect(generateRosterDraft(ws,allOwned,['manu-exp-redpine-control','trade-wuyou-duoling-fireworks','trade-karlan-jaye']).status).toBe('blocked')
  expect(generateRosterDraft(ws,allOwned,['dorm-perception-support','trade-wuyou-duoling-fireworks']).status).toBe('blocked')
 })
 it('does not fill a third slot in an exact two-person template',()=>{
  const r=generateRosterDraft(createDefaultWorkspace(),allOwned,['manu-gold-weedy-purestream'])
  expect(r.status).toBe('draft')
  const room=r.workspace!.mainPlan.facilities[r.placements[0]!.roomId]
  expect(room.slots.filter(s=>s.occupant.kind==='operator')).toHaveLength(2)
  expect(room.slots.filter(s=>s.occupant.kind==='empty')).toHaveLength(1)
 })
 it('preserves occupied rooms and Free beds instead of evicting existing staff',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots[0]!.occupant={kind:'operator',operatorId:id('砾')}
  for(const r of Object.values(ws.mainPlan.facilities))if(r.type==='dormitory')r.slots.forEach(s=>s.occupant={kind:'free'})
  const r=generateRosterDraft(ws,allOwned,['manu-gold-weedy-purestream'])
  expect(r.status).toBe('draft');expect(r.placements[0]!.roomId).not.toBe('room_1_1')
  expect(r.workspace!.mainPlan.facilities.room_1_1).toEqual(ws.mainPlan.facilities.room_1_1)
  expect(r.workspace!.mainPlan.facilities.dormitory_1).toEqual(ws.mainPlan.facilities.dormitory_1)
  expect(generateRosterDraft(ws,allOwned,['dorm-perception-support']).status).toBe('blocked')
 })
 it('checks recipe unlocks and physical facility count independently of existing validator',()=>{
  let ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.level=2;ws.mainPlan.facilities.room_1_1.product='fragment'
  expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto']).diagnostics.some(d=>d.code==='RECIPE_LEVEL')).toBe(true)
  ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.level=2;ws.mainPlan.facilities.room_1_1.product='exp'
  expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto']).diagnostics.some(d=>d.code==='RECIPE_LEVEL')).toBe(false)
  ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_3.type='manufacture';ws.mainPlan.facilities.room_2_3.type='manufacture'
  expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto']).diagnostics.some(d=>d.code==='FACILITY_COUNT')).toBe(true)
 })
 it('allows level 2 manufacture stations to produce exp without triggering RECIPE_LEVEL',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_2_2.level=2
  ws.mainPlan.facilities.room_2_2.product='exp'
  ws.mainPlan.facilities.room_2_2.slots=ws.mainPlan.facilities.room_2_2.slots.slice(0,2)
  const res=generateRosterDraft(ws,allOwned,['manu-exp-p3-makoto'])
  expect(res.diagnostics.some(d=>d.code==='RECIPE_LEVEL')).toBe(false)
 })
 it('assigns unique ordinary backups and an atomic new target group without stealing primary staff',()=>{
  const ws=createDefaultWorkspace();ws.mainPlan.facilities.dormitory_1.slots.slice(0,3).forEach(s=>s.occupant={kind:'free'})
  const r=generateRosterDraft(ws,owned(['砾','阿罗玛','槐琥','雪猎','梅尔','淬羽赫默','但书']),['manu-gold-waai-fu-copy'])
  expect(r.status).toBe('draft')
  const slots=r.workspace!.mainPlan.facilities[r.placements[0]!.roomId].slots
  const replacements=slots.flatMap(s=>s.replacements)
  expect(replacements).toHaveLength(3);expect(new Set(replacements).size).toBe(3)
  expect(replacements).not.toContain(id('但书'))
  expect(replacements.some(rep=>mains(r.workspace!).includes(rep))).toBe(false)
  expect(new Set(slots.map(s=>s.groupId)).size).toBe(1)
  expect(r.restResources.missingReplacementIds).toEqual([])
 })
 it('keeps missing rest resources visible and never turns a temporal strategy into permanent staffing',()=>{
  const r=generateRosterDraft(createDefaultWorkspace(),owned(['温蒂','清流']),['manu-gold-weedy-purestream'])
  expect(r.status).toBe('draft');expect(r.restResources.missingReplacementIds).toHaveLength(2)
  expect(r.diagnostics.some(d=>d.code==='REST_RESOURCES_INCOMPLETE')).toBe(true)
  expect(generateRosterDraft(createDefaultWorkspace(),allOwned,['trade-run-kafka-bibeak']).diagnostics.some(d=>d.code==='TEMPORAL_TEMPLATE')).toBe(true)
 })
 it('distinguishes exhausted search budget, unknown IDs, missing ownership and deterministic reruns',()=>{
  const ws=createDefaultWorkspace()
  expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto'],{maxStates:1}).diagnostics.some(d=>d.code==='SEARCH_BUDGET')).toBe(true)
  expect(generateRosterDraft(ws,allOwned,['unknown']).status).toBe('blocked')
  expect(generateRosterDraft(ws,[],['power-aigis-makoto']).diagnostics.some(d=>d.code==='CANDIDATE_NOT_ADMITTED')).toBe(true)
  expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto'])).toEqual(generateRosterDraft(ws,allOwned,['power-aigis-makoto']))
 })
 it('corrects the two-member Karlan team instead of counting Swire alter as a third',()=>{
  const c=candidate('trade-karlan-silverash')
  expect(c.targetAssignment.operators.filter(ref=>matchesRiicIdentity(OPERATORS.find(o=>o.charId===ref.charId)!,'nationId','kjerag'))).toHaveLength(2)
  expect(c.name).not.toContain('三谢拉格')
  expect(c.constraints.roster.join('')).toContain('2名')
 })
})

it.each(['central','contact'] as const)('rejects a forged second %s at the meeting-room key',type=>{
 const ws=createDefaultWorkspace();ws.mainPlan.facilities.meeting.type=type
 expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto']).diagnostics.some(d=>d.code==='FIXED_ROOM_TYPE')).toBe(true)
})
it('protects keyed room identity and empty slots carrying unknown metadata',()=>{
 let ws=createDefaultWorkspace();ws.mainPlan.facilities.meeting.roomId='contact'
 expect(generateRosterDraft(ws,allOwned,['power-aigis-makoto']).diagnostics.some(d=>d.code==='ROOM_ID_MISMATCH')).toBe(true)
 ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.slots[0]!.metadata={unknownRule:{keep:true}}
 const before=structuredClone(ws.mainPlan.facilities.room_1_1.slots[0])
 const r=generateRosterDraft(ws,allOwned,['manu-gold-waai-fu-copy'])
 expect(r.status).toBe('draft');expect(r.placements[0]!.roomId).not.toBe('room_1_1')
 expect(r.workspace!.mainPlan.facilities.room_1_1.slots[0]).toEqual(before)
})

it('executes a generated main/backup team through real morale and production events',()=>{
 const ws=createDefaultWorkspace();ws.mainPlan.facilities.dormitory_1.slots.slice(0,3).forEach(s=>s.occupant={kind:'free'})
 const inventory=owned(['砾','阿罗玛','槐琥','雪猎','梅尔','淬羽赫默'])
 const draft=generateRosterDraft(ws,inventory,['manu-gold-waai-fu-copy'])
 const idleLibrary=owned(['艾丽妮','白铁','百炼嘉维尔','仇白','嵯峨','归溟幽灵鲨'])
 const report=simulateSchedule(compileRosterSchedule(draft.workspace!),{sampleHours:48,warmupHours:24,maxStepHours:.25,operatorInventory:[...inventory,...idleLibrary],production:{droneTarget:'none'}})
 expect(report.success).toBe(true)
 expect(report.events.some(e=>e.type==='shift-off')).toBe(true)
 expect(report.events.some(e=>e.type==='shift-on')).toBe(true)
 expect(report.production!.manufacturing.find(r=>r.roomId===draft.placements[0]!.roomId)!.completedItems).toBeGreaterThan(0)
 for(const op of report.operators)expect(op.workHours+op.restHours+op.idleHours+op.exhaustedHours).toBeCloseTo(48,6)
 for(const value of Object.values(report.production!.ledger.balances))expect(value).toBeGreaterThanOrEqual(0)
},30000)

it('keeps an existing on-duty worker absent from the imported idle-only library',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.central.slots[0]!.occupant={kind:'operator',operatorId:id('杜宾')}
 const draft=generateRosterDraft(ws,owned(['温蒂','清流']),['manu-gold-weedy-purestream'])
 expect(draft.status).toBe('draft')
 expect(draft.workspace?.mainPlan.facilities.central.slots[0]!.occupant).toEqual({kind:'operator',operatorId:id('杜宾')})
 expect(draft.diagnostics.some(d=>d.code==='INVENTORY_OPERATOR_NOT_OWNED')).toBe(false)
})
