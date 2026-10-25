// Bounded Python values for Mower alpha 94a49b4c expressions, without dynamic evaluation.
import type {MowerDateTimeValue} from './mowerSchedulingData'
import {lookupBackupUnicodeName,isBackupUnicodePrintable} from './unicodeEscapeNames'

export interface BackupBytesValue {kind:'bytes';bytes:readonly number[]}
export interface BackupComplexValue {kind:'complex';real:number;imag:number}
export type BackupExpressionValue=string|number|bigint|boolean|null|MowerDateTimeValue|BackupBytesValue|BackupComplexValue|BackupExpressionValue[]
const fail=(message:string):never=>{throw new Error('副表：'+message)}
// Native AST resource checks belong to the parser; runtime allocations use platform limits.
const MAX_LITERAL_BITS=256,MAX_LITERAL_LENGTH=512
// CPython3.12 default int_max_str_digits applies to decimal conversion only.
const FIRST_OVERSIZED_DECIMAL_INTEGER=10n**4300n
const integerBits=(value:bigint)=>value===0n?1:(value<0n?-value:value).toString(2).length
function integerLiteral(value:bigint):bigint {
 if(integerBits(value)>MAX_LITERAL_BITS)return fail('整数常量超过位数限制')
 return value
}

export function parseBackupNumberLiteral(text:string):number|bigint|BackupComplexValue {
 const imaginary=/[jJ]$/.test(text),raw=imaginary?text.slice(0,-1):text
 const digits=String.raw`\d(?:_?\d)*`,decimal=new RegExp(`^(?:(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?)$`)
 const integer=/^(?:0[xX]_?[\da-fA-F](?:_?[\da-fA-F])*|0[oO]_?[0-7](?:_?[0-7])*|0[bB]_?[01](?:_?[01])*|(?:0(?:_?0)*|[1-9](?:_?\d)*))$/
 if(!imaginary&&integer.test(raw))return integerLiteral(BigInt(raw.replace(/_/g,'')))
 if(!decimal.test(raw))return fail('无效数字常量')
 if(!imaginary&&!/[.eE]/.test(raw))return fail('无效整数常量')
 const value=Number(raw.replace(/_/g,''))
 return imaginary?{kind:'complex',real:0,imag:value}:value
}

export function decodeBackupStringLiteral(text:string):string|BackupBytesValue {
 const match=/^([rRuUbB]*)("""|'''|"|')/.exec(text)
 if(!match)return fail('无效字符串常量')
 const prefix=match[1]!.toLowerCase(),quote=match[2]!,raw=prefix.includes('r'),bytes=prefix.includes('b')
 if(!['','r','u','b','br','rb'].includes(prefix)||!text.endsWith(quote)||text.length<match[0].length+quote.length)return fail('无效字符串常量')
 const source=text.slice(match[0].length,-quote.length).replace(/\r\n?/g,'\n'),characters:string[]=[]
 for(let i=0;i<source.length;i++){
  const char=source[i]!
  if(char==='\0'||quote.length===1&&(char==='\n'||char===quote))return fail('无效字符串常量')
  if(bytes&&char.charCodeAt(0)>127)return fail('bytes常量只能直接包含ASCII字符')
  if(char!=='\\'){characters.push(char);continue}
  const escaped=source[++i];if(escaped===undefined)return fail('字符串转义不完整')
  if(bytes&&escaped.charCodeAt(0)>127)return fail('bytes常量只能直接包含ASCII字符')
  if(raw){characters.push('\\',escaped);continue}
  if(escaped==='\n')continue
  const simple:Record<string,string>={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v',"'":"'",'"':'"','\\':'\\'}
  if(escaped in simple){characters.push(simple[escaped]!);continue}
  if(/[0-7]/.test(escaped)){
   const octal=escaped+(/^[0-7]{0,2}/.exec(source.slice(i+1))?.[0]??'');i+=octal.length-1
   characters.push(String.fromCodePoint(parseInt(octal,8)%(bytes?256:0x110000)));continue
  }
  if(escaped==='x'||!bytes&&(escaped==='u'||escaped==='U')){
   const length=escaped==='x'?2:escaped==='u'?4:8,hex=source.slice(i+1,i+1+length)
   if(hex.length!==length||!/^[\da-fA-F]+$/.test(hex)||parseInt(hex,16)>0x10ffff)return fail('无效十六进制或Unicode转义')
   characters.push(String.fromCodePoint(parseInt(hex,16)));i+=length;continue
  }
  if(!bytes&&escaped==='N'){
   const end=source.indexOf('}',i+2)
   if(source[i+1]!=='{'||end<0)return fail('Unicode名称转义不完整')
   characters.push(lookupBackupUnicodeName(source.slice(i+2,end)));i=end;continue
  }
  characters.push('\\',escaped)
 }
 const value=characters.join('')
 if(Array.from(value).length>MAX_LITERAL_LENGTH)return fail('字符串常量超过512码点限制')
 return bytes?{kind:'bytes',bytes:Array.from(value,char=>char.charCodeAt(0))}:value
}

type Value=BackupExpressionValue
type Numeric=number|bigint|boolean
const isBytes=(value:Value):value is BackupBytesValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&'kind' in value&&value.kind==='bytes'
const isComplex=(value:Value):value is BackupComplexValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&'kind' in value&&value.kind==='complex'
const isDate=(value:Value):value is MowerDateTimeValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&'timeMicros' in value
const isNumeric=(value:Value):value is Numeric=>['number','bigint','boolean'].includes(typeof value)
const isInteger=(value:Value):value is bigint|boolean=>typeof value==='bigint'||typeof value==='boolean'
const asInteger=(value:bigint|boolean):bigint=>typeof value==='boolean'?BigInt(value):value
function asFloat(value:Numeric):number {
 const result=typeof value==='number'?value:Number(value)
 if(typeof value==='bigint'&&!Number.isFinite(result))return fail('整数过大，无法转换成浮点数')
 return result
}
export function backupExpressionTruthy(value:Value):boolean {
 if(value===null)return false
 if(typeof value==='number')return value!==0 // Python NaN is true.
 if(isBytes(value))return value.bytes.length>0
 if(isComplex(value))return value.real!==0||value.imag!==0
 return Array.isArray(value)?value.length>0:Boolean(value)
}
function numericCompare(a:Numeric,b:Numeric):number {
 if(isInteger(a)&&isInteger(b)){const x=asInteger(a),y=asInteger(b);return x===y?0:x<y?-1:1}
 if(isInteger(b))return -numericCompare(b,a)
 if(Number.isNaN(b)||typeof a==='number'&&Number.isNaN(a))return NaN
 if(isInteger(a)){
  if(!Number.isFinite(b))return b===Infinity?-1:1
  const x=asInteger(a),whole=BigInt(Math.trunc(b))
  return x<whole?-1:x>whole?1:b>Math.trunc(b)?-1:b<Math.trunc(b)?1:0
 }
 return a===b?0:a<b?-1:1
}
export function backupExpressionEqual(a:Value,b:Value):boolean {
 if(isNumeric(a)&&isNumeric(b))return numericCompare(a,b)===0
 if(isComplex(a)||isComplex(b)){
  const complex=isComplex(a)?a:b as BackupComplexValue,other=isComplex(a)?b:a
  return isComplex(other)?complex.real===other.real&&complex.imag===other.imag:complex.imag===0&&isNumeric(other)&&numericCompare(complex.real,other)===0
 }
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>backupExpressionEqual(value,b[index]!))
 if(isBytes(a)&&isBytes(b))return a.bytes.length===b.bytes.length&&a.bytes.every((value,index)=>value===b.bytes[index])
 if(isDate(a)&&isDate(b))return a.timeMicros===b.timeMicros
 return a===b
}
function lexicographic(a:Value[],b:Value[]):number {
 for(let i=0;i<Math.min(a.length,b.length);i++)if(!backupExpressionEqual(a[i]!,b[i]!))return backupExpressionCompare(a[i]!,b[i]!)
 return Math.sign(a.length-b.length)
}
export function backupExpressionCompare(a:Value,b:Value):number {
 if(isNumeric(a)&&isNumeric(b))return numericCompare(a,b)
 if(typeof a==='string'&&typeof b==='string')return lexicographic(Array.from(a).map(char=>char.codePointAt(0)!),Array.from(b).map(char=>char.codePointAt(0)!))
 if(Array.isArray(a)&&Array.isArray(b))return lexicographic(a,b)
 if(isBytes(a)&&isBytes(b))return lexicographic([...a.bytes],[...b.bytes])
 if(isDate(a)&&isDate(b))return Math.sign(a.timeMicros-b.timeMicros)
 return fail('这些类型不能有序比较')
}
export function normalizeBackupExpressionValue(value:Value):Value {
 if(typeof value==='bigint'&&value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER))return Number(value)
 return Array.isArray(value)?value.map(normalizeBackupExpressionValue):value
}
export function backupExpressionLiteralLength(value:Value):number|null {
 return typeof value==='string'?Array.from(value).length:isBytes(value)?value.bytes.length:null
}
function iterable(value:Value):Value[] {
 return Array.isArray(value)?value:typeof value==='string'?Array.from(value):isBytes(value)?value.bytes.map(byte=>BigInt(byte)):fail('需要可迭代的字符串、bytes或列表')
}
export function backupExpressionIndex(container:Value,index:Value):Value {
 if(!isInteger(index))return fail('索引需要整数')
 const items=iterable(container),raw=asInteger(index),position=raw<0n?raw+BigInt(items.length):raw
 if(position<0n||position>=BigInt(items.length))return fail('索引越界')
 return items[Number(position)]!
}
export function backupExpressionContains(container:Value,needle:Value):boolean {
 if(Array.isArray(container))return container.some(value=>backupExpressionEqual(value,needle))
 if(typeof container==='string')return typeof needle==='string'?container.includes(needle):fail('字符串成员必须是字符串')
 if(isBytes(container)){
  if(isInteger(needle)){const byte=asInteger(needle);if(byte<0n||byte>255n)return fail('bytes成员整数应在0到255之间');return container.bytes.includes(Number(byte))}
  if(!isBytes(needle))return fail('bytes成员必须是整数或bytes')
  return Array.from({length:Math.max(0,container.bytes.length-needle.bytes.length+1)},(_,index)=>index).some(index=>needle.bytes.every((byte,offset)=>container.bytes[index+offset]===byte))
 }
 return fail('成员比较需要序列')
}
export function backupExpressionUnary(value:Value):Value {
 if(isComplex(value))return {kind:'complex',real:-value.real,imag:-value.imag}
 if(!isNumeric(value))return fail('负号运算需要数字')
 return isInteger(value)?-asInteger(value):-value
}
function roundedQuotient(numerator:bigint,denominator:bigint):bigint {
 const quotient=numerator/denominator,remainder=numerator%denominator,doubled=remainder*2n
 return quotient+(doubled>denominator||doubled===denominator&&quotient%2n!==0n?1n:0n)
}
/** Round a nonnegative rational directly to binary64, including subnormals. */
function rationalFloat(numerator:bigint,denominator:bigint):number {
 if(!numerator)return 0
 let exponent=integerBits(numerator)-integerBits(denominator)
 if(exponent>=0?numerator<denominator<<BigInt(exponent):numerator<<BigInt(-exponent)<denominator)exponent--
 if(exponent>1023)return fail('整数真除法结果超过浮点范围')
 const shift=Math.max(-1074,exponent-52),significand=shift>=0?roundedQuotient(numerator,denominator<<BigInt(shift)):roundedQuotient(numerator<<BigInt(-shift),denominator)
 const result=Number(significand)*2**shift
 if(!Number.isFinite(result))return fail('整数真除法结果超过浮点范围')
 return result
}
function floatDivmod(a:number,b:number):[number,number] {
 let remainder=a%b,division=(a-remainder)/b
 if(remainder!==0){if((remainder<0)!==(b<0)){remainder+=b;division--}}
 else remainder=b<0||Object.is(b,-0)?-0:0
 let floor:number
 if(division!==0){floor=Math.floor(division);if(division-floor>0.5)floor++}
 else floor=a/b<0||Object.is(a/b,-0)?-0:0
 return [floor,remainder]
}
function numericBinary(op:string,a:Numeric,b:Numeric):Value {
 if(op==='**'&&(!isInteger(b)||asInteger(b)<0n||asInteger(b)>64n))return fail('幂运算指数必须是0到64的整数常量')
 if(isInteger(a)&&isInteger(b)){
  const x=asInteger(a),y=asInteger(b)
  if(['/', '//', '%'].includes(op)&&y===0n)return fail('除零')
  if(op==='/')return (x<0n)!==(y<0n)?-rationalFloat(x<0n?-x:x,y<0n?-y:y):rationalFloat(x<0n?-x:x,y<0n?-y:y)
  if(op==='**')return x**y
  if(op==='+')return x+y
  if(op==='-')return x-y
  if(op==='*')return x*y
  const remainder=x%y,adjust=remainder!==0n&&(remainder<0n)!==(y<0n)
  if(op==='//')return x/y-(adjust?1n:0n)
  if(op==='%')return remainder+(adjust?y:0n)
 }else{
  const x=asFloat(a),y=asFloat(b)
  if(['/', '//', '%'].includes(op)&&y===0)return fail('除零')
  if(op==='+')return x+y
  if(op==='-')return x-y
  if(op==='*')return x*y
  if(op==='/')return x/y
  if(op==='//')return floatDivmod(x,y)[0]
  if(op==='%')return floatDivmod(x,y)[1]
  if(op==='**'){const result=x**y;if(Number.isFinite(x)&&!Number.isFinite(result))return fail('幂运算浮点结果溢出');return result}
 }
 return fail('不支持的算术运算')
}
function complex(value:Value):BackupComplexValue {
 return isComplex(value)?value:isNumeric(value)?{kind:'complex',real:asFloat(value),imag:0}:fail('复数运算需要数字')
}
function complexProduct(a:BackupComplexValue,b:BackupComplexValue):BackupComplexValue {
 return {kind:'complex',real:a.real*b.real-a.imag*b.imag,imag:a.real*b.imag+a.imag*b.real}
}
function complexBinary(op:string,left:Value,right:Value):BackupComplexValue {
 const a=complex(left),b=complex(right)
 if(op==='+')return {kind:'complex',real:a.real+b.real,imag:a.imag+b.imag}
 if(op==='-')return {kind:'complex',real:a.real-b.real,imag:a.imag-b.imag}
 if(op==='*')return complexProduct(a,b)
 if(op==='/'){
  if(b.real===0&&b.imag===0)return fail('复数除零')
  if(Math.abs(b.real)>=Math.abs(b.imag)){
   const ratio=b.imag/b.real,denominator=b.real+b.imag*ratio
   return {kind:'complex',real:(a.real+a.imag*ratio)/denominator,imag:(a.imag-a.real*ratio)/denominator}
  }
  const ratio=b.real/b.imag,denominator=b.real*ratio+b.imag
  return {kind:'complex',real:(a.real*ratio+a.imag)/denominator,imag:(a.imag*ratio-a.real)/denominator}
 }
 if(op==='**'){
  if(!isInteger(right)||asInteger(right)<0n||asInteger(right)>64n)return fail('幂运算指数必须是0到64的整数常量')
  let power=asInteger(right),factor=a,result:BackupComplexValue={kind:'complex',real:1,imag:0}
  while(power){if(power&1n)result=complexProduct(result,factor);power>>=1n;if(power)factor=complexProduct(factor,factor)}
  if(Number.isFinite(a.real)&&Number.isFinite(a.imag)&&(!Number.isFinite(result.real)||!Number.isFinite(result.imag)))return fail('复数幂运算结果溢出')
  return result
 }
 return fail('复数不支持整除或取模')
}
function repeatSequence(sequence:string|Value[]|BackupBytesValue,count:bigint|boolean):Value {
 const requested=asInteger(count)
 if(requested>0x7fffffffffffffffn||requested< -0x8000000000000000n)return fail('序列复制次数超过整数范围')
 const length=typeof sequence==='string'?Array.from(sequence).length:isBytes(sequence)?sequence.bytes.length:sequence.length,repeats=requested>0n?requested:0n
 const times=length?Number(repeats):0
 if(typeof sequence==='string')return sequence.repeat(times)
 if(isBytes(sequence))return {kind:'bytes',bytes:Array.from({length:length*times},(_,index)=>sequence.bytes[index%length]!)}
 return Array.from({length:length*times},(_,index)=>sequence[index%length]!)
}
export function backupExpressionBinary(op:string,a:Value,b:Value):Value {
 if(op==='%'&&(typeof a==='string'||isBytes(a)))return percentFormat(a,b)
 if(op==='+'){
  if(typeof a==='string'&&typeof b==='string')return a+b
  if(Array.isArray(a)&&Array.isArray(b))return [...a,...b]
  if(isBytes(a)&&isBytes(b))return {kind:'bytes',bytes:[...a.bytes,...b.bytes]}
 }
 if(op==='*'){
  if(isInteger(b)&&(typeof a==='string'||Array.isArray(a)||isBytes(a)))return repeatSequence(a,b)
  if(isInteger(a)&&(typeof b==='string'||Array.isArray(b)||isBytes(b)))return repeatSequence(b,a)
 }
 if(isComplex(a)||isComplex(b))return complexBinary(op,a,b)
 if(isNumeric(a)&&isNumeric(b))return numericBinary(op,a,b)
 return fail('算术运算需要兼容的数字或序列')
}
export function backupExpressionCall(name:string,inputs:Value[]):Value {
 if(!['max','min','sum','any','all','abs'].includes(name))return fail('不支持的副表函数')
 if(['abs','any','all'].includes(name)&&inputs.length!==1||name==='sum'&&(inputs.length<1||inputs.length>2)||!inputs.length)return fail(name+'参数数量错误')
 const first=inputs[0]!
 if(name==='abs'){
  if(isComplex(first)){const result=Math.hypot(first.real,first.imag);if(Number.isFinite(first.real)&&Number.isFinite(first.imag)&&!Number.isFinite(result))return fail('复数绝对值溢出');return result}
  if(!isNumeric(first))return fail('abs需要数字')
  return isInteger(first)?asInteger(first)<0n?-asInteger(first):asInteger(first):Math.abs(first)
 }
 const items=['sum','any','all'].includes(name)||inputs.length===1?iterable(first):inputs
 if(name==='any')return items.some(backupExpressionTruthy)
 if(name==='all')return items.every(backupExpressionTruthy)
 if(name==='sum'){
  const result:Value=inputs.length===2?inputs[1]!:0n
  if(typeof result==='string'||isBytes(result))return fail('sum起始值不能是str或bytes')
  return pythonSum(items,result)
 }
 if(!items.length)return fail(name+'不能使用空序列')
 let result:Value=items[0]!
 for(const value of items.slice(1)){const order=backupExpressionCompare(value,result);if(name==='max'?order>0:order<0)result=value}
 return result
}

/** CPython 3.12 builtin_sum, Windows: C long is 32-bit, Py_ssize_t is 64-bit. */
function pythonSum(items:Value[],start:Value):Value {
 const fitsLong=(value:bigint)=>value>= -2147483648n&&value<=2147483647n
 let result=start,cursor=0
 if(typeof result==='bigint'&&fitsLong(result)){
  let integerTotal=result
  while(cursor<items.length){
   const value=items[cursor++]!
   if(isInteger(value)){
    const item=asInteger(value),sum=integerTotal+item
    if(fitsLong(item)&&sum>= -0x8000000000000000n&&sum<=0x7fffffffffffffffn){integerTotal=sum;result=sum;continue}
   }
   result=backupExpressionBinary('+',integerTotal,value);break
  }
 }
 if(typeof result==='number'){
  let total=result,compensation=0,fallback=false
  const finish=()=>compensation!==0&&Number.isFinite(compensation)?total+compensation:total
  while(cursor<items.length){
   const value=items[cursor++]!
   if(typeof value==='number'){
    const sum=total+value
    compensation+=Math.abs(total)>=Math.abs(value)?(total-sum)+value:(value-sum)+total
    total=sum;continue
   }
   if(isInteger(value)&&fitsLong(asInteger(value))){total+=Number(asInteger(value));continue}
   result=backupExpressionBinary('+',finish(),value);fallback=true;break
  }
  if(!fallback)return finish()
 }
 for(;cursor<items.length;cursor++)result=backupExpressionBinary('+',result,items[cursor]!)
 return result
}

function pythonFloat(value:number):string {
 if(Number.isNaN(value))return 'nan'
 if(!Number.isFinite(value))return value<0?'-inf':'inf'
 if(value===0)return Object.is(value,-0)?'-0.0':'0.0'
 const sign=value<0?'-':'',absolute=Math.abs(value),text=absolute.toString()
 if(absolute>=1e-4&&absolute<1e16)return sign+text+(Number.isInteger(absolute)?'.0':'')
 let mantissa:string,exponent:number
 if(text.includes('e')){const pieces=text.split('e');mantissa=pieces[0]!;exponent=Number(pieces[1])}
 else if(absolute>=1){const digits=text.replace(/0+$/,'');mantissa=digits[0]!+(digits.length>1?'.'+digits.slice(1):'');exponent=text.length-1}
 else {const index=text.search(/[1-9]/),digits=text.slice(index);mantissa=digits[0]!+(digits.length>1?'.'+digits.slice(1):'');exponent=1-index}
 return sign+mantissa+'e'+(exponent<0?'-':'+')+String(Math.abs(exponent)).padStart(2,'0')
}
function pythonComplex(value:BackupComplexValue):string {
 const component=(number:number)=>pythonFloat(number).replace(/\.0$/,''),imag=component(value.imag)
 if(value.real===0&&!Object.is(value.real,-0))return imag+'j'
 return '('+component(value.real)+(value.imag<0||Object.is(value.imag,-0)?'':'+')+imag+'j)'
}
function escapedCodePoint(code:number):string {return code<=0xff?'\\x'+code.toString(16).padStart(2,'0'):code<=0xffff?'\\u'+code.toString(16).padStart(4,'0'):'\\U'+code.toString(16).padStart(8,'0')}
function decimalInteger(value:bigint):string {
 if(value>=FIRST_OVERSIZED_DECIMAL_INTEGER||value<=-FIRST_OVERSIZED_DECIMAL_INTEGER)return fail('整数十进制转换超过Python3.12默认4300位限制')
 return value.toString()
}
function repr(value:Value,ascii=false,depth=0):string {
 // Only List AST nodes add nesting. AST<=128, while concat/repeat/sum/index do not
 // increase that nesting, so accepted expression values cannot reach this guard.
 if(depth>128)return fail('格式化嵌套过深')
 if(typeof value==='string'||isBytes(value)){
  const chars=typeof value==='string'?Array.from(value):value.bytes.map(byte=>String.fromCharCode(byte)),quote=chars.includes("'")&&!chars.includes('"')?'"':"'"
  let text=(isBytes(value)?'b':'')+quote
  for(const char of chars){const code=char.codePointAt(0)!;text+=char===quote||char==='\\'?'\\'+char:char==='\n'?'\\n':char==='\r'?'\\r':char==='\t'?'\\t':code<32||code===127||(ascii||isBytes(value))&&code>=127||!isBackupUnicodePrintable(code)?escapedCodePoint(code):char}
  return text+quote
 }
 if(Array.isArray(value))return '['+value.map(item=>repr(item,ascii,depth+1)).join(', ')+']'
 return pythonString(value)
}
function pythonString(value:Value):string {
 if(value===null)return 'None'
 if(typeof value==='boolean')return value?'True':'False'
 if(typeof value==='bigint')return decimalInteger(value)
 if(typeof value==='number')return pythonFloat(value)
 if(typeof value==='string')return value
 if(isComplex(value))return pythonComplex(value)
 if(isDate(value)){
  const date=new Date(value.timeMicros/1000)
  if(!Number.isFinite(date.getTime()))return fail('日期值超过可格式化范围')
  const base=date.toISOString().slice(0,19).replace('T',' '),fraction=((value.timeMicros%1_000_000)+1_000_000)%1_000_000
  return base+(fraction?'.'+String(fraction).padStart(6,'0'):'')
 }
 return repr(value)
}
function floatRational(value:number):[bigint,bigint] {
 const buffer=new ArrayBuffer(8),view=new DataView(buffer);view.setFloat64(0,value)
 const high=view.getUint32(0),low=view.getUint32(4),encoded=(high>>>20)&0x7ff,fraction=(BigInt(high&0xfffff)<<32n)|BigInt(low)
 const significand=fraction+(encoded?1n<<52n:0n),exponent=encoded?encoded-1023-52:-1074
 return exponent>=0?[significand<<BigInt(exponent),1n]:[significand,1n<<BigInt(-exponent)]
}
const ten=(power:number)=>10n**BigInt(power)
function roundDecimal(numerator:bigint,denominator:bigint,places:number):bigint {
 return places>=0?roundedQuotient(numerator*ten(places),denominator):roundedQuotient(numerator,denominator*ten(-places))
}
function decimalExponent(value:number,numerator:bigint,denominator:bigint):number {
 if(!value)return 0
 let exponent=Math.floor(Math.log10(value))
 const below=(power:number)=>power>=0?numerator<denominator*ten(power):numerator*ten(-power)<denominator
 while(below(exponent))exponent--
 while(!below(exponent+1))exponent++
 return exponent
}
function fixedDecimal(numerator:bigint,denominator:bigint,places:number,alternate:boolean):string {
 const digits=roundDecimal(numerator,denominator,places).toString().padStart(places+1,'0')
 return places?digits.slice(0,-places)+'.'+digits.slice(-places):digits+(alternate?'.':'')
}
function exponentialDecimal(numerator:bigint,denominator:bigint,exponent:number,places:number,alternate:boolean):string {
 let digits=roundDecimal(numerator,denominator,places-exponent).toString()
 if(digits.length>places+1){digits=digits.slice(0,-1);exponent++}
 digits=digits.padStart(places+1,'0')
 return digits[0]!+(places||alternate?'.'+digits.slice(1):'')+'e'+(exponent<0?'-':'+')+String(Math.abs(exponent)).padStart(2,'0')
}
function floatFormat(value:number,conversion:string,precision:number,alternate:boolean):string {
 if(!Number.isFinite(value))return Number.isNaN(value)?'nan':'inf'
 const [numerator,denominator]=floatRational(value),exponent=decimalExponent(value,numerator,denominator),type=conversion.toLowerCase()
 if(type==='f')return fixedDecimal(numerator,denominator,precision,alternate)
 if(type==='e')return exponentialDecimal(numerator,denominator,exponent,precision,alternate)
 const significant=precision||1,rounded=roundDecimal(numerator,denominator,significant-1-exponent),roundedExponent=rounded.toString().length>significant?exponent+1:exponent
 let text=roundedExponent< -4||roundedExponent>=significant?exponentialDecimal(numerator,denominator,exponent,significant-1,alternate):fixedDecimal(numerator,denominator,Math.max(0,significant-1-roundedExponent),alternate)
 if(!alternate){const parts=text.split('e');if(parts[0]!.includes('.'))parts[0]=parts[0]!.replace(/0+$/,'').replace(/\.$/,'');text=parts.join('e')}
 return text
}
function formatDimension(text:string):number {return Number(text||0)}
function percentFormat(format:string|BackupBytesValue,operand:Value):Value {
 const byteFormat=isBytes(format),source=typeof format==='string'?format:format.bytes.map(byte=>String.fromCharCode(byte)).join('')
 let output='',used=false
 const append=(text:string)=>{output+=text}
 for(let cursor=0;cursor<source.length;cursor++){
  if(source[cursor]!=='%'){const char=String.fromCodePoint(source.codePointAt(cursor)!);append(char);cursor+=char.length-1;continue}
  if(source[cursor+1]==='%'){append('%');cursor++;continue}
  const spec=/^([-+#0 ]*)(\d*|\*)(?:\.(\d*|\*))?([hlL]?)([\s\S])/.exec(source.slice(cursor+1))
  if(!spec)return fail('格式化占位符不完整')
  if(used)return fail('格式化参数不足')
  used=true;cursor+=spec[0].length
  const flags=spec[1]!,conversion=spec[5]!,type=conversion.toLowerCase(),numeric='diuoxXeEfFgG'.includes(conversion),width=spec[2]==='*'?fail('格式化宽度需要元组参数'):formatDimension(spec[2]!),precision=spec[3]==='*'?fail('格式化精度需要元组参数'):spec[3]===undefined?undefined:formatDimension(spec[3]),alternate=flags.includes('#')
  let text:string,sign='',prefix=''
  if('diuoxX'.includes(conversion)){
   if(!isNumeric(operand))return fail('整数格式需要数字')
   if('oxX'.includes(conversion)&&!isInteger(operand))return fail('进制格式需要整数')
   if(typeof operand==='number'&&!Number.isFinite(operand))return fail('不能格式化非有限整数')
   const integer=isInteger(operand)?asInteger(operand):BigInt(Math.trunc(operand)),absolute=integer<0n?-integer:integer
   sign=integer<0n?'-':flags.includes('+')?'+':flags.includes(' ')?' ':''
   text=(type==='o'?absolute.toString(8):type==='x'?absolute.toString(16):decimalInteger(absolute)).padStart(precision??1,'0')
   if(type==='x'&&conversion==='X')text=text.toUpperCase()
   if(alternate&&type==='o')prefix='0o'
   if(alternate&&type==='x')prefix=conversion==='X'?'0X':'0x'
  }else if('eEfFgG'.includes(conversion)){
   if(!isNumeric(operand))return fail('浮点格式需要实数')
   const number=asFloat(operand),negative=number<0||Object.is(number,-0)
   sign=negative?'-':flags.includes('+')?'+':flags.includes(' ')?' ':''
   text=floatFormat(Math.abs(number),conversion,precision??6,alternate)
   if(conversion===conversion.toUpperCase())text=text.toUpperCase()
  }else if(conversion==='c'){
   if(isInteger(operand)){const code=asInteger(operand);if(code<0n||code>BigInt(byteFormat?255:0x10ffff))return fail('字符码点越界');text=String.fromCodePoint(Number(code))}
   else if(byteFormat&&isBytes(operand)&&operand.bytes.length===1)text=String.fromCharCode(operand.bytes[0]!)
   else if(!byteFormat&&typeof operand==='string'&&Array.from(operand).length===1)text=operand
   else return fail('字符格式需要单个字符或整数')
  }else if(['s','r','a',...(byteFormat?['b']:[])].includes(conversion)){
   text=byteFormat&&['s','b'].includes(conversion)?isBytes(operand)?operand.bytes.map(byte=>String.fromCharCode(byte)).join(''):fail('bytes格式需要bytes值'):conversion==='s'?pythonString(operand):repr(operand,conversion==='a'||byteFormat)
   if(precision!==undefined)text=Array.from(text).slice(0,precision).join('')
  }else return fail('不支持的格式化占位符')
  const padding=Math.max(0,width-Array.from(sign+prefix+text).length),zero=numeric&&flags.includes('0')&&!flags.includes('-')
  append(flags.includes('-')?sign+prefix+text+' '.repeat(padding):zero?sign+prefix+'0'.repeat(padding)+text:' '.repeat(padding)+sign+prefix+text)
 }
 if(!used&&!Array.isArray(operand)&&(!isBytes(operand)||byteFormat))return fail('格式化有未使用的参数')
 return byteFormat?{kind:'bytes',bytes:Array.from(output,char=>char.charCodeAt(0))}:output
}
