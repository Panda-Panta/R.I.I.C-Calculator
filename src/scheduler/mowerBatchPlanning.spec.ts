import {describe,it,expect} from 'vitest'
import {createRosterRuntime,settleRoster,type RuntimeConfig} from './rosterRuntime'
const rates={workRate:()=>1,recoveryRate:()=>1}
describe('Mower ordinary SHIFT_OFF batch reservations',()=>{
 it('counts all planned covers including the workaholic before admitting another group',()=>{
  const c:RuntimeConfig={positions:[...['J','K','L','M'].map(primary=>({id:primary,roomId:'old',primary,candidates:['R'+primary],shiftOffThreshold:0})),...['H1','H2','H3','H4'].map(primary=>({id:primary,roomId:'auto',primary,candidates:['R'+primary],group:'auto',shiftOffThreshold:15})),{id:'W',roomId:'auto',primary:'W',candidates:['RW'],group:'auto',permanent:true},{id:'A',roomId:'next',primary:'A',candidates:['X'],shiftOffThreshold:15}],beds:[...['J','K','L','M'].map((_primary,i)=>({id:'vip'+i,roomId:'dormitory_'+(i+1),vip:true})),...Array.from({length:5},(_,i)=>({id:'normal'+i,roomId:'dormitory_'+(i%4+1),vip:false}))],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{J:10,K:10,L:10,M:10,H1:5,H2:5,H3:5,H4:5,W:24,A:10}}
  const s=createRosterRuntime(c);for(const [i,id] of ['J','K','L','M'].entries()){s.occupants[id]='R'+id;s.bedOccupants['vip'+i]=id}settleRoster(s,rates)
  expect(s.occupants.H1).toBe('RH1');expect(s.occupants.W).toBe('RW');expect(s.occupants.A).toBe('A');expect(Object.values(s.bedOccupants)).not.toContain('A')
 })
 it('keeps a selected cover original bed reserved across later low-priority groups',()=>{
  const c:RuntimeConfig={positions:[{id:'a',roomId:'first',primary:'A',candidates:['R'],shiftOffThreshold:15},{id:'l',roomId:'second',primary:'L',candidates:['Y'],shiftOffThreshold:15,restingPriority:'low'}],beds:[{id:'vip',roomId:'dormitory_1',vip:true},{id:'normal',roomId:'dormitory_1',vip:false}],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{A:5,L:10,R:10,Y:24}}
  const s=createRosterRuntime(c);s.bedOccupants.normal='R';settleRoster(s,rates)
  expect(s.occupants.a).toBe('R');expect(s.bedOccupants.vip).toBe('A');expect(s.occupants.l).toBe('L');expect(Object.values(s.bedOccupants)).not.toContain('L')
 })
})

it('uses one work, dorm and planning phase for the entire ordinary SHIFT_OFF task',()=>{
 const c:RuntimeConfig={positions:[{id:'a',roomId:'first',primary:'A',candidates:['R'],shiftOffThreshold:15},{id:'l',roomId:'second',primary:'L',candidates:['Y'],shiftOffThreshold:15,restingPriority:'low'}],beds:[{id:'vip',roomId:'dormitory_1',vip:true},{id:'normal',roomId:'dormitory_1',vip:false}],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false},initialMorale:{A:5,L:10,R:24,Y:24}}
 const s=createRosterRuntime(c),calls:any[]=[];settleRoster(s,rates,0,phase=>{calls.push({phase,occupants:{...s.occupants},beds:{...s.bedOccupants}});return false})
 expect(calls.map(x=>x.phase)).toEqual(['BEFORE_WORK','BEFORE_DORM','BEFORE_PLANNING'])
 expect(calls[0].occupants).toEqual({a:'A',l:'L'});expect(calls[1].occupants).toEqual({a:'R',l:'Y'});expect(calls[1].beds).toEqual({});expect(calls[2].beds).toEqual({vip:'A',normal:'L'})
})
