import {describe,it,expect} from 'vitest'
import native from './fixtures/mower-resting-priority-alpha.json'
import {MowerOperatorState,type MowerOperatorOptions} from './mowerOperatorState'
import {
 mowerRestingTier,mowerRestingKey,mowerUnregisteredIdleCandidates,registerMowerRestingOperator,mowerCanStandby,
 mowerRescueMoodThreshold,mowerRestingMoodThreshold,updateMowerStandbyLowPriority,hasMowerRestingAnchor,isMowerStandby,
 mowerStandbyCanYield,legacyMowerStandbyCanYield,mowerStandbyCandidates,
 type MowerRegisteredRestingOperator,type MowerRestingRegistrationState,type MowerRestingAnchorSeam,type MowerRestingPriorityConfig,
} from './mowerRestingPriority'
interface ObservedOperator extends Omit<MowerOperatorOptions,'timeStampMicros'|'idleRestCheck'> {
 timeStampMicros:number|null;idleRestCheck:[number,number,number|undefined]|null;dormMoodFallback:string;dormMoodPeers:Record<string,unknown>;
 refreshOrderRooms:[boolean,string[]];refreshDrained:boolean;arrangeOrder:unknown;
}
interface Input {
 customHookError?:boolean;lingHookError?:boolean;action:'inspect'|'register'|'update'|'standby';experimental:boolean;nowMicros:number;agentList:string[];
 config:MowerRestingPriorityConfig;plan:MowerRestingRegistrationState['plan'];operators:Record<string,ObservedOperator>;
 shadowCopy:Record<string,ObservedOperator>;groups:Record<string,string[]>;exhaustAgent:string[];exhaustGroup:string[];workaholicAgent:string[];restInFullGroup:string[];
 agentArrangeOrder:Record<string,unknown>;names:string[];dorms:{name:string;position:[string,number];effective:boolean}[];
 recoveryDormIndices:Record<string,number>;customMoodNames:string[];excluded:string[];incoming?:ObservedOperator;
 events:{name:string;returned:boolean;mood?:number}[];customHookChanges:Record<string,{lower:number;upper:number}>;lingHookChanges:Record<string,{lower:number;upper:number}>;
}
const fields=['name','room','index','group','replacement','operatorType','restingPriority','currentRoom','currentIndex','mood','timeStampMicros','depletionRate',
 'upperLimit','lowerLimit','workaholic','exhaustRequire','restInFull','standbyLowPriority','restingFromTrain','dormPositionVersion','dormRecoveryRoom',
 'dormRecoveryIndex','dormRecoveryFixed','dormMoodFallback','dormMoodPeers','idleRestCheck','refreshOrderRooms','refreshDrained','arrangeOrder']
function observed(raw:ObservedOperator):MowerRegisteredRestingOperator{
 const {timeStampMicros,idleRestCheck,...options}=raw
 const op:MowerRegisteredRestingOperator=new MowerOperatorState({...options,timeStampMicros:timeStampMicros??undefined,idleRestCheck:idleRestCheck??undefined})
 op.dormMoodFallback=raw.dormMoodFallback;op.dormMoodPeers=structuredClone(raw.dormMoodPeers);op.refreshOrderRooms=structuredClone(raw.refreshOrderRooms)
 op.refreshDrained=raw.refreshDrained;op.arrangeOrder=structuredClone(raw.arrangeOrder);return op
}
function serialized(op:MowerRegisteredRestingOperator):Record<string,unknown>{
 const object=op as unknown as Record<string,unknown>
 return Object.fromEntries(fields.map(key=>[key,object[key]??null]))
}
function run(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid native fixture object')
 const input=structuredClone(raw) as Input
 if(!['inspect','register','update','standby'].includes(input.action)||!Number.isSafeInteger(input.nowMicros))throw new Error('Invalid native fixture protocol')
 const clock=input.nowMicros,trace:Record<string,unknown>[]=[],events:Record<string,unknown>[]=[]
 const state:MowerRestingRegistrationState={
  experimental:input.experimental,nowMicros:()=>clock,nativeName:name=>name,agentList:input.agentList,config:input.config,plan:input.plan,
  operators:Object.fromEntries(Object.entries(input.operators).map(([name,op])=>[name,observed(op)])),
  shadowCopy:Object.fromEntries(Object.entries(input.shadowCopy).map(([name,op])=>[name,observed(op)])),
  groups:input.groups,exhaustAgent:new Set(input.exhaustAgent),exhaustGroup:new Set(input.exhaustGroup),workaholicAgent:new Set(input.workaholicAgent),restInFullGroup:new Set(input.restInFullGroup),
  agentArrangeOrder:input.agentArrangeOrder,
 }
 const originalOps={...state.operators}
 const seam:MowerRestingAnchorSeam={
  dorms:input.dorms,isEffectiveFreeSlot:bed=>{
   const actual=input.dorms.find(item=>item===bed)
   if(!actual)throw new Error('Explicit actual effective bed observation required');return actual.effective
  },recoveryDormIndex:name=>input.recoveryDormIndices[name],
 }
 let incoming:MowerRegisteredRestingOperator|undefined,result:Record<string,unknown>|null=null,error:{name:string;message:string}|null=null
 try{
  if(input.action==='register'){
   incoming=observed(input.incoming!)
   registerMowerRestingOperator(state,incoming,{
    setCurrentRoomFromShadow:(op,room)=>{trace.push({kind:'shadow-position-copy',field:'currentRoom',value:room});op.currentRoom=room},
    setCurrentIndexFromShadow:(op,index)=>{trace.push({kind:'shadow-position-copy',field:'currentIndex',value:index});op.currentIndex=index},
    applyCustomMoodLimits:op=>{
     trace.push({kind:'custom-limits',name:op.name,registered:state.operators[op.name]===op})
     if(input.customHookError){const e=new Error('custom failed');e.name='ValueError';throw e}
     for(const [name,limits] of Object.entries(input.customHookChanges)){state.operators[name]!.lowerLimit=limits.lower;state.operators[name]!.upperLimit=limits.upper}
    },
    applyLingXiMoodLimits:()=>{
     trace.push({kind:'ling-limits',operatorNames:Object.keys(state.operators)})
     if(input.lingHookError){const e=new Error('ling failed');e.name='ValueError';throw e}
     for(const [name,limits] of Object.entries(input.lingHookChanges)){state.operators[name]!.lowerLimit=limits.lower;state.operators[name]!.upperLimit=limits.upper}
    },
   })
  }else if(input.action==='update'){
   for(const event of input.events){
    const op=state.operators[event.name]!
    if(event.mood!==undefined)op.mood=event.mood
    updateMowerStandbyLowPriority(state,op,undefined,event.returned)
    events.push({low:op.standbyLowPriority,tier:mowerRestingTier(state,op.name),key:mowerRestingKey(state,op.name)})
   }
  }
  if(input.action==='standby'){
   // Build the same complete native result atomically: a KeyError leaves result None.
   const need=(name:string)=>{
    const op=state.operators[name];if(!op){const e=new Error("'"+name+"'");e.name='KeyError';throw e}return op
   }
   result={
    can:Object.fromEntries(input.names.map(name=>[name,mowerCanStandby(state,need(name))])),
    yielding:Object.fromEntries(input.names.map(name=>[name,mowerStandbyCanYield(state,need(name))])),
    legacyYielding:Object.fromEntries(input.names.map(name=>[name,legacyMowerStandbyCanYield(state,need(name))])),
    actual:Object.fromEntries(input.names.map(name=>[name,isMowerStandby(state,name,seam)])),
    candidates:[...mowerStandbyCandidates(state,input.names,seam)].sort(),anchor:hasMowerRestingAnchor(state,seam),groupAnchor:hasMowerRestingAnchor(state,seam,'g'),
   }
  }else{
   result={
    tiers:Object.fromEntries(input.names.map(name=>[name,mowerRestingTier(state,name)])),
    keys:Object.fromEntries(input.names.map(name=>[name,mowerRestingKey(state,name)])),
    ordered:[...input.names].sort((a,b)=>{const aa=mowerRestingKey(state,a),bb=mowerRestingKey(state,b);return aa[0]-bb[0]||aa[1]-bb[1]}),
    idle:mowerUnregisteredIdleCandidates(state,input.excluded),
    rescue:Object.fromEntries(input.names.filter(name=>name in state.operators).map(name=>[name,mowerRescueMoodThreshold(state,state.operators[name]!)])),
    resting:Object.fromEntries(input.names.filter(name=>name in state.operators).map(name=>[name,mowerRestingMoodThreshold(state,state.operators[name]!,key=>input.customMoodNames.includes(key))])),
   }
  }
 }catch(caught){if(!(caught instanceof Error))throw caught;error={name:caught.name,message:caught.message}}
 let registration:Record<string,unknown>|null=null
 if(incoming){
  const saved=state.shadowCopy[incoming.name]
  registration={incoming:serialized(incoming),inserted:state.operators[incoming.name]===incoming,
   operatorMapIdentity:Object.fromEntries(Object.entries(state.operators).map(([name,op])=>[name,op===originalOps[name]])),
   peersContainerIsShadow:saved?incoming.dormMoodPeers===saved.dormMoodPeers:null,
   peerValuesRetained:saved?Object.entries(incoming.dormMoodPeers??{}).every(([key,value])=>value===saved.dormMoodPeers?.[key]):null,
   fixedIsShadow:saved?incoming.dormRecoveryFixed===saved.dormRecoveryFixed:null,
  }
 }
 return {result,exception:error,events,trace,nowMicros:clock,operators:Object.fromEntries(Object.entries(state.operators).map(([name,op])=>[name,serialized(op)])),groups:state.groups,
  exhaustAgent:[...state.exhaustAgent].sort(),exhaustGroup:[...state.exhaustGroup].sort(),workaholicAgent:[...state.workaholicAgent].sort(),restInFullGroup:[...state.restInFullGroup].sort(),registration}
}
describe('actual pinned resting tiers, registration and standby policy',()=>{
 it.each(native.cases)('matches complete source effects and identity: $name',test=>{
  expect(native.sourceCommit).toBe('c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88')
  expect(run(test.input)).toEqual(test.output)
 })
})
