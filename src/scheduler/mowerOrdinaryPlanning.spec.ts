import {describe,it,expect} from 'vitest'
import oracle from './fixtures/mower-ordinary-planning-alpha-cases.json'
import {MowerOperatorState} from './mowerOperatorState'
import {MowerSchedulingData,MowerDormState} from './mowerSchedulingData'
import {MowerTaskQueue} from './mowerTaskQueue'
import {mowerResting,mowerTryReorder} from './mowerOrdinaryPlanning'
interface InputOperator {name:string;room?:string;index?:number;group?:string;replacement?:string[];operator_type?:string;resting_priority?:string;mood?:number;lower_limit?:number;upper_limit?:number;current_room?:string;current_index?:number;workaholic?:boolean;rest_in_full?:boolean;exhaust_require?:boolean;rest_mood_limit?:boolean;observed?:boolean}
describe('actual pinned Python ordinary resting and try_reorder',()=>{
 for(const fixture of oracle.cases)it(fixture.id,()=>{
  const input=fixture.input
  const operators=Object.fromEntries((input.operators as InputOperator[]).map(o=>[o.name,new MowerOperatorState({name:o.name,room:o.room,index:o.index,group:o.group,replacement:o.replacement,operatorType:o.operator_type==='high'?'high':'low',restingPriority:o.resting_priority==='high'?'high':'low',mood:o.mood,lowerLimit:o.lower_limit,upperLimit:o.upper_limit,currentRoom:o.current_room,currentIndex:o.current_index,workaholic:o.workaholic,exhaustRequire:o.exhaust_require,restInFull:o.rest_in_full,restMoodLimit:o.rest_mood_limit,timeStampMicros:o.observed===false?undefined:0})]))
  const data=new MowerSchedulingData({operators,plan:Object.fromEntries(Object.entries(input.plan).map(([room,slots])=>[room,(slots as {agent:string}[]).map(slot=>slot.agent)])),dorms:input.beds.map(b=>new MowerDormState([String(b.position[0]),Number(b.position[1])],b.name,b.time===null?undefined:b.time*3_600_000_000)),nowMicros:0,restingPriorityNames:input.priority,excludedCandidates:new Set(['Proviso','Tequila'])})
  const queue=new MowerTaskQueue()
  const plan=mowerResting(data,queue,{fiaTargets:'fia' in input?input.fia as string[]:[]}),reorder=mowerTryReorder(data,plan)
  expect({plan,reorder:reorder??null,beds:data.dorms.map(b=>({position:b.position,name:b.name,time:b.timeMicros===undefined?null:b.timeMicros/3_600_000_000})),tasks:queue.tasks.map(t=>({type:t.type.key,plan:t.plan}))}).toEqual(fixture.output)
 })
})
