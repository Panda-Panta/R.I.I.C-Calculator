import {describe,expect,it} from 'vitest'
import {advanceRoster,createRosterRuntime,currentMoraleDerivatives,moraleDerivative,nextRosterEventHours} from './rosterRuntime'

const rates={workRate:()=>1,recoveryRate:()=>2}

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
