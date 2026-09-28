import {it,expect} from 'vitest'
import {advanceRoster,createRosterRuntime,settleRoster,type RuntimeConfig} from './rosterRuntime'
const rates={workRate:()=>1,recoveryRate:()=>4}
const policy={restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false}
const cfg=():RuntimeConfig=>({positions:[{id:'a',roomId:'work',primary:'A',candidates:['X'],shiftOffThreshold:15}],beds:[{id:'one',roomId:'dormitory_1',vip:true},{id:'two',roomId:'dormitory_2',vip:true}],initialMorale:{A:15,R:10},idleOperators:['R'],mowerPolicy:policy})
it('uses the first takable bed rather than preferring an empty bed later in the pool',()=>{
 const s=createRosterRuntime(cfg());s.bedOccupants.one='R';settleRoster(s,rates)
 expect(s.events.find(e=>e.type==='shift-off')?.beds).toEqual(['one'])
})
it('does not evict a recovering replacement for a low-priority primary',()=>{
 const c=cfg();c.positions[0]!.restingPriority='low';c.beds.splice(1);const s=createRosterRuntime(c);s.bedOccupants.one='R';settleRoster(s,rates)
 expect(s.occupants.a).toBe('A');expect(s.bedOccupants.one).toBe('R')
})
const fullGroup=():RuntimeConfig=>({positions:[{id:'h',roomId:'work',primary:'H',candidates:['R1'],group:'g',shiftOffThreshold:15},{id:'j',roomId:'work',primary:'J',candidates:['R2'],group:'g',shiftOffThreshold:15,restToFull:true},{id:'a',roomId:'other',primary:'A',candidates:['X'],shiftOffThreshold:15}],beds:[{id:'one',roomId:'dormitory_1',vip:true},{id:'two',roomId:'dormitory_2',vip:true}],initialMorale:{H:24,J:16,A:15},mowerPolicy:policy})
it('takes a completed main bed without recalling its unfinished group or losing its full member',()=>{
 const s=createRosterRuntime(fullGroup());s.occupants={h:'R1',j:'R2',a:'A'};s.bedOccupants={one:'H',two:'J'};s.recoveryCompletedAt={H:-.1};settleRoster(s,rates)
 expect(s.occupants).toEqual({h:'R1',j:'R2',a:'X'});expect(s.completedRest).toContain('H');expect(s.morale.H).toBe(24);expect(Object.values(s.bedOccupants)).toContain('A');expect(Object.values(s.bedOccupants)).toContain('J')
 advanceRoster(s,2,rates);settleRoster(s,rates);expect(s.occupants.h).toBe('H');expect(s.occupants.j).toBe('J');expect(s.completedRest??[]).not.toContain('H')
})
it('does not take a main bed exactly at completion, and makes it takable after that instant',()=>{
 const s=createRosterRuntime(fullGroup());s.occupants={h:'R1',j:'R2',a:'A'};s.bedOccupants={one:'H',two:'J'};s.recoveryCompletedAt={H:0};settleRoster(s,rates);expect(s.occupants.a).toBe('A')
 advanceRoster(s,.25,rates);settleRoster(s,rates);expect(s.occupants.a).toBe('X');expect(s.completedRest).toContain('H')
})
it('records the exact physical recovery completion time independently of the integration step',()=>{
 const s=createRosterRuntime(fullGroup());s.occupants={h:'R1',j:'R2',a:'A'};s.bedOccupants={one:'H',two:'J'};s.morale.H=23;advanceRoster(s,.5,rates)
 expect(s.recoveryCompletedAt?.H).toBeCloseTo(.25)
})

it('restarts the completed timer when a backup changes the recovery upper limit',()=>{
 const c=fullGroup();c.positions[0]!.upperLimit=12;const s=createRosterRuntime(c);s.occupants={h:'R1',j:'R2',a:'A'};s.bedOccupants={one:'H',two:'J'};s.recoveryCompletedAt={H:0};settleRoster(s,rates);advanceRoster(s,1,rates);
 s.config.positions[0]!.upperLimit=24;settleRoster(s,rates);expect(s.occupants.a).toBe('A');expect(s.recoveryCompletedAt?.H).toBe(1);
 advanceRoster(s,.25,rates);settleRoster(s,rates);expect(s.occupants.a).toBe('X')
})

it('recalls the whole group when a task leaves an unfinished member without any valid bed',()=>{
 const c=fullGroup();c.positions.splice(2);c.positions[1]!.restToFull=false;c.positions[1]!.restingPriority='low';c.initialMorale={H:1,J:1,R:10};c.idleOperators=['R'];const s=createRosterRuntime(c);s.occupants={h:'R1',j:'R2'};s.bedOccupants={one:'H',two:'R'};s.pendingRest=['J'];settleRoster(s,rates);
 expect(s.occupants).toEqual({h:'H',j:'J'});expect(Object.values(s.returnDeadlines??{}).every(Number.isFinite)).toBe(true);expect(s.pendingRest??[]).not.toContain('J')
})

it('does not count a completed main bed against the ideal resting limit',()=>{
 const c=fullGroup();c.positions.push({id:'k',roomId:'third',primary:'K',candidates:['R3'],restToFull:true},{id:'l',roomId:'fourth',primary:'L',candidates:['R4'],restToFull:true});c.beds.push({id:'three',roomId:'dormitory_3',vip:true},{id:'four',roomId:'dormitory_4',vip:true});Object.assign(c.initialMorale!,{K:16,L:16});const s=createRosterRuntime(c);s.occupants={h:'R1',j:'R2',a:'A',k:'R3',l:'R4'};s.bedOccupants={one:'H',two:'J',three:'K',four:'L'};s.recoveryCompletedAt={H:-.1};settleRoster(s,rates);
 expect(s.occupants.a).toBe('X');expect(s.bedOccupants.one).toBe('A');expect(s.completedRest).toContain('H');expect(s.occupants.h).toBe('R1')
})

it('assigns low-priority group beds after all replacements are chosen and before high-priority beds',()=>{
 const c:RuntimeConfig={positions:[{id:'f',roomId:'old',primary:'F',candidates:['R1'],group:'old'},{id:'g',roomId:'old',primary:'G',candidates:['R2'],group:'old',restToFull:true},{id:'h',roomId:'new',primary:'H',candidates:['X'],group:'new',shiftOffThreshold:15},{id:'l',roomId:'new',primary:'L',candidates:['Y'],group:'new',shiftOffThreshold:15,restingPriority:'low'}],beds:[{id:'one',roomId:'dormitory_1',vip:true},{id:'two',roomId:'dormitory_2',vip:true},{id:'three',roomId:'dormitory_1',vip:false}],initialMorale:{F:24,G:16,H:15,L:15,R:10},idleOperators:['R'],mowerPolicy:policy};
 const s=createRosterRuntime(c);s.occupants={f:'R1',g:'R2',h:'H',l:'L'};s.bedOccupants={one:'F',two:'G',three:'R'};s.recoveryCompletedAt={F:-.1};settleRoster(s,rates);expect(s.occupants.h).toBe('X');expect(s.occupants.l).toBe('Y');expect(Object.values(s.bedOccupants)).toContain('H');expect(Object.values(s.bedOccupants)).toContain('L');expect(s.completedRest).toContain('F')
})

it.each([1,2])('does not treat a selected recovering replacement bed as empty before group admission, %s beds',count=>{
 const c=cfg();c.positions[0]!.candidates=['R'];c.positions[0]!.restingPriority='low';c.beds=c.beds.slice(0,count);const s=createRosterRuntime(c);s.bedOccupants.one='R';settleRoster(s,rates);
 if(count===1){expect(s.occupants.a).toBe('A');expect(s.bedOccupants.one).toBe('R')}else{expect(s.occupants.a).toBe('R');expect(s.events.find(e=>e.type==='shift-off')?.beds).toEqual(['two']);expect(Object.values(s.bedOccupants)).not.toContain('R')}
})

it('preserves atomic low-first admission when BEFORE_DORM re-enters the planner',()=>{
 const c:RuntimeConfig={positions:[{id:'f',roomId:'old',primary:'F',candidates:['R1'],group:'old'},{id:'g',roomId:'old',primary:'G',candidates:['R2'],group:'old',restToFull:true},{id:'h',roomId:'new',primary:'H',candidates:['X'],group:'new',shiftOffThreshold:15},{id:'l',roomId:'new',primary:'L',candidates:['Y'],group:'new',shiftOffThreshold:15,restingPriority:'low'}],beds:[{id:'one',roomId:'dormitory_1',vip:true},{id:'two',roomId:'dormitory_2',vip:true},{id:'three',roomId:'dormitory_1',vip:false}],initialMorale:{F:24,G:16,H:15,L:15,R:10},idleOperators:['R'],mowerPolicy:policy};
 const s=createRosterRuntime(c);s.occupants={f:'R1',g:'R2',h:'H',l:'L'};s.bedOccupants={one:'F',two:'G',three:'R'};s.recoveryCompletedAt={F:-.1};let reentered=false;settleRoster(s,rates,0,phase=>{if(phase==='BEFORE_DORM'&&!reentered){reentered=true;return true}return false});expect(reentered).toBe(true);expect(s.occupants.h).toBe('X');expect(s.occupants.l).toBe('Y');expect(s.pendingRest??[]).toEqual([]);expect(s.events.some(e=>e.reason==='position-correction'&&e.operators.includes('H'))).toBe(false);expect(s.events.find(e=>e.type==='rest-bed-takeover'&&e.operators[0]==='F')?.operators[1]).toBe('L')
})
