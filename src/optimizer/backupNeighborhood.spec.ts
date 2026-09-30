import {describe,it,expect} from 'vitest'
import {OPERATORS} from '../domain/operators'
import type {OwnedOperatorInput} from '../domain/operatorInventory'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {generateBackupNeighbors} from './backupNeighborhood'
const owned=(names:string[]):OwnedOperatorInput[]=>names.map(operator=>{const o=OPERATORS.find(o=>o.name===operator)!;return {operator,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}})
const allOwned=owned(OPERATORS.map(o=>o.name))
function fixture(){
 const w=createDefaultWorkspace()
 for(const [key,name,replacements] of [['room_1_1','砾',['淬羽赫默','梅尔']],['room_1_2','调香师',['雪猎','维伊']]] as const){
  const room=w.mainPlan.facilities[key];room.type='manufacture';room.product=key==='room_1_1'?'gold':'exp';room.level=3
  room.slots[0]!.occupant={kind:'operator',operatorId:id(name)};room.slots[0]!.replacements=[...replacements];room.slots[0]!.groupId=key+'-group'
 }
 return w
}
describe('fair protected ordinary backup neighborhood',()=>{
 it('enumerates replace, adjacent reorder and cross-recipe exchange before exhausting the first slot',()=>{
  const w=fixture(),before=structuredClone(w),r=generateBackupNeighbors(w,allOwned,6)
  expect(r.slice(0,3).map(n=>n.move.kind)).toEqual(['replace','reorder','exchange'])
  expect(r[3]!.move.positions[0]).toBe('room_1_2_0')
  expect(w).toEqual(before)
  for(const n of r){
   const copy=structuredClone(n.workspace)
   for(const room of Object.values(copy.mainPlan.facilities))room.slots.forEach((s,i)=>{s.replacements=[...before.mainPlan.facilities[room.roomId].slots[i]!.replacements]})
   expect(copy).toEqual(before)
  }
 })
 it('swaps adjacent priorities without changing the candidate set',()=>{
  const w=fixture(),r=generateBackupNeighbors(w,allOwned,21,{exchange:false}).filter(n=>n.move.kind==='reorder')
  expect(r[0]!.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual(['梅尔','淬羽赫默'])
  expect(r[0]!.move.positions).toEqual(['room_1_1_0'])
 })
 it('exchanges distinct slots at the same facility type and preserves literal names',()=>{
  const w=fixture(),r=generateBackupNeighbors(w,allOwned,21,{reorder:false}).find(n=>n.move.kind==='exchange')!
  expect(r.move.positions).toEqual(['room_1_1_0','room_1_2_0'])
  expect(r.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements).toEqual(['雪猎','梅尔'])
  expect(r.workspace.mainPlan.facilities.room_1_2.slots[0]!.replacements).toEqual(['淬羽赫默','维伊'])
 })
 it('rejects exchanges across facility types or without matching owned unlocked skills',()=>{
  const w=fixture();w.mainPlan.facilities.room_1_2.type='trading';w.mainPlan.facilities.room_1_2.product='money'
  expect(generateBackupNeighbors(w,allOwned,21).some(n=>n.move.kind==='exchange')).toBe(false)
  w.mainPlan.facilities.room_1_2.type='manufacture';w.mainPlan.facilities.room_1_2.product='gold';w.mainPlan.facilities.room_1_2.slots[0]!.replacements=['Lancet-2']
  expect(generateBackupNeighbors(w,allOwned,21).some(n=>n.move.kind==='exchange')).toBe(false)
  w.mainPlan.facilities.room_1_2.slots[0]!.replacements=['雪猎']
  expect(generateBackupNeighbors(w,owned(['砾','调香师','淬羽赫默','梅尔']),21).some(n=>n.move.kind==='exchange')).toBe(false)
 })
 it.each(['run','policy','fia','metadata','workaholic'])('freezes protected slots for every move: %s',protection=>{
  const w=fixture(),slot=w.mainPlan.facilities.room_1_1.slots[0]!
  if(protection==='run')slot.replacements=['淬羽赫默','但书']
  if(protection==='policy')w.mainPlan.conf.rest_in_full=['淬羽赫默']
  if(protection==='metadata')slot.metadata={unknown:true}
  if(protection==='workaholic')w.mainPlan.conf.workaholic=['砾']
  if(protection==='fia'){const f=w.mainPlan.facilities.dormitory_1.slots[0]!;f.occupant={kind:'operator',operatorId:id('菲亚梅塔')};f.replacements=['砾']}
  const original=structuredClone(slot)
  for(const n of generateBackupNeighbors(w,allOwned,21))expect(n.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(original)
 })
 it('normalizes name and ID aliases to avoid duplicate candidates and no-op swaps',()=>{
  const w=fixture();w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['淬羽赫默',id('雪猎')];w.mainPlan.facilities.room_1_2.slots[0]!.replacements=[id('淬羽赫默'),'维伊']
  const results=generateBackupNeighbors(w,allOwned,21)
  for(const n of results)for(const room of Object.values(n.workspace.mainPlan.facilities))for(const slot of room.slots)expect(new Set(slot.replacements.map(id)).size).toBe(slot.replacements.length)
  expect(results.filter(n=>n.move.kind==='exchange').every(n=>n.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements.map(id).join()!==w.mainPlan.facilities.room_1_1.slots[0]!.replacements.map(id).join())).toBe(true)
 })
 it('supports two slots within one room while keeping each main and group untouched',()=>{
  const w=fixture(),a=w.mainPlan.facilities.room_1_1,b=w.mainPlan.facilities.room_1_2
  a.slots[1]=structuredClone(b.slots[0]!)
  b.slots[0]!.occupant={kind:'empty'};b.slots[0]!.replacements=[]
  const exchange=generateBackupNeighbors(w,allOwned,6).find(n=>n.move.kind==='exchange')!
  expect(exchange.move.positions).toEqual(['room_1_1_0','room_1_1_1'])
  expect(exchange.workspace.mainPlan.facilities.room_1_1.slots[1]!.groupId).toBe('room_1_2-group')
 })
 it('uses an owned lower-stage candidate with an unlocked facility skill during reordering',()=>{
  const w=fixture();w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['淬羽赫默','白面鸮']
  w.mainPlan.facilities.room_1_2.slots[0]!.occupant={kind:'operator',operatorId:id('断罪者')}
  const entries=[...owned(['砾','断罪者','淬羽赫默','梅尔','雪猎','维伊']),{operator:'白面鸮',elitePhase:0,level:1}]
  const r=generateBackupNeighbors(w,entries,21)
  expect(r.some(n=>n.move.kind==='reorder'&&n.move.positions.includes('room_1_1_0'))).toBe(true)
 })
 it('does not move unowned or not-yet-unlocked existing candidates during reordering',()=>{
  const w=fixture();w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['淬羽赫默','调香师']
  w.mainPlan.facilities.room_1_2.slots[0]!.occupant={kind:'operator',operatorId:id('断罪者')}
  const entries=[...owned(['砾','断罪者','淬羽赫默','梅尔','雪猎','维伊']),{operator:'调香师',elitePhase:0,level:1}]
  const r=generateBackupNeighbors(w,entries,21)
  expect(r.some(n=>n.move.kind==='reorder'&&n.move.positions.includes('room_1_1_0'))).toBe(false)
  for(const n of r.filter(n=>n.move.kind==='exchange'))expect(n.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements[1]).toBe('调香师')
 })
 it('protects named staff inside nested custom policies and rejects invalid alias rosters',()=>{
  const w=fixture();w.mainPlan.conf.custom={target:{operator:id('淬羽赫默')}}
  for(const n of generateBackupNeighbors(w,allOwned,21))expect(n.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(w.mainPlan.facilities.room_1_1.slots[0])
  delete w.mainPlan.conf.custom
  w.mainPlan.facilities.room_1_1.slots[0]!.replacements=['淬羽赫默',id('淬羽赫默')]
  expect(generateBackupNeighbors(w,allOwned,21)).toEqual([])
 })
 it('keeps bounded deterministic unique outputs and supports replace-only compatibility',()=>{
  const w=fixture(),a=generateBackupNeighbors(w,allOwned,21),b=generateBackupNeighbors(w,allOwned,21)
  expect(a).toEqual(b);expect(a).toHaveLength(21);expect(new Set(a.map(n=>JSON.stringify(n.workspace.mainPlan))).size).toBe(21)
  expect(generateBackupNeighbors(w,allOwned,3,{reorder:false,exchange:false}).map(n=>n.move.kind)).toEqual(['replace','replace','replace'])
  expect(generateBackupNeighbors(w,allOwned,0)).toEqual([])
  for(const limit of [-1,22,NaN,1.5])expect(()=>generateBackupNeighbors(w,allOwned,limit)).toThrow()
 })
})
