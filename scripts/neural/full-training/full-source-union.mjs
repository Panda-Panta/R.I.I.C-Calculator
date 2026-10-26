/** Explicit independent full TRAIN union planning; not an executable training dataset. */
import {isAbsolute} from 'node:path';
import {digest,qualifyEnvelope} from './state.mjs';
import {canonicalInventoryHash} from '../full-baseline/collisions.mjs';
import {referenceManifestContract,LATEST_DEFAULT_REFERENCE} from '../full-baseline/reference-protocol.mjs';
import {verifyTeacherSourceCompatibility,LATEST_POLICY_TRANSITIONS} from './source-compatibility.mjs';
export function planFullTrainingUnion(members,{trainingProvenance,sourceTransition,excludedInputs}) {
    if(!Array.isArray(members)||members.length<2||!Array.isArray(excludedInputs)||!Object.hasOwn(LATEST_POLICY_TRANSITIONS,sourceTransition))throw Error('Explicit independent TRAIN members, exclusions and latest transition required');
    const sourceHashes=trainingProvenance?.sourceHashes;
    if(!sourceHashes||typeof sourceHashes!=='object'||Array.isArray(sourceHashes)||!Object.keys(sourceHashes).length||Object.entries(sourceHashes).some(([path,hash])=>!path||typeof hash!=='string'||!hash)||trainingProvenance.sourceHash!==digest(sourceHashes))throw Error('Training source commitment mismatch');
    const seen={family:new Set(),seed:new Set(),inventory:new Set()},excluded={family:new Set(),seed:new Set(),inventory:new Set()};
    for(const input of excludedInputs){excluded.family.add(input.familyId);excluded.seed.add(input.seed);excluded.inventory.add(canonicalInventoryHash(input.entries));}
    const declarations=[],boundMembers=[];let referenceIdentity;
    for(const [memberIndex,member] of members.entries()){
        const {sources,checkpoint,inputs,directory}=member,m=sources?.teacherManifest;
        if(!isAbsolute(directory)||sources?.purpose!=='train'||sources.teacherKind!=='full-optimizer'||m?.sourceKind!=='full-optimizer')throw Error('Union requires original full TRAIN source manifests');
        if(sources.teacherManifestHash!==digest(m)||checkpoint?.manifestHash!==digest(m))throw Error('Member checkpoint/manifest commitment mismatch');
        if(m.provenance.sourceHash!==digest(m.provenance.sourceHashes))throw Error('Member producer source commitment mismatch');
        const compatibility=verifyTeacherSourceCompatibility(m.provenance,trainingProvenance,sourceTransition);
        if(digest(compatibility)!==digest(sources.sourceCompatibility))throw Error('Member source compatibility commitment mismatch');
        const reference=referenceManifestContract(m,inputs);
        if(reference.referenceProtocol.id!==LATEST_DEFAULT_REFERENCE)throw Error('Union requires exact latest default reference protocol');
        const identity={referenceProtocol:reference.referenceProtocol,producerSourceHash:m.provenance.sourceHash,producerBundleHash:m.provenance.bundleHash};
        if(referenceIdentity&&digest(identity)!==digest(referenceIdentity))throw Error('Union reference protocol/producer population mismatch');referenceIdentity=identity;
        if(!Array.isArray(inputs)||inputs.length!==m.cases.length||new Set(inputs.map(i=>i.familyId)).size!==inputs.length)throw Error('Member input population mismatch');
        const usedRecords=new Set(),usedInputs=new Set();
        for(const c of m.cases){
            const input=inputs.find(i=>i.familyId===c.familyId),inventory=input&&canonicalInventoryHash(input.entries);
            if(c.split!=='train'||input?.split!=='train'||c.seed!==input.seed||c.inputHash!==digest(input)||c.inventoryHash!==inventory||input.inventoryHash!==inventory||usedInputs.has(c.familyId))throw Error('Declared TRAIN input/inventory/split commitment mismatch');
            usedInputs.add(c.familyId);
            for(const [kind,value] of Object.entries({family:c.familyId,seed:c.seed,inventory})){
                if(seen[kind].has(value)||excluded[kind].has(value))throw Error('TRAIN union/excluded cohort '+kind+' collision');seen[kind].add(value);
            }
            const attempts=checkpoint.cases[c.familyId]??[],rows=[];let qualified=0;
            for(const a of attempts){
                if(a.status==='running')throw Error('Union member has active attempt');
                let qualification={qualified:false,reasons:['NO_COMPLETED_RAW_RESULT'],score:null};
                if(a.resultPath){
                    const matches=sources.records.map((r,index)=>({r,index})).filter(({r})=>r.input.familyId===c.familyId&&r.attempt===a.attempt&&r.resultPath===a.resultPath);
                    if(matches.length!==1)throw Error('Missing or duplicated original attempt record');
                    const {r,index}=matches[0];if(usedRecords.has(index)||r.resultHash!==a.resultHash||digest(r.outcome)!==a.resultHash||digest(r.input)!==c.inputHash||r.outcome.status!==a.status)throw Error('Original attempt/raw record commitment mismatch');
                    usedRecords.add(index);qualification=qualifyEnvelope(r.input,r.outcome,'train');
                    if(qualification.qualified)qualified++;
                }
                rows.push({originalAttempt:structuredClone(a),status:a.status,score:qualification.qualified?qualification.score:null,qualified:qualification.qualified,reasons:qualification.reasons});
            }
            if(qualified>1)throw Error('Multiple qualified attempts require explicit selection, not duplicate training weights');
            declarations.push({memberIndex,sourceManifestHash:digest(m),declaration:structuredClone(c),familyId:c.familyId,inventoryHash:inventory,qualified:qualified===1,attempts:rows});
        }
        if(usedRecords.size!==sources.records.length||Object.keys(checkpoint.cases).some(id=>!usedInputs.has(id)))throw Error('Undeclared original source record/attempt');
        boundMembers.push({directory,manifest:structuredClone(m),manifestHash:digest(m),checkpoint:structuredClone(checkpoint),checkpointHash:digest(checkpoint),sourceRecordsHash:digest(sources),sourceCompatibility:compatibility,pending:structuredClone(sources.pending),declaredFamilies:m.cases.length});
    }
    const allAttempts=declarations.flatMap(c=>c.attempts);
    return {schemaVersion:1,kind:'independent-full-train-union-plan-v1',trainingExecutable:false,purpose:'train',referenceIdentity,sourceTransition,trainingSourceHash:trainingProvenance.sourceHash,members:boundMembers,excludedInputsHash:digest(excludedInputs),excludedFamilyCount:excludedInputs.length,cases:declarations,accounting:{declaredFamilies:declarations.length,qualifiedFamilies:declarations.filter(c=>c.qualified).length,declaredAttempts:allAttempts.length,failedAttempts:allAttempts.filter(a=>a.status!=='completed').length,unqualifiedFamilies:declarations.filter(c=>!c.qualified).length},scope:'Descriptor only. Envelope qualification is not new-mode exact replay. Original per-member manifests/checkpoints and every attempt remain bound. No executable dataset, numerical updates, implicit resampling or parity.',parity:false};
}
