import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from '../provenance.mjs';
import { publishExclusiveJson } from '../full-baseline/atomic.mjs';
import { inventoryCollisions } from '../full-baseline/collisions.mjs';
import { bounded } from '../full-baseline/process.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const atomic=(p,v)=>{writeFileSync(p+'.tmp',JSON.stringify(v,null,2),{mode:0o600});renameSync(p+'.tmp',p);};
export async function enrichedCollection(root,freezeBundle,mode){
 if(!['prepare','pilot','all'].includes(mode))throw Error('Unknown enriched operation');
 const run='molecular-enriched-20261031',data=join(root,'training_data/neural-full-v2',run),reports=join(root,'artifacts/neural/molecular-training',run),lockPath=join(root,'training_data/neural-full-v2',`.${run}.collector.lock`);
 mkdirSync(join(root,'training_data/neural-full-v2'),{recursive:true,mode:0o700});const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,mode,utc:new Date().toISOString()}));
 const cancellation=new AbortController(),stop=()=>cancellation.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  const manifestPath=join(data,'manifest.json');
  if(mode==='prepare'){
   if(existsSync(data))throw Error('Frozen enriched inputs already exist; no overwrite/resample');
   mkdirSync(data,{recursive:true,mode:0o700});mkdirSync(reports,{recursive:true});const provenance=await freezeBundle(data),inputs=[];
   for(let index=1;index<=12;index++){const input=JSON.parse(execFileSync(process.execPath,[join(data,'worker.mjs'),'--prepare-enriched'],{input:JSON.stringify({index}),encoding:'utf8',maxBuffer:8*1024*1024}));publishExclusiveJson(join(data,input.familyId+'.input.json'),input);inputs.push(input);}
   if(new Set(inputs.map(i=>i.inventoryHash)).size!==12)throw Error('Duplicate enriched inventory');
   const collisionAudit=inventoryCollisions(root,inputs,data);publishExclusiveJson(join(reports,'inventory-collision-audit.json'),collisionAudit);if(!collisionAudit.complete||collisionAudit.collisions.length||collisionAudit.familyIdCollisions.length)throw Error('Enriched inventory collision audit failed');
   const manifest={schemaVersion:2,sourceKind:'molecular-simulated',purpose:'training',inputProfile:'TRAIN-enriched-catalog-high-stage-v1',baselineEligible:false,createdUtc:new Date().toISOString(),provenance,scope:'Synthetic enriched TRAIN only; not original random distribution, actual user inventory, full mathematical teacher or release evidence',config:{run,concurrency:1,timeoutMs:1800000,pilotIndices:[1,8],cases:inputs.map(i=>({familyId:i.familyId,seed:i.seed,size:i.size,split:i.split,index:i.enrichment.index}))},cases:inputs.map(i=>({familyId:i.familyId,seed:i.seed,size:i.size,split:i.split,index:i.enrichment.index,inputHash:sha256(i),inventoryHash:i.inventoryHash,layoutTag:i.layoutTag,targets:i.enrichment.targets})),collisionAuditHash:sha256(collisionAudit),inputPolicy:'12 independent fresh draws; explicit max-stage target/support intervention and exclusions; unpaired background contrasts; Proviso same background random profile; empty layout; hints never supplied to generator or features'};
   publishExclusiveJson(manifestPath,manifest);publishExclusiveJson(join(reports,'offline-validation.json'),{manifestHash:sha256(manifest),baselineEligible:false,teacherExecuted:false,cases:inputs.map(i=>({familyId:i.familyId,layoutTag:i.layoutTag,forcedSelections:i.enrichment.forcedSelections,forcedStages:i.enrichment.forcedStages,...i.offlineValidation}))});
   console.log(JSON.stringify({status:'inputs-frozen-awaiting-review',manifestPath:relative(root,manifestPath),manifestHash:sha256(manifest),sourceHash:provenance.sourceHash,bundleHash:provenance.bundleHash,cases:12}));return;
  }
  const manifest=read(manifestPath);if(manifest.inputProfile!=='TRAIN-enriched-catalog-high-stage-v1'||manifest.sourceKind!=='molecular-simulated'||manifest.config.timeoutMs!==1800000)throw Error('Unknown enriched manifest');
  if(sha256(readFileSync(join(data,'worker.mjs'),'utf8'))!==manifest.provenance.bundleHash)throw Error('Frozen enriched bundle changed');
  const checkpointPath=join(data,'checkpoint.json'),checkpoint=existsSync(checkpointPath)?read(checkpointPath):{manifestHash:sha256(manifest),cases:{}};
  if(checkpoint.manifestHash!==sha256(manifest)||Object.values(checkpoint.cases).some(a=>a.at(-1)?.status==='running'))throw Error('Checkpoint mismatch or uncertain running process');
  const cases=manifest.cases.filter(c=>mode==='all'||manifest.config.pilotIndices.includes(c.index));
  for(const c of cases){if(cancellation.signal.aborted)break;if(checkpoint.cases[c.familyId]?.length)continue;
   const input=read(join(data,c.familyId+'.input.json'));if(sha256(input)!==c.inputHash)throw Error('Frozen enriched input changed');
   const prefix=join(data,c.familyId+'.attempt-1'),candidateDirectory=prefix+'.candidates';mkdirSync(candidateDirectory,{mode:0o700});
   const attempt={status:'running',score:null,inputHash:c.inputHash,bundleHash:manifest.provenance.bundleHash,wallTimeoutMs:1800000,startedUtc:new Date().toISOString()};checkpoint.cases[c.familyId]=[attempt];atomic(checkpointPath,checkpoint);console.error(JSON.stringify({event:'enriched-case-start',familyId:c.familyId,...attempt}));
   const outcome=await bounded(process.execPath,[join(data,'worker.mjs'),'--candidate-evidence',JSON.stringify({directory:candidateDirectory,sourceHash:manifest.provenance.sourceHash,bundleHash:manifest.provenance.bundleHash})],{input:JSON.stringify(input),timeoutMs:1800000,signal:cancellation.signal,stdoutPath:prefix+'.stdout.json',stderrPath:prefix+'.progress.jsonl',onProgress:p=>{attempt.lastProgress=p;atomic(checkpointPath,checkpoint);console.error(JSON.stringify({familyId:c.familyId,...p}));}});
   publishExclusiveJson(prefix+'.result.json',outcome);Object.assign(attempt,{status:outcome.status,score:outcome.score,endedUtc:new Date().toISOString(),durationMs:outcome.durationMs,resultHash:sha256(outcome),resultPath:relative(root,prefix+'.result.json')});atomic(checkpointPath,checkpoint);atomic(join(reports,'summary.json'),{manifestHash:sha256(manifest),inputProfile:manifest.inputProfile,baselineEligible:false,cases:checkpoint.cases});console.error(JSON.stringify({event:'enriched-case-finished',familyId:c.familyId,...attempt}));
  }
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);closeSync(lock);unlinkSync(lockPath);}
}
