import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-bed-takeover-20261016.json'
import {alphaRestingTier,alphaSlotTakable} from './mowerAlphaDorm'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerDormState,MowerSchedulingData} from './mowerSchedulingData'
import {mowerResting} from './mowerOrdinaryPlanning'
import {MowerTaskQueue,toMowerMicros} from './mowerTaskQueue'

function fixture(requesterTier:number,residentTier:number,mood=10,upperLimit=24,observed=true,prediction:number|null=null){
 const operators:Record<string,MowerOperatorState>={},priorities:string[]=[],priorityReplacements:string[]=[],referenced:string[]=[],blacklist:string[]=[]
 for(const [name,tier] of [['requester',requesterTier],['resident',residentTier]] as const){
  const high=[0,1,2,4].includes(tier),isRequester=name==='requester'
  operators[name]=new MowerOperatorState({name,room:high?(isRequester?'work':'owners'):'',index:high?0:-1,
   operatorType:high?'high':'low',restingPriority:tier===4?'standby':tier===2?'low':'high',
   currentRoom:isRequester?(high?'work':''):'dormitory_1',currentIndex:isRequester?(high?0:-1):0,
   mood:isRequester?mood:10,upperLimit:isRequester?upperLimit:24,timeStampMicros:isRequester&&!observed?undefined:0,
   depletionRate:isRequester&&prediction!==null?mood-prediction:0})
  if(tier===0)priorities.push(name)
  if(tier===3)priorityReplacements.push(name)
  if([3,5].includes(tier))referenced.push(name)
  if(tier===7)blacklist.push(name)
 }
 operators.owner=new MowerOperatorState({name:'owner',replacement:referenced})
 const data=new MowerSchedulingData({alpha:true,nowMicros:prediction===null?0:toMowerMicros(1),operators,
  plan:{work:['requester'],owners:['resident'],references:['owner'],dormitory_1:['Free']},
  dorms:[new MowerDormState(['dormitory_1',0],'resident',toMowerMicros(4))],restingPriorityNames:priorities,
  priorityReplacement:priorityReplacements,freeBlacklist:blacklist})
 return data
}

describe('Mower bed takeover: retained tier matrix and 84e3926 personal-cap changes',()=>{
 for(const sample of oracle.takeoverMatrix)it(`requester tier ${sample.requesterTier} / resident tier ${sample.residentTier}`,()=>{
  const data=fixture(sample.requesterTier,sample.residentTier)
  expect(alphaRestingTier(data,'requester')).toBe(sample.requesterTier)
  expect(alphaRestingTier(data,'resident')).toBe(sample.residentTier)
  expect(alphaSlotTakable(data,data.dorms[0]!,'requester')).toBe(sample.expected)
 })
 // The immutable 617aef fixture includes a full requester that was exempt at
 // priority tier 0. Native 84e3926 now classifies that dynamic candidate as idle.
 for(const sample of oracle.takeoverBoundaries.filter(sample=>sample.name!=='priority-near-full'))it(sample.name,()=>{
  const data=fixture(sample.requesterTier,6,sample.mood,sample.upperLimit,sample.observed,sample.prediction)
  expect(alphaSlotTakable(data,data.dorms[0]!,'requester')).toBe(sample.expected)
 })
 it('does not displace an unfinished resident for a requester already at its personal cap',()=>{
  const data=fixture(0,6,24)
  expect(alphaRestingTier(data,'requester')).toBe(6)
  expect(alphaSlotTakable(data,data.dorms[0]!,'requester')).toBe(false)
 })
 it.each([0,1,2,3])('releases a measured-full dynamic resident with configured priority %s',tier=>{
  const data=fixture(0,tier),resident=data.operators.resident!
  resident.mood=resident.upperLimit;data.emergencyDormAgents.add('resident')
  expect(alphaRestingTier(data,'resident')).toBe(6)
  expect(alphaSlotTakable(data,data.dorms[0]!,'requester')).toBe(true)
 })
 it('keeps the observed 252 recovery group in bed instead of allowing the inverse group to evict a hunter',()=>{
  const data=fixture(1,2),a=data.operators.resident!,c=data.operators.requester!
  Object.assign(a,{name:'B',room:'deep',index:1,group:'deep',mood:22.85,restingPriority:'low',replacement:['RB']})
  delete data.operators.resident;data.operators.B=a;data.dorms[0]!.name='B'
  Object.assign(c,{name:'C',room:'sense',index:0,group:'sense',mood:12,replacement:['RC']})
  delete data.operators.requester;data.operators.C=c
  data.operators.A=new MowerOperatorState({name:'A',room:'deep',index:0,group:'deep',operatorType:'high',restingPriority:'high',mood:8.4367,timeStampMicros:0,replacement:['RA'],currentRoom:'dormitory_1',currentIndex:1})
  data.operators.D=new MowerOperatorState({name:'D',room:'sense',index:1,group:'sense',operatorType:'high',restingPriority:'high',mood:12,timeStampMicros:0,replacement:['RD'],currentRoom:'sense',currentIndex:1})
  c.currentRoom='sense';c.currentIndex=0
  for(const [name,room,index] of [['RA','deep',0],['RB','deep',1],['RC','',-1],['RD','',-1]] as const)data.operators[name]=new MowerOperatorState({name,currentRoom:room,currentIndex:index,mood:24,timeStampMicros:0})
  data.plan={deep:['A','B'],sense:['C','D'],dormitory_1:['Free','Free','Free']}
  data.dorms.push(new MowerDormState(['dormitory_1',1],'A',toMowerMicros(5)),new MowerDormState(['dormitory_1',2]))
  data.restingPriorityNames=['A']
  const before=JSON.stringify(data)
  expect(mowerResting(data,new MowerTaskQueue())).toEqual({})
  expect(JSON.stringify(data)).toBe(before)
 })
})
