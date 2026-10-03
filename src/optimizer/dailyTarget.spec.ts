import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'
import {it,expect} from 'vitest'
import {importMowerJson} from '../workbench/compat/mowerJson'
import fixture from '../workbench/compat/fixtures/mower-252-2gold.json'
import type {IncomeCase} from './incomeComparison'
import {assess252DailyTarget,seededSearchOrder} from './dailyTarget'
const workspace=()=>importMowerJson(JSON.stringify(fixture))
const cases=():IncomeCase[]=>[1,2].flatMap(seed=>[.25,.125].map(step=>({key:`${seed}:${step}`,seed,step,context:JSON.stringify({sampleHours:168,warmupHours:24,layout:compileRosterSchedule(workspace()).rooms.map(r=>({id:r.roomId,type:r.type,level:r.level,product:r.product}))}),eligible:true,issues:[],assumptions:[],daily:{lmd:0,exp:0,gold:0,fragment:0,orundum:0,drone:0,orirock:0,device:0},opening:{lmd:0,exp:0,gold:0,fragment:0,orundum:0,drone:0,orirock:0,device:0},closing:{lmd:0,exp:0,gold:0,fragment:0,orundum:0,drone:0,orirock:0,device:0},output:{mode:'potential',daily:{exp:100100,goldValue:0,orderValue:0,weightedExp:100100,weightedGold:0,weightedOrders:0,weightedFragments:0,weightedOrundum:0,total:100100}}})))
const window={sampleHours:168,warmupHours:24}
it('requires every scenario to reach the target after step uncertainty, rather than using the mean',()=>{
 const c=cases();expect(assess252DailyTarget(workspace(),c,window).status).toBe('reached')
 c[0]!.output!.daily.total=100050;c[1]!.output!.daily.total=100200
 expect(assess252DailyTarget(workspace(),c,window)).toMatchObject({status:'below',minimum:100050,conservativeDaily:99900})
})
it('never calls invalid, duplicate, short, conditional, or different-layout results reached',()=>{
 const c=cases();c[0]!.eligible=false;expect(assess252DailyTarget(workspace(),c,window).status).toBe('ineligible')
 expect(assess252DailyTarget(workspace(),cases().slice(1),window).status).toBe('ineligible')
 const d=cases();d[0]!.key=d[1]!.key;expect(assess252DailyTarget(workspace(),d,window).status).toBe('ineligible')
 const short=cases();short.forEach(c=>{const source=JSON.parse(c.context);source.sampleHours=48;c.context=JSON.stringify(source)})
 expect(assess252DailyTarget(workspace(),short,{...window,sampleHours:48}).status).toBe('short-window')
 expect(assess252DailyTarget(workspace(),short,window).status).toBe('ineligible')
 const mixed=cases();mixed[0]!.context=mixed[0]!.context.replace('168','336');expect(assess252DailyTarget(workspace(),mixed,window).status).toBe('ineligible')
 expect(assess252DailyTarget(workspace(),cases(),window,100000,true).status).toBe('conditional')
 const w=workspace();Object.values(w.mainPlan.facilities).find(r=>r.type==='power')!.type='manufacture'
 expect(assess252DailyTarget(w,cases(),window).status).toBe('other-layout')
})
it('shuffles without changing input or inventory membership and can be replayed',()=>{
 const items=Array.from({length:429},(_,i)=>i),before=[...items]
 expect(seededSearchOrder(items,42)).toEqual(seededSearchOrder(items,42))
 expect(seededSearchOrder(items,43)).not.toEqual(seededSearchOrder(items,42))
 expect(seededSearchOrder(items,0).sort((a,b)=>a-b)).toEqual(items);expect(items).toEqual(before)
 expect(()=>seededSearchOrder(items,-1)).toThrow();expect(()=>assess252DailyTarget(workspace(),cases(),window,NaN)).toThrow()
})
