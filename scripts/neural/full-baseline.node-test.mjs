import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bounded } from './full-baseline/process.mjs';
import { atomic, freezeBundle, validateResume } from './full-baseline.mjs';
import { sha256 } from './provenance.mjs';
test('whole-worker hard timeout includes startup and remains unknown/null',async()=>{
 // A short wall cap may correctly expire before worker startup under concurrent load.
 // Do not require readiness output to precede an independently enforced deadline.
 const r=await bounded(process.execPath,['-e','while(true){}'],{timeoutMs:150});
 assert.equal(r.status,'EXTERNAL_PROCESS_TIMEOUT'); assert.equal(r.score,null); assert.equal(r.completed,false);
});
test('worker error, invalid stdout, nonzero exit cannot become zero teacher',async()=>{
 for(const script of ['throw Error("bad")','console.log("bad")','console.log(JSON.stringify({completed:true,score:0}));process.exitCode=1']) {
  const r=await bounded(process.execPath,['-e',script],{timeoutMs:2000});assert.equal(r.completed,false);assert.equal(r.score,null);
 }
 const zero=await bounded(process.execPath,['-e','console.log(JSON.stringify({completed:true,score:0}))'],{timeoutMs:2000});assert.equal(zero.score,0);assert.equal(zero.completed,true);
});
test('readiness-synchronized cancellation kills blocked worker and preserves stderr/null',async()=>{
 const controller=new AbortController();let ready=false;
 const pending=bounded(process.execPath,['-e','console.error(JSON.stringify({event:"building"})); while(true){}'],{timeoutMs:10000,signal:controller.signal,onProgress:event=>{if(event.event==='building'){ready=true;setTimeout(()=>controller.abort(),50);}}});
 const r=await pending; assert.equal(ready,true);assert.equal(r.status,'CANCELLED');assert.equal(r.score,null);assert.match(r.stderr,/building/);
});
test('checkpoint preserves attempts and resume refuses changed inputs/config',()=>{
 const dir=mkdtempSync(join(tmpdir(),'full-baseline-test-'));
 try { const value={manifestHash:'hash',cases:{a:[{status:'EXTERNAL_PROCESS_TIMEOUT',score:null},{status:'completed',score:0}]}};atomic(join(dir,'checkpoint.json'),value);assert.deepEqual(JSON.parse(readFileSync(join(dir,'checkpoint.json'),'utf8')),value);
 validateResume({config:{seed:1}},{seed:1});assert.throws(()=>validateResume({config:{seed:1}},{seed:2}),/mismatch/); } finally {rmSync(dir,{recursive:true,force:true});}
});
test('frozen worker builds deterministic legal actual-stage empty full243 inputs, including random-stage proviso',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'full-baseline-input-'));
 try { const p=await freezeBundle(dir);assert.equal(sha256(readFileSync(join(dir,'worker.mjs'),'utf8')),p.bundleHash);assert.ok(p.sourceHashes['src/optimizer/smartRoster.ts']);
 const prepare=(seed,size,declared={})=>JSON.parse(execFileSync(process.execPath,[join(dir,'worker.mjs'),'--prepare'],{input:JSON.stringify({seed,size,...declared}),encoding:'utf8'}));
 const a=prepare(2026102701,100); assert.deepEqual(a,prepare(2026102701,100));assert.equal(a.entries.length,100);assert.ok(a.requiredProviso);assert.equal(a.options.branchCount,10);assert.equal(a.options.enableDeepSearch,true);assert.equal(a.options.simulationSampleHours,72);
 const counts={};for(const room of Object.values(a.workspace.mainPlan.facilities)){if(room.level>0)counts[room.type]=(counts[room.type]??0)+1;for(const slot of room.slots){assert.equal(slot.occupant.kind,'empty');assert.deepEqual(slot.replacements,[]);assert.equal(slot.groupId,null);}}
 assert.equal(counts.manufacture,4);assert.equal(counts.trading,2);assert.equal(counts.power,3);assert.equal(counts.dormitory,4);
 assert.ok(a.entries.some(e=>e.elitePhase===0));assert.ok(a.entries.some(e=>e.elitePhase===2));assert.equal(new Set(a.entries.map(e=>e.operator)).size,100);
 const training=prepare(2026102801,100,{familyId:'explicit-train-1',split:'train',layout:'empty-default243',stagePolicy:'actual-mixture-v1'});assert.equal(training.familyId,'explicit-train-1');assert.equal(training.split,'train');
 const b=prepare(2026102702,400);assert.equal(b.entries.length,400);assert.notEqual(a.inventoryHash,b.inventoryHash);
 // An arbitrary same-policy draw must allow proviso below maximum (never forced E2).
 assert.ok([a,b,prepare(1,100),prepare(2,100)].some(x=>x.requiredProviso.elitePhase<2));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('nonfinite or null completed labels stay unqualified',async()=>{
 for(const score of ['null','"Infinity"']) { const r=await bounded(process.execPath,['-e',`console.log(JSON.stringify({completed:true,score:${score}}))`],{timeoutMs:2000}); assert.equal(r.completed,false); assert.equal(r.score,null); assert.equal(r.status,'unqualified'); }
});

test('forbidden trading main and replacement references are tagged without mutating teacher',async()=>{
 const {auditTradingExclusions}=await import('./full-baseline/semantic-audit.mjs'); const workspace={mainPlan:{facilities:{trade:{type:'trading',roomId:'trade',slots:[{occupant:{kind:'operator',operatorId:'char_4058_pepe'},replacements:['U-Official']}]}}}};const before=structuredClone(workspace);const audit=auditTradingExclusions(workspace);assert.equal(audit.conflicts.length,2);assert.equal(audit.imitationPolicyCompatible,false);assert.deepEqual(workspace,before);
});
test('higher retry budget keeps timed-out attempt/raw input immutable; running or uncertain is refused',async()=>{
 const {retryBudget}=await import('./full-baseline/retry.mjs');
 const dir=mkdtempSync(join(tmpdir(),'full-baseline-retry-'));
 try {
  const input=JSON.stringify({seed:7,workspace:{empty:true},options:{branchCount:10,enableDeepSearch:true}}),inputHash=sha256(input);
  const first=await bounded(process.execPath,['-e','while(true){}'],{input,timeoutMs:120,stdoutPath:join(dir,'attempt-1.stdout'),stderrPath:join(dir,'attempt-1.stderr')});
  const previous={...first,endedUtc:new Date().toISOString(),inputHash};atomic(join(dir,'attempt-1.json'),previous);const original=readFileSync(join(dir,'attempt-1.json'),'utf8');
  const config={defaultTimeoutMs:120,retryTimeoutMs:2000,reason:'Measured synchronous work exceeded original development calibration cap',resume:true};
  const timeoutMs=retryBudget(previous,config);assert.equal(timeoutMs,2000);
  const second=await bounded(process.execPath,['-e','let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.stringify({completed:true,score:0,input:s})))'],{input,timeoutMs});
  assert.equal(second.completed,true);assert.equal(sha256(second.result.input),inputHash);assert.equal(readFileSync(join(dir,'attempt-1.json'),'utf8'),original);
  assert.throws(()=>retryBudget({...previous,status:'running'},config),/running or uncertain/);
  assert.throws(()=>retryBudget({...previous,endedUtc:undefined},config),/running or uncertain/);
  assert.throws(()=>retryBudget(previous,{...config,reason:undefined}),/requires/);
  assert.throws(()=>retryBudget(previous,{...config,resume:false}),/requires/);
  assert.equal(retryBudget(undefined,config),120); // Newly pending cases do not inherit retry override.
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('explicit cohorts preserve declared train/dev families and reject unsupported or mixed policy',async()=>{
 const {validateCohort}=await import('./full-baseline/cohort.mjs');const base={schemaVersion:1,purpose:'training',namespace:'new-train',layout:'empty-default243',stagePolicy:'actual-mixture-v1',cases:[{familyId:'new-train-1',split:'train',seed:2026102801,size:100}]};
 const c=validateCohort(base);assert.equal(c.cases[0].split,'train');assert.equal(c.cases[0].seed,2026102801);assert.equal(c.hash,validateCohort(structuredClone(base)).hash);
 assert.throws(()=>validateCohort({...base,purpose:'release'}),/release/);assert.throws(()=>validateCohort({...base,layout:'tiny'}),/Unsupported/);assert.throws(()=>validateCohort({...base,stagePolicy:'all-max'}),/Unsupported/);assert.throws(()=>validateCohort({...base,cases:[{...base.cases[0],split:'dev'}]}),/contradicts/);assert.throws(()=>validateCohort({...base,cases:[...base.cases,...base.cases]}),/Duplicate/);
});
test('cross-cohort canonical inventory and family identity collisions are detected',async()=>{
 const {inventoryCollisions}=await import('./full-baseline/collisions.mjs');const {mkdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'full-cohort-collision-'));try{
 mkdirSync(join(dir,'artifacts/neural'),{recursive:true});const entries=[{operator:'b',elitePhase:0,level:1},{operator:'a',elitePhase:2,level:1}];atomic(join(dir,'artifacts/neural/previous.json'),{familyId:'prior',entries});
 const sameContent=inventoryCollisions(dir,[{familyId:'new',entries:[...entries].reverse()}],join(dir,'none'));assert.equal(sameContent.collisions.length,1);assert.equal(sameContent.familyIdCollisions.length,0);
 const sameId=inventoryCollisions(dir,[{familyId:'prior',entries:[{operator:'c',elitePhase:0,level:1}]}],join(dir,'none'));assert.equal(sameId.collisions.length,0);assert.equal(sameId.familyIdCollisions.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('empty raw timeout stdout does not poison inventory audit; corrupt canonical input still fails closed',async()=>{
 const {inventoryCollisions}=await import('./full-baseline/collisions.mjs');const {mkdirSync,writeFileSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'full-raw-audit-'));try{mkdirSync(join(dir,'training_data/prior'),{recursive:true});writeFileSync(join(dir,'training_data/prior/family.attempt-1.stdout.json'),'');atomic(join(dir,'training_data/prior/family.input.json'),{familyId:'prior',entries:[{operator:'a',elitePhase:0,level:1}]});
 const cases=[{familyId:'next',entries:[{operator:'b',elitePhase:0,level:1}]}];const valid=inventoryCollisions(dir,cases,join(dir,'none'));assert.equal(valid.complete,true);assert.equal(valid.ignoredRawAttempts.length,1);writeFileSync(join(dir,'training_data/prior/family.input.json'),'{');assert.equal(inventoryCollisions(dir,cases,join(dir,'none')).complete,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('independent supervisor kills worker after collector SIGKILL and writes terminal receipt',async()=>{
 const {spawn}=await import('node:child_process');const {existsSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'full-orphan-'));try{
 const moduleUrl=new URL('./full-baseline/process.mjs',import.meta.url).href,out=join(dir,'out.json'),marker=join(dir,'escaped');
 const worker=`require('fs').writeFileSync(${JSON.stringify(join(dir,'started'))},'yes');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1000);setInterval(()=>{},1000)`;
 const code=`import{bounded}from${JSON.stringify(moduleUrl)};await bounded(process.execPath,['-e',${JSON.stringify(worker)}],{timeoutMs:400,stdoutPath:${JSON.stringify(out)}});`;
 const parent=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
 for(let i=0;i<100&&!existsSync(join(dir,'started'));i++)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(join(dir,'started')));parent.kill('SIGKILL');await new Promise(r=>parent.on('close',r));
 for(let i=0;i<150&&!existsSync(out+'.terminal.json');i++)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(out+'.terminal.json'));const receipt=JSON.parse(readFileSync(out+'.terminal.json','utf8'));assert.equal(receipt.closed,true);assert.equal(receipt.reason,'EXTERNAL_PROCESS_TIMEOUT');await new Promise(r=>setTimeout(r,1000));assert.equal(existsSync(marker),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('concurrent real CLI cannot read stale checkpoint before exclusive lock or overwrite attempt files',async()=>{
 const {mkdirSync,writeFileSync,openSync,closeSync,unlinkSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const {resolve}=await import('node:path');
 const run=`node-test-lock-${process.pid}`,root=resolve(new URL('../..',import.meta.url).pathname),base=join(root,'training_data/neural-full-v2'),data=join(base,run),lockPath=join(base,`.${run}.collector.lock`);mkdirSync(data,{recursive:true});let lock;
 try{
  writeFileSync(join(data,'worker.mjs'),'// no execution');const config={run,timeoutMs:3600000,concurrency:1,cases:[{seed:2026102701,size:100},{seed:2026102702,size:400}]};const manifest={config,provenance:{bundleHash:sha256('// no execution')},cases:[{familyId:'a'}]};atomic(join(data,'manifest.json'),manifest);const checkpoint={manifestHash:sha256(manifest),cases:{a:[{status:'completed',attempt:1,score:0,endedUtc:'done'}]}};atomic(join(data,'checkpoint.json'),checkpoint);writeFileSync(join(data,'a.attempt-1.result.json'),'immutable original');
  lock=openSync(lockPath,'wx');const contender=spawnSync(process.execPath,[join(root,'scripts/neural/full-baseline.mjs'),'--run',run,'--resume'],{encoding:'utf8'});assert.notEqual(contender.status,0);assert.match(contender.stderr,/EEXIST/);
  checkpoint.cases.a.push({status:'completed',attempt:2,score:1,endedUtc:'later'});atomic(join(data,'checkpoint.json'),checkpoint);closeSync(lock);lock=undefined;unlinkSync(lockPath);
  const later=spawnSync(process.execPath,[join(root,'scripts/neural/full-baseline.mjs'),'--run',run,'--resume'],{encoding:'utf8'});assert.equal(later.status,0,later.stderr);assert.deepEqual(JSON.parse(readFileSync(join(data,'checkpoint.json'),'utf8')),checkpoint);assert.equal(readFileSync(join(data,'a.attempt-1.result.json'),'utf8'),'immutable original');
 }finally{if(lock!==undefined)closeSync(lock);rmSync(lockPath,{force:true});rmSync(data,{recursive:true,force:true});}
});
test('existing raw attempt stdout is never overwritten and worker never starts',async()=>{
 const {writeFileSync,existsSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'full-exclusive-'));try{const out=join(dir,'out'),marker=join(dir,'marker');writeFileSync(out,'original');await assert.rejects(bounded(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],{timeoutMs:1000,stdoutPath:out}),/EEXIST/);assert.equal(readFileSync(out,'utf8'),'original');assert.equal(existsSync(marker),false);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('atomic-exclusive result publication preserves original and never leaves a truncated final',async()=>{
 const {publishExclusiveJson}=await import('./full-baseline/atomic.mjs');const {readdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'full-atomic-exclusive-'));try{const path=join(dir,'result.json'),value={large:'x'.repeat(2*1024*1024)};publishExclusiveJson(path,value);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),value);assert.throws(()=>publishExclusiveJson(path,{replacement:true}),/EEXIST/);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),value);assert.deepEqual(readdirSync(dir),['result.json']);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('legacy in-directory lock blocks new sibling-lock collector before reading old state',async()=>{
 const {mkdirSync,writeFileSync,existsSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const {resolve}=await import('node:path');const root=resolve(new URL('../..',import.meta.url).pathname),run=`node-test-legacy-${process.pid}`,base=join(root,'training_data/neural-full-v2'),data=join(base,run);mkdirSync(data,{recursive:true});try{writeFileSync(join(data,'collector.lock'),'legacy owner');const result=spawnSync(process.execPath,[join(root,'scripts/neural/full-baseline.mjs'),'--run',run,'--resume'],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/Legacy collector lock/);assert.equal(readFileSync(join(data,'collector.lock'),'utf8'),'legacy owner');assert.equal(existsSync(join(base,`.${run}.collector.lock`)),false);}finally{rmSync(data,{recursive:true,force:true});}
});
