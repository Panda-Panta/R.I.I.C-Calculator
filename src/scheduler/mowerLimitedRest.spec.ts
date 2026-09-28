import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {advanceRoster,createRosterRuntime,nextRosterActionHours,settleRoster,type RuntimeConfig} from './rosterRuntime'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
const config=():RuntimeConfig=>({positions:[{id:'a',roomId:'work',primary:'A',candidates:['X'],group:'g',upperLimit:12,shiftOffThreshold:7,restMoodLimit:true},{id:'b',roomId:'work',primary:'B',candidates:['Y'],group:'g',upperLimit:24,shiftOffThreshold:15,restToFull:true}],beds:[{id:'one',roomId:'dormitory_1',vip:true},{id:'two',roomId:'dormitory_2',vip:true}],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{A:11.5,B:16}})
const rates={workRate:()=>1,recoveryRate:()=>4}
describe('Mower default Ling/Xi rest mood limit',()=>{
 it('maps the low half only, without extending the rule to Totter',()=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.central.slots[0]={occupant:{kind:'operator',operatorId:'令'},groupId:null,replacements:['重岳']};w.mainPlan.conf.ling_xi=1;
  const c=compiledScheduleToRuntimeConfig(compileRosterSchedule(w));expect(c.positions.find(p=>p.primary===id('令'))).toMatchObject({upperLimit:12,restMoodLimit:true});
  w.mainPlan.conf.ling_xi=2;expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(w)).positions.find(p=>p.primary===id('令'))).toMatchObject({lowerLimit:12});expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(w)).positions.find(p=>p.primary===id('令'))?.restMoodLimit).not.toBe(true)
  w.mainPlan.conf.ling_xi=3;expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(w)).positions.find(p=>p.primary===id('令'))?.restMoodLimit).not.toBe(true)
 })
 it('schedules release exactly at the policy upper limit while the group is still recovering',()=>{
  const s=createRosterRuntime(config());s.occupants={a:'X',b:'Y'};s.bedOccupants={one:'A',two:'B'};
  expect(nextRosterActionHours(s,rates)).toBeCloseTo(.125);advanceRoster(s,.125,rates);settleRoster(s,rates);
  expect(Object.values(s.bedOccupants)).not.toContain('A');expect(s.morale.A).toBe(12);expect(s.completedRest).toContain('A');expect(s.occupants).toEqual({a:'X',b:'Y'});
  advanceRoster(s,.5,rates);expect(s.morale.A).toBe(12);settleRoster(s,rates);expect(s.occupants).toEqual({a:'X',b:'Y'})
 })
 it('returns the completed member with its recovering peers and clears its parked record',()=>{
  const s=createRosterRuntime(config());s.occupants={a:'X',b:'Y'};s.bedOccupants={one:'A',two:'B'};s.morale.A=12;settleRoster(s,rates);
  advanceRoster(s,2,rates);settleRoster(s,rates);expect(s.occupants).toEqual({a:'A',b:'B'});expect(s.completedRest??[]).not.toContain('A');expect(s.morale.A).toBe(12)
 })
 it('does not reserve a bed for a limited member already at its cap when the group leaves',()=>{
  const c=config();c.positions.push({id:'c',roomId:'work',primary:'C',candidates:['Z'],group:'g',upperLimit:24,shiftOffThreshold:15,restToFull:true});c.positions.push({id:'o',roomId:'other',primary:'O',candidates:['P'],upperLimit:24,shiftOffThreshold:15,restToFull:true});c.beds.push({id:'three',roomId:'dormitory_3',vip:true});c.initialMorale={A:12,B:15,C:15,O:0};
  const s=createRosterRuntime(c);s.occupants.o='P';s.bedOccupants.three='O';settleRoster(s,rates);
  expect(s.occupants).toEqual({a:'X',b:'Y',c:'Z',o:'P'});expect(Object.values(s.bedOccupants)).not.toContain('A');expect(s.completedRest).toContain('A');
  expect(Object.values(s.bedOccupants)).toEqual(expect.arrayContaining(['B','C']))
 })
 it('applies the rest cap to a planned replacement and does not repeatedly refill its idle bed',()=>{
  const c:RuntimeConfig={positions:[{id:'a',roomId:'work',primary:'A',candidates:['L'],permanent:true}],beds:[{id:'one',roomId:'dormitory_1',vip:true}],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false,restMoodLimits:{L:12}},initialMorale:{L:11.5}};
  const s=createRosterRuntime(c);settleRoster(s,rates);expect(s.bedOccupants.one).toBe('L');expect(nextRosterActionHours(s,rates)).toBeCloseTo(.125);
  advanceRoster(s,.125,rates);settleRoster(s,rates);expect(Object.values(s.bedOccupants)).not.toContain('L');expect(s.completedRest??[]).not.toContain('L');
  settleRoster(s,rates);expect(Object.values(s.bedOccupants)).not.toContain('L');expect(nextRosterActionHours(s,rates)).toBeGreaterThan(0)
 })
 it.each([['令',1],['夕',2]] as const)('maps the cap for replacement %s in mode %i', (name,mode)=>{
  const w=createDefaultWorkspace();w.mainPlan.facilities.central.slots[0]={occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:[name]};w.mainPlan.conf.ling_xi=mode;
  expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(w)).mowerPolicy?.restMoodLimits).toEqual({[id(name)]:12})
 })
 it('returns a parked workaholic atomically with its group when a rescue deadline recalls the group early',()=>{
  const c=config();c.positions[0]!.permanent=true;c.positions[1]!.restToFull=false;c.positions.push({id:'o',roomId:'other',primary:'O',candidates:[],shiftOffThreshold:0});c.initialMorale={A:12,B:16,O:1};
  const s=createRosterRuntime(c);s.occupants.a='X';s.occupants.b='Y';s.bedOccupants={one:'A',two:'B'};settleRoster(s,rates);
  advanceRoster(s,.5,rates);settleRoster(s,rates);expect(s.occupants.a).toBe('A');expect(s.occupants.b).toBe('B');expect(s.completedRest??[]).not.toContain('A')
 })
 it('does not apply early release to a normal full-rest group member',()=>{
  const c=config();c.positions[0]!.restMoodLimit=undefined;const s=createRosterRuntime(c);s.occupants={a:'X',b:'Y'};s.bedOccupants={one:'A',two:'B'};s.morale.A=12;settleRoster(s,rates);expect(Object.values(s.bedOccupants)).toContain('A')
 })
 it('counts a cap-completed idle primary in alpha average mood before applying the ideal rest quota',()=>{
  const c:RuntimeConfig={positions:[{id:'l',roomId:'control',primary:'L',candidates:['RL'],group:'g',upperLimit:12,restMoodLimit:true},{id:'b',roomId:'work',primary:'B',candidates:['RB'],group:'g'},...['C','D','E'].map(primary=>({id:primary,roomId:'work',primary,candidates:['R'+primary]})),{id:'a',roomId:'work',primary:'A',candidates:['X'],shiftOffThreshold:15}],beds:[...['B','C','D','E'].map((x,i)=>({id:x+'bed',roomId:'dormitory_'+(i+1),vip:true})),...['1','2','3','4','5'].map((x,i)=>({id:'spare'+x,roomId:'dormitory_'+(i%4+1),vip:false}))],mowerPolicy:{restMoodLimits:{L:12},restingThreshold:.65,rescueThreshold:.75,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{L:12,B:5,C:5,D:5,E:5,A:10}}
  const s=createRosterRuntime(c);s.occupants={l:'RL',b:'RB',C:'RC',D:'RD',E:'RE',a:'A'};s.bedOccupants={Bbed:'B',Cbed:'C',Dbed:'D',Ebed:'E'};s.completedRest=['L']
  // Alpha average_mood is (12+10)/(12+24)> .65*.75, so 4 resting mains exhaust the ideal quota.
  settleRoster(s,rates);expect(s.occupants.a).toBe('A');expect(Object.values(s.bedOccupants)).not.toContain('A')
 })

})
