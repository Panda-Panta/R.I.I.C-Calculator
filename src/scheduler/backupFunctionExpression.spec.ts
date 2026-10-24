import { describe, expect, it } from 'vitest'
import { compileBackupExpression } from './backupExpression'
import { createRosterRuntime } from './rosterRuntime'
import { getMowerSourceRuntime } from './mowerSourceRuntime'
import { MowerSchedulingData } from './mowerSchedulingData'
import { MowerOperatorState } from './mowerOperatorState'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'

const compile = (source: unknown) => compileBackupExpression(source, new Set())
const fixture = () => createRosterRuntime({ positions: [], beds: [] })

// Mower ae9fc322: logic_expression.py FunctionExpression and logic_expression_tests.py.
describe('Mower function backup conditions', () => {
  it.each([
    ['max', ['3', '9', '4'], 9], ['min', ['3', '9', '4'], 3],
    ['sum', ['3', '9', '4'], 16], ['any', ['False', 'True'], true],
    ['all', ['True', 'False'], false], ['abs', ['-8'], 8],
    ['max', ['7'], 7], ['min', ['7'], 7], ['sum', ['7'], 7],
    ['any', ['False'], false], ['all', ['True'], true],
  ])('evaluates saved %s arguments', (name, args, expected) => {
    expect(compile({ function: name, args }).evaluate(fixture())).toBe(expected)
  })

  it('reads live inventory through nested function and binary nodes without modifying imported metadata', () => {
    const source = { left: { function: 'max', args: [
      "op_data.inventory_count('赤金')",
      { function: 'sum', args: [{ left: '3', operator: '+', right: '4', future: 'keep' }, '8'] },
    ], future: { mode: 'keep' } }, operator: '>', right: '20', future: [1, 2] }
    const before = structuredClone(source), expression = compile(source), state = fixture()
    state.mowerInventoryCounts = { 赤金: 10 }
    expect(expression).toMatchObject({ usesInventory: true, observedOperatorDependenciesOnly: false })
    expect(expression.evaluate(state)).toBe(false)
    state.mowerInventoryCounts = { 赤金: 30 }
    expect(expression.evaluate(state)).toBe(true)
    expect(source).toEqual(before)
  })

  it.each([
    'max(3, min(9, 4), 8) == 8', 'max([7]) == 7', 'min([7]) == 7',
    'sum([3, 9, 4]) == 16', 'any([False, 3 > 2])', 'all([True, abs(-8) == 8])',
    "max('a', 'b') == 'b'", 'sum([True, False, 4]) == 5',
  ])('accepts source-equivalent text %s', source => {
    expect(compile(source).evaluate(fixture())).toBe(true)
  })

  it('tracks operator observations and clock dependencies through nested functions', () => {
    const participants = new Set<string>(), id = resolveOperatorCharId('令')
    const expression = compileBackupExpression({ function: 'max', args: [
      { function: 'abs', args: [`op_data.operators['令'].current_mood() - 10`] }, '2',
    ] }, participants), state = fixture()
    state.morale[id] = 15
    expect(expression).toMatchObject({ usesCurrentMood: true, observedOperatorDependenciesOnly: true })
    expect([...participants]).toEqual([id])
    expect(expression.evaluate(state)).toBe(5)
    state.morale[id] = 11
    expect(expression.evaluate(state)).toBe(2)
  })

  it('tracks all query dependencies even behind an outer short-circuit', () => {
    const expression = compile(`True or all([
      op_data.inventory_count('赤金') > 0,
      op_data.facility_product_type_count() > 0,
      op_data.major_maintenance_remaining_hours() > 0,
      op_data.facility_is_training('train'),
      op_data.group_max_mood('absent') > 0
    ])`)
    expect(expression).toMatchObject({ usesInventory: true, usesFacilityProduct: true, usesMajorMaintenance: true,
      usesMasteryPlan: true, usesCurrentMood: true, observedOperatorDependenciesOnly: false })
    expect(expression.evaluate(fixture())).toBe(true)
  })

  it('preserves eager Python list arguments to any/all while retaining and/or short-circuiting', () => {
    const state = fixture()
    expect(() => compile("any([True, op_data.inventory_count('赤金')])").evaluate(state)).toThrow('缺少库存状态')
    expect(() => compile("all([False, op_data.inventory_count('赤金')])").evaluate(state)).toThrow('缺少库存状态')
    expect(compile("True or any([op_data.inventory_count('赤金')])").evaluate(state)).toBe(true)
    expect(compile("False and all([op_data.inventory_count('赤金')])").evaluate(state)).toBe(false)
    expect(compile("any([True or op_data.inventory_count('赤金')])").evaluate(state)).toBe(true)
  })

  it.each([{}, { left: '', operator: '', right: '' }, { left: ' ', right: '\t' }])('treats an empty logic tree as false: %j', source => {
    expect(compile({ function: 'any', args: [source] }).evaluate(fixture())).toBe(false)
  })

  it.each([
    { function: 'max', args: [] }, { function: 'sum', args: [] },
    { function: 'abs', args: ['1', '2'] }, { function: 'eval', args: ['1'] },
    { function: 'sum', args: '1' }, { function: 'sum', args: [null] },
    'max(1)', 'sum(1, 2)', 'abs(1, 2)', 'all([True)', 'min(1, 2',
    'eval(1)', 'max([1]).constructor', 'abs(__import__("os"))',
    'sum([1 for x in [1]])', 'sum([])', 'all([])', 'max([])', 'abs([1])',
  ])('rejects invalid or unsupported syntax %j', source => expect(() => compile(source)).toThrow('副表：'))

  it('rejects nonnumeric sums and nonfinite arithmetic results', () => {
    expect(() => compile("sum(['1', 2])").evaluate(fixture())).toThrow('需要数字')
    expect(() => compile('sum([1e308, 1e308])').evaluate(fixture())).toThrow('不是有限数')
  })

  it('bounds nested and wide function trees and their text equivalents', () => {
    let source: unknown = '1'
    for (let i = 0; i < 34; i++) source = { function: 'abs', args: [source] }
    expect(() => compile(source)).toThrow('条件树超过限制')
    expect(() => compile('abs('.repeat(65) + '1' + ')'.repeat(65))).toThrow('条件嵌套超过限制')
    expect(() => compile({ function: 'sum', args: Array(129).fill('1') })).toThrow('函数参数超过限制')
    expect(() => compile(`sum([${Array(129).fill('1').join(',')}])`)).toThrow('函数参数超过限制')
  })
})

describe('latest Mower mood and training observations', () => {
  it('computes group maximum from live fixed anchors and registers clock dependence', () => {
    const state = createRosterRuntime({ positions: [], beds: [], mowerPolicy: { restingThreshold: .65, powerPlantCount: 2, opeRestingPriority: [] },
      mowerAlpha: true, mowerSourcePlan: {}, mowerSourceRules: { workaholic: [], exhaustRequire: [], restInFull: [], lowPriority: [], refreshDrained: [], lingMode: 0 } })
    const operators = Object.fromEntries([
      { name: 'anchor1', mood: 20, depletionRate: 2 }, { name: 'anchor2', mood: 19, depletionRate: 0.5 },
      { name: 'workaholic', mood: 24, workaholic: true }, { name: 'standby', mood: 24, restingPriority: 'standby' as const },
    ].map(options => [options.name, new MowerOperatorState({ operatorType: 'high', room: 'room_1_1', currentRoom: 'room_1_1', group: 'test', timeStampMicros: 0, ...options })]))
    getMowerSourceRuntime(state).data = new MowerSchedulingData({ alpha: true, operators, plan: { room_1_1: Object.keys(operators) }, dorms: [], nowMicros: 0 })
    const expression = compile("op_data.group_max_mood('test')")
    expect(expression.usesCurrentMood).toBe(true)
    expect(expression.evaluate(state)).toBe(20)
    state.time = 2
    expect(expression.evaluate(state)).toBe(18)
    operators.anchor2!.group = 'other'
    expect(expression.evaluate(state)).toBe(16)
    expect(() => compile("op_data.group_max_mood('absent')").evaluate(state)).toThrow('不存在的绑组')
    operators.anchor1!.workaholic = true
    expect(() => expression.evaluate(state)).toThrow('没有可统计心情的干员')
  })

  it('keeps training observations false with legacy training flags and nested calls', () => {
    const state = fixture()
    Object.assign(state.config, { mowerMasteryPlanPresent: true, mowerTaskScheduling: { enableMastery: true } })
    const before = structuredClone(state.config)
    const expression = compile("any([op_data.facility_has_mastery_plan('train'), op_data.facility_is_training('train')])")
    expect(expression).toMatchObject({ usesMasteryPlan: true, usesCurrentMood: false })
    expect(expression.evaluate(state)).toBe(false)
    state.time = 24
    expect(expression.evaluate(state)).toBe(false)
    expect(state.config).toEqual(before)
    expect(() => compile("op_data.facility_is_training('room_1_1')")).toThrow('不支持的训练室位置')
  })
})
