import {describe,it,expect} from 'vitest'
import retryOracle from './fixtures/mower-room-retry-alpha.json'
import {MowerConnectionError,MowerRecognizeError} from './mowerNativeErrors'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from './compileRosterSchedule'
import {compiledScheduleToRuntimeConfig} from './scheduleAdapter'
import {createRosterRuntime,advanceRoster,type RuntimeRates} from './rosterRuntime'
import {getMowerSourceRuntime,settleMowerSource,nextMowerSourceActionHours} from './mowerSourceRuntime'
import {MowerTask,MOWER_TASK_TYPES as T,toMowerMicros} from './mowerTaskQueue'
function scenario(withFia=false){
 const ws=createDefaultWorkspace()
 for(const room of Object.values(ws.mainPlan.facilities))room.slots=[]
 ws.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'芬'},groupId:null,replacements:['但书']}]
 ws.mainPlan.conf.workaholic=['芬']
 if(withFia)ws.mainPlan.facilities.dormitory_1.slots=[
  ...['杜林','闪灵','菲亚梅塔'].map(n=>({occupant:{kind:'operator' as const,operatorId:n},groupId:null,replacements:[]})),
  ...Array.from({length:2},()=>({occupant:{kind:'free' as const},groupId:null,replacements:[]})),
 ]
 const state=createRosterRuntime(compiledScheduleToRuntimeConfig(compileRosterSchedule(ws))),source=getMowerSourceRuntime(state)
 source.queue.tasks=[new MowerTask({time:-1/3600})]
 const observations:{kind:string;timeMicros:number}[]=[],phases:string[]=[]
 const durations={'enter-room':200_000,'wait-interface':0,'read-order':300_000,'return-main':500_000,drone:0}
 const rates:RuntimeRates={workRate:()=>1,recoveryRate:()=>2,mowerRunOrderIO:(request,s)=>({
  delayMicros:durations[request.kind],
  observe:()=>{observations.push({kind:request.kind,timeMicros:toMowerMicros(s.time)});return {observedAtMicros:toMowerMicros(s.time),...(request.kind==='read-order'?{absoluteDueMicros:900_123_456}:{})}}
 })}
 const settle=()=>settleMowerSource(state,rates,phase=>{phases.push(phase);return false})
 function finishIO(){
  let limit=20
  while(source.execution||source.phaseExecution){
   if(--limit<0)throw new Error('I/O failed to terminate')
   advanceRoster(state,nextMowerSourceActionHours(state),rates)
   settle()
  }
 }
 return {state,source,observations,phases,rates,settle,finishIO}
}
describe('native run-order lifecycle in source runtime',()=>{
 it('plans with live replacements, shares morale clock and does not repeat BEGINNING on an I/O wake',()=>{
  const {state,source,observations,phases,settle,finishIO}=scenario()
  settle()
  expect(source.phaseExecution).toBeDefined()
  expect(observations).toHaveLength(0)
  expect(source.runFlags).toEqual({planned:false,todoTask:false,collectNotification:false})
  finishIO()
  const task=source.queue.find({type:T.RUN_ORDER,metadata:'room_1_1'})!
  expect(task.timeMicros).toBe(720_123_456)
  expect(task.plan.room_1_1).toEqual(['char_4032_provs'])
  expect(toMowerMicros(state.time)).toBe(1_000_000)
  expect(state.morale.char_123_fang).toBeCloseTo(24-1/3600,10)
  expect(observations).toEqual([{kind:'enter-room',timeMicros:200_000},{kind:'wait-interface',timeMicros:200_000},{kind:'read-order',timeMicros:500_000},{kind:'return-main',timeMicros:1_000_000}])
  expect(phases.filter(p=>p==='BEGINNING')).toHaveLength(1)
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:false})
 })
 it('dispatches REFRESH_TIME through the native branch and consumes the original identity after I/O',()=>{
  const {state,source,observations,phases,settle,finishIO}=scenario()
  const selected=new MowerTask({type:T.REFRESH_TIME,metadata:'room_1_1',time:-1/3600})
  source.queue.tasks=[selected]
  settle()
  expect(source.execution?.task).toBe(selected)
  expect(source.queue.tasks).toContain(selected)
  finishIO()
  expect(source.queue.tasks).not.toContain(selected)
  expect(source.queue.tasks.filter(t=>t.type===T.RUN_ORDER)).toHaveLength(1)
  expect(observations).toHaveLength(4)
  expect(phases.filter(p=>p==='BEGINNING')).toHaveLength(1)
  expect(source.trace).toHaveLength(1)
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
  expect(source.runReturn).toBeUndefined()
  expect(toMowerMicros(state.time)).toBe(1_000_000)
 })
 it('reports absence of lifecycle input so a decision-only replay cannot be claimed as full Mower parity',()=>{
  const {state,source}=scenario()
  settleMowerSource(state,{workRate:()=>1,recoveryRate:()=>2})
  expect(source.queue.find({type:T.RUN_ORDER})).toBeUndefined()
  expect(state.diagnostics.some(d=>d.code==='mower-run-order-io-unavailable')).toBe(true)
 })
 it('executes native temporary staffing, queues an identity-preserving primary restoration and restores on the next run',()=>{
  const {state,source,rates,settle,finishIO}=scenario()
  state.config.mowerTaskScheduling!.grandet=false
  rates.mowerRunOrderFinishingIO=(request,s)=>({delayMicros:200_000,observe:()=>({kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:null})})
  const selected=new MowerTask({type:T.RUN_ORDER,metadata:'room_1_1',plan:{room_1_1:['char_4032_provs']}})
  source.queue.tasks=[selected,new MowerTask({time:5})]
  settle();finishIO()
  expect(source.queue.tasks).not.toContain(selected)
  expect(state.occupants.room_1_1_0).toBe('char_4032_provs')
  const restore=source.queue.tasks.find(t=>t.type===T.RUN_ORDER&&t.metadata==='')!
  expect(restore.plan).toEqual({room_1_1:['char_123_fang']})
  expect(restore.timeMicros).toBe(selected.timeMicros)
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
  advanceRoster(state,nextMowerSourceActionHours(state),rates)
  settle();finishIO()
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(source.queue.tasks).not.toContain(restore)
 })
 it('does not charge an operator or exchange Fiammetta mood during ordinary run-order entry',()=>{
  const {state,source,rates,settle,finishIO}=scenario(true)
  state.config.mowerTaskScheduling!.grandet=false
  state.morale.char_4032_provs=12
  state.morale.char_300_phenxi=10
  rates.mowerRunOrderFinishingIO=(request,s)=>({delayMicros:0,observe:()=>({kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:null})})
  source.queue.tasks=[new MowerTask({type:T.RUN_ORDER,metadata:'room_1_1',plan:{room_1_1:['char_4032_provs']}}),new MowerTask({time:5})]
  settle();finishIO()
  expect(state.events.filter(event=>event.type==='fiammetta')).toHaveLength(0)
  expect(state.morale.char_4032_provs).toBeCloseTo(12-state.time,8)
  expect(state.morale.char_300_phenxi).toBeCloseTo(10+2*state.time,8)
 })

 it('calibrates before temporary entry, uses native back1, then waits and restores inline',()=>{
  const {state,source,rates,settle,finishIO}=scenario()
  const trace:string[]=[],occupantsAtRead:string[]=[]
  state.mowerUI={scene:'INFRA_MAIN',lastRoom:''}
  state.config.mowerDeviceTiming={roomReturnMicros:500_000}
  let reads=0
  rates.mowerRunOrderFinishingIO=(request,s)=>({
   delayMicros:request.kind==='sleep'?toMowerMicros(request.seconds/3600):request.kind==='back'?request.intervalSeconds*1_000_000:0,
   observe:()=>{
    if(request.kind==='read-remaining'){state.mowerUI={scene:'INFRA_DETAILS',lastRoom:'room_1_1'};occupantsAtRead.push(state.occupants.room_1_1_0!)}
    trace.push(request.kind)
    return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='read-remaining'?(++reads===1?120:60):request.kind==='scene'?'ready':request.kind==='read-drone-count'?0:null}
   }
  })
  const selected=new MowerTask({type:T.RUN_ORDER,metadata:'room_1_1',plan:{room_1_1:['char_4032_provs']}})
  source.queue.tasks=[selected,new MowerTask({time:5})]
  settle()
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(trace).toEqual(['read-remaining'])
  expect(selected.timeMicros).toBe(-60_000_000)
  expect(source.execution?.task).toBe(selected)
  expect(toMowerMicros(state.time)).toBe(0)
  finishIO()
  expect(occupantsAtRead).toEqual(['char_123_fang','char_4032_provs'])
  expect(trace).toEqual(['read-remaining','back','turn-on-room-detail','read-remaining','sleep','scene','accept-order','read-drone-count','find-bill-accelerate'])
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(source.queue.tasks).not.toContain(selected)
  expect(source.queue.tasks.some(t=>t.type===T.RUN_ORDER&&t.metadata==='')).toBe(false)
  expect(toMowerMicros(state.time)).toBe(61_500_000)
  expect(state.mowerUI!.scene).toBe('INFRA_MAIN')
 })
 it('resumes the selected identity at its I/O wake even when native calibration moves its deadline into the future',()=>{
  const {state,source,rates,settle,finishIO}=scenario()
  let reads=0
  rates.mowerRunOrderFinishingIO=(request,s)=>({
   delayMicros:request.kind==='sleep'?toMowerMicros(request.seconds/3600):request.kind==='back'?request.intervalSeconds*1_000_000:0,
   observe:()=>({kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='read-remaining'?(++reads===1?200:1):request.kind==='scene'?'ready':request.kind==='read-drone-count'?0:null})
  })
  const task=new MowerTask({type:T.RUN_ORDER,plan:{room_1_1:['char_4032_provs']}})
  source.queue.tasks=[task,new MowerTask({time:5})]
  settle();expect(task.timeMicros).toBe(20_000_000)
  advanceRoster(state,nextMowerSourceActionHours(state),rates);settle()
  expect(source.execution?.task).toBe(task);expect(state.occupants.room_1_1_0).toBe('char_4032_provs')
  finishIO();expect(source.queue.tasks).not.toContain(task)
 })
 it('native missed selection consumes the outer task without changing staff, clearing the pending room or adding a room return',()=>{
  const {state,source,rates,settle}=scenario()
  state.config.mowerDeviceTiming={roomReturnMicros:500_000}
  const trace:string[]=[]
  rates.mowerRunOrderFinishingIO=(request,s)=>({delayMicros:0,observe:()=>{trace.push(request.kind);return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='read-remaining'?0:null}}})
  const task=new MowerTask({type:T.RUN_ORDER,plan:{room_1_1:['char_4032_provs']}})
  source.queue.tasks=[task,new MowerTask({time:5})]
  settle()
  expect(source.queue.tasks).not.toContain(task);expect(task.plan).toEqual({room_1_1:['char_4032_provs']})
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(trace).toEqual(['read-remaining','notify-missed-order','reset-room-time'])
  expect(toMowerMicros(state.time)).toBe(0)
 })

 it('handles a preselection connection exception inside the native room retry, preserving original restoration',()=>{
  const {state,source,rates,settle,finishIO}=scenario()
  state.config.mowerDeviceTiming={roomReturnMicros:500_000}
  let reads=0
  const trace:string[]=[]
  rates.mowerRunOrderFinishingIO=(request,s)=>({
   delayMicros:request.kind==='sleep'?toMowerMicros(request.seconds/3600):request.kind==='back'?request.intervalSeconds*1_000_000:0,
   observe:()=>{
    trace.push(request.kind)
    if(request.kind==='read-remaining'&&++reads===1)throw new MowerConnectionError('controlled preselection read failure')
    return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value:request.kind==='read-remaining'?60:request.kind==='scene'?'ready':request.kind==='read-drone-count'?0:null}
   }
  })
  const task=new MowerTask({type:T.RUN_ORDER,plan:{room_1_1:['char_4032_provs']}})
  source.queue.tasks=[task,new MowerTask({time:5})]
  expect(()=>settle()).not.toThrow()
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  finishIO()
  expect(trace.filter(k=>k==='read-remaining')).toHaveLength(2)
  expect(state.occupants.room_1_1_0).toBe('char_123_fang')
  expect(task.timeMicros).toBe(0)
  expect(source.queue.tasks).not.toContain(task)
  expect(toMowerMicros(state.time)).toBe(61_000_000)
 })

 describe('actual whole room retry oracle with explicit order-page observations',()=>{
  for(const ErrorType of [MowerRecognizeError,MowerConnectionError,Error])for(const when of ['before-selection','after-confirmation'])it(when+' '+ErrorType.name,()=>{
   const {state,source,rates,settle,finishIO}=scenario()
   state.config.mowerDeviceTiming={roomReturnMicros:500_000}
   state.mowerUI={scene:'INFRA_DETAILS',lastRoom:'room_1_1'}
   let reads=0,failed=false,orderPage=false
   if(when==='after-confirmation'){
    let mood=state.morale.char_4032_provs!
    Object.defineProperty(state.morale,'char_4032_provs',{enumerable:true,configurable:true,get(){
     if(!failed&&state.occupants.room_1_1_0==='char_4032_provs'){failed=true;throw new ErrorType('controlled confirmed room observation')}
     return mood
    },set(v:number){mood=v}})
   }
   rates.mowerRunOrderFinishingIO=(request,s)=>({
    delayMicros:request.kind==='sleep'?toMowerMicros(request.seconds/3600):request.kind==='back'?request.intervalSeconds*1_000_000:0,
    observe:()=>{
     let value:unknown=null
     if(request.kind==='read-remaining'){
      reads++;state.mowerUI!.scene='INFRA_DETAILS'
      if(when==='before-selection'&&!failed){failed=true;throw new ErrorType('controlled preselection observation')}
      value=when==='after-confirmation'&&reads===1?120:60
     }
     if(request.kind==='scene')value='ready'
     if(request.kind==='read-drone-count')value=0
     if(request.kind==='accept-order')orderPage=true
     if(request.kind==='find-bill-accelerate')value=orderPage?{found:true}:null
     if(request.kind==='back'){orderPage=false;state.mowerUI!.scene=request.intervalSeconds===1?'INFRA_MAIN':'INFRA_DETAILS'}
     if(request.kind==='turn-on-room-detail')state.mowerUI!.scene='INFRA_DETAILS'
     return {kind:request.kind,observedAtMicros:toMowerMicros(s.time),value}
    }
   })
   const task=new MowerTask({type:T.RUN_ORDER,plan:{room_1_1:['char_4032_provs']}})
   source.queue.tasks=[task,new MowerTask({time:5})]
   settle();finishIO()
   expect(failed).toBe(true);expect(reads).toBe(2)
   const errorClass=ErrorType===Error?'RuntimeError':ErrorType===MowerConnectionError?'ConnectionError':'RecognizeError'
   const expected=retryOracle.cases.find(c=>c.name===when+'-'+errorClass+'-whole')!.expected
   expect({nowMicros:toMowerMicros(state.time),scene:state.mowerUI!.scene==='INFRA_MAIN'?'MAIN':state.mowerUI!.scene,taskTimeMicros:task.timeMicros,countdownReadAttempts:reads,remainingTaskPlan:task.plan}).toEqual(expected)
   expect(state.mowerUI!.scene).toBe('INFRA_MAIN')
   expect(state.occupants.room_1_1_0).toBe('char_123_fang')
   expect(source.queue.tasks).not.toContain(task)
  })
 })

 it.each(['removed','postponed'] as const)('ends the native run when entry processing %s the selected identity',action=>{
  const {state,source,rates}=scenario(),selected=source.queue.tasks[0]!
  source.queue.tasks.push(new MowerTask({time:5}))
  settleMowerSource(state,rates,phase=>{
   if(phase==='BEGINNING'){
    if(action==='removed')source.queue.consume(selected)
    else selected.time=6
   }
   return false
  })
  expect(source.trace).toHaveLength(0)
  expect(source.execution).toBeUndefined()
  expect(source.phaseExecution).toBeUndefined()
  expect(source.runFlags).toEqual({planned:true,todoTask:true,collectNotification:true})
  expect(source.queue.tasks).not.toHaveLength(0)
 })

})
