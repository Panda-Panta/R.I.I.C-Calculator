/** Executable source contract for explicitly named, independently proven full TRAIN populations. */
import {basename,isAbsolute} from 'node:path';
import {digest} from './state.mjs';
import {planFullTrainingUnion} from './full-source-union.mjs';
import {verifyProducerReplayRecord} from './policy-replay-contract.mjs';
export const FULL_UNION_KIND='independent-full-train-union-v1';
export function validateFullUnionDefinition(definition){
    if(definition?.schemaVersion!==1||definition.kind!=='independent-full-train-union-definition-v1'||definition.purpose!=='train'||!/^[\w-]+$/.test(definition.name??'')||!Array.isArray(definition.members)||definition.members.length<2||!Array.isArray(definition.excludedSources))throw Error('Invalid explicit full union definition');
    const names=new Set();for(const m of definition.members){if(!/^[\w-]+$/.test(m.source??'')||names.has(m.source)||!isAbsolute(m.producerReplayDirectory??''))throw Error('Invalid/duplicate full union member');names.add(m.source);}
    for(const source of definition.excludedSources){if(!/^[\w-]+$/.test(source)||names.has(source))throw Error('Invalid/overlapping full union exclusion');names.add(source);}
    return definition;
}
export function composeFullTrainingUnion(members,{definition,excludedCohorts,trainingProvenance,sourceTransition}){
    validateFullUnionDefinition(definition);
    if(members.length!==definition.members.length||excludedCohorts.length!==definition.excludedSources.length)throw Error('Full union member/exclusion definition count mismatch');
    const excludedInputs=[];
    for(const[i,c]of excludedCohorts.entries()){
        if(basename(c.directory)!==definition.excludedSources[i]||c.manifestHash!==digest(c.manifest)||c.inputs.length!==c.manifest.cases.length)throw Error('Full union excluded source commitment mismatch');
        const seen=new Set();for(const input of c.inputs){const declared=c.manifest.cases.find(d=>d.familyId===input.familyId);if(!declared||seen.has(input.familyId)||declared.split!=='dev'||input.split!=='dev'||declared.inputHash!==digest(input))throw Error('Full union excluded input commitment mismatch');seen.add(input.familyId);excludedInputs.push(input);}
    }
    for(const[i,m]of members.entries()){
        if(basename(m.directory)!==definition.members[i].source||!m.sources.producerReplay||m.sources.producerReplay.producerDirectory!==definition.members[i].producerReplayDirectory)throw Error('Full union member independent proof/directory mismatch');
        const proof=m.sources.producerReplay,seen=new Set();
        for(const r of proof.records){if(seen.has(r.familyId))throw Error('Duplicate original proof family');seen.add(r.familyId);const source=m.sources.records.find(s=>s.input.familyId===r.familyId&&digest(s.outcome)===r.teacherRecordHash);if(!source)throw Error('Full union original proof/raw source mismatch');verifyProducerReplayRecord(proof,source.input,source.outcome);}
    }
    const plan=planFullTrainingUnion(members,{trainingProvenance,sourceTransition,excludedInputs});
    if(plan.accounting.qualifiedFamilies!==plan.accounting.declaredFamilies)throw Error('Executable full union requires complete qualified declarations; a partial phase needs a separately authorized contract, never hidden omission');
    for(const[index,member]of members.entries()){
        const expected=plan.cases.filter(c=>c.memberIndex===index&&c.qualified).map(c=>c.familyId).sort(),actual=member.sources.producerReplay.records.map(r=>r.familyId).sort();
        if(digest(expected)!==digest(actual))throw Error('Full union original proof population must equal complete qualified member declarations');
    }
    const compatibility=members[0].sources.sourceCompatibility;
    if(members.some(m=>digest(m.sources.sourceCompatibility)!==digest(compatibility)))throw Error('Full union incompatible member source contracts');
    return {schemaVersion:4,kind:FULL_UNION_KIND,purpose:'train',teacherKind:'full-optimizer',definition:structuredClone(definition),definitionHash:digest(definition),trainingProvenance:structuredClone(trainingProvenance),sourceCompatibility:compatibility,members:structuredClone(members),excludedCohorts:structuredClone(excludedCohorts),unionPlan:plan,records:members.flatMap((m,sourceMemberIndex)=>m.sources.records.map(r=>({...r,sourceMemberIndex}))),pending:members.flatMap((m,sourceMemberIndex)=>m.sources.pending.map(p=>({...p,sourceMemberIndex}))),cohortAccounting:plan.accounting,scope:'Explicit full TRAIN union; independent original member manifests and producer replay retained, no synthetic teacher manifest'};
}
export function verifyFullTrainingUnion(sources){
    if(sources?.kind!==FULL_UNION_KIND)throw Error('Expected explicit full union source kind');
    const reconstructed=composeFullTrainingUnion(sources.members,{definition:sources.definition,excludedCohorts:sources.excludedCohorts,trainingProvenance:sources.trainingProvenance,sourceTransition:sources.sourceCompatibility.policy});
    if(digest(reconstructed)!==digest(sources))throw Error('Full union complete source commitment mismatch');
    return sources;
}
export function fullUnionDatasetContract(sources){
    return {kind:FULL_UNION_KIND,definitionHash:digest(sources.definition),planHash:digest(sources.unionPlan),declaredFamilies:sources.unionPlan.accounting.declaredFamilies,members:sources.members.map((m,index)=>({index,directory:m.directory,teacherManifestHash:m.sources.teacherManifestHash,sourceRecordsHash:digest(m.sources),checkpointHash:digest(m.checkpoint),producerReplayProofHash:digest(m.sources.producerReplay),originalDatasetHash:m.sources.producerReplay.archivedDatasetHash,declaredFamilies:m.sources.teacherManifest.cases.length,qualifiedOriginalFamilies:m.sources.producerReplay.records.length})),excludedCohortsHash:digest(sources.excludedCohorts)};
}
