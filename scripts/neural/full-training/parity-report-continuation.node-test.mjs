import test from 'node:test';import assert from 'node:assert/strict';import {createRequire}from'node:module';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';import{digest}from'./state.mjs';
import{verifyAlignedContinuationEvidence,verifyContinuationCheckpointState}from'./parity-report-continuation.mjs';import{objectiveVersionForPolicy,verifyTrainForkLink}from'./parity-report.mjs';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[require.resolve('vite')]})),dir=mkdtempSync(join(tmpdir(),'parity-continuation-test-'));let fixture;
try{const path=join(dir,'fixture.mjs');await build({entryPoints:[fileURLToPath(new URL('./parity-report-continuation-fixture.ts',import.meta.url))],outfile:path,bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'silent'});fixture=(await import(pathToFileURL(path).href)).fixture;}finally{rmSync(dir,{recursive:true,force:true});}
test('group-cover mode explicitly pairs with unchanged native runtime V3 objective',()=>assert.equal(objectiveVersionForPolicy('latest-native-group-cover-v3'),'latest-default-runtime-lexicographic-v3'));
test('same-feature continuation preserves learned nonzero appended rows and distinguishes 170035 from original91735',()=>{const f=fixture(),r=verifyAlignedContinuationEvidence(f);assert.equal(r.model.modelHash,digest(f.parentBytes));assert.equal(r.model.trainingUpdates,170035);assert.equal(r.inheritedMigration.initialTrainingUpdates,91735);assert.equal(r.model.featureMigrationExecuted,false);assert.equal(r.model.newTrainingUpdates,0);assert.equal(r.population.families,24);assert.deepEqual(r.population.members,[{index:0,families:8},{index:1,families:16}]);});
for(const[label,mutate]of[
 ['newly zeroed learned input row',f=>f.initialBytes[f.initialBytes.length-24]^=1],
 ['counter differs from binary',f=>f.parentState.cursor.updates++],
 ['changed LR',f=>f.manifest.config.learningRate=.02],
 ['changed chunk size',f=>f.manifest.config.chunkSize=128],
 ['dropped family',f=>f.dataset.records.pop()],
 ['reordered valid24',f=>f.dataset.records.reverse()],
 ['cross-member family',f=>f.dataset.records[0].sourceMemberIndex=1],
 ['changed teacher semantics',f=>f.dataset.records[0].teacherSemanticHash='other'],
 ['DEV family',f=>f.dataset.records[0].input.split='dev'],
 ['forged replay partial',f=>f.dataset.records[0].producerReplay.producerActionIdsHash='other'],
 ['changed original producer',f=>{f.childReplays[0].proof.originalProducer='different';f.childReplays[0].proofHash=digest(f.childReplays[0].proof);}],
 ['changed immutable physics',f=>{f.manifest.provenance.sourceHashes['src/simulator/production.ts']='changed';f.manifest.provenance.sourceHash=digest(f.manifest.provenance.sourceHashes);}],
 ['unreviewed new dependency',f=>{f.manifest.provenance.sourceHashes['src/new.ts']='unreviewed';f.manifest.provenance.sourceHash=digest(f.manifest.provenance.sourceHashes);}],
 ['zero helper pin',f=>f.groupHelper.sha256='0'.repeat(64)],
 ['wrong inherited migration receipt',f=>f.parentMigration.receiptHash='other'],
 ['wrong inherited migration counter',f=>f.parentMigration.inheritedTrainingUpdates=170036],
 ['generic recursive continuation',f=>f.parentManifest.lineage.spec.mode='aligned-continuation'],
 ['unfinished boundary',f=>f.parentState.cursor.action=1],
 ['pending evaluation',f=>f.parentState.pendingEvaluation={epoch:10}],
 ['wrong original migration directory',f=>f.lineage.continuation.inheritedMigration.directory='/other'],
])test('continuation rejects '+label,()=>{const f=fixture();mutate(f);assert.throws(()=>verifyAlignedContinuationEvidence(f));});

test('ordinary parameter fork cannot bypass the separately authenticated continuation ancestry',()=>{const f=fixture();f.lineage.spec={mode:'fork',parentRun:'parent'};f.lineage.parent.generation='checkpoint-1-2-3';assert.throws(()=>verifyTrainForkLink({lineage:f.lineage,childManifest:f.manifest,parentManifest:f.parentManifest}),/distinct direct aligned continuation/);});
test('continuation checkpoint binds the NEW receipt and allows learned post-initialization changes without re-zeroing',()=>{const receipt=verifyAlignedContinuationEvidence(fixture()),state={initializationProofHash:digest(receipt),modelHash:receipt.model.modelHash,cursor:receipt.model.outerCursor};assert.doesNotThrow(()=>verifyContinuationCheckpointState(state,receipt));assert.doesNotThrow(()=>verifyContinuationCheckpointState({...state,modelHash:'new-learned-model',cursor:{epoch:1,family:2,action:0,updates:170050}},receipt));for(const change of [{initializationProofHash:receipt.inheritedMigration.receiptHash},{modelHash:'remigrated-zero-model'},{cursor:{epoch:1,family:0,action:0,updates:170035}},{cursor:{epoch:0,family:0,action:0,updates:91735}}])assert.throws(()=>verifyContinuationCheckpointState({...state,...change},receipt));});
