import { sha256 } from '../provenance.mjs';
/** Deliberately development/training only: blinded release requires candidate lock elsewhere. */
export function validateCohort(value) {
  if(value?.schemaVersion!==1 || !['training','development'].includes(value.purpose))throw Error('Cohort purpose must be training or development; release is not supported');
  if(typeof value.namespace!=='string'|| !/^[a-zA-Z0-9_-]+$/.test(value.namespace))throw Error('Invalid cohort namespace');
  if(value.layout!=='empty-default243'||value.stagePolicy!=='actual-mixture-v1')throw Error('Unsupported layout/stage policy; no silent substitution');
  if(!Array.isArray(value.cases)||!value.cases.length)throw Error('Empty cohort');
  const split=value.purpose==='training'?'train':'dev';
  const cases=value.cases.map(c=>{
    if(typeof c.familyId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(c.familyId)||!c.familyId.startsWith(value.namespace+'-'))throw Error('Family ID must be within declared namespace');
    if(c.split!==split)throw Error('Case split contradicts cohort purpose');
    if(!Number.isInteger(c.seed)||c.seed<0||c.seed>0xffffffff)throw Error('Seed must be explicit uint32');
    if(![100,200,300,400].includes(c.size))throw Error('Unsupported cohort inventory size');
    return {familyId:c.familyId,split:c.split,seed:c.seed,size:c.size,layout:value.layout,stagePolicy:value.stagePolicy};
  });
  if(new Set(cases.map(c=>c.familyId)).size!==cases.length||new Set(cases.map(c=>c.seed)).size!==cases.length)throw Error('Duplicate family or seed');
  const normalized={schemaVersion:1,purpose:value.purpose,namespace:value.namespace,layout:value.layout,stagePolicy:value.stagePolicy,cases};
  return {...normalized,hash:sha256(normalized)};
}
