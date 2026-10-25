// Python 3.12 literal \\N{name}, pinned to Unicode 15.0.0.
// Generic names/aliases use ASCII case folding; CPython's Hangul/CJK paths do not.
// Provenance, fixed inputs and offline regeneration: scripts/unicode-escape-names/.
import {BACKUP_UNICODE_VERSION,CJK_UNIFIED_RANGES,UNICODE_NAME_TABLE,UNICODE_PRINTABLE_RANGES} from './unicodeEscapeNamesData'
export {BACKUP_UNICODE_VERSION}
const leading=['G','GG','N','D','DD','R','M','B','BB','S','SS','','J','JJ','C','K','T','P','H']
const vowels=['A','AE','YA','YAE','EO','E','YEO','YE','O','WA','WAE','OE','YO','U','WEO','WE','WI','YU','EU','YI','I']
const trailing=['','G','GG','GS','N','NJ','NH','D','L','LG','LM','LB','LS','LT','LP','LH','M','B','BS','S','SS','NG','J','C','K','T','P','H']
let names:Map<string,string>|undefined
function unknown():never {throw new Error('Unknown Unicode '+BACKUP_UNICODE_VERSION+' character name')}
function namedCharacters():Map<string,string> {
 if(names)return names
 const result=new Map<string,string>();let previous=''
 for(const row of UNICODE_NAME_TABLE.split('\n')){
  const colon=row.indexOf(':'),separator=row.indexOf(';')
  const name=previous.slice(0,Number(row.slice(0,colon)))+row.slice(colon+1,separator)
  result.set(name,String.fromCodePoint(Number.parseInt(row.slice(separator+1),16)));previous=name
 }
 names=result;return result
}
/** Resolve one Python literal named escape. Unknown names and named sequences throw. */
export function lookupBackupUnicodeName(name:string):string {
 if(!/^[\x20-\x7e]+$/.test(name))return unknown()
 if(name.startsWith('CJK UNIFIED IDEOGRAPH-')){
  const suffix=name.slice(22);if(!/^[0-9A-F]{4,5}$/.test(suffix))return unknown()
  const code=Number.parseInt(suffix,16)
  return CJK_UNIFIED_RANGES.some(([start,end])=>code>=start&&code<=end)?String.fromCodePoint(code):unknown()
 }
 if(name.startsWith('HANGUL SYLLABLE ')){
  let remaining=name.slice(16)
  const take=(parts:readonly string[])=>{
   let index=-1,length=-1
   parts.forEach((part,i)=>{if(part.length>length&&remaining.startsWith(part)){index=i;length=part.length}})
   if(index>=0)remaining=remaining.slice(length)
   return index
  }
  const l=take(leading),v=take(vowels),t=take(trailing)
  return l>=0&&v>=0&&t>=0&&!remaining?String.fromCodePoint(0xac00+(l*21+v)*28+t):unknown()
 }
 return namedCharacters().get(name.toUpperCase())??unknown()
}

/** Python 3.12 str.isprintable for one code point, independent of host Unicode data. */
export function isBackupUnicodePrintable(codePoint:number):boolean {
 if(!Number.isInteger(codePoint)||codePoint<0||codePoint>0x10ffff)return false
 let low=0,high=UNICODE_PRINTABLE_RANGES.length-1
 while(low<=high){
  const middle=(low+high)>>>1,[start,end]=UNICODE_PRINTABLE_RANGES[middle]!
  if(codePoint<start)high=middle-1
  else if(codePoint>end)low=middle+1
  else return true
 }
 return false
}
