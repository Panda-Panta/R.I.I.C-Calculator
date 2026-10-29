import {describe,expect,it,vi} from 'vitest'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {mowerReplacementDependencyNames} from './mowerReplacementCoordination'
import {MowerSchedulingData} from './mowerSchedulingData'
import {commitMowerGroupShifts,mowerRestingBindingGroups,mowerSharedReplacements} from './mowerSharedGroups'

function fixture(operators:MowerOperatorOptions[],groupShiftState:Record<string,boolean>={}):MowerSchedulingData {
 return new MowerSchedulingData({alpha:true,operators:Object.fromEntries(operators.map(op=>[op.name,new MowerOperatorState(op)])),plan:{},dorms:[],groupDorms:[],nowMicros:0,groupShiftState})
}

// Frozen pre-index closure. Its ordered result is the observable dependency contract.
function scannedDependencies(data:MowerSchedulingData,seeds:Iterable<string>):Set<string>{
 const names=new Set(seeds);let changed=true
 while(changed){
  changed=false
  const add=(name:string)=>{if(name&&!names.has(name)){names.add(name);changed=true}}
  for(const op of Object.values(data.operators)){
   const covers=op.multiGroup?mowerSharedReplacements(op,mowerRestingBindingGroups(data,op)):op.replacement
   const peers=op.group?data.shiftGroupMembers(op.group):[]
   if(names.has(op.name)||covers.some(name=>names.has(name))||peers.some(name=>names.has(name))){add(op.name);covers.filter(name=>name!=='Free').forEach(add);peers.forEach(add)}
  }
 }
 return names
}

function expectScanParity(data:MowerSchedulingData,seeds:readonly string[]):string[]{
 const before=JSON.stringify(data),expected=[...scannedDependencies(data,seeds)],actual=[...mowerReplacementDependencyNames(data,seeds)]
 expect(actual).toEqual(expected)
 expect(JSON.stringify(data)).toBe(before)
 return actual
}

describe('replacement dependency group index preserves the scanned closure',()=>{
 it('follows shared covers, reverse owners and same-group peers across closure passes',()=>{
  const data=fixture([
   {name:'A',group:'g',replacement:['X']},
   {name:'B',group:'h',replacement:['X','Y']},
   {name:'C',group:'g',replacement:['Z']},
   {name:'X'},{name:'Y'},{name:'Z'},
   {name:'Unrelated',group:'q',replacement:['Q']},{name:'Q'},
  ])
  expect(expectScanParity(data,['B'])).toEqual(['B','X','Y','A','C','Z'])
 })

 it('uses Object.values order even when integer keys change insertion order',()=>{
  const data=fixture([{name:'10',group:'g'},{name:'First',group:'g'},{name:'2',group:'g'}])
  expect(Object.values(data.operators).map(op=>op.name)).toEqual(['2','10','First'])
  expect(expectScanParity(data,['First'])).toEqual(['First','2','10'])
 })

 it('keeps ordinary single-binding membership on op.group and does not link empty groups',()=>{
  const data=fixture([
   {name:'Stored',group:'stored'},
   {name:'Single',group:'active',groupBindings:[{group:'stored',replacement:[]}]},
   {name:'Active',group:'active'},
   {name:'IdleA'},{name:'IdleB'},
  ])
  expect(expectScanParity(data,['Stored'])).toEqual(['Stored'])
  expect(expectScanParity(data,['Active'])).toEqual(['Active','Single'])
  expect(expectScanParity(data,['IdleA'])).toEqual(['IdleA'])
  expect(expectScanParity(data,['','Unknown'])).toEqual(['','Unknown'])
  expect(expectScanParity(data,[])).toEqual([])
 })

 it('includes every shared binding once, retains independent followers, and excludes Free additions',()=>{
  const data=fixture([
   {name:'Anchor',group:'g',replacement:['Free']},
   {name:'Shared',group:'h',replacement:['Y'],groupBindings:[{group:'g',replacement:['X']},{group:'g',replacement:['Unused']},{group:'h',replacement:['Y']}]},
   {name:'Independent',room:'factory',groupBindings:[{group:'',replacement:['Idle']},{group:'g',replacement:['X']}]},
   {name:'Other',group:'h'},
   {name:'X'},{name:'Y'},{name:'Idle'},{name:'Unused'},
  ],{g:true,h:false})
  expect(data.operators.Independent!.group).toBe('')
  expect(data.shiftGroupMembers('g')).toEqual(['Anchor','Shared','Independent'])
  expect(expectScanParity(data,['Anchor'])).toEqual(['Anchor','Shared','Independent','X','Other'])
  expect(expectScanParity(data,['Anchor'])).not.toContain('Free')
  expect(expectScanParity(data,['Free'])).toContain('Free')
 })

 it('rebuilds after live group transitions and binding changes between calls',()=>{
  const data=fixture([
   {name:'A',group:'g'},
   {name:'Shared',room:'factory',group:'g',groupBindings:[{group:'g',replacement:['X']},{group:'h',replacement:['Y']}]},
   {name:'B',group:'h'},
   {name:'Detached',group:'j'},
   {name:'X'},{name:'Y'},
  ],{g:true,h:false,j:false})
  expect(expectScanParity(data,['A'])).toContain('X')
  expect(expectScanParity(data,['A'])).not.toContain('Y')
  commitMowerGroupShifts(data,{g:false,h:true})
  expect(data.operators.Shared!.group).toBe('h')
  expect(expectScanParity(data,['A'])).toContain('Y')
  expect(expectScanParity(data,['A'])).not.toContain('X')
  data.operators.Shared!.groupBindings=[{group:'h',replacement:['Y']},{group:'j',replacement:['Y']}]
  expect(expectScanParity(data,['A'])).toEqual(['A'])
  expect(expectScanParity(data,['B'])).toContain('Detached')
  data.operators.Detached!.group='g'
  expect(expectScanParity(data,['A'])).toEqual(['A','Detached'])
 })

 it.each(Array.from({length:24},(_,seed)=>seed))('matches the old ordered closure for mixed binding graph %i',seed=>{
  const names=Array.from({length:24},(_,index)=>'Op'+index)
  const data=fixture(names.map((name,index)=>{
   const group=index%6===0?'':'g'+((index+seed)%5)
   const replacement=index%4===0?['Free',names[(index+seed+3)%names.length]!]:[names[(index+seed+1)%names.length]!]
   return {name,room:index%7===0?'dormitory_1':'factory',group,replacement,
    groupBindings:index%5===0?[{group,replacement},{group:'g'+((index+seed+2)%5),replacement:[names[(index+9)%names.length]!]},{group,replacement}]:index%5===1?[{group:'stored',replacement}]:[]}
  }),Object.fromEntries(Array.from({length:5},(_,index)=>['g'+index,(index+seed)%2===0])))
  for(const seeds of [[names[seed]!],[names[(seed+1)%24]!,names[(seed+7)%24]!],['Unknown'],['Free']])expectScanParity(data,seeds)
 })

 it('avoids repeated full-roster group scans during one 432-operator dependency closure',()=>{
  const data=fixture(Array.from({length:432},(_,index)=>({name:'Op'+index,group:'g'+index%24,replacement:['Op'+(index+1)%432]})))
  const scan=vi.spyOn(data,'shiftGroupMembers')
  const expected=[...scannedDependencies(data,['Op0'])]
  expect(scan.mock.calls.length).toBeGreaterThanOrEqual(432)
  scan.mockClear()
  expect([...mowerReplacementDependencyNames(data,['Op0'])]).toEqual(expected)
  expect(scan).not.toHaveBeenCalled()
  scan.mockRestore()
 })
})
