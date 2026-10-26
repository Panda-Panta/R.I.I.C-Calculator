import { describe, it, expect } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { OPERATORS } from '../domain/operators'
import { evaluateOperators } from './operatorRules'
import { getTemporalSkillBoundaries, isWarmupSkill, temporalSkillBonus } from './timeDependentSkills'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { inventoryOperatorRecords } from '../domain/operatorContext'
const id = (name:string) => OPERATORS.find(o => o.name === name)!.charId
function factory(names:string[]) { const config=createDefaultConfig(); config.controlOperatorIds=[]; config.rooms.forEach(r=>r.operatorIds=[]); const room=config.rooms.find(r=>r.type==='manufacture')!; room.operatorIds=names.map(id); room.product='gold'; return {config,room} }
describe('time-dependent productivity through the public evaluator',()=>{
 it('starts Aroma at zero bonus instead of its steady twenty',()=>{ const {config,room}=factory(['阿罗玛']); expect(evaluateOperators(room,config,undefined,undefined,undefined,{workHoursByOperator:new Map([[id('阿罗玛'),0]]),warmupModel:'hourly'}).efficiencyPercent).toBe(126) })
})
 it('copies current warmup and respects automation clearing',()=>{const {config,room}=factory(['槐琥','阿罗玛']);const time={workHoursByOperator:new Map([[id('阿罗玛'),0]]),warmupModel:'hourly' as const};expect(evaluateOperators(room,config,undefined,undefined,undefined,time).efficiencyPercent).toBe(152);room.operatorIds.push(id('温蒂'));expect(evaluateOperators(room,config,undefined,undefined,undefined,time).operatorContributions.find(o=>o.operatorId===id('阿罗玛'))?.skillBonus).toBe(0)})
 it('caps Aroma after ten hours and distinguishes explicit subhour models',()=>{const {config,room}=factory(['阿罗玛']);const run=(hours:number,model:'hourly'|'continuous')=>evaluateOperators(room,config,undefined,undefined,undefined,{workHoursByOperator:new Map([[id('阿罗玛'),hours]]),warmupModel:model}).efficiencyPercent;expect(run(2.5,'hourly')).toBe(130);expect(run(2.5,'continuous')).toBe(131);expect(run(10,'hourly')).toBe(146);expect(run(99,'continuous')).toBe(146);expect(evaluateOperators(room,config).efficiencyPercent).toBe(146)})
 it('mechanist twelve-hour bonus starts only at twelve hours',()=>{const {config,room}=factory(['机械师']);room.product='exp';const run=(h:number)=>evaluateOperators(room,config,undefined,undefined,undefined,{workHoursByOperator:new Map([[id('机械师'),h]])}).efficiencyPercent;expect(run(11.99)).toBe(131);expect(run(12)).toBe(141)})
import { currentMoraleRates } from './morale'
it('Mlynar expansion competes with Babel flag, and right-side workplaces receive the winning rate',()=>{const c=createDefaultConfig();c.controlOperatorIds=['玛恩纳','维什戴尔','魔王'].map(id);c.rooms.forEach(r=>r.operatorIds=[]);const room=c.rooms.find(r=>r.type==='manufacture')!;room.operatorIds=[id('芬')];c.facilityOperatorIds.office=[id('梓兰')];c.facilityOperatorIds.reception=[id('香草')];const result=currentMoraleRates(c);expect(result.rates[id('芬')]).toBeCloseTo(.65);expect(result.rates[id('梓兰')]).toBeCloseTo(.65)})
 it.each([['芬',0,121],['芬',4,125],['刻俄柏',0,121],['克洛丝',0,116],['稀音',0,116]] as const)('resolves %s manufacturing at hour %s', (name,h,expected)=>{const {config,room}=factory([name]);expect(evaluateOperators(room,config,undefined,undefined,undefined,{workHoursByOperator:new Map([[id(name),h]]),warmupModel:'hourly'}).efficiencyPercent).toBe(expected)})

describe('shared warmup classification', () => {
 it.each(['manu_prod_spd_addition[100]', 'manu_prod_spd_addition[030]', 'manu_prod_spd_addition[031]',
  'manu_prod_spd_addition[040]', 'manu_prod_spd_addition[041]', 'power_rec_spd&addition[000]',
  'power_rec_spd&addition[001]', 'meet_spd_hast[000]', 'manu_prod_cost_min[001]'])('recognizes the increasing rule %s', buffId => {
  expect(isWarmupSkill(buffId)).toBe(true)
  const bonus = (hours: number) => temporalSkillBonus(buffId, 'operator', { workHoursByOperator: new Map([['operator', hours]]) })
  expect(bonus(24)!).toBeGreaterThan(bonus(0)!)
 })
 it.each(['manu_formula_spd[011]', 'manu_prod_cost_min[000]', 'trade_ord_spd[001]', 'unknown'])('does not infer a temporal rule for %s', buffId => {
  expect(isWarmupSkill(buffId)).toBe(false)
 })
 it('keeps the delayed rule boundary and value on the same actual unlocked skill', () => {
  const context = (elitePhase: number) => ({ operatorRecords: inventoryOperatorRecords(compileOperatorInventory([{ operator: '机械师', elitePhase, level: 1 }])) })
  expect(getTemporalSkillBoundaries(id('机械师'), context(0))).toEqual([])
  expect(getTemporalSkillBoundaries(id('机械师'), context(2))).toEqual([12])
  expect(temporalSkillBonus('manu_prod_cost_min[001]', id('机械师'), { workHoursByOperator: new Map([[id('机械师'), 11.999]]) })).toBe(0)
  expect(temporalSkillBonus('manu_prod_cost_min[001]', id('机械师'), { workHoursByOperator: new Map([[id('机械师'), 12]]) })).toBe(10)
 })
})
