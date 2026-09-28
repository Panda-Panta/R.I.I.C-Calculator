import {simulateSchedule} from '../simulator/scheduleSimulation'
import {describe,it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {resolveOperatorCharId as id} from '../workbench/compat/mowerJson'
import {compileRosterSchedule} from './compileRosterSchedule'
import {createBackupPlanController} from './backupPlans'
import {advanceRoster,compiledScheduleToRuntimeConfig,createRosterRuntime,settleRoster,nextRosterActionHours,type RuntimeConfig,type RuntimeState} from './rosterRuntime'

import {getMowerSourceRuntime} from './mowerSourceRuntime'
const rates={workRate:()=>1,recoveryRate:()=>4}
function nativeDorm(ws:ReturnType<typeof createDefaultWorkspace>){
 ws.mainPlan.facilities.dormitory_1.slots=['安赛尔','安德切尔'].map(operatorId=>({occupant:{kind:'operator' as const,operatorId},groupId:null,replacements:[]}))
 for(let i=0;i<3;i++)ws.mainPlan.facilities.dormitory_1.slots.push({occupant:{kind:'free'},groupId:null,replacements:[]})
}
function seedObservedState(s:RuntimeState){
 const source=getMowerSourceRuntime(s),physical={...s.occupants,...s.bedOccupants}
 for(const op of Object.values(source.data.operators)){
  const entry=Object.entries(physical).find(([,name])=>name===op.name)
  op.mood=s.morale[op.name]??24;op.timeStampMicros=0
  if(entry){op.currentRoom=entry[0].slice(0,entry[0].lastIndexOf('_'));op.currentIndex=Number(entry[0].slice(entry[0].lastIndexOf('_')+1))}
 }
 source.initial=false
}
function driveUntil(s:RuntimeState,controller:ReturnType<typeof createBackupPlanController>,predicate:()=>boolean){
 for(let i=0;i<1000;i++){
  settleRoster(s,rates,0,phase=>controller.evaluate(phase))
  if(predicate())return
  const next=nextRosterActionHours(s,rates)
  if(!Number.isFinite(next)||s.time+next>16)break
  expect(next).toBeGreaterThan(0)
  advanceRoster(s,next,rates)
 }
 throw new Error('Native fixture did not reach the expected physical arrangement '+JSON.stringify({time:s.time,occupants:s.occupants,beds:s.bedOccupants,events:s.events,queue:s.mowerSource?.queue.tasks.slice(0,3),error:s.mowerSource?.error,operators:Object.values(s.mowerSource!.data.operators).filter(op=>[id('阿米娅'),id('芬')].includes(op.name))}))
}
function enqueueBackup(s:RuntimeState){getMowerSourceRuntime(s).queue.tasks.push(...(s.mowerBackupGenerated??[]))}
const config=():RuntimeConfig=>({positions:[{id:'work',roomId:'room',primary:'A',candidates:['B'],shiftOffThreshold:15}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],initialMorale:{A:24,B:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]}})

describe('Mower alpha default dorm and position reconciliation',()=>{
 it('fills a Free bed with a full-morale ordinary replacement',()=>{
  const s=createRosterRuntime(config());settleRoster(s,rates)
  expect(s.bedOccupants).toEqual({bed:'B'})
 })
 it('keeps a recovered resident when free_room is disabled even when blacklisted from new admissions',()=>{
  const c=config();c.freeBlacklist=['B'];const s=createRosterRuntime(c);s.bedOccupants.bed='B';settleRoster(s,rates)
  expect(s.bedOccupants.bed).toBe('B')
 })
 it('releases full replacements and leaves full-only Free beds empty when free_room is enabled',()=>{
  const c=config();c.mowerPolicy!.freeRoom=true;const s=createRosterRuntime(c);s.bedOccupants.bed='B';settleRoster(s,rates)
  expect(s.bedOccupants).toEqual({})
  s.morale.B=23;settleRoster(s,rates);expect(s.bedOccupants.bed).toBe('B')
 })
 it('maps global free_room without inventing it from a plan or resetting it on backup changes',()=>{
  const ws=createDefaultWorkspace();ws.compatibility.backupPlans=[{trigger:'True',conf:{workaholic:'芬'}}]
  const schedule=compileRosterSchedule(ws,{freeRoom:true}),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  expect(s.config.mowerPolicy?.freeRoom).toBe(true)
  createBackupPlanController(schedule,s).evaluate('END');expect(s.config.mowerPolicy?.freeRoom).toBe(true)
  expect(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws)).mowerPolicy?.freeRoom).toBe(false)
 })
 it('rejects non-boolean global free_room instead of silently enabling it',()=>{
  const schedule=compileRosterSchedule(createDefaultWorkspace(),{freeRoom:'false' as unknown as boolean})
  expect(schedule.diagnostics).toContainEqual(expect.objectContaining({code:'INVALID_ASSUMPTION',path:'assumptions.freeRoom',severity:'error'}))
 })
 it('recovers a displaced primary through native correction and a real return task after backup exit',()=>{
  const ws=createDefaultWorkspace()
  ws.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:['芬']}
  nativeDorm(ws)
  ws.compatibility.backupPlans=[{trigger:"op_data.operators['芬'].current_mood()<10",plan:{room_1_1:{plans:[{agent:'芬',group:'',replacement:['阿米娅']}]}},task:{room_1_1:['芬']}}]
  const schedule=compileRosterSchedule(ws,{idleOperators:['香草','克洛丝','芙蓉'],fiammettaFool:false}),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,s)
  s.morale[id('阿米娅')]=8;s.morale[id('芬')]=1;seedObservedState(s)
  controller.evaluate('END');enqueueBackup(s)
  driveUntil(s,controller,()=>s.occupants.room_1_1_0===id('芬'))
  expect(s.morale[id('阿米娅')]).toBeCloseTo(8,8)
  const op=getMowerSourceRuntime(s).data.operators[id('芬')]!
  s.morale[op.name]=24;op.mood=24;op.timeStampMicros=getMowerSourceRuntime(s).data.nowMicros;op.depletionRate=0
  controller.evaluate('END');enqueueBackup(s)
  driveUntil(s,controller,()=>Object.values(s.bedOccupants).includes(id('阿米娅'))&&s.events.some(e=>e.type==='shift-off'&&e.operators.includes(id('阿米娅'))))
  expect(s.events.some(e=>e.type==='shift-off'&&e.operators.includes(id('阿米娅')))).toBe(true)
  driveUntil(s,controller,()=>s.occupants.room_1_1_0===id('阿米娅')&&s.events.some(e=>e.type==='shift-on'&&!e.reason&&e.operators.includes(id('阿米娅'))))
  expect(s.events.some(e=>e.type==='shift-on'&&e.operators.includes(id('阿米娅')))).toBe(true)
  expect(s.morale[id('阿米娅')]).toBeGreaterThan(23)
 })
 it('synchronizes a partly resting group instead of leaving full members in bed without a return deadline',()=>{
  const c=config();c.positions.push({id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g',shiftOffThreshold:15});c.positions[0]!.group='g';c.beds.push({id:'bed2',roomId:'dormitory_1',vip:false});c.initialMorale={A:24,B:24,C:0,D:24}
  const s=createRosterRuntime(c);s.occupants.work='B';s.bedOccupants.bed='A';settleRoster(s,rates)
  expect(s.events.some(e=>e.type==='shift-on'&&e.operators.includes('A'))).toBe(true)
  expect(s.occupants).toEqual({work:'A',peer:'C'})
  expect(Object.values(s.bedOccupants)).not.toContain('A')
 })
 it('repairs a primary at another work slot without an infinite rest deadline or duplicate occupancy',()=>{
  const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g'},{id:'other',roomId:'other',primary:'E',candidates:['F'],permanent:true}];c.beds.push({id:'bed2',roomId:'dormitory_1',vip:false});c.initialMorale={A:24,B:24,C:0,D:24,E:24,F:24}
  const s=createRosterRuntime(c);s.occupants={work:'B',peer:'D',other:'C'};s.bedOccupants={bed:'A'};settleRoster(s,rates)
  expect(s.occupants).toEqual({work:'A',peer:'C',other:'E'})
  expect(Object.values(s.returnDeadlines??{}).every(Number.isFinite)).toBe(true)
  const all=[...Object.values(s.occupants),...Object.values(s.bedOccupants)];expect(new Set(all).size).toBe(all.length)
  expect(s.morale.C).toBe(0)
 })
})

it('retains the exhausted original worker when native EXHAUST_OFF has no eligible cover',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.type='trading'
 ws.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:[]}
 nativeDorm(ws);ws.mainPlan.conf.exhaust_require=['阿米娅']
 const report=simulateSchedule(compileRosterSchedule(ws,{operatorMorale:{[id('阿米娅')]:0},idleOperators:['芬','香草','克洛丝']}),{sampleHours:1,recordSegments:true})
 expect(report.success).toBe(true)
 expect(report.segments.every(s=>s.occupants.room_1_1_0===id('阿米娅'))).toBe(true)
 expect(report.diagnostics).toContainEqual(expect.objectContaining({code:'group-blocked'}))
 expect(report.diagnostics.filter(d=>d.code==='UNQUANTIFIED_WORK_RATE')).toEqual([])
})

it('restores an ungrouped workaholic sent to a temporary dorm task after backup exit',()=>{
 const ws=createDefaultWorkspace();ws.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:['芬']};ws.mainPlan.facilities.dormitory_1.slots[0]={occupant:{kind:'free'},groupId:null,replacements:[]};ws.mainPlan.conf.workaholic=['阿米娅'];ws.compatibility.backupPlans=[{trigger:"op_data.operators['芬'].current_mood()<10",task:{dormitory_1:['阿米娅']}}];
 const schedule=compileRosterSchedule(ws,{idleOperators:[]}),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,s);s.morale[id('阿米娅')]=8;s.morale[id('芬')]=1;controller.evaluate('END');s.morale[id('芬')]=24;controller.evaluate('END');settleRoster(s,rates);
 expect(s.occupants.room_1_1_0).toBe(id('阿米娅'));expect(Object.values(s.bedOccupants)).not.toContain(id('阿米娅'));expect(s.morale[id('阿米娅')]).toBe(8);
})
it('puts a newly designated idle primary to work at the native arrangement boundary',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.slots[0]={occupant:{kind:'operator',operatorId:'阿米娅'},groupId:null,replacements:['芬']}
 nativeDorm(ws)
 ws.compatibility.backupPlans=[{trigger:'True',plan:{room_1_1:{plans:[{agent:'芬',group:'',replacement:['阿米娅']}]}}}]
 const schedule=compileRosterSchedule(ws,{idleOperators:[]}),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,s)
 s.morale[id('芬')]=1;seedObservedState(s)
 controller.evaluate('END');enqueueBackup(s)
 expect(s.occupants.room_1_1_0).toBe(id('阿米娅'))
 driveUntil(s,controller,()=>s.occupants.room_1_1_0===id('芬'))
 expect(s.morale[id('芬')]).toBeCloseTo(1,6)
 expect(Object.values(s.bedOccupants)).not.toContain(id('芬'))
 expect(s.events.filter(e=>e.type==='shift-off'&&e.operators.includes(id('芬')))).toEqual([])
})
it.each([false,true])('protects a full or workaholic member while a valid group peer rests, permanent=%s',permanent=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g',permanent}];c.beds.push({id:'bed2',roomId:'dormitory_1',vip:false});c.initialMorale={A:16,B:24,C:permanent?8:24,D:24};const s=createRosterRuntime(c);s.occupants={work:'B',peer:'D'};s.bedOccupants={bed:'A',...(permanent?{bed2:'C'}:{})};settleRoster(s,rates);expect(s.occupants).toEqual({work:'B',peer:'D'});expect(s.bedOccupants.bed).toBe('A');expect(s.events.filter(e=>e.reason==='position-correction')).toEqual([]);
})
it('includes workaholics when correcting a mixed group',()=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g',permanent:true}];c.initialMorale={A:24,B:24,C:8,D:24};const s=createRosterRuntime(c);s.occupants.peer='D';s.bedOccupants.bed='C';settleRoster(s,rates);expect(s.occupants.peer).toBe('C');expect(Object.values(s.bedOccupants)).not.toContain('C');
})

it('keeps a complete ordinary resting group with a valid cover while its workaholic peer works',()=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g',permanent:true}];c.initialMorale={A:16,B:24,C:8,D:24};const s=createRosterRuntime(c);s.occupants.work='B';s.bedOccupants.bed='A';settleRoster(s,rates);expect(s.occupants).toEqual({work:'B',peer:'C'});expect(s.bedOccupants.bed).toBe('A');
})

it('repairs an invalid cover while preserving a fully resting ordinary group',()=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g'}];c.beds.push({id:'bed2',roomId:'dormitory_1',vip:false});c.initialMorale={A:16,B:24,C:10,D:24,X:24};c.idleOperators=['X'];const s=createRosterRuntime(c);s.occupants={work:'X',peer:'D'};s.bedOccupants={bed:'A',bed2:'C'};settleRoster(s,rates);expect(s.occupants).toEqual({work:'B',peer:'D'});expect(Object.values(s.bedOccupants)).toEqual(expect.arrayContaining(['A','C']));
})
it('returns the complete resting group when an invalid cover has no available replacement',()=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B'],group:'g'},{id:'peer',roomId:'room',primary:'C',candidates:['D'],group:'g'},{id:'other',roomId:'other',primary:'E',candidates:['B'],permanent:true}];c.beds.push({id:'bed2',roomId:'dormitory_1',vip:false});c.initialMorale={A:16,B:24,C:10,D:24,E:24,X:24};c.idleOperators=['X'];const s=createRosterRuntime(c);s.occupants={work:'X',peer:'D',other:'B'};s.bedOccupants={bed:'A',bed2:'C'};
 // Other room's valid cover B is occupied and cannot be taken by this group.
 c.positions[2]!.primary='B';s.config.positions[2]!.primary='B';settleRoster(s,rates);expect(s.occupants.work).toBe('A');expect(s.occupants.peer).toBe('C');expect(s.occupants.other).toBe('B');
})

it('fills a vacated resting slot with the candidate released by another correction',()=>{
 const c=config();c.positions=[{id:'work',roomId:'room',primary:'A',candidates:['B']},{id:'other',roomId:'other',primary:'E',candidates:[],permanent:true}];c.initialMorale={A:16,B:24,E:24};const s=createRosterRuntime(c);s.occupants={other:'B'};s.bedOccupants={bed:'A'};settleRoster(s,rates);expect(s.occupants).toEqual({work:'B',other:'E'});expect(s.bedOccupants.bed).toBe('A');
})
