import { simulateMoraleTimeline } from '../simulator/moraleTimeline'
import { describe, it, expect } from 'vitest'
import { createDefaultWorkspace } from '../workbench/defaults'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig } from './scheduleAdapter'
import { createRosterRuntime, settleRoster, nextCandidate, moraleDerivative, nextRosterEventHours, nextRosterActionHours, advanceRoster, type RuntimeConfig } from './rosterRuntime'
import { resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
function projected(name: string, conf: Record<string, unknown> = {}) {
  const w = createDefaultWorkspace()
  Object.assign(w.mainPlan.conf, conf)
  w.mainPlan.facilities.room_1_1.slots[0] = { occupant: {kind:'operator',operatorId:name},groupId:null,replacements:['芬'] }
  return compiledScheduleToRuntimeConfig(compileRosterSchedule(w))
}
describe('Mower source contract: policy projection and ideal operations', () => {
 it('maps workaholic and low bed priority independently of reorder list', () => {
  const c=projected('令',{workaholic:['令'],resting_priority:['令'],ope_resting_priority:['令']})
  expect(c.positions.find(p=>p.primary===id('令'))).toMatchObject({permanent:true,restingPriority:'low'})
 })
 it('uses Ling mode skill limits and separate ordinary shift-off threshold',()=>{
  const c=projected('令',{ling_xi:1}); expect(c.positions.find(p=>p.primary===id('令'))).toMatchObject({upperLimit:12,lowerLimit:0,shiftOffThreshold:7})
  const d=projected('夕',{ling_xi:1}); expect(d.positions.find(p=>p.primary===id('夕'))).toMatchObject({upperLimit:24,lowerLimit:12,shiftOffThreshold:19})
 })
 it('keeps exhaustion at the skill lower bound, not absolute zero',()=>{
  const c=projected('夕',{ling_xi:1,exhaust_require:['夕']});expect(c.positions.find(p=>p.primary===id('夕'))).toMatchObject({shiftOffThreshold:12})
 })
 it('ordinary non-special primary shifts at floor(24 * .65)=15',()=>{
  const c=projected('能天使');expect(c.positions.find(p=>p.primary===id('能天使'))).toMatchObject({shiftOffThreshold:15})
 })
 const cfg=():RuntimeConfig=>({positions:[{id:'p',roomId:'trade',primary:'A',candidates:['B'],shiftOffThreshold:15}],beds:[{id:'b',roomId:'dorm',vip:true}],initialMorale:{A:15,B:0},mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]}})
 it('Mower ordinary greedy candidate has no morale floor and may come from a dorm',()=>{
  const s=createRosterRuntime(cfg());s.bedOccupants.b='B';expect(nextCandidate(s.config.positions[0]!,s)).toBe('B');settleRoster(s)
  expect(s.occupants.p).toBe('B');expect(s.bedOccupants.b).toBe('A')
 })
 it('a replacement outside a bed never receives invented recovery',()=>{
  const s=createRosterRuntime(cfg());settleRoster(s);expect(s.morale.B).toBe(0)
 })
 it('group returns together at earliest high-priority member unless named full-rest member is pending',()=>{
  const c=cfg(); c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],group:'g',shiftOffThreshold:15},{id:'q',roomId:'t',primary:'C',candidates:['D'],group:'g',shiftOffThreshold:15}];c.beds.push({id:'c',roomId:'d',vip:true});c.initialMorale={A:15,C:16,B:24,D:24}
  const s=createRosterRuntime(c);settleRoster(s);s.morale.A=24;s.morale.C=20;settleRoster(s);expect(s.occupants).toEqual({p:'A',q:'C'})
  c.positions[1]!.restToFull=true;const t=createRosterRuntime(c);settleRoster(t);t.morale.A=24;t.morale.C=20;settleRoster(t);expect(t.occupants).toEqual({p:'B',q:'D'});t.morale.C=24;settleRoster(t);expect(t.occupants).toEqual({p:'A',q:'C'})
 })
 it('dorm candidates retain their actual morale and unassigned substitutes have zero recovery',()=>{
  const s=createRosterRuntime(cfg());s.morale.B=4;s.bedOccupants.b='B';settleRoster(s);expect(s.morale.B).toBe(4)
  s.morale.A=24;settleRoster(s);delete s.bedOccupants.b;expect(moraleDerivative(s,'B',{workRate:()=>1,recoveryRate:()=>2})).toBe(0)
 })
 it('compiler resting threshold is explicitly configurable',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'能天使'},groupId:null,replacements:['芬']}
  const c=compiledScheduleToRuntimeConfig(compileRosterSchedule(w,{restingThreshold:.5}));expect(c.positions.find(p=>p.primary===id('能天使'))?.shiftOffThreshold).toBe(12)
 })

 it('event integration schedules earliest group recovery, with layout-dependent slow-first exception',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],group:'g',shiftOffThreshold:15},{id:'q',roomId:'t',primary:'C',candidates:['D'],group:'g',shiftOffThreshold:15}];c.beds.push({id:'c',roomId:'d',vip:true});c.initialMorale={A:15,C:16,B:24,D:24}
  const sim=simulateMoraleTimeline(c,8.1,{workRate:()=>1,recoveryRate:()=>1});expect(sim.finalState.events.find(e=>e.type==='shift-on')?.time).toBe(8)
  const slow=simulateMoraleTimeline(c,9.1,{workRate:()=>1,recoveryRate:id=>id==='C'?2:1});expect(slow.finalState.events.find(e=>e.type==='shift-on')?.time).toBe(9)
 })
 it('explicit idle roster fills remaining beds without inventing owned operators',()=>{
  const c=cfg();c.initialMorale={A:24,B:24,I:12};c.idleOperators=['I'];const s=createRosterRuntime(c);settleRoster(s);expect(s.bedOccupants.b).toBe('I');expect(s.morale.I).toBe(12)
  const t=createRosterRuntime(cfg());expect(t.diagnostics.some(d=>d.code==='idle-roster-unspecified')).toBe(true)
 })
 it('Fiammetta charging a resting group member immediately returns the whole group',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],group:'g',restToFull:true,shiftOffThreshold:15},{id:'q',roomId:'t',primary:'C',candidates:['D'],group:'g',restToFull:true,shiftOffThreshold:15},{id:'f',roomId:'d',primary:'F',candidates:[],dormitory:true}];c.beds.push({id:'c',roomId:'d',vip:true});c.initialMorale={A:15,C:16,B:24,D:24,F:20};c.fiammetta={operatorId:'F',orderedTargets:['A']}
  const s=createRosterRuntime(c);settleRoster(s);s.morale.F=24;settleRoster(s);expect(s.occupants.p).toBe('A');expect(s.occupants.q).toBe('C');expect(s.morale.C).toBe(16)
 })

 it('exhaustion can preempt an ordinary resting group to obtain a bed',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],exhaustRequired:true,shiftOffThreshold:0},{id:'q',roomId:'t2',primary:'C',candidates:['D'],shiftOffThreshold:15}];c.initialMorale={A:1,B:24,C:15,D:24};const s=createRosterRuntime(c);settleRoster(s);expect(s.bedOccupants.b).toBe('C');s.morale.C=24;s.morale.A=0;settleRoster(s);expect(s.occupants.q).toBe('C');expect(s.occupants.p).toBe('B');expect(s.bedOccupants.b).toBe('A')
 })
 it('exhaustion does not evict an exhaustion-plus-full-rest protected group',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],exhaustRequired:true,shiftOffThreshold:0},{id:'q',roomId:'t2',primary:'C',candidates:['D'],exhaustRequired:true,restToFull:true,shiftOffThreshold:0}];c.initialMorale={A:1,B:24,C:0,D:24};const s=createRosterRuntime(c);settleRoster(s);s.morale.A=0;settleRoster(s);expect(s.occupants.p).toBe('A');expect(s.bedOccupants.b).toBe('C')
 })

 it('Fiammetta disabled fool fallback ignores the group-lowest filter',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],group:'g',permanent:true},{id:'q',roomId:'t',primary:'C',candidates:[],group:'g'},{id:'f',roomId:'d',primary:'F',candidates:[],dormitory:true}];c.initialMorale={A:23,C:10,F:24};c.fiammetta={operatorId:'F',orderedTargets:['A'],fool:false};const s=createRosterRuntime(c);settleRoster(s);expect(s.morale.A).toBe(24);expect(s.morale.F).toBe(23)
 })
 it('Fiammetta no-target retries after 1.2h instead of every morale crossing',()=>{
  const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],permanent:true},{id:'f',roomId:'d',primary:'F',candidates:[],dormitory:true}];c.initialMorale={A:22,F:24};c.fiammetta={operatorId:'F',orderedTargets:['A'],fool:true};const s=createRosterRuntime(c);settleRoster(s);s.time=.6;s.morale.A=21;settleRoster(s);expect(s.morale.A).toBe(21);s.time=1.2;settleRoster(s);expect(s.morale.A).toBe(24)
 })

 it('physical boundaries and numerical substeps do not restart planning or create Zeno shifts',()=>{
  function run(step:number){
   const c=cfg();c.positions=[{id:'p',roomId:'t',primary:'A',candidates:['B'],group:'g',shiftOffThreshold:15},{id:'q',roomId:'t',primary:'C',candidates:['D'],group:'g',shiftOffThreshold:15},{id:'f',roomId:'d',primary:'F',candidates:[],dormitory:true}];c.beds.push({id:'c',roomId:'d',vip:false});c.initialMorale={A:15,C:0,B:24,D:24,F:0};c.fiammetta={operatorId:'F',orderedTargets:['A']}
   const s=createRosterRuntime(c),rates={workRate:()=>1,recoveryRate:(id:string)=>id==='A'?10:1};settleRoster(s,rates)
   for(let i=0;s.time<4-1e-8&&i<2000;i++){
    const action=nextRosterActionHours(s,rates),dt=Math.min(step,4-s.time,nextRosterEventHours(s,rates));advanceRoster(s,dt,rates);if(Math.abs(dt-action)<1e-8)settleRoster(s,rates)
   }
   return s
  }
  const a=run(.25),b=run(1);expect(a.time).toBe(4);expect(b.time).toBe(4);expect(a.events.length).toBeLessThan(10);expect(a.events.map(e=>[e.type,e.time])).toEqual(b.events.map(e=>[e.type,e.time]));expect(a.morale.C).toBeCloseTo(b.morale.C!,8)
 })
 it('all ordinary candidate and explicit idle initial morale inherits the global assumption',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'砾'},groupId:null,replacements:['芬','香草']};const c=compiledScheduleToRuntimeConfig(compileRosterSchedule(w,{initialMorale:12,idleOperators:['斑点'],operatorMorale:{[id('芬')]:3}}));const s=createRosterRuntime(c);expect(s.morale[id('砾')]).toBe(12);expect(s.morale[id('芬')]).toBe(3);expect(s.morale[id('香草')]).toBe(12);expect(s.morale[id('斑点')]).toBe(12)
 })

 it('a physical recovery-rate change applies the native lead time and permits a positive-mood early full-rest return',()=>{
  const c=cfg();c.mowerPolicy!.taskBuffers=true;c.positions[0]!.restToFull=true;const s=createRosterRuntime(c);const slow={workRate:()=>1,recoveryRate:()=>1};settleRoster(s,slow);advanceRoster(s,1,slow);const fast={workRate:()=>1,recoveryRate:()=>100};expect(nextRosterActionHours(s,fast)).toBe(0);settleRoster(s,fast);expect(s.occupants.p).toBe('A');expect(s.morale.A).toBe(16);expect(nextRosterActionHours(s,fast)).toBeGreaterThan(0)
 })

})

// Fixed alpha handle_error keeps an already queued NOT_SPECIFIC task.
describe('Mower queued fallback planning clock',()=>{
  const idleConfig:RuntimeConfig={positions:[],beds:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false}}
  const idleRates={workRate:()=>0,recoveryRate:()=>0}
  it('retains an earlier queued scan after another task completes',()=>{
    const s=createRosterRuntime(idleConfig);settleRoster(s,idleRates);expect(s.nextPlanningTime).toBe(2.5);s.time=2;settleRoster(s,idleRates);expect(s.nextPlanningTime).toBe(2.5)
  })
  it('schedules a fresh fallback only after consuming the due scan',()=>{
    const s=createRosterRuntime(idleConfig);s.nextPlanningTime=2.5;s.time=2.5;settleRoster(s,idleRates);expect(s.nextPlanningTime).toBe(5)
  })
})
