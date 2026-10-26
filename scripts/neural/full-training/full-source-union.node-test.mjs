import test from 'node:test';
import assert from 'node:assert/strict';
import {planFullTrainingUnion} from './full-source-union.mjs';
import {composeFullTrainingUnion,verifyFullTrainingUnion,fullUnionDatasetContract,FULL_UNION_KIND} from './full-union-contract.mjs';
import {digest} from './state.mjs';
import {canonicalInventoryHash} from '../full-baseline/collisions.mjs';
import {referenceProtocol,referenceManifestContract} from '../full-baseline/reference-protocol.mjs';
import {verifyTeacherSourceCompatibility,LATEST_RUNORDER_SOURCE_TRANSITION as transition} from './source-compatibility.mjs';
const protocol=referenceProtocol('latest-default-two-stage-v1');
const provenance={sourceHashes:{'src/physics.ts':'same'},bundleHash:'a'.repeat(64)};provenance.sourceHash=digest(provenance.sourceHashes);
function member(n,status='completed') {
 const entries=[{operator:'char_'+n,elitePhase:2,level:90}],familyId='train-'+n,options={seed:n,enableDeepSearch:false,simulationWarmupHours:24,simulationSampleHours:72,droneTarget:'gold',productionWeights:{exp:1,gold:.8,orders:.2,fragments:0,orundum:0}};
 const input={split:'train',dataVersion:'latest-math-v3',referenceProtocol:protocol,options,familyId,seed:n,entries,inventoryHash:canonicalInventoryHash(entries)};
 const workspace={mainPlan:{fixture:true}},candidate={id:'initial',workspace,simScore:0};
 const outcome=status==='completed'?{status,completed:true,score:0,result:{completed:true,score:0,referenceProtocol:protocol,requestOptionsHash:digest(options),result:{status:'draft',score:0,workspace,calculationReport:{fixture:true},phases:{calculation:{status:'limited',proofScope:'quantified-manufacturing-model-only'},static:{candidates:[candidate]},simulation:{candidates:[candidate],bestScore:0},search:null}},validation:{physical:[]}}}:{status,completed:false,score:null};
 const declaration={familyId,split:'train',seed:n,inputHash:digest(input),inventoryHash:input.inventoryHash},manifest={schemaVersion:3,sourceKind:'full-optimizer',dataVersion:'latest-math-v3',referenceProtocol:protocol,provenance,cases:[declaration]},resultPath='/raw/'+n+'/result.json',attempt={attempt:1,status,score:outcome.score,resultPath,resultHash:digest(outcome)},record={input,outcome,attempt:1,resultPath,resultHash:digest(outcome)};
 return {directory:'/raw/'+n,inputs:[input],checkpoint:{manifestHash:digest(manifest),cases:{[familyId]:[attempt]}},sources:{purpose:'train',teacherKind:'full-optimizer',teacherManifest:manifest,teacherManifestHash:digest(manifest),sourceCompatibility:verifyTeacherSourceCompatibility(provenance,provenance,transition),records:[record],pending:[]}};
}
const options={trainingProvenance:provenance,sourceTransition:transition,excludedInputs:[]};
test('independent full TRAIN union preserves original manifests and denominator without becoming a training dataset',()=>{
 const a=member(1),b=member(2),before=digest([a,b]),u=planFullTrainingUnion([a,b],options);
 assert.equal(u.kind,'independent-full-train-union-plan-v1');assert.equal(u.trainingExecutable,false);assert.equal(u.teacherManifest,undefined);assert.equal(u.dataset,undefined);assert.equal(u.accounting.declaredFamilies,2);assert.equal(u.accounting.qualifiedFamilies,2);assert.deepEqual(u.members.map(m=>m.manifest),[a.sources.teacherManifest,b.sources.teacherManifest]);assert.equal(digest([a,b]),before);
});
test('failed and null attempts remain declared members, never dropped or resampled',()=>{
 const u=planFullTrainingUnion([member(1),member(2,'timeout')],options);assert.equal(u.accounting.declaredFamilies,2);assert.equal(u.accounting.qualifiedFamilies,1);assert.equal(u.accounting.failedAttempts,1);assert.equal(u.cases[1].attempts[0].score,null);assert.equal(u.cases[1].qualified,false);
});
test('omitted attempt or undeclared record is rejected rather than changing denominator',()=>{
 const a=member(1),b=member(2);b.sources.records=[];assert.throws(()=>planFullTrainingUnion([a,b],options),/attempt/);
 const c=member(3);c.sources.records.push(member(4).sources.records[0]);assert.throws(()=>planFullTrainingUnion([a,c],options),/record/);
});
test('DEV/calibration inputs cannot enter TRAIN by relabeling source purpose',()=>{
 const a=member(1),b=member(2);b.sources.purpose='dev-overfit';assert.throws(()=>planFullTrainingUnion([a,b],options),/TRAIN/);
 const c=member(3);c.inputs[0].split='dev';assert.throws(()=>planFullTrainingUnion([a,c],options),/input|split/);
});
test('canonical inventory, family and seed collisions across members or excluded cohorts fail closed',()=>{
 const a=member(1);assert.throws(()=>planFullTrainingUnion([a,member(1)],options),/collision/);
 assert.throws(()=>planFullTrainingUnion([a,member(2)],{...options,excludedInputs:[structuredClone(a.inputs[0])]}),/collision/);
 const b=member(2);b.inputs[0].entries=a.inputs[0].entries;assert.throws(()=>planFullTrainingUnion([a,b],options),/inventory|input/);
});
test('changed protocol/producer/shared physics cannot be hidden in a full union',()=>{
 const a=member(1),b=member(2);b.sources.teacherManifest=structuredClone(b.sources.teacherManifest);b.sources.teacherManifest.referenceProtocol={...protocol,id:'historical-branch10-deep-v1'};b.sources.teacherManifestHash=digest(b.sources.teacherManifest);b.checkpoint.manifestHash=b.sources.teacherManifestHash;assert.throws(()=>planFullTrainingUnion([a,b],options),/protocol|reference/);
 const changed={...provenance,sourceHashes:{'src/physics.ts':'changed'}};changed.sourceHash=digest(changed.sourceHashes);
 assert.throws(()=>planFullTrainingUnion([a,member(2)],{...options,trainingProvenance:changed}),/source mismatch/);
});
test('checkpoint, raw result and declared inventory commitments are independently checked',()=>{
 for(const mutate of [m=>m.checkpoint.manifestHash='bad',m=>m.sources.records[0].outcome.score=99,m=>m.sources.teacherManifest.cases[0].inventoryHash='bad']){const a=member(1),b=member(2);mutate(b);assert.throws(()=>planFullTrainingUnion([a,b],options));}
});
test('union cannot claim a forged current training source commitment over unchanged map',()=>{
 assert.throws(()=>planFullTrainingUnion([member(1),member(2)],{...options,trainingProvenance:{...provenance,sourceHash:'FORGED'}}),/training source commitment/i);
});
function proven(n){const m=member(n);m.sources.producerReplay={producerDirectory:'/original/'+n,kind:'frozen-full-reference-replay-v1',mode:'prepare-only-zero-training-zero-simulation',policyMode:'legacy-unconstrained-v1',featureManifestHash:'old-feature',archivedDatasetHash:'same-'+n,replayedDatasetHash:'same-'+n,records:[{familyId:m.inputs[0].familyId,inputHash:digest(m.inputs[0]),teacherRecordHash:digest(m.sources.records[0].outcome),actionIds:['one'],teacherSemanticHash:'semantic-'+n}]};return m;}
const unionDefinition={schemaVersion:1,kind:'independent-full-train-union-definition-v1',name:'explicit-train-union',purpose:'train',members:[{source:'1',producerReplayDirectory:'/original/1'},{source:'2',producerReplayDirectory:'/original/2'}],excludedSources:[]};
test('executable union retains each separate teacher manifest/proof and member-binds flattened records',()=>{const members=[proven(1),proven(2)],u=composeFullTrainingUnion(members,{...options,definition:unionDefinition,excludedCohorts:[]});assert.equal(u.kind,FULL_UNION_KIND);assert.equal(u.teacherManifest,undefined);assert.equal(u.members.length,2);assert.deepEqual(u.records.map(r=>r.sourceMemberIndex),[0,1]);assert.equal(fullUnionDatasetContract(u).declaredFamilies,2);assert.doesNotThrow(()=>verifyFullTrainingUnion(u));const bad=structuredClone(u);bad.records[0].sourceMemberIndex=1;assert.throws(()=>verifyFullTrainingUnion(bad),/union/);});
test('executable union rejects missing independent original proof or a changed explicit declaration',()=>{const m=[proven(1),proven(2)];delete m[1].sources.producerReplay;assert.throws(()=>composeFullTrainingUnion(m,{...options,definition:unionDefinition,excludedCohorts:[]}),/proof/);const good=[proven(1),proven(2)];assert.throws(()=>composeFullTrainingUnion(good,{...options,definition:{...unionDefinition,members:unionDefinition.members.slice(0,1)},excludedCohorts:[]}),/member|definition/);});
test('a member proof cannot silently omit an otherwise qualified declared family',()=>{const members=[proven(1),proven(2)];members[1].sources.producerReplay.records=[];assert.throws(()=>composeFullTrainingUnion(members,{...options,definition:unionDefinition,excludedCohorts:[]}),/proof.*population|population.*proof/);});
test('executable complete union refuses an undeclared partial phase while preserving failed source evidence',()=>{const failed=member(2,'timeout');failed.sources.producerReplay={...proven(2).sources.producerReplay,records:[]};const members=[proven(1),failed],before=digest(members);assert.throws(()=>composeFullTrainingUnion(members,{...options,definition:unionDefinition,excludedCohorts:[]}),/complete|partial/);assert.equal(digest(members),before);});
test('prepared union must reproduce every member proof population without cross-member relabeling',async()=>{const{verifyPreparedPolicyDataset,verifyProducerReplayRecord}=await import('./policy-replay-contract.mjs'),sources=composeFullTrainingUnion([proven(1),proven(2)],{...options,definition:unionDefinition,excludedCohorts:[]}),records=sources.records.map(s=>{const m=sources.members[s.sourceMemberIndex],p=m.sources.producerReplay,r={familyId:s.input.familyId,input:s.input,teacherRecordHash:digest(s.outcome),teacherSemanticHash:p.records[0].teacherSemanticHash,policyMode:'latest-warmup-runorder-v2',sourceMemberIndex:s.sourceMemberIndex,sourceManifestHash:m.sources.teacherManifestHash};return{...r,producerReplay:verifyProducerReplayRecord(p,s.input,s.outcome,r)};}),dataset={referenceContract:null,referenceContracts:sources.members.map(m=>referenceManifestContract(m.sources.teacherManifest,m.inputs)),policyMode:'latest-warmup-runorder-v2',featureManifestHash:'old-feature',sourceRecordsHash:digest(sources),sourceUnion:fullUnionDatasetContract(sources),records},binding={policyMode:dataset.policyMode,sourceTransition:transition};assert.doesNotThrow(()=>verifyPreparedPolicyDataset(dataset,sources,binding));assert.throws(()=>verifyPreparedPolicyDataset({...dataset,records:records.slice(1)},sources,binding),/cohort|population/);const bad=structuredClone(dataset);bad.records[0].sourceMemberIndex=1;assert.throws(()=>verifyPreparedPolicyDataset(bad,sources,binding),/member|cohort|population/);});
test('real worker prepares every independent member under a new bound union without simulating',async()=>{const{createRequire}=await import('node:module'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{execFileSync}=await import('node:child_process'),require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[require.resolve('vite')]})),dir=mkdtempSync(join(tmpdir(),'union-worker-'));try{const outfile=join(dir,'test.mjs');await build({entryPoints:[fileURLToPath(new URL('./full-union-tests.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'silent'});assert.match(execFileSync(process.execPath,[outfile,'--library'],{encoding:'utf8',timeout:30000}),/exact preparation passed/);}finally{rmSync(dir,{recursive:true,force:true});}});
