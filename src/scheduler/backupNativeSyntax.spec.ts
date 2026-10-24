import {afterEach,describe, expect, it,vi} from 'vitest'
import {compileBackupExpression} from './backupExpression'
import * as values from './backupExpressionValues'
import {createRosterRuntime} from './rosterRuntime'
import {createDefaultWorkspace} from '../workbench/defaults'
import {runCalculationBridge} from '../workbench/calculationBridge'

const evaluate=(text:string)=>compileBackupExpression(text,new Set()).evaluate(createRosterRuntime({positions:[],beds:[]}))
afterEach(()=>vi.restoreAllMocks())

// Expected values were independently checked with 94a's resource checks,
// evalidate permissions and evaluate_expression (audit INPUT-002).
describe('native safe condition syntax',()=>{
  it.each([
    ['5 // 2',2],['-5 // 2',-3],['5 % -2',-1],['-5 % 2',1],
    ['2 ** 3',8],['-2 ** 2',-4],['(-2) ** 2',4],
    ["'room_1_1' in ['room_1_1','dormitory_1']",true],['True in [0,1]',true],
    ['[1,2] == [1,2]',true],['[] or [3]',[3]],['not []',true],
    ["'b' > 'a'",true],["'a' + 'b' == 'ab'",true],
    ['1 if True else 1 / 0',1],['1 / 0 if False else 2',2],
    ['1 if False else 2 if True else 3',2],
    ['any([])',false],['all([])',true],['sum([])',0],
    ['True or abs(1,2)',true],['False and any(1,2)',false],['True or max()',true],
    ['1 if True else sum([1],0,0)',1],['all() if False else 2',2],
    ["True or op_data.inventory_count('unknown')",true],
    ["False and op_data.facility_type('missing')",false],
    ['True or op_data.facility_type([1])',true],['True or op_data.facility_product_type_count(1)',true],
    ["['a','b'][0] == 'a'",true],["['a','b'][-1] == 'b'",true],["'😀a'[0] == '😀'",true],
    ['0x10 == 16',true],['0b1_000 == 8',true],['0o20 == 16',true],['1_000 == 1000',true],['1_0.0_0e+0_1 == 100',true],
    ["'\\x31' == '1'",true],["'\\u0031' in '123'",true],["'a%s' % 'b' == 'ab'",true],
    ['2 ** 64 + 1 > 2 ** 64',true],
    ['1.0 // 0.1',9],["sum([[1],[2]],[]) == [1,2]",true],
    ["'a' 'b' == 'ab'",true],["u'a' == 'a'",true],
    ["r'\\x31' == '\\\\x31'",true],["b'a' == b'a'",true],["b'a'[0] == 97",true],["97 in b'abc'",true],
    ['1j == 1j',true],['1j * 2 == 2j',true],['abs(1j) == 1',true],['2 ** True == 2',true],
    ['1e309 > 0',true],['1e308 * 1e308 > 0',true],['any([1e309 % 1e309])',true],['not (1e309 % 1e309)',false],
    ['True or [][0]',true],
  ])('evaluates %s',(text,want)=>expect(evaluate(text as string)).toEqual(want))

  it.each(['2 ** 65','2 ** -1','2 ** (1 + 2)','2 ** op_data.inventory_count(\'赤金\')'])('rejects unsafe/nonliteral exponents: %s',text=>{
    expect(()=>compileBackupExpression(text,new Set())).toThrow('幂运算')
  })

  it.each(['+1','2 ** +3','()','[1][0:1]',"True or ('a' * 2)","True or ('a' ** 2)",'012 == 12',
    ...['mood','upper_limit','lower_limit','current_index','room','index','group','workaholic','exhaust_require','rest_in_full','operator_type','resting_priority'].map(member=>`True or op_data.operators['芬'].${member}`),
  ])('rejects nodes excluded from the native safe model: %s',text=>{
    expect(()=>compileBackupExpression(text,new Set())).toThrow('副表：')
  })

  it('uses safe dynamic operator keys, permitted attributes and Unicode-aware indexing',()=>{
    const state=createRosterRuntime({positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'char_123_fang',candidates:[]}],beds:[]})
    const participants=new Set<string>()
    const expression=compileBackupExpression("op_data.operators['芬' if True else '德克萨斯'].current_mood() > 0 and op_data.operators['芬'].current_room[0] == 'r'",participants)
    expect(expression.evaluate(state)).toBe(true)
    expect(expression.usesCurrentMood).toBe(true)
    expect(participants).toEqual(new Set(['char_123_fang','char_102_texas']))
  })

  it('registers statically folded operator keys and keeps unselected runtime errors deferred',()=>{
    const participants=new Set<string>()
    const expression=compileBackupExpression("op_data.operators['德'+'克萨斯' if 1<2 else 1/0].current_mood()",participants)
    expect(participants).toEqual(new Set(['char_102_texas']))
    expect(expression.observedOperatorDependenciesOnly).toBe(true)
  })

  it('does not grant observed-only proof to a dynamic key chosen from runtime observations',()=>{
    const expression=compileBackupExpression("op_data.operators['芬' if op_data.operators['德克萨斯'].is_resting() else '香草'].current_mood()",new Set())
    expect(expression.observedOperatorDependenciesOnly).toBe(false)
  })

  it.each([
    "True or ('%100001s' % 'a')",
    "True or ((True and 'a') * 100001)",
    'True or ((True and 2 ** 64) ** 64)',
    'True or max(1,2)',
  ])('does not execute general value operations while compiling dependency proof: %s',text=>{
    const binary=vi.spyOn(values,'backupExpressionBinary').mockImplementation(()=>{throw new Error('must stay deferred')})
    const call=vi.spyOn(values,'backupExpressionCall').mockImplementation(()=>{throw new Error('must stay deferred')})
    const expression=compileBackupExpression(text,new Set())
    expect(binary).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(expression.evaluate(createRosterRuntime({positions:[],beds:[]}))).toBe(true)
    expect(binary).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('uses the native source length, AST node and constant resource limits',()=>{
    expect(evaluate(Array(125).fill('True').join(' and '))).toBe(true) // Expression + BoolOp + And + 125 constants =128.
    expect(()=>compileBackupExpression(Array(126).fill('True').join(' and '),new Set())).toThrow('复杂')
    expect(()=>compileBackupExpression(' '.repeat(2048)+'1',new Set())).toThrow('文本')
    expect(()=>compileBackupExpression(`'${'a'.repeat(513)}'`,new Set())).toThrow('常量')
    expect(()=>compileBackupExpression(`0x1${'0'.repeat(64)}`,new Set())).toThrow('位数')
    expect(evaluate('abs('.repeat(42)+'1'+')'.repeat(42))).toBe(1)
    expect(()=>compileBackupExpression('abs('.repeat(43)+'1'+')'.repeat(43),new Set())).toThrow('复杂')
    expect(evaluate(Array(4).fill(`'${'😀'.repeat(500)}'`).join(' + '))).toBe('😀'.repeat(2000))
    expect(()=>compileBackupExpression(Array(3).fill(`'${'😀'.repeat(200)}'`).join(' '),new Set())).toThrow('常量')
    expect(evaluate('(2 ** 32) ** 64 > 0')).toBe(true)
    expect(()=>compileBackupExpression('(2 ** 33) ** 64 > 0',new Set())).toThrow('幂运算')
  })

  it('reads only observed facility types and cached positions, not configured slots',()=>{
    const state=createRosterRuntime({positions:[{id:'room_1_1_0',roomId:'room_1_1',primary:'char_123_fang',candidates:[]}],beds:[]})
    const type=compileBackupExpression("op_data.facility_type(room_1_1)",new Set())
    expect(type.evaluate(state)).toBeNull()
    state.mowerFacilityTypes={room_1_1:'manufacture'}
    expect(type.evaluate(state)).toBe('manufacture')
    expect(compileBackupExpression("op_data.facility_type('room_' + '1_1')",new Set()).evaluate(state)).toBe('manufacture')
    expect(compileBackupExpression("op_data.facility_type(room_1_1 if True else 'missing')",new Set()).evaluate(state)).toBe('manufacture')
    state.mowerFacilityTypes=Object.create({room_1_1:'trade'}) as Record<string,string>
    expect(type.evaluate(state)).toBeNull()
    expect(compileBackupExpression('op_data.facility_operator_count(room_1_1)',new Set()).evaluate(state)).toBe(1)
    delete state.occupants.room_1_1_0
    expect(compileBackupExpression('op_data.facility_operator_count(room_1_1)',new Set()).evaluate(state)).toBe(0)
  })

  it('carries facility queries through the formal simulation entry and activates the matching backup',()=>{
    const workspace=createDefaultWorkspace()
    workspace.mainPlan.facilities.room_1_1.slots=[{occupant:{kind:'operator',operatorId:'char_123_fang'},groupId:null,replacements:[]}]
    workspace.compatibility.backupPlans=[{name:'observed room',trigger:{left:"op_data.facility_type('room_' + '1_1') == manufacture and ['x','y'][op_data.facility_operator_count(room_1_1 if True else 'missing')] == 'y' and (True or abs(1,2))",operator:'',right:''},conf:{workaholic:'芬'}}]
    const result=runCalculationBridge(workspace,{engine:'simulation',simulationOptions:{warmupHours:0,sampleHours:.02,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:1}}})
    expect(result.success,result.error).toBe(true)
    expect(result.simulationReport?.events.some(event=>event.type==='backup-plan'&&event.active&&event.backupName==='observed room')).toBe(true)
  })
})
