import {describe,it,expect} from 'vitest'
import {createRosterRuntime,settleRoster,nextRosterActionHours,advanceRoster,type RuntimeConfig} from './rosterRuntime'
const rates={workRate:()=>1,recoveryRate:()=>4}
const config=(extraBed=false):RuntimeConfig=>({positions:[{id:'a',roomId:'room_2_1',primary:'A',candidates:['X'],exhaustRequired:true,shiftOffThreshold:0},{id:'b',roomId:'room_3_3',primary:'B',candidates:['X'],restToFull:true}],beds:[{id:'bBed',roomId:'dormitory_1',vip:true},...(extraBed?[{id:'aBed',roomId:'dormitory_2',vip:true}]:[])],mowerPolicy:{restingThreshold:.65,taskBuffers:true,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{A:.6,B:4,X:20,Y:24}})
describe('Mower default exhaust support before red face',()=>{
 it('recalls an ordinary full-rest owner to release both the occupied cover and bed',()=>{
  const s=createRosterRuntime(config());s.occupants={a:'A',b:'X'};s.bedOccupants={bBed:'B'};settleRoster(s,rates)
  expect(s.occupants).toEqual({a:'X',b:'B'});expect(s.bedOccupants).toEqual({bBed:'A'});expect(s.morale.A).toBeGreaterThan(0)
 })
 it('uses an alternate cover before recalling the owner group',()=>{
  const c=config(true);c.positions[1]!.candidates.push('Y');const s=createRosterRuntime(c);s.occupants={a:'A',b:'X'};s.bedOccupants={bBed:'B'};settleRoster(s,rates)
  expect(s.occupants).toEqual({a:'X',b:'Y'});expect(s.bedOccupants).toEqual({bBed:'B',aBed:'A'})
 })
 it('keeps exhaust-and-full-rest owners protected when no alternate cover exists',()=>{
  const c=config();c.positions[1]!.exhaustRequired=true;const s=createRosterRuntime(c);s.occupants={a:'A',b:'X'};s.bedOccupants={bBed:'B'};settleRoster(s,rates)
  expect(s.occupants).toEqual({a:'A',b:'X'});expect(s.bedOccupants).toEqual({bBed:'B'})
 })
 it('commits no partial support when another required group member has no replacement',()=>{
  const c=config(true);c.positions[0]!.group='g';c.positions.push({id:'c',roomId:'room_2_1',primary:'C',candidates:[],group:'g'});c.initialMorale!.C=10;c.positions[1]!.candidates.push('Y');const s=createRosterRuntime(c);s.occupants={a:'A',b:'X',c:'C'};s.bedOccupants={bBed:'B'};settleRoster(s,rates)
  expect(s.occupants).toEqual({a:'A',b:'X',c:'C'});expect(s.bedOccupants.bBed).toBe('B');expect(Object.values(s.bedOccupants)).not.toContain('A');expect(Object.values(s.bedOccupants)).not.toContain('C')
 })
 it.each([[false,.5],[true,22/60]] as const)('releases an ordinary resting bed on the alpha rescue clock with buffers=%s', (buffers,deadline)=>{
  const c:RuntimeConfig={positions:[{id:'a',roomId:'room_2_1',primary:'A',candidates:['X'],shiftOffThreshold:0},{id:'h',roomId:'room_3_3',primary:'H',candidates:['Y'],shiftOffThreshold:0}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],mowerPolicy:{restingThreshold:.65,taskBuffers:buffers,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{A:0,H:0,X:24,Y:24}}
  const s=createRosterRuntime(c);s.occupants={a:'A',h:'Y'};s.bedOccupants={bed:'H'};const r={workRate:()=>1,recoveryRate:()=>2};settleRoster(s,r)
  expect(nextRosterActionHours(s,r)).toBeCloseTo(deadline,8);advanceRoster(s,deadline,r);settleRoster(s,r)
  expect(s.occupants.h).toBe('H');expect(s.morale.H).toBeCloseTo(deadline*2);expect(s.occupants.a).toBe('X');expect(s.bedOccupants.bed).toBe('A')
 })

 it('preserves EXHAUST_OFF priority after recalling an owner with zero mood',()=>{
  const c=config();c.positions[0]!.restToFull=true;c.positions[1]!.group='auto';c.initialMorale!.B=0;const s=createRosterRuntime(c);s.occupants={a:'A',b:'X'};s.bedOccupants={bBed:'B'};settleRoster(s,rates)
  expect(s.occupants).toEqual({a:'X',b:'B'});expect(s.bedOccupants.bBed).toBe('A');expect(s.events.filter(e=>e.type==='exhaust-support')).toHaveLength(1)
 })
 it.each([[false,12-8/60],[true,12]] as const)('uses the native full-rest lead rule with exhaust=%s',(exhaust,deadline)=>{
  const c:RuntimeConfig={positions:[{id:'h',roomId:'room_2_1',primary:'H',candidates:['Y'],restToFull:true,exhaustRequired:exhaust,shiftOffThreshold:0}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],mowerPolicy:{restingThreshold:.65,taskBuffers:true,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{H:0,Y:24}}
  const s=createRosterRuntime(c);s.occupants={h:'Y'};s.bedOccupants={bed:'H'};const r={workRate:()=>1,recoveryRate:()=>2};settleRoster(s,r);expect(s.returnDeadlines?.['slot:h']).toBeCloseTo(deadline,8)
 })
})
