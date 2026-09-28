/**
 * resting_priority and Operators.add/standby policy, pinned alpha
 * c6bdbb292fe7fcd84c6dfb66154a12a1a9bc5b88 (MIT, Copyright 2021 Nano).
 * Names/config/plan use the same resolved keys; nativeName supplies literal source names.
 * Actual dorm validity and mood-limit
 * application remain explicit source dependencies; this is not the full dorm lifecycle.
 */
import {MowerOperatorState,hasRestingMood,restingMood} from './mowerOperatorState'
export const MOWER_RESTING_TIER={PRIORITY:0,MAIN:1,LOW_MAIN:2,PRIORITY_REPLACEMENT:3,STANDBY:4,REPLACEMENT:5,IDLE:6,EXCLUDED:7} as const
export type MowerRestingTier=typeof MOWER_RESTING_TIER[keyof typeof MOWER_RESTING_TIER]
const R=MOWER_RESTING_TIER,TRADE_AGENTS=['但书','龙舌兰','佩佩','可露希尔']
export interface MowerRestingPriorityConfig {
 freeBlacklist:readonly string[];workaholic:readonly string[];opeRestingPriority:readonly string[];
 restingPriorityReplacement:readonly string[];restingPriority:readonly string[];restingStandby:readonly string[];
 exhaustRequire:readonly string[];restInFull:readonly string[];refreshTradingConfig:readonly string[];refreshDrained:readonly string[];
 restingThreshold:number;rescueThreshold:number
}
export interface MowerRestingPriorityState {
 experimental:boolean;nowMicros():number;nativeName(name:string):string;config:MowerRestingPriorityConfig
 agentList:readonly string[];plan:Readonly<Record<string,readonly {agent:string;replacement:readonly string[]}[]>>
 operators:Record<string,MowerRegisteredRestingOperator>;groups:Record<string,string[]>
}
export interface MowerRegisteredRestingOperator extends MowerOperatorState {
 refreshDrained?:boolean;arrangeOrder?:unknown;dormMoodFallback?:string;dormMoodPeers?:Record<string,unknown>
}
export interface MowerRestingRegistrationState extends MowerRestingPriorityState {
 shadowCopy:Record<string,MowerRegisteredRestingOperator>;agentArrangeOrder:Readonly<Record<string,unknown>>
 groups:Record<string,string[]>;exhaustAgent:Set<string>;exhaustGroup:Set<string>;workaholicAgent:Set<string>;restInFullGroup:Set<string>
}
export interface MowerRestingRegistrationSeam {
 /** Caller supplies actual source cache setters, including current_room_changed callbacks. */
 setCurrentRoomFromShadow(operator:MowerRegisteredRestingOperator,room:string):void
 setCurrentIndexFromShadow(operator:MowerRegisteredRestingOperator,index:number):void
 applyCustomMoodLimits(operator:MowerRegisteredRestingOperator):void
 applyLingXiMoodLimits():void
}
export interface MowerRestingAnchorSeam {
 dorms:readonly {name:string;position:readonly [string,number]}[]
 isEffectiveFreeSlot(bed:MowerRestingAnchorSeam['dorms'][number]):boolean
 /** Actual source get_dorm_by_name index. undefined is native None. */
 recoveryDormIndex(name:string):number|undefined
}
export class MowerRestingKeyError extends Error {
 constructor(key:string){super("'"+key+"'");this.name='KeyError'}
}
function requiredOperator(state:MowerRestingPriorityState,name:string):MowerRegisteredRestingOperator{
 const op=Object.prototype.hasOwnProperty.call(state.operators,name)?state.operators[name]:undefined;if(!op)throw new MowerRestingKeyError(name);return op
}
const replacementTier=(state:MowerRestingPriorityState,name:string):MowerRestingTier=>
 state.experimental&&state.config.restingPriorityReplacement.includes(name)?R.PRIORITY_REPLACEMENT:R.REPLACEMENT
export function mowerRestingTier(state:MowerRestingPriorityState,name:string):MowerRestingTier{
 const op=Object.prototype.hasOwnProperty.call(state.operators,name)?state.operators[name]:undefined,config=state.config
 if(config.freeBlacklist.includes(name)||op?.workaholic)return R.EXCLUDED
 if(config.opeRestingPriority.includes(name))return R.PRIORITY
 if(op){
  if(op.room==='train'&&op.index===0||op.currentRoom==='train'&&op.currentIndex===0)return replacementTier(state,name)
  if(op.isHigh()){
   if(state.experimental&&op.restingPriority==='standby'&&op.standbyLowPriority)return R.LOW_MAIN
   const tier={high:R.MAIN,low:R.LOW_MAIN,standby:R.STANDBY}[op.restingPriority]
   if(tier===undefined)throw new MowerRestingKeyError(op.restingPriority)
   return tier
  }
  if(op.restingFromTrain)return replacementTier(state,name)
 }
 return Object.values(state.plan).some(slots=>slots.some(slot=>state.nativeName(slot.agent)!=='菲亚梅塔'&&slot.replacement.includes(name)))?replacementTier(state,name):R.IDLE
}
export function mowerRestingKey(state:MowerRestingPriorityState,name:string,nowMicros=state.nowMicros()):[MowerRestingTier,number]{
 const op=Object.prototype.hasOwnProperty.call(state.operators,name)?state.operators[name]:undefined
 return [mowerRestingTier(state,name),restingMood(op,nowMicros)-(state.experimental?(op?.upperLimit??24):0)]
}
export function mowerUnregisteredIdleCandidates(state:MowerRestingPriorityState,excluded:Iterable<string>=[]):string[]{
 const reject=new Set([...excluded,...state.config.freeBlacklist,...state.config.workaholic])
 return state.agentList.filter(name=>!Object.prototype.hasOwnProperty.call(state.operators,name)&&!reject.has(name))
}
function refreshTrading(config:MowerRestingPriorityConfig,name:string):[boolean,string[]]{
 const match=config.refreshTradingConfig.find(entry=>entry.toLowerCase().includes(name))
 if(match===undefined)return [false,[]]
 const remaining=match.split(name).join('');return [true,remaining?remaining.split(','):[]]
}
/** Full native add control flow, with actual custom/Ling-Xi application supplied synchronously. */
export function registerMowerRestingOperator(state:MowerRestingRegistrationState,operator:MowerRegisteredRestingOperator,seam:MowerRestingRegistrationSeam):void{
 const name=operator.name,config=state.config
 if(!state.agentList.includes(name))return
 if(config.restingPriority.includes(name))operator.restingPriority='low'
 operator.exhaustRequire=config.exhaustRequire.includes(name);operator.restInFull=config.restInFull.includes(name);operator.workaholic=config.workaholic.includes(name)
 operator.refreshOrderRooms=refreshTrading(config,state.nativeName(name));operator.refreshDrained=config.refreshDrained.includes(name)
 if(Object.prototype.hasOwnProperty.call(state.agentArrangeOrder,name))operator.arrangeOrder=state.agentArrangeOrder[name]
 const saved=state.shadowCopy[name]
 if(saved){
  operator.mood=saved.mood;operator.timeStampMicros=saved.timeStampMicros;operator.depletionRate=saved.depletionRate
  seam.setCurrentRoomFromShadow(operator,saved.currentRoom);seam.setCurrentIndexFromShadow(operator,saved.currentIndex)
  operator.dormPositionVersion=saved.dormPositionVersion??0;operator.dormRecoveryRoom=saved.dormRecoveryRoom??'';operator.dormRecoveryIndex=saved.dormRecoveryIndex??-1
  operator.restingFromTrain=saved.restingFromTrain??false;operator.dormRecoveryFixed=saved.dormRecoveryFixed??[]
  operator.dormMoodFallback=saved.dormMoodFallback??'';operator.dormMoodPeers={...(saved.dormMoodPeers??{})}
  operator.idleRestCheck=saved.idleRestCheck;operator.standbyLowPriority=saved.standbyLowPriority??false
 }
 state.operators[name]=operator
 seam.applyCustomMoodLimits(operator)
 if(state.experimental)seam.applyLingXiMoodLimits()
 if(operator.exhaustRequire&&!(operator.group&&operator.room.startsWith('dorm'))){
  state.exhaustAgent.add(name);if(operator.group)state.exhaustGroup.add(operator.group)
 }
 if(operator.group){
  if(!Object.prototype.hasOwnProperty.call(state.groups,operator.group))Object.defineProperty(state.groups,operator.group,{value:[],writable:true,enumerable:true,configurable:true})
  state.groups[operator.group]!.push(name)
 }
 if(operator.workaholic)state.workaholicAgent.add(name)
 if(operator.restInFull&&!(operator.group&&operator.room.startsWith('dorm'))&&operator.group)state.restInFullGroup.add(operator.group)
 if(config.restingStandby.includes(name)&&operator.isHigh()&&(operator.group||state.experimental)&&!operator.room.startsWith('dorm')&&
  !operator.workaholic&&!operator.exhaustRequire&&!operator.restInFull&&(state.experimental||!operator.workshop))operator.restingPriority='standby'
 if(operator.restingPriority!=='standby')operator.standbyLowPriority=false
}
export function mowerCanStandby(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator):boolean{
 return op.isHigh()&&!!(op.group||state.experimental)&&op.restingPriority==='standby'&&!op.standbyLowPriority&&!op.room.startsWith('dorm')&&
  !op.workaholic&&!op.exhaustRequire&&!op.restInFull&&(state.experimental||!op.workshop)
}
export const mowerRescueMoodThreshold=(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator)=>
 op.lowerLimit+(op.upperLimit-op.lowerLimit)*(state.config.restingThreshold*state.config.rescueThreshold)
export function mowerRestingMoodThreshold(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator,hasCustomMoodLimits:(name:string)=>boolean):number{
 const threshold=op.lowerLimit+(op.upperLimit-op.lowerLimit)*state.config.restingThreshold
 return hasCustomMoodLimits(op.name)?threshold:Math.trunc(threshold)
}
export function updateMowerStandbyLowPriority(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator,nowMicros=state.nowMicros(),returnedToPost=false):void{
 if(!state.experimental||!state.config.restingStandby.includes(op.name)||returnedToPost){op.standbyLowPriority=false;return}
 if(restingMood(op,nowMicros)<mowerRescueMoodThreshold(state,op))op.standbyLowPriority=true
}
export function hasMowerRestingAnchor(state:MowerRestingPriorityState,seam:MowerRestingAnchorSeam,group?:string):boolean{
 return seam.dorms.some(bed=>{
  const op=state.operators[bed.name]
  return !!op&&seam.isEffectiveFreeSlot(bed)&&op.isHigh()&&op.restingPriority==='high'&&(group===undefined||op.group===group)
 })
}
export function isMowerStandby(state:MowerRestingPriorityState,name:string,seam:MowerRestingAnchorSeam):boolean{
 const op=requiredOperator(state,name)
 if(!mowerCanStandby(state,op)||op.currentRoom)return false
 const cover=Object.values(state.operators).find(candidate=>candidate.currentRoom===op.room&&candidate.currentIndex===op.index)
 if(!cover||!op.replacement.includes(cover.name)||TRADE_AGENTS.includes(state.nativeName(cover.name)))return false
 if(!op.group)return hasMowerRestingAnchor(state,seam)
 // Native group lists may differ from simply collecting every op with a matching group.
 const members=Object.prototype.hasOwnProperty.call(state.groups,op.group)?state.groups[op.group]!:[]
 return members.some(memberName=>{
  const member=requiredOperator(state,memberName)
  return member.isHigh()&&member.restingPriority==='high'&&!member.room.startsWith('dorm')&&!member.workaholic&&(state.experimental||!member.workshop)&&
   member.isResting()&&seam.recoveryDormIndex(member.name)!==undefined
 })
}
export function mowerStandbyCanYield(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator):boolean{
 if(!mowerCanStandby(state,op))return false
 const now=state.nowMicros(),mood=restingMood(op,now)
 return hasRestingMood(op,now)&&mood>=mowerRescueMoodThreshold(state,op)
}
export const legacyMowerStandbyCanYield=(state:MowerRestingPriorityState,op:MowerRegisteredRestingOperator)=>
 !state.experimental&&mowerStandbyCanYield(state,op)
export function mowerStandbyCandidates(state:MowerRestingPriorityState,names:readonly string[],seam:MowerRestingAnchorSeam):Set<string>{
 const anchorGroups=new Set(names.map(name=>requiredOperator(state,name)).filter(op=>
  !!op.group&&op.isHigh()&&op.restingPriority==='high'&&!op.workaholic&&(state.experimental||!op.workshop)&&!op.room.startsWith('dorm')&&
  op.mood>=0&&op.mood<op.upperLimit&&op.currentMood(state.nowMicros())<op.upperLimit,
 ).map(op=>op.group))
 return new Set(names.filter(name=>{
  const op=requiredOperator(state,name)
  return mowerCanStandby(state,op)&&(anchorGroups.has(op.group)||!op.group&&hasMowerRestingAnchor(state,seam))
 }))
}
