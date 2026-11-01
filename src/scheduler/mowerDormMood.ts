// Shared observed-card estimates, Mower alpha b2d9ac8 (MIT).
import {hasRestingMood,restingMood} from './mowerOperatorState'
import type {MowerSchedulingData} from './mowerSchedulingData'
import {toMowerMicros} from './mowerTaskQueue'

export function mowerDormCandidateMood(data:MowerSchedulingData,name:string):number|undefined {
 return mowerSchedulingMoodObservation(data,name)?.[0]
}
export function mowerSchedulingMoodObservation(data:MowerSchedulingData,name:string):[number,number]|undefined {
 const op=data.operators[name],estimate=data.dormMoodEstimates.get(name),elapsed=estimate?data.nowMicros-estimate[1]:-1
 const measured=hasRestingMood(op,data.nowMicros)&&!op!.moodIsPrediction&&op!.timeStampMicros!<=data.nowMicros
 if(estimate&&Number.isFinite(estimate[0])&&estimate[0]>=0&&estimate[0]<=24&&elapsed>=0&&elapsed<toMowerMicros(1)&&(!measured||estimate[1]>op!.timeStampMicros!))return [estimate[0],estimate[1]]
 return measured?[op!.isResting()?op!.mood:restingMood(op,data.nowMicros),op!.timeStampMicros!]:undefined
}
