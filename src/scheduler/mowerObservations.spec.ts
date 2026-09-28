import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-fia-observation-alpha.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {mowerRoomReadIndexes,shouldMowerReadMood,mowerRefreshDormTime,mowerUpdateDetail} from './mowerObservations'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
describe('actual Mower room observation decisions',()=>{
 for(const [i,fixture] of oracle.cases.entries())it('FIA source predicate '+i,()=>{
  const v=fixture.input,op=new MowerOperatorState({name:v.name,nativeName:v.name,room:v.nativeRoom,mood:10,timeStampMicros:toMowerMicros(v.observedAtHours)}),data=new MowerSchedulingData({plan:{dormitory_1:[]},operators:{[v.name]:op},dorms:[],nowMicros:toMowerMicros(v.nowHours)}),task=v.currentType===null?undefined:new MowerTask({type:T.FIAMMETTA,metadata:v.metadata})
  expect(shouldMowerReadMood(data,v.name,'dormitory_1',v.index,v.readTimeIndices,task)).toBe(fixture.output.shouldReadMood)
 })
 it('reads default Free and FIA timers on every room scan, preserving requested order',()=>{
  const f=new MowerOperatorState({name:'F',nativeName:'菲亚梅塔'}),data=new MowerSchedulingData({plan:{dormitory_1:['K1','K2','F','Free','Free']},operators:{F:f},dorms:[],nowMicros:0})
  expect(mowerRoomReadIndexes(data,'dormitory_1',undefined,[4,2])).toEqual([4,2,3])
  expect(mowerRoomReadIndexes(data,'dormitory_1',new MowerTask({type:T.FIAMMETTA}),[2])).toEqual([2])
 })
 it('uses Python timedelta ties-to-even for proportional capped recovery times',()=>{
  const op=new MowerOperatorState({name:'A',mood:20,upperLimit:22,timeStampMicros:0,currentRoom:'dormitory_1',currentIndex:0}),bed=new MowerDormState(['dormitory_1',0]),data=new MowerSchedulingData({plan:{dormitory_1:['Free']},operators:{A:op},dorms:[bed],nowMicros:0})
  mowerRefreshDormTime(data,'dormitory_1',0,'A',5);expect(bed.timeMicros).toBe(2)
  mowerRefreshDormTime(data,'dormitory_1',0,'A',7);expect(bed.timeMicros).toBe(4)
 })
})

it('runs the native room setter callback before current_index and mood assignment',()=>{
 const a=new MowerOperatorState({name:'A',currentRoom:'room_old',currentIndex:4,mood:9,timeStampMicros:0}),e=new MowerOperatorState({name:'E',currentRoom:'room_new',currentIndex:1,mood:3,timeStampMicros:0})
 const d=new MowerSchedulingData({operators:{A:a,E:e},plan:{room_new:['A','E']},dorms:[],nowMicros:600_000_000})
 const changes:unknown[]=[]
 mowerUpdateDetail(d,'A',8,'room_new',0,true,new Set(),op=>{changes.push([op.currentRoom,op.currentIndex,op.mood]);e.timeStampMicros=undefined})
 expect(changes).toEqual([['room_new',4,9]])
 expect(shouldMowerReadMood(d,'E','room_new',1,[])).toBe(true)
 mowerUpdateDetail(d,'E',1,'room_new',1,true)
 expect(e.mood).toBe(1);expect(e.timeStampMicros).toBe(d.nowMicros)
})
 it.each([false,true])('preserves update_detail decorator return suppression when update_time=%s',updateTime=>{
  const op=new MowerOperatorState({name:'A',room:'room_1_1',currentRoom:'room_1_1',currentIndex:0,mood:8,timeStampMicros:0})
  const bed=new MowerDormState(['dormitory_1',0],'A')
  const data=new MowerSchedulingData({plan:{dormitory_1:['Free']},operators:{A:op},dorms:[bed],nowMicros:1_000_000})
  const result=mowerUpdateDetail(data,'A',7,'dormitory_1',0,updateTime)
  expect(op.currentRoom).toBe('dormitory_1')
  expect(op.mood).toBe(7)
  expect(bed.name).toBe('A')
  expect(result).toBe(updateTime?0:undefined)
 })
