import {describe,expect,it} from 'vitest'
import {advanceRoster,createRosterRuntime,currentMoraleDerivatives,moraleDerivative,nextRosterEventHours} from './rosterRuntime'
import {nextRosterMoraleEventHours} from './rosterMorale'

const rates={workRate:()=>1,recoveryRate:()=>2}

describe('physical morale boundaries and planner deadlines',()=>{
 it('keeps the earlier planning boundary while using prepared physical derivatives unchanged',()=>{
  const state=createRosterRuntime({positions:[{id:'work',roomId:'room_1_1',primary:'A',candidates:[]}],beds:[],initialMorale:{A:12}})
  state.nextPlanningTime=.25
  const before=structuredClone(state),prepared=Object.freeze({A:-2})
  const unexpectedRate=()=>{throw new Error('prepared derivatives must be reused')}
  const preparedRates={workRate:unexpectedRate,recoveryRate:unexpectedRate,snapshotRates:unexpectedRate}
  expect(nextRosterEventHours(state,preparedRates,true,prepared)).toBe(.25)
  expect(nextRosterEventHours(state,preparedRates,false,prepared)).toBe(6)
  expect(nextRosterMoraleEventHours(state,preparedRates,Infinity,prepared)).toBe(6)
  expect(state).toEqual(before)
  expect(prepared).toEqual({A:-2})
 })

 it('scans physical rates without entering the source planner or replacing its deadlines',()=>{
  const state=createRosterRuntime({
   positions:[{id:'work',roomId:'room_1_1',primary:'A',candidates:[]}],beds:[],initialMorale:{A:12},
   mowerSourcePlan:{room_1_1:[{agent:'A',group:'',replacement:[]}]},
   mowerPolicy:{restingThreshold:.65,powerPlantCount:2,opeRestingPriority:[]},
  })
  state.nextPlanningTime=.25;state.returnDeadlines={retained:.5}
  const before=structuredClone(state)
  let snapshots=0
  const unexpectedRate=()=>{throw new Error('the physical rate snapshot must be used')}
  const physicalRates={workRate:unexpectedRate,recoveryRate:unexpectedRate,snapshotRates:()=>{snapshots++;return {work:{A:2},recovery:{}}}}
  expect(nextRosterEventHours(state,physicalRates,false)).toBe(6)
  expect(nextRosterMoraleEventHours(state,physicalRates)).toBe(6)
  expect(snapshots).toBe(2)
  expect(state.mowerSource).toBeUndefined()
  expect(state).toEqual(before)
 })
})

describe('physical dorm residents across backup slot role changes',()=>{
 it('keeps recovering a resting worker when its bed becomes a fixed primary slot',()=>{
  const state=createRosterRuntime({
   positions:[{id:'work',roomId:'room_1_1',primary:'A',candidates:['X']}],
   beds:[{id:'dormitory_1_2',roomId:'dormitory_1',vip:true}],
   initialMorale:{A:20,X:18,P:24,Idle:17},idleOperators:['P','Idle'],
  })
  state.occupants.work='X';state.bedOccupants.dormitory_1_2='A'
  expect(moraleDerivative(state,'A',rates)).toBe(2)
  // A backup changes planned ownership without making a physical arrangement.
  state.config={...state.config,beds:[],positions:[...state.config.positions,
   {id:'dormitory_1_2',roomId:'dormitory_1',primary:'P',candidates:[],permanent:true,dormitory:true},
  ]}
  expect(moraleDerivative(state,'A',rates)).toBe(2)
  expect(currentMoraleDerivatives(state,rates)).toMatchObject({A:2,X:-1,P:0,Idle:0})
  expect(nextRosterEventHours(state,rates,false)).toBe(2)
  advanceRoster(state,1,rates)
  expect(state.morale).toMatchObject({A:22,X:17,P:24,Idle:17})
  expect(state.bedOccupants).toEqual({dormitory_1_2:'A'})
  expect(state.occupants).toEqual({work:'X'})
 })

 it.each([false,true])('keeps the fixed resident recovering when its slot becomes Free (cached rates: %s)',cached=>{
  const state=createRosterRuntime({
   positions:[{id:'dormitory_1_2',roomId:'dormitory_1',primary:'P',candidates:[],permanent:true,dormitory:true}],
   beds:[],initialMorale:{P:20},
  })
  const observedRates=cached?{...rates,snapshotRates:()=>({work:{},recovery:{P:2}})}:rates
  expect(state.occupants.dormitory_1_2).toBe('P')
  state.config={...state.config,positions:[],beds:[{id:'dormitory_1_2',roomId:'dormitory_1',vip:true}]}
  expect(moraleDerivative(state,'P',observedRates)).toBe(2)
  expect(currentMoraleDerivatives(state,observedRates).P).toBe(2)
  expect(nextRosterEventHours(state,observedRates,false)).toBe(2)
  advanceRoster(state,2,observedRates)
  expect(state.morale.P).toBe(24)
  expect(state.occupants.dormitory_1_2).toBe('P')
  expect(state.bedOccupants).toEqual({})
 })

 it.each(['occupants','bedOccupants'] as const)('keeps Fiammetta at two morale per hour in a fixed slot stored in %s',map=>{
  const state=createRosterRuntime({
   positions:[{id:'dormitory_1_0',roomId:'dormitory_1',primary:'Fia',candidates:[],permanent:true,dormitory:true}],
   beds:[],initialMorale:{Fia:20},fiammetta:{operatorId:'Fia',orderedTargets:[]},
  })
  state.occupants={};state.bedOccupants={};state[map].dormitory_1_0='Fia'
  const boostedRates={workRate:()=>1,recoveryRate:()=>9}
  expect(moraleDerivative(state,'Fia',boostedRates)).toBe(2)
  expect(currentMoraleDerivatives(state,boostedRates).Fia).toBe(2)
  advanceRoster(state,1,boostedRates)
  expect(state.morale.Fia).toBe(22)
 })
})
