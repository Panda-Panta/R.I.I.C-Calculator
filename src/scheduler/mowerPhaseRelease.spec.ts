import {it,expect} from 'vitest'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {createBackupPlanController} from './backupPlans'
import {compiledScheduleToRuntimeConfig,createRosterRuntime,settleRoster,advanceRoster,nextRosterActionHours} from './rosterRuntime'
import {simulateMoraleTimeline} from '../simulator/moraleTimeline'

it('releases recovered free_room residents at recovery time rather than the next 2.5h scan',()=>{
 const result=simulateMoraleTimeline({positions:[{id:'work',roomId:'room',primary:'A',candidates:['B'],permanent:true}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],initialMorale:{A:24,B:23},idleOperators:[],mowerPolicy:{restingThreshold:.65,freeRoom:true,powerPlantCount:2,opeRestingPriority:[]}},1,{workRate:()=>0,recoveryRate:()=>4})
 expect(result.finalState.bedOccupants).toEqual({})
 expect(result.segments.filter(s=>s.start>=.25).every(s=>!s.bedOccupants.bed)).toBe(true)
})
it('honors entry and separate exit timing at all alpha planning phases',()=>{
 const ws=createDefaultWorkspace();ws.compatibility.backupPlans=[{name:'phase',trigger:"op_data.operators['芬'].current_mood()<10",trigger_timing:'BEFORE_WORK',exit_trigger_timing:'END'}]
 const schedule=compileRosterSchedule(ws),s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,s)
 s.morale.char_123_fang=1;controller.evaluate('BEGINNING');expect(controller.active).toEqual([false])
 controller.evaluate('BEFORE_WORK');expect(controller.active).toEqual([true])
 s.morale.char_123_fang=24;controller.evaluate('AFTER_PLANNING');expect(controller.active).toEqual([true])
 controller.evaluate('END');expect(controller.active).toEqual([false])
})
it('evaluates work and dorm entry phases before committing a normal shift',()=>{
 const s=createRosterRuntime({positions:[{id:'work',roomId:'room',primary:'A',candidates:['B'],shiftOffThreshold:15}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],initialMorale:{A:15,B:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]}})
 const phases:string[]=[];settleRoster(s,{workRate:()=>1,recoveryRate:()=>4},0,phase=>{phases.push(phase);return false})
 expect(phases.slice(0,3)).toEqual(['BEFORE_WORK','BEFORE_DORM','BEFORE_PLANNING'])
 expect(s.bedOccupants.bed).toBe('A')
})

it('BEFORE_DORM observes the completed work-room move before beds are assigned',()=>{
 const s=createRosterRuntime({positions:[{id:'work',roomId:'room',primary:'A',candidates:['B'],shiftOffThreshold:15}],beds:[{id:'bed',roomId:'dormitory_1',vip:true}],initialMorale:{A:15,B:24},idleOperators:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]}});const observed:any[]=[];settleRoster(s,{workRate:()=>1,recoveryRate:()=>4},0,phase=>{if(phase==='BEFORE_DORM')observed.push({work:s.occupants.work,beds:{...s.bedOccupants}});return false});expect(observed).toEqual([{work:'B',beds:{}}]);
})

it('rejects an invalid BEFORE_DORM backup after the protected complete shift without applying it',()=>{
 const ws=createDefaultWorkspace()
 ws.mainPlan.facilities.room_1_1.slots=['阿米娅','玫兰莎'].map((name,index)=>({occupant:{kind:'operator' as const,operatorId:name},groupId:'g',replacements:[['芬','香草'][index]!]}))
 for(const [room,names] of [['dormitory_1',['杜林','闪灵']],['dormitory_2',['流明','车尔尼']]] as const)
  ws.mainPlan.facilities[room].slots=[...names.map(name=>({occupant:{kind:'operator' as const,operatorId:name},groupId:null,replacements:[]})),{occupant:{kind:'free'},groupId:null,replacements:[]}]
 ws.compatibility.backupPlans=[{trigger:'True',trigger_timing:'BEFORE_DORM',plan:Object.fromEntries([['dormitory_1','安赛尔'],['dormitory_2','安德切尔']].map(([room,name])=>[room,{plans:[{agent:'Current',group:'',replacement:[]},{agent:'Current',group:'',replacement:[]},{agent:name,group:'',replacement:[]}]}]))}]
 const schedule=compileRosterSchedule(ws,{operatorMorale:{char_002_amiya:0,char_208_melan:0},idleOperators:['char_115_headbr','char_124_kroos','char_209_ardign','char_122_beagle','char_121_lava','char_210_stward','char_120_hibisc','char_141_nights']})
 const s=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,s),rates={workRate:()=>1,recoveryRate:()=>4}
 const beforeDorm:string[][]=[]
 const completed:{work:string[];beds:string[]}[]=[]
 const drive=()=>{for(let pass=0;pass<200;pass++){
  settleRoster(s,rates,0,phase=>{if(phase==='BEFORE_DORM')beforeDorm.push([s.occupants.room_1_1_0!,s.occupants.room_1_1_1!]);if(phase==='BEFORE_PLANNING')completed.push({work:[s.occupants.room_1_1_0!,s.occupants.room_1_1_1!],beds:Object.values(s.bedOccupants)});return controller.evaluate(phase)})
  advanceRoster(s,Math.min(.25,nextRosterActionHours(s,rates)),rates)
 }}
 expect(drive).not.toThrow()
 expect(s.diagnostics.some(entry=>entry.code==='mower-task-exception'&&/分组需要 2 个休息床位/.test(entry.message))).toBe(true)
 expect(beforeDorm).toEqual([])
 expect(completed).toContainEqual({work:['char_123_fang','char_240_wyvern'],beds:expect.arrayContaining(['char_002_amiya','char_208_melan'])})
 expect(controller.active).toEqual([false])
})
