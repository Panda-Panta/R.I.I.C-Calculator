import {describe,expect,it} from 'vitest'
import {alphaFindDormSlot} from './mowerAlphaDorm'
import {planMowerAlphaDormFill} from './mowerAlphaCandidates'
import {mowerAssignDormGroup} from './mowerDormAssignment'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerDormState,MowerSchedulingData} from './mowerSchedulingData'
import {prepareMowerDormSelection} from './mowerSelection'
import {MowerTask,MowerTaskQueue,MOWER_TASK_TYPES as T,type MowerTaskPlan} from './mowerTaskQueue'

// Worked native 94a49b4c Operators.dorm_capacity_allows examples. A grouped
// Free contributes a quota; the physical bed carrying its group is interchangeable.
function fixture(){
 const operators={
  Keeper:new MowerOperatorState({name:'Keeper',room:'dormitory_1',index:0,group:'g',replacement:['Free'],operatorType:'high',mood:24,timeStampMicros:0}),
  G:new MowerOperatorState({name:'G',room:'work_g',index:0,group:'g',replacement:['Replacement'],operatorType:'high',mood:5,timeStampMicros:0}),
  H1:new MowerOperatorState({name:'H1',room:'work_h',index:0,group:'h',operatorType:'high',mood:5,timeStampMicros:0,currentRoom:'dormitory_1',currentIndex:1}),
  H2:new MowerOperatorState({name:'H2',room:'work_h',index:1,group:'h',operatorType:'high',mood:5,timeStampMicros:0}),
  Replacement:new MowerOperatorState({name:'Replacement',mood:5,timeStampMicros:0}),
 }
 const data=new MowerSchedulingData({alpha:true,operators,plan:{work_g:['G'],work_h:['H1','H2'],dormitory_1:['Keeper','Free']},dorms:[new MowerDormState(['dormitory_1',0],'',undefined,true),new MowerDormState(['dormitory_1',1],'H1',3_600_000_000)],nowMicros:0,groupShiftState:{g:true,h:true},priorityReplacement:['Replacement']})
 return data
}

describe('group-managed Free recovery quotas',()=>{
 it('does not admit a second protected worker from another group into the only grouped quota',()=>{
  const data=fixture(),before=data.dorms.map(bed=>[bed.name,bed.timeMicros])
  expect(alphaFindDormSlot(data,'H2',new Set())).toBeUndefined()
  expect(mowerAssignDormGroup(data,['H2'])).toBeUndefined()
  expect(data.dorms.map(bed=>[bed.name,bed.timeMicros])).toEqual(before)
 })
 it('checks the complete pending allocation before committing any member of a group',()=>{
  const data=fixture();data.operators.H1!.setProjectedPosition('',-1);data.dorms[1]!.reset()
  const plan:MowerTaskPlan={work_h:['Current','Current']}
  expect(mowerAssignDormGroup(data,['H1','H2'],undefined,undefined,plan)).toBeUndefined()
  expect(data.dorms.every(bed=>!bed.name)).toBe(true)
  expect(plan).toEqual({work_h:['Current','Current']})
 })
 it('matches quotas across physical positions instead of assigning an owner group to each bed',()=>{
  const data=fixture();data.operators.H1!.setProjectedPosition('dormitory_1',0)
  data.dorms[0]!.name='H1';data.dorms[1]!.reset()
  expect(alphaFindDormSlot(data,'G',new Set())).toBe(1)
  expect(mowerAssignDormGroup(data,['G'])?.map(bed=>bed.position)).toEqual([['dormitory_1',1]])
 })
 it('counts a prior pending member at its planned destination even before the physical read',()=>{
  const data=fixture();data.operators.H1!.setProjectedPosition('',-1);data.dorms[1]!.reset()
  expect(alphaFindDormSlot(data,'H2',new Set([0]),undefined,{dormitory_1:['H1','Current']})).toBeUndefined()
 })
 it('releases ordinary quota when its current resident has an explicit move out',()=>{
  const data=fixture(),plan={work_h:['H1','Current']}
  expect(alphaFindDormSlot(data,'H2',new Set(),undefined,plan)).toBe(0)
 })
 it('does not fill a grouped vacancy with a priority replacement when ordinary quota is exhausted',()=>{
  const data=fixture()
  expect(planMowerAlphaDormFill(data,new MowerTaskQueue())).toBeUndefined()
 })
 it('still lets lower tiers use an otherwise available grouped bed',()=>{
  const data=fixture();data.priorityReplacement=[]
  expect(alphaFindDormSlot(data,'Replacement',new Set())).toBe(0)
 })
 it('excludes a grouped bed closed by the pending return, including for ordinary idle candidates',()=>{
  const data=fixture();data.priorityReplacement=[]
  expect(alphaFindDormSlot(data,'Replacement',new Set(),undefined,{work_g:['G']})).toBeUndefined()
 })
})

describe('explicit dorm selection rechecks grouped quotas',()=>{
 it.each([false,true])('cancels a newly named protected arrival that exceeds ordinary quota (preserve=%s)',preserve=>{
  const data=fixture(),names=['H2','Current'],task=new MowerTask({plan:{dormitory_1:names}})
  prepareMowerDormSelection(data,names,'dormitory_1',preserve,false,task)
  expect(names).toEqual(['Free','Current'])
 })
 it('checks an unregistered explicitly prioritized name before the unknown-operator fallback',()=>{
  const data=fixture(),names=['Ghost','Current'];data.restingPriorityNames=['Ghost']
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,new MowerTask({plan:{dormitory_1:names}}))
  expect(names).toEqual(['Free','Current'])
 })
 it('keeps an existing observed occupant while admitting no new over-quota arrival',()=>{
  const data=fixture(),names=['H2','Current'];data.operators.H2!.setProjectedPosition('dormitory_1',0)
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,new MowerTask({plan:{dormitory_1:names}}))
  expect(names).toEqual(['H2','Current'])
 })
 it('counts the task move that releases an ordinary quota in another room',()=>{
  const data=fixture(),names=['H2','Current'],task=new MowerTask({plan:{work_h:['H1','Current'],dormitory_1:names}})
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,task)
  expect(names).toEqual(['H2','Current'])
 })
 it.each([false,true])('uses retained group transitions after the work room leaves the remaining plan (resting=%s)',resting=>{
  const data=fixture(),names=['G','Current'],task=new MowerTask({plan:{dormitory_1:names}})
  task.groupShiftTransitions={g:resting}
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,task)
  expect(names).toEqual([resting?'G':'Free','Current'])
 })
 it('uses the task binding when a shared dorm follower changes from Free to a fixed replacement',()=>{
  const data=fixture(),names=['H2','Current'],task=new MowerTask({plan:{dormitory_1:names}})
  data.operators.Keeper!.groupBindings=[{group:'g',replacement:['Free']},{group:'x',replacement:['H2']}]
  data.operators.H2!.workaholic=true
  task.groupShiftTransitions={g:false,x:true}
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,task)
  expect(names).toEqual(['H2','Current'])
 })
 it('preserves a fixed dorm primary rather than treating its own post as dynamic recovery',()=>{
  const data=fixture(),names=['Keeper','Current']
  prepareMowerDormSelection(data,names,'dormitory_1',false,false,new MowerTask({plan:{dormitory_1:names}}))
  expect(names).toEqual(['Keeper','Current'])
 })
 it.each(['legacy','fiammetta','mood-probe'])('keeps %s selection outside the alpha ordinary quota rule',mode=>{
  const data=fixture(),names=['H2','Current'],task=new MowerTask({type:mode==='fiammetta'?T.FIAMMETTA:T.SHIFT_OFF,plan:{dormitory_1:names}})
  if(mode==='legacy')data.alpha=false
  prepareMowerDormSelection(data,names,'dormitory_1',false,mode==='mood-probe',task)
  expect(names).toEqual(['H2','Current'])
 })
})
