import {describe,it,expect} from 'vitest'
import {compileBackupExpression} from './backupExpression'
import {createRosterRuntime} from './rosterRuntime'
import {getMowerSourceRuntime} from './mowerSourceRuntime'
import {MowerSchedulingData} from './mowerSchedulingData'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {resolveOperatorCharId} from '../domain/operatorIdentifiers'

function fixture(options:MowerOperatorOptions[]=[]){
 const state=createRosterRuntime({positions:[],beds:[],mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},mowerAlpha:true,mowerSourcePlan:{},mowerSourceRules:{workaholic:[],exhaustRequire:[],restInFull:[],lowPriority:[],refreshDrained:[],lingMode:0}})
 const operators=Object.fromEntries(options.map(option=>[option.name,new MowerOperatorState({operatorType:'high',room:'room_1_1',currentRoom:'room_1_1',group:'红松',timeStampMicros:0,...option})]))
 getMowerSourceRuntime(state).data=new MowerSchedulingData({alpha:true,operators,plan:{room_1_1:Object.keys(operators)},dorms:[],nowMicros:0})
 return state
}
const expression=(text:string)=>compileBackupExpression(text,new Set())

// Native f19a: these method arguments are checked during execution, while
// evalidate rejects attributes outside its whitelist before execution.
describe('alpha backup group and mastery predicates',()=>{
 it('uses cached current moods at the evaluation clock and registers clock dependence',()=>{
  const far=resolveOperatorCharId('远牙'),state=fixture([{name:'A',mood:20,depletionRate:2},{name:far,mood:20,depletionRate:1}])
  state.time=2;state.morale.A=1
  const compiled=expression(`op_data.group_min_mood("红松") != op_data.operators['远牙'].current_mood()`)
  expect(compiled.usesCurrentMood).toBe(true)
  expect(compiled.evaluate(state)).toBe(true)
  expect(expression(`op_data.group_min_mood('红松')`).evaluate(state)).toBe(16)
 })
 it('filters shared followers, workaholics, dorm residents, standby and low operators while retaining ordinary low-priority anchors',()=>{
  const state=fixture([
   {name:'anchor',mood:8,restingPriority:'low'},
   {name:'workaholic',mood:0,workaholic:true},
   {name:'keeper',mood:0,room:'dormitory_1'},
   {name:'standby',mood:0,restingPriority:'standby'},
   {name:'cover',mood:0,operatorType:'low'},
   {name:'shared',mood:0,groupBindings:[{group:'红松',replacement:[]},{group:'other',replacement:[]}]},
  ])
  expect(expression(`op_data.group_min_mood('红松')`).evaluate(state)).toBe(8)
 })
 it('reads effective membership again after a backup changes the group',()=>{
  const state=fixture([{name:'A',mood:5},{name:'B',mood:12}]),compiled=expression(`op_data.group_min_mood('红松')`)
  expect(compiled.evaluate(state)).toBe(5)
  state.mowerSource!.data.operators.A!.group='another'
  expect(compiled.evaluate(state)).toBe(12)
 })
 it('preserves distinct native errors for absent groups and groups without mood anchors',()=>{
  expect(()=>expression(`op_data.group_min_mood('')`).evaluate(fixture([{name:'A',group:''}]))).toThrow('不存在的绑组：')
  expect(()=>expression(`op_data.group_min_mood('不存在')`).evaluate(fixture())).toThrow('不存在的绑组：不存在')
  expect(()=>expression(`op_data.group_min_mood('红松')`).evaluate(fixture([{name:'A',workaholic:true}]))).toThrow('绑组内没有可统计心情的干员：红松')
 })
 it.each([undefined,false,true,'true'])('always treats training as having no unfinished plan despite legacy state %s',present=>{
  const state=fixture()
  if(present!==undefined)Object.assign(state.config,{mowerMasteryPlanPresent:present})
  const before=structuredClone(state.config)
  const compiled=expression(`op_data.facility_has_mastery_plan('train') == False`)
  expect(compiled.usesMasteryPlan).toBe(true);expect(compiled.usesCurrentMood).toBe(false)
  expect(compiled.evaluate(state)).toBe(true)
  expect(expression(`op_data.facility_has_mastery_plan('train')`).evaluate(state)).toBe(false)
  state.time=24
  expect(compiled.evaluate(state)).toBe(true)
  expect(state.config).toEqual(before)
 })
 it.each([false,true])('keeps the no-plan condition independent of native enableMastery %s',enabled=>{
  const state=fixture();state.config.mowerTaskScheduling={enableMastery:enabled}
  expect(expression(`op_data.facility_has_mastery_plan('train') == False`).evaluate(state)).toBe(true)
 })
 it('rejects rooms other than train as the native method does',()=>{
  const compiled=expression(`op_data.facility_has_mastery_plan('room_1_1')`)
  expect(()=>compiled.evaluate(fixture())).toThrow('不支持的训练室位置')
  expect(expression(`True or op_data.facility_has_mastery_plan('room_1_1')`).evaluate(fixture())).toBe(true)
 })
 it.each([
  `op_data.group_min_mood()`,
  `op_data.group_min_mood(1)`,
  `op_data.group_min_mood('红松', 'other')`,
  `op_data.facility_has_mastery_plan(op_data.party_time)`,
 ])('keeps syntactically valid bad arguments as execution errors: %s',source=>{
  const compiled=expression(source)
  expect(()=>compiled.evaluate(fixture())).toThrow('需要一个字符串参数')
  expect(expression(`True or ${source}`).evaluate(fixture())).toBe(true)
 })
 it('rejects attributes outside the native whitelist before execution',()=>{
  expect(()=>expression(`op_data.group_min_mood('红松').anything`)).toThrow('副表：')
 })
 it('keeps Python short-circuiting for unused external states',()=>{
  expect(expression(`True or op_data.facility_has_mastery_plan('train')`).evaluate(fixture())).toBe(true)
  expect(expression(`op_data.facility_has_mastery_plan('train') and op_data.group_min_mood('不存在')`).evaluate(fixture())).toBe(false)
  expect(expression(`not op_data.facility_has_mastery_plan('train') or op_data.group_min_mood('不存在')`).evaluate(fixture())).toBe(true)
  expect(expression(`False and op_data.group_min_mood('不存在')`).evaluate(fixture())).toBe(false)
 })
})
