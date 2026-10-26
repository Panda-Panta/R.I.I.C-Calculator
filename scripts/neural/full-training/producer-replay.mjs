/** Independent, prepare-only replay by an immutable original full-reference worker. */
import {readFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {atomic,digest} from './state.mjs';
import {runWorker} from './process.mjs';
import {verifyTeacherSourceCompatibility,LATEST_POLICY_TRANSITIONS} from './source-compatibility.mjs';
import {assertFullBaselineDataset} from './evaluate.mjs';
import {referenceManifestContract,LATEST_DEFAULT_REFERENCE} from '../full-baseline/reference-protocol.mjs';
export {verifyProducerReplayRecord} from './policy-replay-contract.mjs';
import {verifyProducerReplayRecord} from './policy-replay-contract.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const originalMode='legacy-unconstrained-v1';
export async function prepareProducerReplay({producerDirectory,directory,sources,trainingProvenance,sourceTransition,timeoutMs=120000}) {
    if (!Object.hasOwn(LATEST_POLICY_TRANSITIONS,sourceTransition)) throw Error('Explicit approved producer replay source transition required');
    if (sources.sourceCompatibility?.policy && sources.sourceCompatibility.policy!=='none' && sources.sourceCompatibility.policy!==sourceTransition) throw Error('Requested producer replay source transition mismatch');
    producerDirectory=resolve(producerDirectory);directory=resolve(directory);
    if(existsSync(join(producerDirectory,'run.lock')))throw Error('Original producer preparation must be stopped');
    const manifest=read(join(producerDirectory,'manifest.json')),snapshot=read(join(producerDirectory,'source-snapshot.json')),originalSources=read(join(producerDirectory,'source-records.json')),dataset=read(join(producerDirectory,'dataset.json')),preparation=read(join(producerDirectory,'preparation.json')),bundle=readFileSync(join(producerDirectory,'worker.mjs'));
    if(manifest.config?.teacherKind!=='full-optimizer'||manifest.config.purpose!==sources.purpose||(manifest.config.policyMode??originalMode)!==originalMode||(manifest.config.sourceTransition??'none')!=='none')
        throw Error('Original producer replay requires unchanged full-reference preparation and matching purpose');
    if(manifest.provenance.sourceHash!==digest(manifest.provenance.sourceHashes)||digest(bundle)!==manifest.provenance.bundleHash)
        throw Error('Original producer bundle/source commitment mismatch');
    for(const [key,hash] of Object.entries(manifest.provenance.sourceHashes))
        if(typeof snapshot[key]!=='string'||digest(snapshot[key])!==hash)throw Error('Original producer source snapshot mismatch: '+key);
    if(originalSources.teacherManifestHash!==digest(originalSources.teacherManifest)||digest(originalSources.teacherManifest)!==digest(sources.teacherManifest)||digest(originalSources.records)!==digest(sources.records)||digest(originalSources.pending??[])!==digest(sources.pending??[]))
        throw Error('Original producer raw reference/source identity changed');
    const reference=referenceManifestContract(sources.teacherManifest,sources.records.map(r=>r.input));
    if(reference.referenceProtocol.id!==LATEST_DEFAULT_REFERENCE)throw Error('Producer replay transition requires latest default reference');
    verifyTeacherSourceCompatibility(originalSources.teacherManifest.provenance,manifest.provenance,'none');
    // Extra feature/numerical dependencies absent from the mathematical producer are also immutable.
    const srcOnly=p=>({sourceHashes:Object.fromEntries(Object.entries(p.sourceHashes).filter(([key])=>key.startsWith('src/')))});
    for (const key of Object.keys(srcOnly(manifest.provenance).sourceHashes)) if (!trainingProvenance.sourceHashes[key]) throw Error('Original producer source dependency commitment missing: '+key);
    verifyTeacherSourceCompatibility(srcOnly(manifest.provenance),srcOnly(trainingProvenance),sourceTransition);
    if(dataset.sourceRecordsHash!==digest(originalSources)||dataset.purpose!==sources.purpose||preparation.status!=='completed'||preparation.result?.status!=='dataset-ready'||preparation.result.datasetHash!==digest(dataset)||!dataset.records.length)
        throw Error('Original producer prepared dataset commitment mismatch');
    assertFullBaselineDataset(dataset,manifest);
    const families=new Set();
    for(const record of dataset.records){
        if(families.has(record.familyId))throw Error('Duplicate original producer family');families.add(record.familyId);
        const source=sources.records.find(r=>r.input.familyId===record.familyId&&digest(r.outcome)===record.teacherRecordHash);
        if(!source||digest(source.input)!==digest(record.input)||(record.policyMode??originalMode)!==originalMode)
            throw Error('Original producer record/source commitment mismatch');
    }
    mkdirSync(directory,{recursive:false,mode:0o700});
    for(const [from,to] of [['worker.mjs','worker.mjs'],['source-records.json','source-records.json'],['manifest.json','producer-manifest.json'],['source-snapshot.json','producer-source-snapshot.json'],['dataset.json','producer-dataset.json'],['preparation.json','producer-preparation.json']])
        copyFileSync(join(producerDirectory,from),join(directory,to));
    const job={mode:'prepare',directory,purpose:manifest.config.purpose,teacherKind:'full-optimizer',constructionOrder:manifest.config.constructionOrder??'legacy-v1',inputProfile:manifest.config.inputProfile??'actual-mixture-v1',sourceTransition:'none'};
    const outcome=await runWorker(join(directory,'worker.mjs'),job,{timeoutMs,stderrPath:join(directory,'prepare.stderr')});
    atomic(join(directory,'preparation.json'),outcome);
    if(outcome.status!=='completed'||outcome.result?.status!=='dataset-ready')throw Error('Independent original producer replay did not complete');
    const reproduced=read(join(directory,'dataset.json'));
    if(digest(reproduced)!==digest(dataset)||outcome.result.datasetHash!==digest(dataset))throw Error('Independent original producer replay dataset mismatch');
    const proof={schemaVersion:1,kind:'frozen-full-reference-replay-v1',mode:'prepare-only-zero-training-zero-simulation',producerDirectory,producerManifestHash:digest(manifest),producerSourceHash:manifest.provenance.sourceHash,producerBundleHash:manifest.provenance.bundleHash,teacherManifestHash:digest(sources.teacherManifest),sourceRecordsHash:digest(originalSources),archivedDatasetHash:digest(dataset),replayedDatasetHash:digest(reproduced),featureManifestHash:dataset.featureManifestHash,constructionOrder:dataset.constructionOrder??'legacy-v1',policyMode:originalMode,preparationJobHash:digest(job),preparationOutcomeHash:digest(outcome),records:dataset.records.map(r=>({familyId:r.familyId,inputHash:digest(r.input),teacherRecordHash:r.teacherRecordHash,actionIds:r.actionIds,teacherSemanticHash:r.teacherSemanticHash,constructionOrder:r.constructionOrder??'legacy-v1',policyMode:r.policyMode??originalMode}))};
    for(const record of dataset.records){const source=sources.records.find(r=>r.input.familyId===record.familyId&&digest(r.outcome)===record.teacherRecordHash);verifyProducerReplayRecord(proof,source.input,source.outcome,record);}
    atomic(join(directory,'proof.json'),proof);
    atomic(join(directory,'job.json'),job);
    return proof;
}
