import type { QualityRule } from '../domain/types'
import type { ProductionWeights } from '../domain/productionWeights'
import { getOrderDistribution, captureOrder, type SpecialCapture } from '../rules/orderRules'
import { virtualGoldEquivalent } from '../rules/orderValue'
import { scoreProduction } from './productionObjective'

export interface RunOrderChoice {
  key: string
  label: string
  names: string[]
  capture: SpecialCapture
}
export interface RunOrderGain extends RunOrderChoice {
  allowed: boolean
  baselineScore: number
  score: number
  delta: number
  gainPercent: number | null
}
export const RUN_ORDER_CHOICES: readonly RunOrderChoice[] = [
  ...(['00','02','20','22'] as const).map(code => ({ key: 'pair'+code, label: '龙舌兰＋但书 '+code,
    names: ['但书','龙舌兰'], capture: { tequila: (code[0]==='0'?1:2) as 1|2, proviso: (code[1]==='0'?1:2) as 1|2 } })),
  ...([0,2] as const).flatMap(phase => [
    { key:'proviso'+phase, label:'但书 精'+phase, names:['但书'], capture:{proviso:(phase===0?1:2) as 1|2} },
    { key:'tequila'+phase, label:'龙舌兰 精'+phase, names:['龙舌兰'], capture:{tequila:(phase===0?1:2) as 1|2} },
    { key:'closure'+phase, label:'可露希尔 精'+phase, names:['可露希尔'], capture:phase===2?{closure:true}:{} },
    { key:'pepe'+phase, label:'佩佩 精'+phase, names:['佩佩'], capture:phase===2?{pepe:true}:{} },
  ]),
]

/** Renewal expectation E[weighted reward] / E[time], with the same main team and no drones. */
export function calculateRunOrderGains(level:number,quality:QualityRule,efficiency:number,weights?:Partial<ProductionWeights>):RunOrderGain[] {
  if(!Number.isFinite(efficiency)||efficiency<=0)throw new Error('接单效率必须大于0')
  function score(c:SpecialCapture):number {
    const mode=c.pepe?'pepe':c.closure?'closure':'gold'
    let minutes=0,orderLmd=0,virtualGold=0
    for(const base of getOrderDistribution(level,quality,mode)) {
      const order=captureOrder(base,c,0)
      minutes+=base.probability*base.baseMinutes
      orderLmd+=base.probability*order.lmdReward
      virtualGold+=base.probability*virtualGoldEquivalent(order)
    }
    return scoreProduction({exp:0,gold:0,orderLmd,virtualGold},minutes/60/(mode==='pepe'?1:efficiency),weights).total
  }
  const baselineScore=score({})
  return RUN_ORDER_CHOICES.map(choice=>{
    const allowed=level===3||!choice.names.includes('龙舌兰')
    const value=allowed?score(choice.capture):baselineScore
    const delta=value-baselineScore
    return {...choice,allowed,baselineScore,score:value,delta,gainPercent:baselineScore>0?delta/baselineScore*100:null}
  })
}
