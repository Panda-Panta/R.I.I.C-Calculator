import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '../provenance.mjs';
export function canonicalInventoryHash(entries) {
  return sha256(entries.map(e=>({operator:e.operator,elitePhase:e.elitePhase,level:e.level})).sort((a,b)=>a.operator<b.operator?-1:a.operator>b.operator?1:0));
}
/** Inspect all JSON evidence except frozen source archives (which contain code, not cohorts). */
export function inventoryCollisions(root, cases, excludedDirectory) {
  const targets=new Map(cases.map(c=>[canonicalInventoryHash(c.entries),c.familyId]));
  const inspected=[],collisions=[],familyIdCollisions=[],ignoredRawAttempts=[],errors=[];
  const targetFamilies=new Set(cases.map(c=>c.familyId));
  function inspect(value,path,location='') {
    if(!value||typeof value!=='object')return;
    if(typeof value.familyId==='string' && targetFamilies.has(value.familyId))familyIdCollisions.push({familyId:value.familyId,path,location});
    if(Array.isArray(value)&&value.length&&value.every(e=>e&&typeof e.operator==='string'&&Number.isInteger(e.elitePhase)&&Number.isInteger(e.level))) {
      const hash=canonicalInventoryHash(value);if(targets.has(hash))collisions.push({familyId:targets.get(hash),path,location,inventoryHash:hash});return;
    }
    for(const [key,item]of Object.entries(value))if(item&&typeof item==='object')inspect(item,path,location+'/'+key);
  }
  function walk(dir){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(/\.attempt-\d+\.stdout\.json$/.test(entry.name)){ignoredRawAttempts.push({path:relative(root,path),reason:'Non-authoritative stdout may be empty/truncated after watchdog; inventory comes from immutable .input.json/manifest'});continue;}
    if(path===excludedDirectory||entry.name==='source'||entry.name==='source-snapshot.json')continue;
    if(entry.isDirectory())walk(path);else if(entry.name.endsWith('.json')){try{const raw=readFileSync(path,'utf8');inspected.push({path:relative(root,path),hash:sha256(raw)});inspect(JSON.parse(raw),relative(root,path));}catch(e){errors.push({path:relative(root,path),error:String(e)});}}
  }}
  walk(join(root,'artifacts/neural'));walk(join(root,'training_data'));
  return {canonicalization:'operator ID + actual elitePhase + level; sorted ASCII operator ID',inspected,collisions,familyIdCollisions,ignoredRawAttempts,errors,complete:errors.length===0};
}
