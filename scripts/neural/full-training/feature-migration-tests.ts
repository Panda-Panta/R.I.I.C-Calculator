/** Synthetic zero-update initialization contract; no teacher or simulation. */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initialModel,featureMigrationReceipt} from '../full-train-worker';
import {serializeFullPolicy} from '../../../src/optimizer/neural/fullPolicy';
import {FULL_FEATURE_MANIFEST,LEGACY_FULL_FEATURE_MANIFEST} from '../../../src/optimizer/neural/fullFeatures';
import {FEATURE_MIGRATION_CONTRACT as C,FEATURE_MIGRATION_SOURCE_PAIRS as PAIRS,FEATURE_MIGRATION_ID,ALIGNED_SOURCE_TRANSITION} from './feature-migration-contract.mjs';
import {digest,atomic} from './state.mjs';
const directory=mkdtempSync(join(tmpdir(),'feature-migration-init-'));
try{
 const header={version:2,featureVersion:C.oldVersion,manifestHash:C.oldHash,featureCount:C.oldCount,hiddenSize:1,metadata:{seed:43,trainingUpdates:91735,optimizerVersion:'common-l2-sgd-v1',resume:{datasetHash:'old',learningRate:.01,epoch:35,sampleIndex:0,optimizerVersion:'common-l2-sgd-v1'}}},json=Buffer.from(JSON.stringify(header)),bytes=Buffer.alloc(8+json.length+8*(C.oldCount+2));bytes.writeUInt32LE(0x46503242);bytes.writeUInt32LE(json.length,4);json.copy(bytes,8);bytes.writeDoubleLE(-0,8+json.length);bytes.writeDoubleLE(2,8+json.length+8*C.oldCount);
 const numerical={optimizer:'common-l2-sgd-v1',learningRate:.01,hiddenSize:1,seed:43,chunkSize:512};
 const record={familyId:'synthetic',input:{familyId:'synthetic',split:'train'},teacherRecordHash:'teacher',teacherSemanticHash:'semantic'},parentDataset={purpose:'train',featureManifestHash:C.oldHash,records:[record]},dataset={...parentDataset,featureManifestHash:C.newHash};atomic(join(directory,'parent-dataset.json'),parentDataset);atomic(join(directory,'dataset.json'),dataset);
 const lineage={spec:{mode:'feature-migration',featureMigration:FEATURE_MIGRATION_ID},parent:{datasetHash:digest(parentDataset),modelHash:digest(bytes),featureManifestHash:C.oldHash,purpose:'train',cursor:{epoch:5,family:0,action:0,updates:91735}},initialModelHash:digest(bytes),featureMigration:{id:FEATURE_MIGRATION_ID,parentFeatureManifestHash:digest(LEGACY_FULL_FEATURE_MANIFEST),parentNumericalConfig:numerical}};
 const sourceHashes={...Object.fromEntries(Object.entries(PAIRS).map(([key,pair])=>[key,pair.next])),[C.migrationModule]:C.migrationModuleHash},provenance={sourceHashes,sourceHash:digest(sourceHashes),bundleHash:'synthetic-test-only'};
 atomic(join(directory,'manifest.json'),{provenance});
 const binding={...numerical,sourceHash:provenance.sourceHash,bundleHash:provenance.bundleHash,lineageHash:digest(lineage),featureManifestHash:C.newHash,purpose:'train',featureMigration:FEATURE_MIGRATION_ID,sourceTransition:ALIGNED_SOURCE_TRANSITION};
 atomic(join(directory,'lineage.json'),lineage);atomic(join(directory,'parent-feature-manifest.json'),LEGACY_FULL_FEATURE_MANIFEST);atomic(join(directory,'feature-manifest.json'),FULL_FEATURE_MANIFEST);writeFileSync(join(directory,'initial-model.bin'),bytes);
 const model=initialModel({directory,binding});assert.equal(model.metadata.trainingUpdates,91735);assert.equal(model.metadata.resume,undefined);assert.equal(model.featureCount,56177);assert.ok(Object.is(model.inputWeights[0]![0],-0));assert.equal(model.inputWeights[53006]![0],0);
 const receipt=JSON.parse(readFileSync(join(directory,'feature-migration.json'),'utf8'));assert.equal(receipt.oldModelHash,digest(bytes));assert.equal(receipt.newModelHash,digest(serializeFullPolicy(model)));assert.equal(receipt.newTrainingUpdates,0);assert.deepEqual(readFileSync(join(directory,'migrated-initial-model.bin')),Buffer.from(serializeFullPolicy(model)));
 assert.equal(digest(serializeFullPolicy(initialModel({directory,binding}))),receipt.newModelHash);
 for(const mutate of [(x:any)=>x.spec.mode='fresh',(x:any)=>x.parent.purpose='dev-overfit',(x:any)=>x.featureMigration.parentNumericalConfig.learningRate=.02]){const changed=structuredClone(lineage);mutate(changed);atomic(join(directory,'lineage.json'),changed);assert.throws(()=>featureMigrationReceipt({directory,binding},bytes,serializeFullPolicy(model)),/lineage|migration/);}atomic(join(directory,'lineage.json'),lineage);
 assert.throws(()=>initialModel({directory,binding:{...binding,optimizer:'sgd-v1'}}),/migration|numerical/);
 atomic(join(directory,'parent-feature-manifest.json'),{});assert.throws(()=>initialModel({directory,binding}),/manifest/);
 console.log('migration initializer preserves old bits and zero updates');
}finally{rmSync(directory,{recursive:true,force:true});}
