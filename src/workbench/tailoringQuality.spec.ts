import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { inventoryOperatorRecords } from '../domain/operatorContext'
import { compileOperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import type { QualityRule } from '../domain/types'
import { evaluateOperators } from '../engine/operatorRules'
import { compileMainPlanToAppConfig } from './adapter'
import { importMowerJson, resolveOperatorCharId as id } from './compat/mowerJson'
import { runScheduleSimulationBridge } from './scheduleSimulationBridge'

const expectedProbabilities: Record<QualityRule, number[]> = {
  normal: [.3,.5,.2], alpha: [.15,.3,.55], beta: [.05,.1,.85],
}

function imported(operators: string[], backup?: string) {
  return importMowerJson(JSON.stringify({ default: 'plan1', plan1: {
    room_3_1: { name: '贸易站', plans: operators.map((agent,index) => ({ agent, group:'', replacement: index===0 && backup ? [backup] : [] })) },
    room_1_3: { name: '发电站', plans: [{ agent:'Lancet-2', group:'', replacement:[] }] },
    conf: { workaholic: [...operators,'Lancet-2'] },
  } }))
}

function inventory(operators: Array<[string, number]>, backup?: string): OwnedOperatorInput[] {
  return [...operators.map(([operator,elitePhase]) => ({operator,elitePhase,level:1})),
    {operator:'Lancet-2',elitePhase:0,level:30},
    ...(backup ? [{operator:backup,elitePhase:2,level:1}] : []),
  ]
}

function verifyPipeline(operators: Array<[string,number]>, quality: QualityRule, backup?: string, level: 1 | 2 | 3 = 3) {
  const workspace = imported(operators.map(([name])=>name),backup)
  workspace.mainPlan.facilities.room_3_1.level = level
  workspace.mainPlan.facilities.room_3_1.slots.length = level
  const before = structuredClone(workspace), entries = inventory(operators,backup)
  const owned = compileOperatorInventory(entries)
  expect(owned.valid, JSON.stringify(owned.diagnostics)).toBe(true)
  const config = compileMainPlanToAppConfig(workspace.mainPlan,workspace,createDefaultConfig())
  config.operatorRecords = inventoryOperatorRecords(owned)
  const room = config.rooms.find(r=>r.id==='B301')!
  expect(room.level).toBe(level)
  expect(room.quality).toBe('normal') // No manually supplied quality in the imported plan.
  expect(evaluateOperators(room,config).quality).toBe(quality)
  const result = runScheduleSimulationBridge(workspace,{ warmupHours:0,sampleHours:level < 3 ? 24 : 8,operatorInventory:entries,
    production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42},
  })
  expect(result.report?.success,result.error).toBe(true)
  expect(result.report!.production?.success).toBe(true)
  expect(result.report!.diagnostics.some(d=>d.code==='ORDER_DISTRIBUTION_UNSUPPORTED')).toBe(false)
  const orders = result.report!.production!.events.filter(e=>e.type==='order-completed' && e.roomId==='room_3_1').map(e=>e.order!)
  expect(orders.length).toBeGreaterThanOrEqual(2)
  // Check actual completed order snapshots, not just the inferred label or preview.
  for(const order of orders) {
    expect(order.kind).toBe('gold')
    expect(order.probability).toBe(expectedProbabilities[quality][order.goldCost-2])
    expect(order.lmdReward).toBe(order.goldCost*500)
  }
  expect(workspace).toEqual(before)
  return {config,room}
}

describe('imported tailoring skills reach actual order production',()=>{
  it.each([
    ['柏喙',0,'alpha'],['柏喙',1,'alpha'],['柏喙',2,'beta'],
    ['明椒',0,'alpha'],['明椒',2,'beta'],
    ['贝娜',0,'normal'],['贝娜',2,'alpha'],['巫恋',2,'alpha'],
  ] as const)('%s elite %i uses %s without manually changing room quality',(name,phase,quality)=>{
    verifyPipeline([[name,phase],['空爆',1],['克洛丝',1]],quality)
  })

  it('uses beta rather than stacking alpha when both are working',()=>{
    verifyPipeline([['柏喙',2],['巫恋',0],['空爆',1]],'beta')
  })

  it('does not turn two alpha providers into beta',()=>{
    verifyPipeline([['柏喙',0],['巫恋',0],['空爆',1]],'alpha')
  })

  it('does not apply the skill of a replacement who is not yet working',()=>{
    verifyPipeline([['芬',1],['空爆',1],['克洛丝',1]],'normal','柏喙')
  })

  it('stops using tailoring when its provider is excluded from active staff',()=>{
    const {config,room} = verifyPipeline([['柏喙',2],['空爆',1],['克洛丝',1]],'beta')
    const active = new Set([id('空爆'),id('克洛丝')])
    expect(evaluateOperators(room,config,active).quality).toBe('normal')
    config.zeroMoraleOperatorIds=[id('柏喙')]
    expect(evaluateOperators(room,config).quality).toBe('normal')
  })

  it.each([
    [1,0,'alpha'], [1,2,'beta'], [2,0,'alpha'], [2,2,'beta'],
  ] as const)('uses fixed %s-level tailoring elite %s (%s) for completed imported orders',(level,phase,quality)=>{
    const operators: Array<[string,number]> = [['柏喙',phase]]
    if(level === 2) operators.push(['空爆',1])
    verifyPipeline(operators,quality,undefined,level)
  })
  it.each([0, 2])('keeps physical Tequila elite %i disabled at level 2 even with tailoring four-gold orders', phase=>{
    verifyPipeline([['柏喙',2],['龙舌兰',phase]],'beta',undefined,2)
  })
})
