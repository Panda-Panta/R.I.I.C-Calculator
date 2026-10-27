import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExternalSources } from './external-dev.mjs';
const train = { config: { purpose: 'train', teacherKind: 'molecular-simulated' } }, dev = { config: { purpose: 'dev-overfit', teacherKind: 'full-optimizer' } }, td = { purpose: 'train', records: [{ familyId: 'train1' }] }, dd = { purpose: 'dev-overfit', baselineEligible: true, records: [{ familyId: 'dev1', input: { split: 'dev' }, sourceKind: 'full-optimizer', baselineEligible: true }] };
test('explicit auxiliary TRAIN can be evaluated against separate full DEV, never as its baseline', () => { assert.doesNotThrow(() => validateExternalSources(train, dev, td, dd)); assert.throws(() => validateExternalSources(train, { config: { purpose: 'dev-overfit', teacherKind: 'molecular-simulated' } }, td, dd), /Auxiliary/); });
test('transfer evaluation rejects DEV-trained weights, release splits and duplicate families', () => { assert.throws(() => validateExternalSources(dev, dev, td, dd), /TRAIN model/); assert.throws(() => validateExternalSources(train, dev, td, { ...dd, records: [{ ...dd.records[0], input: { split: 'test' } }] }), /exposed FULL DEV/); assert.throws(() => validateExternalSources(train, dev, { ...td, records: [{ familyId: 'dev1' }] }, dd), /overlap/); });
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from './process.mjs';
test('real bundled external decode worker rejects unauthorized split before reading a model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'full-external-dev-'));
    try {
        const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), bundle = join(dir, 'worker.mjs');
        await build({ entryPoints: ['scripts/neural/full-training/external-dev-worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'silent' });
        const result = await runWorker(bundle, { input: { split: 'test' } }, { timeoutMs: 10000, stderrPath: join(dir, 'error.log') });
        assert.notEqual(result.status, 'completed');
        assert.match(readFileSync(join(dir, 'error.log'), 'utf8'), /exposed DEV only/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('real model-only decode enforces inventory split, immutable model and full baseline boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'external-dev-boundaries-'));
    try {
        const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), bundle = join(dir, 'tests.mjs');
        await build({ entryPoints: ['scripts/neural/full-training/external-dev-contract-tests.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'silent' });
        const { execFileSync } = await import('node:child_process');
        assert.match(execFileSync(process.execPath, [bundle], { encoding: 'utf8', timeout: 10000 }), /model-only decode checks passed/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('external FULL DEV must reject changed producer/shared physics before jobs, while explicit action transition is narrow', async () => { const { validateExternalTeacherContract } = await import('./external-dev.mjs'); assert.equal(typeof validateExternalTeacherContract, 'function'); const source = (path, hash) => ({ sourceHashes: { [path]: hash } }), sources = { teacherManifest: { provenance: source('src/simulator/core.ts', 'old') } }; assert.throws(() => validateExternalTeacherContract({ config: {}, provenance: source('src/simulator/core.ts', 'new') }, sources), /shared source mismatch/); const actionSources = { teacherManifest: { provenance: source('src/optimizer/neural/fullTransitions.ts', 'old') } }; assert.throws(() => validateExternalTeacherContract({ config: {}, provenance: source('src/optimizer/neural/fullTransitions.ts', 'new') }, actionSources), /shared source mismatch/); const accepted = validateExternalTeacherContract({ config: { constructionOrder: 'staffing-first-v1', sourceTransition: 'legacy-action-replay-to-staffing-first-v1' }, provenance: source('src/optimizer/neural/fullTransitions.ts', 'new') }, actionSources); assert.equal(accepted.legacyProofRequired, true); });
test('external evaluator binds actual TRAIN checkpoint settings, source, features and lineage before snapshot',async()=>{const {verifyExternalTrainCheckpoint}=await import('./external-dev.mjs');const {digest}=await import('./state.mjs');const manifest={config:{purpose:'train',teacherKind:'full-optimizer'},provenance:{sourceHash:'source',bundleHash:'bundle'}},dataset={featureManifestHash:'feature',records:[]},binding={datasetHash:digest(dataset),sourceHash:'source',bundleHash:'bundle',featureManifestHash:'feature',...manifest.config};assert.doesNotThrow(()=>verifyExternalTrainCheckpoint(manifest,dataset,{state:{binding}}));for(const key of ['purpose','sourceHash','bundleHash','featureManifestHash'])assert.throws(()=>verifyExternalTrainCheckpoint(manifest,dataset,{state:{binding:{...binding,[key]:'dev-or-other'}}}),/mismatch/);});
test('external latest action transition requires bound latest policy mode and independent proof',async()=>{
 const {validateExternalTeacherContract}=await import('./external-dev.mjs'),{referenceProtocol}=await import('../full-baseline/reference-protocol.mjs');
 const path='src/optimizer/neural/fullTransitions.ts',sources={teacherManifest:{dataVersion:'latest-math-v3',referenceProtocol:referenceProtocol('latest-default-two-stage-v1'),provenance:{sourceHashes:{[path]:'old'}}},records:[]},training={config:{teacherKind:'full-optimizer',constructionOrder:'staffing-first-v1',policyMode:'latest-warmup-exhaustion-v1',sourceTransition:'latest-default-to-warmup-policy-v1'},provenance:{sourceHashes:{[path]:'new'}}};
 const result=validateExternalTeacherContract(training,sources);assert.equal(result.producerReplayProofRequired,true);
 assert.throws(()=>validateExternalTeacherContract({...training,config:{...training.config,policyMode:'legacy-unconstrained-v1'}},sources),/transition|policy/i);
});
test('external decode cannot silently reinterpret legacy dataset records under latest policy settings',()=>{
 const latest={config:{purpose:'train',teacherKind:'full-optimizer',policyMode:'latest-warmup-exhaustion-v1'}};
 assert.throws(()=>validateExternalSources(latest,dev,td,dd),/policy.mode/i);
 const latestData={...td,policyMode:'latest-warmup-exhaustion-v1',records:[{familyId:'train1',policyMode:'latest-warmup-exhaustion-v1'}]};
 assert.doesNotThrow(()=>validateExternalSources(latest,dev,latestData,dd));
 assert.throws(()=>validateExternalSources(latest,dev,{...latestData,records:[{familyId:'train1'}]},dd),/policy.mode/i);
});
test('aligned external source contract requires explicit feature migration binding, never just v2 mode',async()=>{const{validateExternalTeacherContract}=await import('./external-dev.mjs'),{FEATURE_MIGRATION_ID,ALIGNED_SOURCE_TRANSITION,FEATURE_MIGRATION_CONTRACT:C,FEATURE_MIGRATION_SOURCE_PAIRS:P}=await import('./feature-migration-contract.mjs'),{referenceProtocol}=await import('../full-baseline/reference-protocol.mjs');const producer={sourceHashes:Object.fromEntries(Object.entries(P).map(([k,p])=>[k,p.old]))},trainer={sourceHashes:{...Object.fromEntries(Object.entries(P).map(([k,p])=>[k,p.next])),[C.migrationModule]:C.migrationModuleHash}},sources={teacherManifest:{dataVersion:'latest-math-v3',referenceProtocol:referenceProtocol('latest-default-two-stage-v1'),provenance:producer},records:[]},training={config:{purpose:'train',teacherKind:'full-optimizer',constructionOrder:'staffing-first-v1',policyMode:'latest-warmup-runorder-v2',sourceTransition:ALIGNED_SOURCE_TRANSITION,featureMigration:FEATURE_MIGRATION_ID},provenance:trainer};assert.equal(validateExternalTeacherContract(training,sources).featureMigration.id,FEATURE_MIGRATION_ID);assert.throws(()=>validateExternalTeacherContract({...training,config:{...training.config,featureMigration:undefined}},sources),/feature migration/);});

test('policy fork external snapshot requires saved receipt and exact initialization proof before any worker/job',async()=>{const{verifyExternalTrainCheckpoint}=await import('./external-dev.mjs'),{POLICY_FORK_ID,POLICY_FORK_PARENT}=await import('./aligned-policy-fork-contract.mjs'),{digest}=await import('./state.mjs'),{writeFileSync}=await import('node:fs');const directory=mkdtempSync(join(tmpdir(),'fork-external-proof-'));try{const training={config:{purpose:'train',policyForkId:POLICY_FORK_ID},provenance:{sourceHash:'source',bundleHash:'bundle'}},data={featureManifestHash:'feature',records:[]},binding={datasetHash:digest(data),sourceHash:'source',bundleHash:'bundle',featureManifestHash:'feature',...training.config},receipt={kind:POLICY_FORK_ID,model:{trainingUpdates:POLICY_FORK_PARENT.updates,modelHash:POLICY_FORK_PARENT.modelHash}},state={binding,cursor:{epoch:0,family:0,action:0,updates:248335},pendingEvaluation:null,modelHash:POLICY_FORK_PARENT.modelHash,initializationProofHash:digest(receipt)},checkpoint={state};assert.throws(()=>verifyExternalTrainCheckpoint(training,data,checkpoint,directory));writeFileSync(join(directory,'policy-fork.json'),JSON.stringify(receipt));assert.doesNotThrow(()=>verifyExternalTrainCheckpoint(training,data,checkpoint,directory));for(const changed of[{initializationProofHash:'other'},{modelHash:'other'},{cursor:{...state.cursor,epoch:1}},{pendingEvaluation:{epoch:1}}])assert.throws(()=>verifyExternalTrainCheckpoint(training,data,{state:{...state,...changed}},directory));writeFileSync(join(directory,'policy-fork.json'),JSON.stringify({...receipt,changed:true}));assert.throws(()=>verifyExternalTrainCheckpoint(training,data,checkpoint,directory));}finally{rmSync(directory,{recursive:true,force:true});}});
