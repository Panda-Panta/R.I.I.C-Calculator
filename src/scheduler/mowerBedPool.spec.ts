import {it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {createBackupPlanController} from './backupPlans'
import {compiledScheduleToRuntimeConfig,createRosterRuntime,settleRoster,type RuntimeConfig} from './rosterRuntime'
const rates={workRate:()=>0,recoveryRate:()=>4}
it('keeps the default recovery bed pool and VIP identity when a backup adds an earlier physical Free slot',()=>{
 const w=createDefaultWorkspace();w.mainPlan.facilities.dormitory_4.slots=[{occupant:{kind:'operator',operatorId:'杜林'},groupId:null,replacements:[]},{occupant:{kind:'operator',operatorId:'闪灵'},groupId:null,replacements:[]},{occupant:{kind:'operator',operatorId:'爱丽丝'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]}];
 w.compatibility.backupPlans=[{trigger:'True',plan:{dormitory_4:{plans:[{agent:'Current'},{agent:'Current'},{agent:'Free'},{agent:'Free'},{agent:'Free'}]}}}];const base=compileRosterSchedule(w,{idleOperators:['芬'],freeRoom:false}),s=createRosterRuntime(compiledScheduleToRuntimeConfig(base));createBackupPlanController(base,s).evaluate('END');
 expect(s.config.beds.find(b=>b.id==='dormitory_4_2')).toMatchObject({managedRecovery:false,vip:false});expect(s.config.beds.find(b=>b.id==='dormitory_4_3')).toMatchObject({vip:true});
 expect(s.config.beds.filter(b=>b.managedRecovery!==false).map(b=>b.id)).toEqual(compiledScheduleToRuntimeConfig(base).beds.map(b=>b.id));s.bedOccupants.dormitory_4_2='char_123_fang';settleRoster(s,rates);expect(s.bedOccupants.dormitory_4_2).toBeTruthy()
})
it('does not promote a later bed when a backup replaces the original VIP Free slot',()=>{
 const w=createDefaultWorkspace();w.mainPlan.facilities.dormitory_4.slots=[{occupant:{kind:'operator',operatorId:'杜林'},groupId:null,replacements:[]},{occupant:{kind:'operator',operatorId:'闪灵'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]},{occupant:{kind:'free'},groupId:null,replacements:[]}];
 w.compatibility.backupPlans=[{trigger:'True',plan:{dormitory_4:{plans:[{agent:'Current'},{agent:'Current'},{agent:'爱丽丝'},{agent:'Free'},{agent:'Free'}]}}}];const base=compileRosterSchedule(w),s=createRosterRuntime(compiledScheduleToRuntimeConfig(base));createBackupPlanController(base,s).evaluate('END');expect(s.config.beds.filter(b=>b.roomId==='dormitory_4').every(b=>!b.vip)).toBe(true)
})

it('only recalls groups that can release a managed recovery bed during exhaustion',()=>{
 const c:RuntimeConfig={positions:[{id:'h',roomId:'r1',primary:'H',candidates:['R1']},{id:'j',roomId:'r2',primary:'J',candidates:['R2']},{id:'e',roomId:'r3',primary:'E',candidates:['R3'],exhaustRequired:true}],beds:[{id:'extra',roomId:'dormitory_1',vip:false,managedRecovery:false},{id:'managed',roomId:'dormitory_2',vip:true}],initialMorale:{H:20,J:18,E:0},mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[],freeRoom:false}};
 const s=createRosterRuntime(c);s.occupants={h:'R1',j:'R2',e:'E'};s.bedOccupants={extra:'H',managed:'J'};settleRoster(s,{workRate:()=>1,recoveryRate:()=>4});
 expect(s.events.filter(e=>e.type==='shift-on'||e.type==='exhaust-support').flatMap(e=>e.operators)).toEqual(['J']);expect(s.occupants.h).toBe('R1');expect(s.bedOccupants.extra).toBe('H');expect(s.occupants.e).toBe('R3');expect(s.bedOccupants.managed).toBe('E')
})
