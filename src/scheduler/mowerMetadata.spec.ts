import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-metadata-alpha-cases.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MOWER_TASK_TYPES as T,MowerTask,MowerTaskQueue,toMowerMicros} from './mowerTaskQueue'
import {planMowerMetadata} from './mowerMetadata'
describe('actual pinned Python plan_metadata matrix',()=>{
 for(const fixture of oracle.cases)it(fixture.id,()=>{
  const input=fixture.input;const planned=new Set(Object.values(input.plan).flatMap(slots=>(slots as {agent:string;replacement:string[]}[]).flatMap(slot=>[slot.agent,...slot.replacement])));const operators=Object.fromEntries(input.operators.map(o=>[o.name,new MowerOperatorState({name:o.name,room:o.room,index:o.index,group:o.group,replacement:o.replacement,operatorType:o.operator_type==='high'?'high':'low',restingPriority:o.resting_priority==='low'?'low':o.resting_priority==='standby'?'standby':'high',mood:o.mood,lowerLimit:o.lower_limit,upperLimit:o.upper_limit,restInFull:o.rest_in_full,exhaustRequire:o.exhaust_require,workaholic:o.workaholic,currentRoom:o.current_room,currentIndex:o.current_index,timeStampMicros:o.observedAtHours===null?undefined:toMowerMicros(o.observedAtHours),exhaustTimeMicros:o.exhaustAtHours===null?undefined:toMowerMicros(o.exhaustAtHours),depletionRate:o.depletion_rate,restMoodLimit:planned.has(o.name)&&(input.config.ling_xi===1&&o.name==='令'||input.config.ling_xi===2&&o.name==='夕')})]))
  const data=new MowerSchedulingData({operators,plan:Object.fromEntries(Object.entries(input.plan).map(([room,slots])=>[room,(slots as {agent:string}[]).map(slot=>slot.agent)])),dorms:input.dorm.map(b=>new MowerDormState([String(b.position[0]),Number(b.position[1])],b.name,b.completedAtHours===null?undefined:toMowerMicros(b.completedAtHours))),nowMicros:toMowerMicros(input.nowHours),freeRoom:input.config.free_room,powerPlantCount:input.powerPlantCount,planConditions:input.planCondition,policy:{restingThreshold:input.config.resting_threshold},groupRestInFullOnMoodGap:input.globalConfig.group_rest_in_full_on_mood_gap,groupMoodGapMaxExtraWaitHours:input.globalConfig.group_mood_gap_max_extra_wait_hours,mergeIntervalMinutes:input.globalConfig.merge_interval})
  const queue=new MowerTaskQueue();queue.tasks=input.tasks.map(raw=>new MowerTask({time:raw.timeHours,type:Object.values(T).find(t=>t.key===raw.type),plan:structuredClone(raw.plan),metadata:raw.metadata,strictMoodLimit:undefined,moodLimit:undefined}));const originals=[...queue.tasks]
  planMowerMetadata(data,queue)
  expect({tasks:queue.tasks.map(t=>({type:t.type.key,timeMicros:t.timeMicros,plan:t.plan,metadata:t.metadata,strictMoodLimit:t.strictMoodLimit,moodLimit:t.moodLimit??null,retainedInputIndex:originals.includes(t)?originals.indexOf(t):null}))}).toEqual(fixture.output)
 })
})
