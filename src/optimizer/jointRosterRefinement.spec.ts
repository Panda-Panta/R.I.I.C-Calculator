import {describe,it,expect} from 'vitest'
import {OPERATORS} from '../domain/operators'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {refineJointRoster} from './jointRosterRefinement'
const all=OPERATORS.map(o=>({operator:o.name,elitePhase:o.rarity<3?0:o.rarity===3?1:2,level:o.rarity<3?30:o.rarity===3?55:o.rarity===4?70:o.rarity===5?80:90}))
const own=(names:string[])=>all.filter(o=>names.includes(o.operator))
const slot=(main:string,backup:string,group='普通组')=>({occupant:{kind:'operator' as const,operatorId:id(main)},groupId:group,replacements:[id(backup)]})
function fixture(){const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots[0]=slot('斑点','砾');return w}
describe('joint main and backup roster refinement',()=>{
 it('promotes a stronger backup using the actual ordinary duty fraction and preserves the source',()=>{
  const w=fixture(),before=JSON.stringify(w),r=refineJointRoster(w,own(['斑点','砾']),{maxEvaluations:20})
  expect(r.changes[0]?.kind).toBe('main-backup-swap')
  expect(r.after!.rankingScore!-r.before!.rankingScore!).toBeCloseTo(220,6)
  expect(r.workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(slot('砾','斑点'))
  expect(JSON.stringify(w)).toBe(before);expect(r.evaluations).toBeLessThanOrEqual(20)
 })
 it('keeps assigned workers even when the imported library contains only idle candidates',()=>{
  const w=fixture(),r=refineJointRoster(w,own(['香草']),{maxEvaluations:20})
  expect(r.diagnostics).not.toContain('SOURCE_NOT_ADMITTED')
  expect(r.before).not.toBeNull()
  expect(r.changes.some(change=>change.kind==='main-backup-swap')).toBe(true)
  const slot=r.workspace.mainPlan.facilities.room_1_1.slots[0]!
  expect(new Set([slot.occupant.kind==='operator'?slot.occupant.operatorId:'',...slot.replacements])).toEqual(new Set([id('斑点'),id('砾')]))
 })
 it('reassigns existing main workers across different products without borrowing someone else',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_2.product='exp'
  w.mainPlan.facilities.room_1_1.slots[0]=slot('断罪者','Castle-3','A')
  w.mainPlan.facilities.room_1_2.slots[0]=slot('砾','夜烟','B')
  const r=refineJointRoster(w,own(['断罪者','Castle-3','砾','夜烟']),{maxEvaluations:24})
  expect(r.after!.rankingScore).toBeGreaterThan(r.before!.rankingScore!)
  expect(r.changes.some(c=>c.kind==='main-room-swap')).toBe(true)
  expect(r.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('A')
  expect(r.workspace.mainPlan.facilities.room_1_2.slots[0]!.groupId).toBe('B')
 })
 it('reunites Lemuen and Exusiai across trade rooms without changing the backup assignments',()=>{
  const w=createDefaultWorkspace()
  w.mainPlan.facilities.room_3_1.slots[0]=slot('能天使','香草','trade-A')
  w.mainPlan.facilities.room_3_1.slots[1]=slot('芬','夜烟','trade-A')
  w.mainPlan.facilities.room_3_2.slots[0]=slot('蕾缪安','讯使','trade-B')
  const r=refineJointRoster(w,own(['能天使','香草','芬','夜烟','蕾缪安','讯使']),{maxEvaluations:32})
  expect(r.changes.some(c=>c.kind==='main-room-swap')).toBe(true)
  expect(r.after!.rankingScore!-r.before!.rankingScore!).toBeCloseTo(397.787611,5)
  expect(r.after!.backupScore).toBeCloseTo(r.before!.backupScore,6)
 })
 it('uses unused stronger staff but never borrows a fixed auxiliary resident',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots[0]=slot('斑点','芬')
  const entries=own(['斑点','芬','砾'])
  const improved=refineJointRoster(w,entries,{maxEvaluations:20})
  expect(improved.changes.some(c=>c.kind==='main-replacement'&&c.after.includes(id('砾')))).toBe(true)
  w.mainPlan.facilities.meeting.slots[0]!.occupant={kind:'operator',operatorId:id('砾')}
  const fixed=refineJointRoster(w,entries,{maxEvaluations:20})
  expect(fixed.workspace).toEqual(w)
 })
 it('rejects a main replacement whose production rule is not quantified',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots[0]=slot('斑点','芬')
  const r=refineJointRoster(w,own(['斑点','芬','黍']),{maxEvaluations:20})
  expect(r.evaluations).toBeGreaterThan(4)
  expect(r.workspace).toEqual(w)
  expect(r.after!.rankingScore).toBe(r.before!.rankingScore)
 })
 it('keeps explicit locks, cross-room synchronized groups and fixed auxiliary workers intact',()=>{
  const w=fixture();w.mainPlan.facilities.room_1_2.slots[0]=slot('香草','月见夜')
  const r=refineJointRoster(w,all,{maxEvaluations:60})
  expect(r.workspace).toEqual(w)
  const locked=refineJointRoster(fixture(),all,{maxEvaluations:60,lockedPositions:['room_1_1:0']})
  expect(locked.workspace).toEqual(fixture())
 })
 it('accepts on-duty workers outside the idle library and ignores low-stage idle candidates',()=>{
  const w=fixture()
  expect(refineJointRoster(w,own(['斑点'])).before).not.toBeNull()
  const low=own(['斑点','砾']).map(o=>o.operator==='砾'?{...o,elitePhase:0,level:1}:o)
  expect(refineJointRoster(w,low).before).not.toBeNull()
  w.compatibility.backupPlans.push({trigger:'unhandled'})
  expect(refineJointRoster(w,all).workspace).toEqual(w)
 })
 it('never accepts a non-improving move and counts complete paired evaluations against the budget',()=>{
  for(const maxEvaluations of [2,3,4,9]){
   const r=refineJointRoster(fixture(),all,{maxEvaluations})
   expect(r.evaluations).toBeLessThanOrEqual(maxEvaluations)
   expect(r.evaluations%2).toBe(0)
   expect(r.after!.rankingScore).toBeGreaterThanOrEqual(r.before!.rankingScore!)
   expect(r.changes.every(c=>c.afterRanking>c.beforeRanking)).toBe(true)
  }
 })
})
