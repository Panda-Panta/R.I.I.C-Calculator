import {describe,expect,it} from 'vitest'
import {MowerOperatorState} from './mowerOperatorState'
import {mowerGetRestingPlan,mowerResting,mowerTryReorder} from './mowerOrdinaryPlanning'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerTaskQueue,MOWER_TASK_TYPES as T,type MowerTaskPlan} from './mowerTaskQueue'

function fixture(ideal=true,protectedResident=false){
 return new MowerSchedulingData({
  adjustForRunOrders:ideal?false:undefined,nowMicros:0,
  plan:{central:['A'],room_1_1:['B'],room_2_1:['U'],dormitory_1:['Manager1','Manager2','Manager3','Free','Free']},
  operators:{
   A:new MowerOperatorState({name:'A',room:'central',index:0,currentRoom:'central',currentIndex:0,group:'group',operatorType:'high',replacement:['X'],mood:12,timeStampMicros:0}),
   B:new MowerOperatorState({name:'B',room:'room_1_1',index:0,currentRoom:'room_1_1',currentIndex:0,group:'group',operatorType:'high',restingPriority:'low',replacement:['Y'],mood:12,timeStampMicros:0}),
   X:new MowerOperatorState({name:'X',currentRoom:'dormitory_1',currentIndex:3,mood:20,timeStampMicros:0}),
   Y:new MowerOperatorState({name:'Y',currentRoom:protectedResident?'':'dormitory_1',currentIndex:protectedResident?-1:4,mood:20,timeStampMicros:0}),
   U:new MowerOperatorState({name:'U',room:'room_2_1',index:0,currentRoom:protectedResident?'dormitory_1':'room_2_1',currentIndex:protectedResident?4:0,operatorType:'high',mood:20,timeStampMicros:0}),
  },
  dorms:[new MowerDormState(['dormitory_1',3],'X',3_600_000_000),new MowerDormState(['dormitory_1',4],protectedResident?'U':'Y',3_600_000_000)],
 })
}

function addAlternativeCovers(data:MowerSchedulingData):void {
 data.plan.dormitory_2=['Manager4','Manager5','Manager6','Free','Free']
 data.operators.A!.replacement.push('X2')
 data.operators.B!.replacement.push('Y2')
 data.operators.X2=new MowerOperatorState({name:'X2',currentRoom:'dormitory_2',currentIndex:3,mood:20,timeStampMicros:0})
 data.operators.Y2=new MowerOperatorState({name:'Y2',currentRoom:'dormitory_2',currentIndex:4,mood:20,timeStampMicros:0})
 data.dorms.push(new MowerDormState(['dormitory_2',3],'X2',3_600_000_000),new MowerDormState(['dormitory_2',4],'Y2',3_600_000_000))
}

const reservations=(data:MowerSchedulingData)=>data.dorms.map(bed=>({name:bed.name,timeMicros:bed.timeMicros}))
const physicalPositions=(data:MowerSchedulingData)=>Object.fromEntries(Object.entries(data.operators).map(([name,op])=>[name,{room:op.currentRoom,index:op.currentIndex}]))

describe('beds vacated by replacements in an ideal roster transaction',()=>{
 it('can rest the complete group in beds vacated by its selected replacements',()=>{
  const data=fixture(),plan:MowerTaskPlan={}
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(true)
  expect(plan).toEqual({central:['X'],room_1_1:['Y']})
  expect(new Set(data.dorms.map(bed=>bed.name))).toEqual(new Set(['A','B']))
  const dormPlan=mowerTryReorder(data,plan)
  expect(dormPlan?.dormitory_1?.slice(3).sort()).toEqual(['A','B'])
  expect(data.operators.X!.currentRoom).toBe('dormitory_1')
  expect(data.operators.Y!.currentRoom).toBe('dormitory_1')
 })

 it('retains the frozen native bed rule when ideal scheduling is not selected',()=>{
  const data=fixture(false),plan:MowerTaskPlan={}
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(data.dorms.map(bed=>bed.name)).toEqual(['X','Y'])
 })

 it('retains protected residents and commits no partial group reservation',()=>{
  const data=fixture(true,true),plan:MowerTaskPlan={}
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(data.dorms.map(bed=>bed.name)).toEqual(['X','U'])
 })

 it('does not treat an excluded replacement as a departing resident',()=>{
  const data=fixture(),plan:MowerTaskPlan={}
  data.excludedCandidates.add('X')
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(data.dorms.map(bed=>bed.name)).toEqual(['X','Y'])
 })

 it('plans the group once through ordinary resting even when second covers have their own beds',()=>{
  const data=fixture(),queue=new MowerTaskQueue();addAlternativeCovers(data)
  const physical=physicalPositions(data)
  expect(mowerResting(data,queue)).toEqual({central:['X'],room_1_1:['Y']})
  expect(queue.tasks).toHaveLength(1)
  expect(queue.tasks[0]!.type).toBe(T.SHIFT_OFF)
  expect(queue.tasks[0]!.plan).toEqual({central:['X'],room_1_1:['Y']})
  expect(new Set(data.dorms.slice(0,2).map(bed=>bed.name))).toEqual(new Set(['A','B']))
  expect(reservations(data).slice(2)).toEqual([{name:'X2',timeMicros:3_600_000_000},{name:'Y2',timeMicros:3_600_000_000}])
  expect(physicalPositions(data)).toEqual(physical)
 })

 it('does not consume second-cover beds when the same group is planned again before execution',()=>{
  const data=fixture(),plan:MowerTaskPlan={},selected:string[]=[];addAlternativeCovers(data)
  const physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],selected,plan)).toBe(true)
  const reserved=reservations(data)
  expect(selected).toEqual(['X','Y'])
  expect(mowerGetRestingPlan(data,['A','B'],selected,plan)).toBe(false)
  expect(plan).toEqual({central:['X'],room_1_1:['Y']})
  expect(selected).toEqual(['X','Y'])
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })

 it('respects an already committed work post without reserving any alternate-cover beds',()=>{
  const data=fixture(),plan:MowerTaskPlan={central:['X']},selected=['X'];addAlternativeCovers(data)
  const reserved=reservations(data),physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],selected,plan)).toBe(false)
  expect(plan).toEqual({central:['X']})
  expect(selected).toEqual(['X'])
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })

 it.each([
  {label:'rest to full',restInFull:true,exhaustRequire:false},
  {label:'exhaustion',restInFull:false,exhaustRequire:true},
  {label:'rest to full and exhaustion',restInFull:true,exhaustRequire:true},
 ])('does not bypass a high replacement protected by $label',policy=>{
  const data=fixture(),plan:MowerTaskPlan={},selected:string[]=[]
  data.plan.room_3_1=['X']
  data.operators.X=new MowerOperatorState({name:'X',room:'room_3_1',index:0,currentRoom:'dormitory_1',currentIndex:3,operatorType:'high',restingPriority:'high',mood:20,timeStampMicros:0,restInFull:policy.restInFull,exhaustRequire:policy.exhaustRequire})
  const reserved=reservations(data),physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],selected,plan)).toBe(false)
  expect(plan).toEqual({})
  expect(selected).toEqual([])
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })

 it('does not use a stale bed record when its replacement actually rests elsewhere',()=>{
  const data=fixture(),plan:MowerTaskPlan={}
  data.plan.dormitory_2=['Manager4','Manager5','Manager6','Free','Free']
  data.operators.Y!.currentRoom='dormitory_2';data.operators.Y!.currentIndex=3
  const reserved=reservations(data),physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })

 it('does not turn a fixed keeper slot into a recovery bed because its occupant departs',()=>{
  const data=fixture(),plan:MowerTaskPlan={}
  data.plan.dormitory_1![4]='Keeper'
  data.operators.Keeper=new MowerOperatorState({name:'Keeper',room:'dormitory_1',index:4,operatorType:'high'})
  const reserved=reservations(data),physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })

 it('does not count a physical Free slot absent from the managed recovery pool',()=>{
  const data=fixture(true,true),plan:MowerTaskPlan={}
  data.plan.dormitory_2=['Manager4','Manager5','Manager6','Free','Free']
  data.operators.Y!.currentRoom='dormitory_2';data.operators.Y!.currentIndex=3
  const reserved=reservations(data),physical=physicalPositions(data)
  expect(mowerGetRestingPlan(data,['A','B'],[],plan)).toBe(false)
  expect(plan).toEqual({})
  expect(reservations(data)).toEqual(reserved)
  expect(physicalPositions(data)).toEqual(physical)
 })
})
