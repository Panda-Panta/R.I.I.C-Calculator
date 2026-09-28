import {it,expect} from 'vitest'
import {advanceRoster,createRosterRuntime,settleRoster,type RuntimeConfig} from './rosterRuntime'
const rates={workRate:(id:string)=>id==='P'?0:1,recoveryRate:()=>4}
const cfg=(mood=24):RuntimeConfig=>({positions:[{id:'a',roomId:'work',primary:'A',candidates:['X'],group:'g',shiftOffThreshold:15},{id:'p',roomId:'power',primary:'P',candidates:['Y'],group:'g',permanent:true}],beds:[{id:'one',roomId:'dormitory_1',vip:true}],initialMorale:{A:15,P:mood},mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false}})
it.each([24,8])('moves workaholic out with its group without reserving a recovery bed, mood %s',mood=>{
 const s=createRosterRuntime(cfg(mood));settleRoster(s,rates);expect(s.occupants).toEqual({a:'X',p:'Y'});expect(Object.values(s.bedOccupants)).toEqual(['A']);expect(s.events.find(e=>e.type==='shift-off')?.operators).toContain('P');expect(s.pendingRest??[]).not.toContain('P');
 advanceRoster(s,2.25,rates);settleRoster(s,rates);expect(s.occupants).toEqual({a:'A',p:'P'});expect(Object.values(s.bedOccupants)).not.toContain('P');expect(s.morale.P).toBe(mood)
})
it('retains the whole group when its workaholic has no available replacement',()=>{
 const c=cfg();c.positions[1]!.candidates=[];const s=createRosterRuntime(c);settleRoster(s,rates);expect(s.occupants).toEqual({a:'A',p:'P'});expect(s.events.some(e=>e.type==='shift-off')).toBe(false);expect(Object.values(s.bedOccupants)).not.toContain('A');expect(Object.values(s.bedOccupants)).not.toContain('P')
})
it('does not initiate rest for a workaholic-only group',()=>{
 const c=cfg(0);c.positions.splice(0,1);const s=createRosterRuntime(c);settleRoster(s,rates);expect(s.occupants.p).toBe('P');expect(s.events.some(e=>e.type==='shift-off')).toBe(false)
})

it('sorts workaholics with ordinary group members before greedy replacement selection',()=>{
 const c=cfg(8);c.positions.reverse();c.positions[0]!.candidates=['X'];c.positions[1]!.candidates=['X','Y'];const s=createRosterRuntime(c);settleRoster(s,rates);expect(s.occupants).toEqual({p:'X',a:'Y'});expect(Object.values(s.bedOccupants)).toEqual(['A'])
})
