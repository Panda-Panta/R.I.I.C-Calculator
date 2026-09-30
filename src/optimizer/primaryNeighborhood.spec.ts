import {describe,it,expect} from 'vitest'
import {OPERATORS,OPERATOR_MAP} from '../domain/operators'
import type {OwnedOperatorInput} from '../domain/operatorInventory'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import type {MowerRoomId} from '../workbench/model'
import {validatePhysicalRoster} from './rosterDraft'
import {generateProductionMainNeighbors} from './primaryNeighborhood'

const owned=(names:string[]):OwnedOperatorInput[]=>names.map(operator=>{
 const o=OPERATOR_MAP.get(id(operator))!
 return {operator,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}
})
const allOwned=owned(OPERATORS.map(o=>o.name))
function fixture(){
 const w=createDefaultWorkspace()
 w.name='保留原文';w.compatibility.sourceVersion='source-v1'
 w.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'砾'},groupId:'制造组',replacements:['白雪']}
 w.mainPlan.facilities.room_1_2.slots[0]={occupant:{kind:'operator',operatorId:id('克洛丝')},groupId:null,replacements:[]}
 w.mainPlan.facilities.room_3_1.slots[0]={occupant:{kind:'operator',operatorId:'芬'},groupId:'贸易组',replacements:[]}
 w.mainPlan.facilities.room_1_3.slots[0]={occupant:{kind:'operator',operatorId:'雷蛇'},groupId:'发电组',replacements:[]}
 return w
}
function position(key:string){const index=Number(key.slice(key.lastIndexOf('_')+1));return {roomId:key.slice(0,key.lastIndexOf('_')) as MowerRoomId,index}}
describe('protected production main neighborhood',()=>{
 it('admits a stronger unlocked skill without requiring the maximum-stage version',()=>{
  const w=createDefaultWorkspace()
  w.mainPlan.facilities.room_1_1.slots[0]!.occupant={kind:'operator',operatorId:id('黑角')}
  const results=generateProductionMainNeighbors(w,[{operator:'黑角',elitePhase:0,level:1},{operator:'白面鸮',elitePhase:0,level:1}])
  expect(results.map(n=>n.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant)).toEqual([
   {kind:'operator',operatorId:id('白面鸮')},
  ])
 })
 it('changes one occupied production seat, round robins facilities and preserves every other field',()=>{
  const w=fixture(),before=structuredClone(w),results=generateProductionMainNeighbors(w,owned(['阿罗玛','海蒂','格雷伊']),4)
  expect(results).toHaveLength(4)
  expect(results.map(n=>n.move.positions)).toEqual([['room_1_1_0'],['room_1_2_0'],['room_1_3_0'],['room_3_1_0']])
  for(const n of results){
   expect(n.move.kind).toBe('production-main')
   expect(validatePhysicalRoster(n.workspace)).toEqual([])
   const {roomId,index}=position(n.move.positions[0]!),copy=structuredClone(n.workspace)
   copy.mainPlan.facilities[roomId].slots[index]!.occupant=structuredClone(before.mainPlan.facilities[roomId].slots[index]!.occupant)
   expect(copy).toEqual(before)
  }
  expect(w).toEqual(before)
 })
 it('requires an owned unlocked facility skill and uses the actual layout type',()=>{
  const w=fixture()
  const results=generateProductionMainNeighbors(w,[...owned(['海蒂','阿米娅']),{operator:'斑点',elitePhase:0,level:1}])
  expect(results.map(n=>n.move.positions)).toEqual([['room_3_1_0']])
  w.mainPlan.facilities.room_3_1.type='manufacture';w.mainPlan.facilities.room_3_1.product='exp'
  expect(generateProductionMainNeighbors(w,owned(['梓兰']))).toEqual([])
 })
 it('keeps passive occupants without that facility skill, empty seats and unresolved Current fixed',()=>{
  const w=createDefaultWorkspace()
  w.mainPlan.facilities.room_1_1.slots[0]!.occupant={kind:'operator',operatorId:'阿米娅'}
  w.mainPlan.facilities.room_1_1.slots[1]!.occupant={kind:'current'}
  expect(generateProductionMainNeighbors(w,allOwned)).toEqual([])
 })
 it('reserves all existing main and backup aliases, even in auxiliary facilities',()=>{
  const w=fixture()
  w.mainPlan.facilities.factory.slots[0]!.occupant={kind:'operator',operatorId:'斑点'}
  w.mainPlan.facilities.contact.slots[0]!.replacements=[id('梓兰')]
  expect(generateProductionMainNeighbors(w,owned(['斑点','梓兰','砾','白雪','芬','雷蛇']))).toEqual([])
 })
 it.each(['conf','fia','slot-metadata','metadata-reference','backup-plan','compatibility-key','explicit','special-backup','protected-backup'])('protects referenced production seats: %s',kind=>{
  const w=fixture(),slot=w.mainPlan.facilities.room_1_1.slots[0]!
  if(kind==='conf')w.mainPlan.conf.custom='砾, 芬'
  if(kind==='fia'){const f=w.mainPlan.facilities.dormitory_1.slots[0]!;f.occupant={kind:'operator',operatorId:'菲亚梅塔'};f.replacements=['砾']}
  if(kind==='slot-metadata')slot.metadata={custom:true}
  if(kind==='metadata-reference')w.mainPlan.facilities.factory.slots[0]!.metadata={target:id('砾')}
  if(kind==='backup-plan')w.compatibility.backupPlans=[{trigger:'op("砾") == 0'}]
  if(kind==='compatibility-key')w.compatibility.unrecognizedFields={linked:{[id('砾')]:true}}
  if(kind==='special-backup')slot.replacements=['白雪','但书']
  if(kind==='protected-backup')w.mainPlan.conf.rest_in_full=['白雪']
  const results=generateProductionMainNeighbors(w,owned(['斑点']),20,kind==='explicit'?['砾']:[])
  expect(results.map(n=>n.move.positions)).toEqual([['room_1_2_0']])
  expect(results[0]!.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(slot)
 })
 it.each(['conf','fia','metadata','backup-plan','explicit'])('does not recruit a candidate referenced by %s',kind=>{
  const w=fixture()
  if(kind==='conf')w.mainPlan.conf.custom='斑点, 阿米娅'
  if(kind==='fia'){const f=w.mainPlan.facilities.dormitory_1.slots[0]!;f.occupant={kind:'operator',operatorId:'菲亚梅塔'};f.replacements=['斑点']}
  if(kind==='metadata')w.mainPlan.facilities.factory.slots[0]!.metadata={target:'斑点'}
  if(kind==='backup-plan')w.compatibility.backupPlans=[{target:id('斑点')}]
  expect(generateProductionMainNeighbors(w,owned(['斑点']),20,kind==='explicit'?['斑点']:[])).toEqual([])
 })
 it('excludes run-order and Fiammetta mains and candidates',()=>{
  const w=createDefaultWorkspace()
  w.mainPlan.facilities.room_3_1.slots[0]!.occupant={kind:'operator',operatorId:'但书'}
  expect(generateProductionMainNeighbors(w,allOwned)).toEqual([])
  expect(generateProductionMainNeighbors(fixture(),owned(['但书','龙舌兰','菲亚梅塔']))).toEqual([])
 })
 it('rejects physical alias duplicates, invalid inventories and invalid budgets',()=>{
  const w=fixture();w.mainPlan.facilities.meeting.slots[0]!.occupant={kind:'operator',operatorId:id('砾')}
  expect(generateProductionMainNeighbors(w,allOwned)).toEqual([])
  for(const limit of [-1,22,NaN,1.5])expect(()=>generateProductionMainNeighbors(fixture(),allOwned,limit)).toThrow()
  expect(()=>generateProductionMainNeighbors(fixture(),owned(['斑点',id('斑点')]))).toThrow('无效的干员库')
  expect(()=>generateProductionMainNeighbors(fixture(),[{operator:'未知',elitePhase:2,level:90}])).toThrow('无效的干员库')
 })
 it('is bounded, unique and repeatable without mutating inventory',()=>{
  const entries=structuredClone(allOwned),results=generateProductionMainNeighbors(fixture(),entries,21)
  expect(results).toHaveLength(21)
  expect(results).toEqual(generateProductionMainNeighbors(fixture(),entries,21))
  expect(new Set(results.map(n=>JSON.stringify(n.workspace))).size).toBe(21)
  expect(generateProductionMainNeighbors(fixture(),entries,0)).toEqual([])
  expect(entries).toEqual(allOwned)
 })
})
