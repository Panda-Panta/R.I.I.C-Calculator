import {describe,it,expect} from 'vitest'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerOperatorState as Op} from './mowerOperatorState'
import {MowerTask,MOWER_TASK_TYPES as T} from './mowerTaskQueue'
import {mowerArrangementReadIndexes} from './mowerSelection'
import {mowerFiaReadyMicros} from './mowerFiammetta'
describe('source selection read order and cached Fia scheduling',()=>{
 it('captures Fia and original target before full targets can turn into Free',()=>{
  const data=new MowerSchedulingData({plan:{dormitory_1:['Free','Fia']},operators:{A:new Op({name:'A',room:'room_1_1',operatorType:'high'}),Fia:new Op({name:'Fia',nativeName:'菲亚梅塔',room:'dormitory_1'})},dorms:[],nowMicros:0})
  expect(mowerArrangementReadIndexes(data,'dormitory_1',['A','Fia'],false,new MowerTask({type:T.FIAMMETTA,metadata:'A'}))).toEqual([0,1])
  expect(mowerArrangementReadIndexes(data,'dormitory_1',['R','Fia'],false,new MowerTask({type:T.FIAMMETTA,metadata:'A'}))).toEqual([1])
 })
 it('matches get_refresh_index free_room branch with static Free positions',()=>{
  const data=new MowerSchedulingData({plan:{dormitory_1:['K','Free','Free']},operators:{A:new Op({name:'A',room:'room_1_1',operatorType:'high'})},dorms:[new MowerDormState(['dormitory_1',1])],freeRoom:true,nowMicros:0})
  expect(mowerArrangementReadIndexes(data,'dormitory_1',['A','K','R'],true,new MowerTask({type:T.SHIFT_OFF}))).toEqual([1,2])
 })
 it('does not refresh get_time outside any managed dorm',()=>{
  const data=new MowerSchedulingData({plan:{dormitory_1:['Free']},operators:{A:new Op({name:'A',room:'room_1_1',operatorType:'high'})},dorms:[],nowMicros:0})
  expect(mowerArrangementReadIndexes(data,'dormitory_1',['A'],true,new MowerTask({type:T.SHIFT_OFF}))).toEqual([])
 })
 it('uses cached full Fia without reading physical mood',()=>{
  const o=new Op({name:'Fia',mood:24,timeStampMicros:0})
  expect(mowerFiaReadyMicros(o,10,()=>{throw Error('no read when cached mood is 24')})).toBe(10)
 })
 it('keeps a future cached Fia timestamp without reading the room',()=>{
  const o=new Op({name:'Fia',mood:12,timeStampMicros:20})
  expect(mowerFiaReadyMicros(o,10,()=>{throw Error('future timestamp suppresses read')})).toBe(20)
 })
 it('reads the actual room timer for a non-full Fia without a future cache',()=>{
  const o=new Op({name:'Fia',mood:12,timeStampMicros:10});let reads=0
  expect(mowerFiaReadyMicros(o,10,()=>{reads++;return 30})).toBe(30);expect(reads).toBe(1)
 })
})