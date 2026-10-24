import {describe,it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {lookupBackupUnicodeName,BACKUP_UNICODE_VERSION,isBackupUnicodePrintable} from './unicodeEscapeNames'
const source=(file:string)=>readFileSync(new URL('../../scripts/unicode-escape-names/'+file,import.meta.url))
describe('offline Python 3.12 Unicode named escapes',()=>{
 it('pins the database version to the fixed Mower Python 3.12 runtime',()=>expect(BACKUP_UNICODE_VERSION).toBe('15.0.0'))
 it.each([
  ['LATIN CAPITAL LETTER A','A'],['latin capital letter a','A'],['Latin Capital Letter A','A'],
  ['GREEK SMALL LETTER PI','π'],['GRINNING FACE','😀'],['NULL','\0'],['nul','\0'],
  ['LINE FEED','\n'],['Lf','\n'],['BYTE ORDER MARK','\ufeff'],
  ['LATIN CAPITAL LETTER GHA','\u01a2'],['KAKTOVIK NUMERAL ZERO','\u{1d2c0}'],
  ['SHAKING FACE','\u{1fae8}'],['PINK HEART','\u{1fa77}'],
 ])('resolves the exact character for %s',(name,character)=>expect(lookupBackupUnicodeName(name)).toBe(character))
 it('covers every explicit canonical name and formal alias in the fixed official data',()=>{
  const lines=gunzipSync(source('UnicodeData-15.0.0.txt.gz')).toString('utf8').trim().split('\n')
  let canonical=0,aliases=0
  for(const line of lines){const fields=line.trim().split(';'),name=fields[1]!
   if(name.startsWith('<'))continue
   const character=String.fromCodePoint(Number.parseInt(fields[0]!,16))
   expect(lookupBackupUnicodeName(name),name).toBe(character)
   expect(lookupBackupUnicodeName(name.toLowerCase()),name+' lowercase').toBe(character)
   canonical++
  }
  for(const line of source('NameAliases-15.0.0.txt').toString('utf8').split('\n')){
   const content=line.split('#')[0]!.trim();if(!content)continue
   const [hex,name]=content.split(';'),character=String.fromCodePoint(Number.parseInt(hex!,16))
   expect(lookupBackupUnicodeName(name!),name).toBe(character)
   expect(lookupBackupUnicodeName(name!.toLowerCase()),name+' lowercase alias').toBe(character)
   aliases++
  }
  expect(canonical).toBe(34823);expect(aliases).toBe(473)
 })
 it.each([
  ['3400',0x3400],['4DBF',0x4dbf],['4E00',0x4e00],['04E00',0x4e00],['9FFF',0x9fff],
  ['20000',0x20000],['2A6DF',0x2a6df],['2A700',0x2a700],['2B739',0x2b739],
  ['2B740',0x2b740],['2B81D',0x2b81d],['2B820',0x2b820],['2CEA1',0x2cea1],
  ['2CEB0',0x2ceb0],['2EBE0',0x2ebe0],['30000',0x30000],['3134A',0x3134a],
  ['31350',0x31350],['323AF',0x323af],
 ])('accepts only assigned Unicode15 CJK algorithmic code %s',(hex,code)=>expect(lookupBackupUnicodeName('CJK UNIFIED IDEOGRAPH-'+hex)).toBe(String.fromCodePoint(code)))
 it.each(['339F','4DC0','A000','1FFFF','2A6E0','2A6FF','2B73A','2B73F','2B81E','2B81F','2CEA2','2CEAF','2EBE1','2EBF0','2FFFF','3134B','3134F','323B0','D800','110000','00004E00','4e00'])('rejects the unassigned or invalid CJK suffix %s',suffix=>expect(()=>lookupBackupUnicodeName('CJK UNIFIED IDEOGRAPH-'+suffix)).toThrow())
 it.each([['GA',0xac00],['GAG',0xac01],['GGAGS',0xae4f],['A',0xc544],['HIH',0xd7a3]])('resolves Hangul algorithmic syllable %s',(syllable,code)=>expect(lookupBackupUnicodeName('HANGUL SYLLABLE '+syllable)).toBe(String.fromCodePoint(code)))
 it.each(['hangul syllable ga','HANGUL SYLLABLE ga','HANGUL SYLLABLE','HANGUL SYLLABLE G','HANGUL SYLLABLE GAX','HANGUL SYLLABLE GAA','cjk unified ideograph-4E00','CJK UNIFIED IDEOGRAPH-4e00'])('keeps native algorithmic spelling strict for %s',name=>expect(()=>lookupBackupUnicodeName(name)).toThrow())
 it('rejects every official named sequence accepted by unicodedata.lookup but forbidden by Python string literals',()=>{
  let count=0
  for(const line of source('NamedSequences-15.0.0.txt').toString('utf8').split('\n')){
   const content=line.split('#')[0]!.trim();if(!content)continue
   const name=content.split(';')[0]!
   expect(()=>lookupBackupUnicodeName(name),name).toThrow();count++
  }
  expect(count).toBe(461)
 })
 it.each(['','LATIN_CAPITAL_LETTER_A','LATIN  CAPITAL LETTER A',' LATIN CAPITAL LETTER A','LATIN CAPITAL LETTER A ','LATIN CAPITAL LETTER A\0','LATİN CAPITAL LETTER A','__proto__','<control>','TANGUT IDEOGRAPH-17000','TULU-TIGALARI LETTER A','KEYCAP DIGIT ONE'])('rejects unknown, normalized, post-version or multi-codepoint name %s',name=>expect(()=>lookupBackupUnicodeName(name)).toThrow())
})

describe('Unicode15 printability for Python repr',()=>{
 it.each([
  [0x20,true],[0x21,true],[0x7e,true],[0x7f,false],[0,false],[10,false],
  [0xa0,false],[0xad,false],[0x3000,false],[0x2028,false],[0x2029,false],
  [0x200d,false],[0x301,true],[0xfe0f,true],[0x3164,true],
  [0x378,false],[0xd800,false],[0xdfff,false],[0xe000,false],[0x10ffff,false],
  [0x1fae8,true],[0x323af,true],[0x1cc00,false],[0x2ebf0,false],
 ])('classifies U+%s independently of the host Unicode version',(code,printable)=>expect(isBackupUnicodePrintable(code)).toBe(printable))
 it.each([-1,0x110000,1.5,NaN,Infinity])('rejects invalid code point %s',code=>expect(isBackupUnicodePrintable(code)).toBe(false))
 it('matches official Unicode15 general categories for all 1114112 code points',()=>{
  const expected=new Uint8Array(0x110000)
  let first=-1,category=''
  for(const row of gunzipSync(source('UnicodeData-15.0.0.txt.gz')).toString('utf8').trim().split('\n')){
   const fields=row.trim().split(';'),code=Number.parseInt(fields[0]!,16),name=fields[1]!
   if(name.endsWith(', First>')){first=code;category=fields[2]!;continue}
   if(name.endsWith(', Last>')){expected.fill(Number(!'CZ'.includes(category[0]!)),first,code+1);first=-1;continue}
   expected[code]=Number(!'CZ'.includes(fields[2]![0]!))
  }
  expected[0x20]=1
  const mismatches:number[]=[]
  for(let code=0;code<expected.length;code++)if(isBackupUnicodePrintable(code)!==Boolean(expected[code])){mismatches.push(code);if(mismatches.length===10)break}
  expect(mismatches.map(code=>'U+'+code.toString(16))).toEqual([])
 })
})
