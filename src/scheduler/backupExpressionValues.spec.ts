import {describe,expect,it} from 'vitest'
import * as values from './backupExpressionValues'
const {parseBackupNumberLiteral}=values

describe('Python backup literal values',()=>{
 it('retains exact integer constants while distinguishing floats',()=>{
  expect(parseBackupNumberLiteral('18_446_744_073_709_551_617')).toBe(18446744073709551617n)
  expect(parseBackupNumberLiteral('0x_FF')).toBe(255n)
  expect(parseBackupNumberLiteral('0o17')).toBe(15n)
  expect(parseBackupNumberLiteral('0b101')).toBe(5n)
  expect(parseBackupNumberLiteral('0_0')).toBe(0n)
  expect(parseBackupNumberLiteral('1_2.5_0e-1')).toBe(1.25)
 })
})

describe('bounded Python numeric values',()=>{
 it('keeps integer arithmetic exact beyond binary64 precision',()=>{
  const base=values.backupExpressionBinary('**',2n,64n)
  expect(values.backupExpressionCompare(values.backupExpressionBinary('+',base,1n),base)).toBe(1)
  expect(values.normalizeBackupExpressionValue([1n,18446744073709551617n])).toEqual([1,18446744073709551617n])
 })
 it('uses Python negative floor and remainder signs',()=>{
  expect(values.backupExpressionBinary('//',-7n,3n)).toBe(-3n)
  expect(values.backupExpressionBinary('%',-7n,3n)).toBe(2n)
  expect(values.backupExpressionBinary('//',7n,-3n)).toBe(-3n)
  expect(values.backupExpressionBinary('%',7n,-3n)).toBe(-2n)
 })
 it('uses the floating divmod correction rather than flooring a rounded quotient',()=>{
  expect(values.backupExpressionBinary('//',1.0,0.1)).toBe(9)
  expect(values.backupExpressionBinary('%',1.0,0.1)).toBe(0.09999999999999995)
  expect(Object.is(values.backupExpressionBinary('%',-4.0,2.0),0)).toBe(true)
  expect(Object.is(values.backupExpressionBinary('%',4.0,-2.0),-0)).toBe(true)
 })
 it('compares large integers with floats without converting the integer to binary64',()=>{
  expect(values.backupExpressionEqual(9007199254740993n,9007199254740992)).toBe(false)
  expect(values.backupExpressionCompare(9007199254740993n,9007199254740992)).toBe(1)
  expect(values.backupExpressionEqual(2n,2.0)).toBe(true)
  expect(values.backupExpressionCompare(-2n,-2.5)).toBe(1)
 })
 it('preserves Python nonfinite float results and truthiness',()=>{
  expect(parseBackupNumberLiteral('1e309')).toBe(Infinity)
  expect(values.backupExpressionBinary('*',1e308,1e308)).toBe(Infinity)
  expect(values.backupExpressionTruthy(values.backupExpressionBinary('%',Infinity,Infinity))).toBe(true)
  expect(values.backupExpressionEqual(NaN,NaN)).toBe(false)
  expect(values.backupExpressionCompare(NaN,1n)).toBeNaN()
 })
 it('computes a finite true quotient of huge integers without inf divided by inf',()=>{
  const huge=1n<<2048n
  expect(values.backupExpressionBinary('/',huge,huge)).toBe(1)
  expect(values.backupExpressionBinary('/',1n<<1024n,2n)).toBe(8.98846567431158e307)
  expect(()=>values.backupExpressionBinary('/',huge,1n)).toThrow()
 })
 it('enforces native literal, exponent and zero-divisor limits',()=>{
  expect(()=>parseBackupNumberLiteral((1n<<256n).toString())).toThrow()
  expect(()=>parseBackupNumberLiteral('012')).toThrow()
  expect(()=>parseBackupNumberLiteral('1__0')).toThrow()
  expect(()=>values.backupExpressionBinary('**',2n,65n)).toThrow()
  expect(()=>values.backupExpressionBinary('/',1n,0n)).toThrow()
 })
 it('implements bool integer arithmetic and unary minus while rejecting other values',()=>{
  expect(values.backupExpressionUnary(true)).toBe(-1n)
  expect(values.backupExpressionBinary('+',true,2n)).toBe(3n)
  expect(()=>values.backupExpressionUnary('1')).toThrow()
 })
 it('allows a native 4096-bit power to grow to 4097 bits by ordinary addition',()=>{
  const power=values.backupExpressionBinary('**',(1n<<128n)-1n,32n)
  const result=values.backupExpressionBinary('+',power,power)
  expect(typeof result).toBe('bigint')
  expect(values.backupExpressionCompare(result,1n<<4096n)).toBe(1)
 })
})

describe('Python strings, bytes and sequence values',()=>{
 it('decodes standard, octal, hex and Unicode escapes by code point',()=>{
  expect(values.decodeBackupStringLiteral(String.raw`'\a\b\f\v\101\x42\u4e2d\U0001f600'`)).toBe('\x07\b\f\vAB中😀')
  expect(values.decodeBackupStringLiteral(String.raw`r'\x31'`)).toBe('\\x31')
  expect(values.decodeBackupStringLiteral("u'a'")).toBe('a')
  expect(values.decodeBackupStringLiteral("'''a\nb'''")).toBe('a\nb')
  expect(values.decodeBackupStringLiteral(String.raw`'\q'`)).toBe('\\q')
  expect(()=>values.decodeBackupStringLiteral(String.raw`'\xG0'`)).toThrow()
  expect(()=>values.decodeBackupStringLiteral("'"+'😀'.repeat(513)+"'")).toThrow()
 })
 it('decodes native Unicode names and aliases while rejecting named sequences and unknown names',()=>{
  expect(values.decodeBackupStringLiteral(String.raw`'\N{LATIN CAPITAL LETTER A}'`)).toBe('A')
  expect(values.decodeBackupStringLiteral(String.raw`'\N{cArRiAgE rEtUrN}'`)).toBe('\r')
  expect(values.decodeBackupStringLiteral(String.raw`'\N{CJK UNIFIED IDEOGRAPH-4E2D}'`)).toBe('中')
  expect(values.decodeBackupStringLiteral(String.raw`'\N{HANGUL SYLLABLE GA}'`)).toBe('가')
  expect(values.decodeBackupStringLiteral(String.raw`r'\N{LATIN CAPITAL LETTER A}'`)).toBe('\\N{LATIN CAPITAL LETTER A}')
  expect(()=>values.decodeBackupStringLiteral(String.raw`'\N{KEYCAP DIGIT ONE}'`)).toThrow()
  expect(()=>values.decodeBackupStringLiteral(String.raw`'\N{UNKNOWN BACKUP NAME}'`)).toThrow()
 })
 it('keeps bytes separate from str, clips octal escapes, and returns integer byte indexes',()=>{
  const bytes=values.decodeBackupStringLiteral(String.raw`b'\x61\400'`)
  expect(bytes).toEqual({kind:'bytes',bytes:[97,0]})
  expect(values.backupExpressionEqual(bytes,'a\0')).toBe(false)
  expect(values.backupExpressionIndex(bytes,0n)).toBe(97n)
  expect(values.backupExpressionContains(bytes,97n)).toBe(true)
  expect(values.backupExpressionContains(bytes,values.decodeBackupStringLiteral("b'a'"))).toBe(true)
  expect(()=>values.backupExpressionContains(bytes,256n)).toThrow()
  expect(()=>values.decodeBackupStringLiteral("b'中'")).toThrow()
 })
 it('indexes Unicode code points and lists with Python negative int and bool indexes',()=>{
  expect(values.backupExpressionIndex('a😀中',-2n)).toBe('😀')
  expect(values.backupExpressionIndex([10n,20n],true)).toBe(20n)
  expect(values.backupExpressionIndex([10n,20n],-2n)).toBe(10n)
  expect(()=>values.backupExpressionIndex([1n],1n)).toThrow()
  expect(()=>values.backupExpressionIndex('a',0.0)).toThrow()
  expect(values.backupExpressionCompare('😀','\ue000')).toBe(1)
 })
 it('concatenates and repeats only compatible sequence and integer types',()=>{
  expect(values.backupExpressionBinary('+',[1n],[2n])).toEqual([1n,2n])
  expect(values.backupExpressionBinary('*','ab',3n)).toBe('ababab')
  expect(values.backupExpressionBinary('*',true,[2n])).toEqual([2n])
  expect(values.backupExpressionBinary('*',[1n],-1n)).toEqual([])
  expect(values.backupExpressionBinary('+',values.decodeBackupStringLiteral("b'a'"),values.decodeBackupStringLiteral("b'b'"))).toEqual({kind:'bytes',bytes:[97,98]})
  expect(()=>values.backupExpressionBinary('*','a',1n<<64n)).toThrow()
  expect(()=>values.backupExpressionBinary('*','a',2.0)).toThrow()
  expect(values.backupExpressionLiteralLength('😀中')).toBe(2)
  expect(values.backupExpressionLiteralLength(2n)).toBeNull()
 })
 it('allows larger practical native sequences and format widths',()=>{
  expect((values.backupExpressionBinary('*','a',32768n) as string).length).toBe(32768)
  expect((values.backupExpressionBinary('%','%32768s','a') as string).length).toBe(32768)
 })
 it('does not add sequence or format caps beyond native and platform limits',()=>{
  expect((values.backupExpressionBinary('*','x',100001n) as string).length).toBe(100001)
  expect((values.backupExpressionBinary('%','%100001s','x') as string).length).toBe(100001)
 })
 it('allows the native BoolOp-hidden four-level power without a global integer result cap',()=>{
  let result:values.BackupExpressionValue=2n
  for(let level=0;level<4;level++)result=values.backupExpressionBinary('**',result,64n)
  expect(values.backupExpressionCompare(result,0n)).toBe(1)
 })
})

describe('Python safe builtin calls and complex values',()=>{
 it('retains the Python sum start type, including list and bool starts',()=>{
  expect(values.backupExpressionCall('sum',[[[1n],[2n]],[]])).toEqual([1n,2n])
  expect(values.backupExpressionCall('sum',[[],true])).toBe(true)
  expect(values.backupExpressionCall('sum',[[true,2n],true])).toBe(4n)
  expect(()=>values.backupExpressionCall('sum',[[],''])).toThrow()
 })
 it('uses Python 3.12 compensated float sum and its Windows mixed-int fallback',()=>{
  expect(values.backupExpressionCall('sum',[[1e16,1.0,-1e16]])).toBe(1)
  expect(values.backupExpressionCall('sum',[[1e16,1n,-1e16]])).toBe(0)
  expect(values.backupExpressionCall('sum',[[1e16,1.0,-1e16],true])).toBe(0)
  expect(values.backupExpressionCall('sum',[[1e16,1.0,-1e16],1n<<32n])).toBe(4294967296)
  expect(values.backupExpressionCall('sum',[[1e16,1n,-1e16],2.0])).toBe(4)
  expect(values.backupExpressionCall('sum',[[1e16,1.0,-1e16],2.0])).toBe(3)
 })
 it('uses Python iterable and comparison semantics for min/max/any/all',()=>{
  expect(values.backupExpressionCall('max',[[9007199254740993n,9007199254740992]])).toBe(9007199254740993n)
  expect(values.backupExpressionCall('min',['😀中'])).toBe('中')
  expect(values.backupExpressionCall('any',[[NaN]])).toBe(true)
  expect(values.backupExpressionCall('all',[[]])).toBe(true)
  expect(values.backupExpressionCall('max',[[NaN,1n]])).toBeNaN()
  expect(()=>values.backupExpressionCall('abs',[1n,2n])).toThrow()
  expect(()=>values.backupExpressionCall('max',[[]])).toThrow()
 })
 it('evaluates complex constants and numeric operations without enabling floor division or modulo',()=>{
  const j=values.parseBackupNumberLiteral('1j'),zero=values.parseBackupNumberLiteral('0j')
  expect(values.backupExpressionTruthy(zero)).toBe(false)
  expect(values.backupExpressionEqual(j,values.parseBackupNumberLiteral('1.0j'))).toBe(true)
  expect(values.backupExpressionBinary('*',j,2n)).toEqual({kind:'complex',real:0,imag:2})
  expect(values.backupExpressionBinary('/',j,2n)).toEqual({kind:'complex',real:0,imag:0.5})
  expect(values.backupExpressionBinary('/',{kind:'complex',real:1,imag:2},{kind:'complex',real:3,imag:-4})).toEqual({kind:'complex',real:-0.2,imag:0.4})
  expect(values.backupExpressionBinary('**',j,2n)).toEqual({kind:'complex',real:-1,imag:0})
  expect(()=>values.backupExpressionBinary('**',parseBackupNumberLiteral('1e308j'),2n)).toThrow()
  expect(values.backupExpressionCall('abs',[j])).toBe(1)
  expect(()=>values.backupExpressionBinary('//',j,1n)).toThrow()
  expect(()=>values.backupExpressionBinary('%',j,1n)).toThrow()
  expect(()=>values.backupExpressionCompare(j,j)).toThrow()
 })
})

describe('bounded Python single-operand percent formatting',()=>{
 it.each(['%s','%r','%a','%d','%i','%u'])('applies native Python3.12 integer decimal conversion limits to %s',format=>{
  expect(()=>values.backupExpressionBinary('%',format,2n**16384n)).toThrow()
 })
 it.each(['%r','%a','%d','%i','%u'])('applies the same native decimal conversion limit in bytes %s',format=>{
  const bytes={kind:'bytes' as const,bytes:Array.from(format,char=>char.charCodeAt(0))}
  expect(()=>values.backupExpressionBinary('%',bytes,2n**16384n)).toThrow()
 })
 it('counts source integer digits without limiting signs, zero padding or nondecimal bases',()=>{
  expect((values.backupExpressionBinary('%','%d',10n**4299n) as string).length).toBe(4300)
  expect((values.backupExpressionBinary('%','%d',-(10n**4299n)) as string).length).toBe(4301)
  expect(values.backupExpressionBinary('%','%.5000d',1n)).toBe('0'.repeat(4999)+'1')
  expect(values.backupExpressionBinary('%','%5000d',1n)).toBe(' '.repeat(4999)+'1')
  expect(values.backupExpressionBinary('%','%x',2n**16384n)).toBe('1'+'0'.repeat(4096))
  expect(values.backupExpressionBinary('%','%o',2n**16384n)).toBe('2'+'0'.repeat(5461))
 })
 it.each([[0x1cc00,"'\\U0001cc00'"],[0x2ebf0,"'\\U0002ebf0'"]] as const)('uses target Unicode15 printability for U+%s rather than the JS host version',(point,expected)=>{
  const value=String.fromCodePoint(point)
  expect(values.backupExpressionBinary('%','%r',value)).toBe(expected)
  expect(values.backupExpressionBinary('%','%a',value)).toBe(expected)
  expect(values.backupExpressionBinary('%','%s',value)).toBe(value)
 })
 it.each([
  ['%s',null,'None'],['%r',[true,null,1.0],'[True, None, 1.0]'],
  ['%a','中😀',"'\\u4e2d\\U0001f600'"],['%05d',-3n,'-0003'],
  ['%#.0o',0n,'0o0'],['%#x',255n,'0xff'],['%.0f',2.5,'2'],
  ['%.2f',2.675,'2.67'],['%#.0g',10.0,'1.e+01'],['%.2e',999.5,'1.00e+03'],
  ['%s',true,'True'],['%s',-0.0,'-0.0'],['%%',[],'%'],
 ] as const)('formats %s with Python flags, values and rounding',(format,operand,expected)=>{
  expect(values.backupExpressionBinary('%',format,operand as values.BackupExpressionValue)).toBe(expected)
 })
 it('formats complex negative zero and exact large integers as Python text',()=>{
  expect(values.backupExpressionBinary('%','%s',values.backupExpressionUnary(parseBackupNumberLiteral('1j')))).toBe('(-0-1j)')
  expect(values.backupExpressionBinary('%','%d',18446744073709551617n)).toBe('18446744073709551617')
  expect(values.backupExpressionBinary('%','%r','a\n')).toBe("'a\\n'")
 })
 it('supports byte formatting while retaining bytes-only requirements',()=>{
  const literal=values.decodeBackupStringLiteral
  expect(values.backupExpressionBinary('%',literal("b'%s'"),literal("b'a'"))).toEqual({kind:'bytes',bytes:[97]})
  expect(values.backupExpressionBinary('%',literal("b'%c'"),255n)).toEqual({kind:'bytes',bytes:[255]})
  expect(()=>values.backupExpressionBinary('%',literal("b'%s'"),'a')).toThrow()
 })
 it('distinguishes unused bytes operands in text and bytes format strings',()=>{
  const bytes=values.decodeBackupStringLiteral("b'a'")
  expect(values.backupExpressionBinary('%','%%',bytes)).toBe('%')
  expect(()=>values.backupExpressionBinary('%',values.decodeBackupStringLiteral("b'%%'"),bytes)).toThrow()
 })
 it('rejects missing or unused format operands',()=>{
  expect(()=>values.backupExpressionBinary('%','%%',1n)).toThrow()
  expect(()=>values.backupExpressionBinary('%','%s%s','a')).toThrow()
 })
})
