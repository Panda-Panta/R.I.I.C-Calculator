import { readFileSync, mkdirSync, existsSync, openSync, writeFileSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '../provenance.mjs';
import { bounded } from '../full-baseline/process.mjs';
import { publishExclusiveJson } from '../full-baseline/atomic.mjs';
import { validatePolicy } from './policy.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function atomic(p,v){writeFileSync(p+'.tmp',JSON.stringify(v,null,2),{mode:0o600});renameSync(p+'.tmp',p);}
export function selectFailed400Retries(manifest,checkpoint,loadInput){
 if(checkpoint.manifestHash!==sha256(manifest))throw Error('Original checkpoint binding mismatch');
 if(manifest.cases.some(c=>!checkpoint.cases[c.familyId]?.length||checkpoint.cases[c.familyId].at(-1).status==='running'))throw Error('Original cohort must be terminal before linked retry');
 return manifest.cases.filter(c=>c.size===400&&checkpoint.cases[c.familyId].at(-1).status!=='completed').map(c=>{const input=loadInput(c);if(sha256(input)!==c.inputHash)throw Error('Original input drift');validatePolicy(input);const attempt=checkpoint.cases[c.familyId].at(-1);if(attempt.score!==null||!attempt.resultHash)throw Error('Invalid failed attempt binding');return{...c,input,parentAttempt:attempt};});
}
/** Separate immutable linked run, same family/input, never silently mutate old timeout evidence. */
export async function retryFailed400(root,freezeBundle){
 const parent=join(root,'training_data/neural-full-v2/molecular-training-20261030'),lockPath=join(root,'training_data/neural-full-v2/.molecular-training-20261030.collector.lock');
 const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,purpose:'explicit linked400retry',utc:new Date().toISOString()}));
 const cancellation=new AbortController(),stop=()=>cancellation.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  const manifest=read(join(parent,'manifest.json')),checkpoint=read(join(parent,'checkpoint.json'));
  const selected=selectFailed400Retries(manifest,checkpoint,c=>read(join(parent,c.familyId+'.input.json')));
  if(!selected.length)throw Error('No failed400 family to retry');
  const directory=join(parent,'retries/durable-1800000'),reports=join(root,'artifacts/neural/molecular-training/linked-retry-1800000');
  if(existsSync(directory))throw Error('Linked retry already exists; no implicit restart or overwrite');
  // Verify retained authoritative parent outcomes, not merely a checkpoint status.
  for(const c of selected){const outcome=read(join(root,c.parentAttempt.resultPath));if(sha256(outcome)!==c.parentAttempt.resultHash||outcome.completed||outcome.score!==null)throw Error('Parent failed result commitment mismatch');}
  mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(reports,{recursive:true});
  const provenance=await freezeBundle(directory),cases=selected.map(({input,parentAttempt,...c})=>({...c,parentAttemptHash:sha256(parentAttempt),parentResultHash:parentAttempt.resultHash,parentResultPath:parentAttempt.resultPath}));
  const retryManifest={schemaVersion:2,sourceKind:'molecular-simulated',purpose:'training',baselineEligible:false,scope:'Explicit same-input linked400retry; never new family or full baseline',createdUtc:new Date().toISOString(),config:{timeoutMs:1800000,concurrency:1,cases},provenance,cases,lineage:{parentManifestHash:sha256(manifest),parentCheckpointHash:sha256(checkpoint),parentSourceHash:manifest.provenance.sourceHash,parentBundleHash:manifest.provenance.bundleHash,reason:'Original 600000ms whole-case cap exhausted after second candidate completion at542116ms; preserve null outcome, add durable per-candidate evidence and explicit1800000ms cap; no resampling',sameInput:true,sameFamilies:true}};
  for(const c of selected)publishExclusiveJson(join(directory,c.familyId+'.input.json'),c.input);
  publishExclusiveJson(join(directory,'manifest.json'),retryManifest);
  const state={manifestHash:sha256(retryManifest),cases:{}},statePath=join(directory,'checkpoint.json');atomic(statePath,state);
  for(const c of selected){if(cancellation.signal.aborted)break;const prefix=join(directory,c.familyId+'.attempt-1'),candidateDirectory=prefix+'.candidates';mkdirSync(candidateDirectory,{mode:0o700});
   const attempt={status:'running',score:null,wallTimeoutMs:1800000,inputHash:c.inputHash,bundleHash:provenance.bundleHash,startedUtc:new Date().toISOString(),parentResultHash:c.parentAttempt.resultHash};state.cases[c.familyId]=[attempt];atomic(statePath,state);
   console.error(JSON.stringify({event:'linked-case-start',familyId:c.familyId,...attempt}));
   const outcome=await bounded(process.execPath,[join(directory,'worker.mjs'),'--candidate-evidence',JSON.stringify({directory:candidateDirectory,sourceHash:provenance.sourceHash,bundleHash:provenance.bundleHash})],{input:JSON.stringify(c.input),timeoutMs:1800000,signal:cancellation.signal,stdoutPath:prefix+'.stdout.json',stderrPath:prefix+'.progress.jsonl',onProgress:p=>{attempt.lastProgress=p;atomic(statePath,state);console.error(JSON.stringify({familyId:c.familyId,...p}));}});
   publishExclusiveJson(prefix+'.result.json',outcome);Object.assign(attempt,{status:outcome.status,score:outcome.score,endedUtc:new Date().toISOString(),durationMs:outcome.durationMs,resultHash:sha256(outcome),resultPath:relative(root,prefix+'.result.json')});atomic(statePath,state);atomic(join(reports,'summary.json'),{manifestHash:sha256(retryManifest),baselineEligible:false,cases:state.cases});console.error(JSON.stringify({event:'linked-case-finished',familyId:c.familyId,...attempt}));
  }
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);closeSync(lock);unlinkSync(lockPath);}
}
