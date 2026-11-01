// Shared identity, priority and takeover rules; actual room I/O stays in the adapter.
// October 3 alpha b2d9ac85fe070e805aadf0d5f44fc095c1e95253 (Mower, MIT).
import {mowerDormCandidateMood} from './mowerDormMood'
import {hasRestingMood} from './mowerOperatorState'
import type {MowerSchedulingData} from './mowerSchedulingData'

export const alphaPosition=(room:string,index:number)=>room+'\0'+index
/** Personal-cap candidates release recovery priority unless the post or policy retains them. */
export function alphaFullDynamicCandidate(data:MowerSchedulingData,name:string):boolean{
 const op=data.operators[name]
 if(!op||op.isHigh()&&op.room.startsWith('dorm')||data.freeRoomExclusions.includes(name))return false
 const mood=mowerDormCandidateMood(data,name)
 return mood!==undefined&&mood>=op.upperLimit
}
export function alphaFullDormFiller(data:MowerSchedulingData,name:string):boolean{
 const op=data.operators[name]
 if(!op?.isResting()||!alphaFullDynamicCandidate(data,name))return false
 const tier=alphaRestingTier(data,name)
 return tier>3&&tier<7&&hasRestingMood(op,data.nowMicros)&&op.timeStampMicros!<=data.nowMicros&&!op.moodIsPrediction&&op.mood>=op.upperLimit
}
export function alphaRestingTier(data:MowerSchedulingData,name:string,referencedReplacements?:ReadonlySet<string>):number{
 const op=data.operators[name]
 if(data.freeBlacklist.includes(name)||op?.workaholic)return 7
 if(alphaFullDynamicCandidate(data,name))return 6
 if(data.restingPriorityNames.includes(name))return 0
 if(data.standbyNames.includes(name))return 4
 const replacement=data.priorityReplacement.includes(name)?3:5
 if(op){
  if(op.room==='train'&&op.index===0||op.currentRoom==='train'&&op.currentIndex===0)return replacement
  if(op.isHigh())return {high:1,low:2,standby:4}[op.restingPriority]
  if(op.restingFromTrain)return replacement
 }
 return (referencedReplacements?.has(name)??Object.values(data.operators).some(owner=>owner.nativeName!=='菲亚梅塔'&&(owner.replacement.includes(name)||owner.groupBindings.some(binding=>binding.replacement.includes(name)))))?replacement:6
}
export function alphaRestingKey(data:MowerSchedulingData,name:string):[number,number]{return [alphaRestingTier(data,name),(mowerDormCandidateMood(data,name)??24)-(data.operators[name]?.upperLimit??24)]}
export const compareAlphaKeys=(a:readonly number[],b:readonly number[])=>a[0]!-b[0]!||a[1]!-b[1]!

export function alphaBedTakeoverAllowed(data:MowerSchedulingData,requester:string,resident:string):boolean{
 const requesterTier=alphaRestingTier(data,requester),residentTier=alphaRestingTier(data,resident)
 if(alphaFullDynamicCandidate(data,requester)||requesterTier===7||residentTier<=3)return false
 const incoming=data.operators[requester],mood=mowerDormCandidateMood(data,requester)
 if(alphaFullDormFiller(data,resident))return !!incoming&&mood!==undefined&&mood<incoming.upperLimit
 if(!(requesterTier<residentTier&&residentTier<7))return false
 return requesterTier<=3||!!incoming&&mood!==undefined&&mood<=incoming.upperLimit*.8
}
