// Mower logic_expression.py serializes (left operator right) before evaluation.
// This interpreter preserves that syntax without evaluating imported Python/JS.
import { OPERATOR_MAP } from '../domain/operators'
import {compileMowerBackupQuery} from './mowerBackupQueries'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import type { RuntimeState } from './rosterRuntime'
import {toMowerMicros} from './mowerTaskQueue'
import * as values from './backupExpressionValues'

type Value = values.BackupExpressionValue
type Expression = (state: RuntimeState) => Value
type ParsedExpression = Expression & {nodes:number;numericBits:number|null;integerLiteral?:bigint;integerConstant?:boolean;items?:ParsedExpression[];constant?:{value:Value}}
type Token = { text: string; kind: 'operator' | 'value' | 'worker' | 'attribute' | 'external' | 'query'; value?: Value; member?: string;literal?:'number'|'string'|'constant' }
const roomName = /^(?:room_[1-3]_[1-3]|dormitory_[1-4]|gaming_[1-3]|central|meeting|factory|contact|train|recycle)$/
const functionNames = new Set(['max', 'min', 'sum', 'any', 'all', 'abs'])
const maxFunctionArguments = 128
const fail = (message: string): never => { throw new Error(`副表：${message}`) }
export const backupExpressionTruthy=values.backupExpressionTruthy
const bits=(value:Value):number|null=>typeof value==='bigint'?Math.max(1,(value<0n?-value:value).toString(2).length):typeof value==='boolean'?1:typeof value==='number'?64:null
function fold(evaluate:()=>Value):Pick<ParsedExpression,'constant'> {
  // Only bounded index/comparison metadata uses this helper; general operations stay deferred.
  try{return {constant:{value:evaluate()}}}catch{return {}} // Runtime errors remain runtime errors, including in unselected branches.
}
function constantConcatenation(left:ParsedExpression,right:ParsedExpression):Pick<ParsedExpression,'constant'> {
  const a=left.constant?.value,b=right.constant?.value
  return typeof a==='string'&&typeof b==='string'&&Array.from(a).length+Array.from(b).length<=512?{constant:{value:a+b}}:{}
}
function constantIndex(container:ParsedExpression,index:ParsedExpression):Pick<ParsedExpression,'constant'> {
  const target=container.constant?.value,key=index.constant?.value
  const size=typeof target==='string'?Array.from(target).length:Array.isArray(target)?target.length
    :target&&typeof target==='object'&&'kind' in target&&target.kind==='bytes'?target.bytes.length:Infinity
  const smallIndex=typeof key==='boolean'||typeof key==='bigint'&&key>=-512n&&key<=512n
  return size<=512&&smallIndex?fold(()=>values.backupExpressionIndex(target!,key!)):{}
}
function constantNegation(expression:ParsedExpression):Pick<ParsedExpression,'constant'> {
  const value=expression.constant?.value
  return typeof value==='bigint'||typeof value==='number'?{constant:{value:-value}}
    :typeof value==='boolean'?{constant:{value:-BigInt(value)}}:{}
}
function node(evaluate:Expression,nodes:number,numericBits:number|null=null,metadata:Partial<ParsedExpression>={}):ParsedExpression {
  if(nodes+1>128)return fail('条件表达式过于复杂') // Includes ast.Expression.
  return Object.assign(evaluate,{nodes,numericBits,...metadata})
}
function quotedLiteral(text:string):string|undefined {
  const start=/^(?:[bB][rR]|[rR][bB]|[rRuUbB])?(?=['"])/.exec(text)
  if(!start)return undefined
  const offset=start[0].length,quote=text[offset]!,delimiter=text.slice(offset,offset+3)===quote.repeat(3)?quote.repeat(3):quote
  for(let cursor=offset+delimiter.length;cursor<text.length;cursor++){
    if(text[cursor]==='\\'){cursor++;continue}
    if(text.startsWith(delimiter,cursor))return text.slice(0,cursor+delimiter.length)
  }
  return fail('字符串常量不完整')
}

export function actualRoom(state: RuntimeState, id: string): string {
  const position = state.config.positions.find(p => state.occupants[p.id] === id)
  return position?.roomId ?? state.config.beds.find(b => state.bedOccupants[b.id] === id)?.roomId ?? ''
}

/** Mower ae9fc322 LogicExpression / FunctionExpression; never mutates imported trees. */
export function serializeBackupExpression(source: unknown, depth = 0, budget = { nodes: 0 }): string {
  if (depth > 256 || ++budget.nodes > 1024) return fail('条件树超过限制')
  if (typeof source === 'string') {
    if (Array.from(source).length > 2048) return fail('条件文本超过限制')
    return source
  }
  if (typeof source === 'boolean') return source ? 'True' : 'False'
  if (typeof source === 'number' && Number.isFinite(source)) return String(source)
  if (!source || typeof source !== 'object' || Array.isArray(source)) return fail('条件必须为表达式树')
  const node = source as Record<string, unknown>
  if ('function' in node) {
    const name = node.function
    if (typeof name !== 'string' || !functionNames.has(name)) return fail('不支持的副表函数')
    if (!Array.isArray(node.args) || !node.args.length) return fail('函数条件需要参数')
    if (node.args.length > maxFunctionArguments) return fail('函数参数超过限制')
    if (name === 'abs' && node.args.length !== 1) return fail('abs 条件只接受一项参数')
    let args = node.args.map(arg => serializeBackupExpression(arg, depth + 1, budget)).join(', ')
    if (['sum', 'any', 'all'].includes(name) || (['max', 'min'].includes(name) && node.args.length === 1)) args = `[${args}]`
    const text = `${name}(${args})`
    if (Array.from(text).length > 2048) return fail('条件文本超过限制')
    return text
  }
  if ([node.left, node.operator, node.right].every(value => value == null || typeof value === 'string' && !value.trim())) return 'False'
  const text = `(${serializeBackupExpression(node.left ?? '', depth + 1, budget)} ${serializeBackupExpression(node.operator ?? '', depth + 1, budget)} ${serializeBackupExpression(node.right ?? '', depth + 1, budget)})`
  if (Array.from(text).length > 2048) return fail('条件文本超过限制')
  return text
}

function tokenize(text: string): Token[] {
  if(text.includes('\0'))return fail('条件文本包含不允许的空字符')
  const tokens: Token[] = []
  for (let rest = text.trim(); rest; rest = rest.trimStart()) {
    if(rest.startsWith('#')){rest=rest.slice(rest.indexOf('\n')<0?rest.length:rest.indexOf('\n'));continue}
    if(rest.startsWith('\\\n')||rest.startsWith('\\\r\n')){rest=rest.slice(rest.startsWith('\\\r\n')?3:2);continue}
    if (tokens.length >= 1024) return fail('条件文本超过限制')
    const worker = /^op_data\s*\.\s*operators\b/.exec(rest)
    const attribute = /^\.\s*([A-Za-z_]\w*)/.exec(rest)
    const query = /^op_data\s*\.\s*(group_min_mood|group_max_mood|facility_has_mastery_plan|facility_is_training|inventory_count|facility_product_count|facility_product_type_count|facility_product|facility_type|facility_operator_count)\b/.exec(rest)
    const external = /^op_data\s*\.\s*(party_time|major_maintenance_remaining_hours)\b/.exec(rest)
    const quoted = quotedLiteral(rest)
    const number = /^(?:0[xX]_?[\da-fA-F](?:_?[\da-fA-F])*|0[oO]_?[0-7](?:_?[0-7])*|0[bB]_?[01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)/.exec(rest)
    const word = /^(?:and|or|not|is|in|if|else|True|False|None)\b/.exec(rest)
    const symbol = /^(?:==|!=|<=|>=|\/\/|\*\*|[<>+*/%(),\[\]\-])/.exec(rest)
    const aggregate = /^(?:max|min|sum|any|all|abs)\b/.exec(rest)
    const room = /^(?:room_[1-3]_[1-3]|dormitory_[1-4]|gaming_[1-3]|central|meeting|factory|contact|train|recycle)\b/.exec(rest)
    const product = /^(?:orirock_device|orirock|orundum|gold|exp3|lmd|manufacture|trade|power)\b/.exec(rest)
    let token: Token
    if (worker) token = { text: worker[0], kind: 'worker' }
    else if (attribute) token = {text:attribute[0],kind:'attribute',member:attribute[1]}
    else if (query) token = { text: query[0], kind: 'query', member: query[1] }
    else if (external) token = { text: external[0], kind: 'external',member:external[1] }
    else if (quoted) token = { text: quoted, kind: 'value', value: values.decodeBackupStringLiteral(quoted), literal:'string' }
    else if (number) token = { text: number[0], kind: 'value', value: values.parseBackupNumberLiteral(number[0]), literal:'number' }
    else if (word) token = ['True', 'False', 'None'].includes(word[0])
      ? { text: word[0], kind: 'value', value: word[0] === 'None' ? null : word[0] === 'True', literal:'constant' }
      : { text: word[0], kind: 'operator' }
    else if (symbol) token = { text: symbol[0], kind: 'operator' }
    else if (aggregate) token = { text: aggregate[0], kind: 'operator' }
    else if (product) token = { text: product[0], kind: 'value', value: product[0] }
    else if (room) token = { text: room[0], kind: 'value', value: room[0] }
    else return fail(`不支持的条件 ${rest.slice(0, 120)}`)
    rest = rest.slice(token.text.length)
    const previous=tokens[tokens.length-1]
    if(previous?.literal==='string'&&token.literal==='string'){
      previous.value=values.backupExpressionBinary('+',previous.value!,token.value!)
      if((values.backupExpressionLiteralLength(previous.value)??0)>512)return fail('字符串常量过长')
      previous.text+=` ${token.text}`
    }else tokens.push(token)
  }
  return tokens
}

export function compileBackupExpression(source: unknown, participants: Set<string>): { evaluate: Expression; usesCurrentMood: boolean; usesMajorMaintenance: boolean; usesMasteryPlan: boolean; usesInventory: boolean; usesFacilityProduct: boolean; usesFacilityObservation: boolean; observedOperatorDependenciesOnly: boolean; skipped?: string } {
  const tokens = tokenize(serializeBackupExpression(source))
  let cursor = 0, nesting = 0, observedOperatorKeysStatic = true
  const peek = () => tokens[cursor]?.text
  const take = (text: string) => peek() === text ? (++cursor, true) : false
  function argumentsFor(name:string):ParsedExpression[] {
    if(!take('('))return fail(`${name} 缺少参数括号`)
    const args:ParsedExpression[]=[]
    if(take(')'))return args
    do {
      if(args.length>=maxFunctionArguments)return fail('函数参数超过限制')
      args.push(conditional())
    } while(take(',')&&peek()!==')')
    if(!take(')'))return fail(`${name} 参数括号不完整`)
    return args
  }
  function comparisonValue(a:Value,b:Value,op:string):boolean {
    if (op === 'is' || op === 'is not') return op === 'is' ? a === b : a !== b
    if (op === '==' || op === '!=') return op==='=='?values.backupExpressionEqual(a,b):!values.backupExpressionEqual(a,b)
    if (op === 'in' || op === 'not in') {
      const included=values.backupExpressionContains(b,a)
      return op==='in'?included:!included
    }
    const order=values.backupExpressionCompare(a,b)
    return op==='<'?order<0:op==='<='?order<=0:op==='>'?order>0:order>=0
  }
  function binary(left:ParsedExpression,right:ParsedExpression,op:string):ParsedExpression {
    let resultBits:number|null=null
    if(left.numericBits!==null&&right.numericBits!==null){
      resultBits=op==='**'?Math.max(1,left.numericBits*Number(right.integerLiteral))
        :op==='*'?left.numericBits+right.numericBits
        :['+','-'].includes(op)?Math.max(left.numericBits,right.numericBits)+1:Math.max(left.numericBits,right.numericBits)
    }
    if(op==='*'&&(resultBits===null||resultBits>4096))return fail(resultBits===null?'乘法仅支持数值表达式':'乘法结果过大')
    if(op==='**'){
      if(right.integerLiteral===undefined||right.integerLiteral<0n||right.integerLiteral>64n)return fail('幂运算指数必须是0到64的整数常量')
      if(resultBits===null||resultBits>4096)return fail('幂运算结果过大')
    }
    return node(state=>values.backupExpressionBinary(op,left(state),right(state)),left.nodes+right.nodes+2,resultBits,
      op==='+'?constantConcatenation(left,right):{})
  }
  function atom():ParsedExpression {
    let expression=primary()
    while(take('[')){
      const index=conditional(),container=expression
      if(!take(']'))return fail('索引括号不完整或包含不支持的Slice')
      expression=node(state=>values.backupExpressionIndex(container(state),index(state)),container.nodes+index.nodes+2,null,
        constantIndex(container,index))
    }
    return expression
  }
  function primary():ParsedExpression {
    if (++nesting > 201) return fail('条件嵌套超过限制')
    try {
      if (functionNames.has(peek() ?? '')) {
        const name = tokens[cursor++]!.text
        const args = argumentsFor(name)
        let resultBits:number|null=null
        if(['any','all'].includes(name)&&args.length===1)resultBits=1
        else if(name==='abs'&&args.length===1)resultBits=args[0]!.numericBits
        else {
          const numericArgs=['max','min'].includes(name)&&args.length>=2?args:name==='sum'&&args.length===1?args[0]!.items:undefined
          if(numericArgs?.every(arg=>arg.numericBits!==null)){
            resultBits=Math.max(1,...numericArgs.map(arg=>arg.numericBits!))
            if(name==='sum'&&numericArgs.length)resultBits+=(numericArgs.length-1).toString(2).replace(/^0$/,'').length
          }
        }
        // Eager call arguments; only and/or and conditional expressions short-circuit.
        return node(state=>values.backupExpressionCall(name,args.map(arg=>arg(state))),3+args.reduce((total,arg)=>total+arg.nodes,0),resultBits)
      }
      if(take('[')){
        const items:ParsedExpression[]=[]
        if(!take(']')){
          do{if(items.length>=128)return fail('条件列表超过限制');items.push(conditional())}while(take(',')&&peek()!==']')
          if(!take(']'))return fail('条件列表不完整')
        }
        return node(state=>items.map(item=>item(state)),2+items.reduce((total,item)=>total+item.nodes,0),null,{items,
          ...items.every(item=>item.constant)?{constant:{value:items.map(item=>item.constant!.value)}}:{}})
      }
      if (take('(')) {
        if (take(')')) return fail('原生安全模型不支持Tuple')
        const expr = conditional()
        if (!take(')')) return fail('条件括号不完整')
        return expr
      }
      const token = tokens[cursor++]
      if (token?.kind === 'value') {
        const integerLiteral=typeof token.value==='bigint'?token.value:typeof token.value==='boolean'?BigInt(token.value):undefined
        return node(()=>token.value!,token.literal?1:2,token.literal==='number'&&/[jJ]$/.test(token.text)?64:bits(token.value!),{integerLiteral,integerConstant:integerLiteral!==undefined,constant:{value:token.value!}})
      }
      if (token?.kind === 'query') {
        const args=argumentsFor(token.member!)
        const resultBits=['inventory_count','facility_operator_count','facility_product_count','facility_product_type_count','group_min_mood','group_max_mood'].includes(token.member!)?64:null
        return node(state=>{
          const inputs=args.map(arg=>arg(state))
          if(token.member==='facility_product_type_count'){
            if(inputs.length)return fail('facility_product_type_count 不接受参数')
            const count=compileMowerBackupQuery(token.member)(state)
            if(typeof count!=='number')return fail('设施产物种类数量必须是整数')
            return BigInt(count)
          }
          if(inputs.length!==1||typeof inputs[0]!=='string')return fail(`${token.member} 需要一个字符串参数`)
          const value=compileMowerBackupQuery(token.member!,inputs[0])(state)
          return ['inventory_count','facility_operator_count','facility_product_count'].includes(token.member!)&&typeof value==='number'&&Number.isInteger(value)?BigInt(value):value
        },5+args.reduce((total,arg)=>total+arg.nodes,0),resultBits)
      }
      if (token?.kind === 'external') {
        if (token.member === 'major_maintenance_remaining_hours') {
          const args=argumentsFor(token.member)
          return node(state=>{
            const inputs=args.map(arg=>arg(state))
            if(inputs.length)return fail('major_maintenance_remaining_hours 不接受参数')
            const remaining=(state.config.majorMaintenanceStartHours??Infinity)-state.time
            return remaining>0?remaining:Infinity
          },5+args.reduce((total,arg)=>total+arg.nodes,0),64)
        }
        return node(state => state.mowerSource?.data.partyTime ?? null,4)
      }
      if (token?.kind === 'worker') {
        if(!take('['))return fail('干员查询缺少下标')
        const start=cursor,name=conditional()
        for(const candidate of tokens.slice(start,cursor))if(typeof candidate.value==='string'){
          const id=resolveOperatorCharId(candidate.value)
          if(OPERATOR_MAP.has(id))participants.add(id)
        }
        const staticId=typeof name.constant?.value==='string'?resolveOperatorCharId(name.constant.value):undefined
        if(staticId&&OPERATOR_MAP.has(staticId))participants.add(staticId)
        else observedOperatorKeysStatic=false
        if(!take(']'))return fail('干员下标不完整')
        const attribute=tokens[cursor++]
        if(attribute?.kind!=='attribute'||!['current_room','is_resting','is_working','current_mood'].includes(attribute.member!))return fail(`原生安全模型不支持干员属性 ${attribute?.member??attribute?.text??''}`)
        const called=peek()==='(',args=called?argumentsFor(attribute.member!):[]
        if(attribute.member!=='current_room'&&!called)return fail('干员观测方法需要调用括号')
        return node(state => {
          const selected=name(state),inputs=args.map(arg=>arg(state))
          if(typeof selected!=='string')return fail('干员下标必须是字符串')
          const id=resolveOperatorCharId(selected)
          if(!OPERATOR_MAP.has(id))return fail(`未知干员 ${selected}`)
          if(inputs.length||attribute.member==='current_room'&&called)return fail('干员观测方法参数不正确')
          const source=state.mowerSource?.data.operators
          if(source&&!Object.prototype.hasOwnProperty.call(source,id)||!source&&!Object.prototype.hasOwnProperty.call(state.morale,id))return fail(`缺少 ${selected} 的干员观测`)
          const observed=state.mowerSource?.data.operators[id]
          const room = observed?.currentRoom??actualRoom(state, id)
          if (attribute.member === 'is_resting') return room.startsWith('dormitory_')
          if (attribute.member === 'is_working') return roomName.test(room) && !room.startsWith('dormitory_')
          if (attribute.member === 'current_room') return room
          if(observed)return observed.currentMood(toMowerMicros(state.time))
          return state.morale[id] ?? fail(`缺少 ${selected} 的心情`)
        },8+name.nodes+(called?1+args.reduce((total,arg)=>total+arg.nodes,0):0),attribute.member==='current_mood'&&called?64:null)
      }
      return fail(`不支持的条件 ${token?.text ?? '空操作数'}`)
    } finally { nesting-- }
  }
  function power():ParsedExpression {
    const left=atom()
    if(!take('**'))return left
    return binary(left,unary(),'**')
  }
  function unary():ParsedExpression {
    if(take('+'))return fail('原生安全模型不支持UAdd')
    if(take('-')){
      const expr=unary()
      return node(state=>values.backupExpressionUnary(expr(state)),expr.nodes+2,expr.numericBits,{integerLiteral:expr.integerConstant?-expr.integerLiteral!:undefined,
        ...constantNegation(expr)})
    }
    return power()
  }
  function product():ParsedExpression {
    let expr = unary()
    while (['*','/','//','%'].includes(peek()??'')) { const op = tokens[cursor++]!.text; expr = binary(expr, unary(), op) }
    return expr
  }
  function sum():ParsedExpression {
    let expr = product()
    while (peek() === '+' || peek() === '-') { const op = tokens[cursor++]!.text; expr = binary(expr, product(), op) }
    return expr
  }
  function comparison():ParsedExpression {
    const operands = [sum()], operators: string[] = []
    while (['==', '!=', '<', '<=', '>', '>=', 'is', 'in', 'not'].includes(peek() ?? '')) {
      let op = tokens[cursor++]!.text
      if (op === 'is' && take('not')) op = 'is not'
      else if (op === 'not') { if (!take('in')) return fail('not 后缺少 in'); op = 'not in' }
      operators.push(op); operands.push(sum())
    }
    if (!operators.length) return operands[0]!
    const compareAll=(resolve:(index:number)=>Value):Value=>{
      let left = resolve(0)
      for (let i = 0; i < operators.length; i++) {
        const right = resolve(i+1)
        if (!comparisonValue(left,right,operators[i]!)) return false
        left = right
      }
      return true
    }
    return node(state=>compareAll(index=>operands[index]!(state)),1+operators.length+operands.reduce((total,operand)=>total+operand.nodes,0),1,
      operands.every(operand=>operand.constant)?fold(()=>compareAll(index=>operands[index]!.constant!.value)):{})
  }
  function negation():ParsedExpression {
    let count = 0
    while (take('not')) count++
    const expr = comparison()
    return count?node(state=>count%2?!backupExpressionTruthy(expr(state)):backupExpressionTruthy(expr(state)),expr.nodes+2*count,expr.numericBits,
      expr.constant?{constant:{value:count%2?!backupExpressionTruthy(expr.constant.value):backupExpressionTruthy(expr.constant.value)}}:{}):expr
  }
  function logicalAnd():ParsedExpression {
    const operands=[negation()]
    while(take('and'))operands.push(negation())
    return operands.length===1?operands[0]!:node(state=>{
      let value:Value=false
      for(const operand of operands){value=operand(state);if(!backupExpressionTruthy(value))break}
      return value
    },2+operands.reduce((total,operand)=>total+operand.nodes,0),1,logicalConstant(operands,false))
  }
  function logicalOr():ParsedExpression {
    const operands=[logicalAnd()]
    while(take('or'))operands.push(logicalAnd())
    return operands.length===1?operands[0]!:node(state=>{
      let value:Value=false
      for(const operand of operands){value=operand(state);if(backupExpressionTruthy(value))break}
      return value
    },2+operands.reduce((total,operand)=>total+operand.nodes,0),1,logicalConstant(operands,true))
  }
  function logicalConstant(operands:ParsedExpression[],shortCircuitWhen:boolean):Pick<ParsedExpression,'constant'> {
    let constant:ParsedExpression['constant']
    for(const operand of operands){
      if(!operand.constant)return {}
      constant=operand.constant
      if(backupExpressionTruthy(constant.value)===shortCircuitWhen)break
    }
    return {constant}
  }
  function conditional():ParsedExpression {
    const body=logicalOr()
    if(!take('if'))return body
    const condition=logicalOr()
    if(!take('else'))return fail('条件表达式缺少else')
    const alternative=conditional()
    const resultBits=body.numericBits!==null&&alternative.numericBits!==null?Math.max(body.numericBits,alternative.numericBits):null
    return node(state=>backupExpressionTruthy(condition(state))?body(state):alternative(state),1+body.nodes+condition.nodes+alternative.nodes,resultBits,
      condition.constant?{constant:(backupExpressionTruthy(condition.constant.value)?body:alternative).constant}:{})
  }
  const parsed = tokens.length ? conditional() : node(() => false,1,1)
  if (cursor !== tokens.length) return fail(`条件存在未解析内容 ${peek()}`)
  const usesMajorMaintenance = tokens.some(token => token.kind === 'external' && token.member === 'major_maintenance_remaining_hours')
  return {
    evaluate:state=>values.normalizeBackupExpressionValue(parsed(state)), usesMajorMaintenance,
    observedOperatorDependenciesOnly:observedOperatorKeysStatic&&tokens.some(token=>token.kind==='worker')&&tokens.every(token=>['operator','value','worker','attribute'].includes(token.kind)),
    usesInventory: tokens.some(token=>token.kind==='query'&&token.member==='inventory_count'),
    usesFacilityProduct: tokens.some(token=>token.kind==='query'&&['facility_product','facility_product_count','facility_product_type_count'].includes(token.member!)),
    usesFacilityObservation:tokens.some(token=>token.kind==='query'&&['facility_type','facility_operator_count'].includes(token.member!)),
    usesMasteryPlan: tokens.some(token=>token.kind==='query'&&['facility_has_mastery_plan','facility_is_training'].includes(token.member!)),
    usesCurrentMood: tokens.some(token=>token.kind==='attribute'&&token.member==='current_mood'||token.kind==='query'&&['group_min_mood','group_max_mood'].includes(token.member!)),
  }
}
