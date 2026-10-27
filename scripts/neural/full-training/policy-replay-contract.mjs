import {verifyPolicyForkModeBinding,POLICY_FORK_SOURCE_TRANSITION} from './aligned-policy-fork-contract.mjs';
import {GROUP_COVER_SOURCE_TRANSITION} from './aligned-continuation-contract.mjs';
/** Pure evidence checks shared by replay preparation and numerical workers. */
import {digest} from './state.mjs';
import {isLatestPolicyMode,verifyLatestPolicyTransition} from './source-compatibility.mjs';
import {FEATURE_MIGRATION_CONTRACT,FEATURE_MIGRATION_ID,ALIGNED_SOURCE_TRANSITION} from './feature-migration-contract.mjs';
import {FULL_UNION_KIND,verifyFullTrainingUnion,fullUnionDatasetContract} from './full-union-contract.mjs';
import {referenceManifestContract} from '../full-baseline/reference-protocol.mjs';
const originalMode='legacy-unconstrained-v1';
export function verifyProducerReplayRecord(proof,input,outcome,reconstructed) {
    if(proof?.kind!=='frozen-full-reference-replay-v1'||proof.mode!=='prepare-only-zero-training-zero-simulation'||proof.policyMode!==originalMode||proof.archivedDatasetHash!==proof.replayedDatasetHash)
        throw Error('Missing independent frozen producer replay proof');
    const records=proof.records?.filter(r=>r.familyId===input.familyId);
    if(records?.length!==1)throw Error('Missing or duplicate original producer replay family');
    const record=records[0];
    if(record.inputHash!==digest(input)||record.teacherRecordHash!==digest(outcome)||!Array.isArray(record.actionIds)||!record.actionIds.length)
        throw Error('Original producer replay input/teacher commitment mismatch');
    if(reconstructed&&record.teacherSemanticHash!==reconstructed.teacherSemanticHash)
        throw Error('New policy changed original teacher semantic workspace');
    return {producerReplayProofHash:digest(proof),producerActionIdsHash:digest(record.actionIds),producerSemanticHash:record.teacherSemanticHash};
}
export function verifyPreparedPolicyDataset(dataset,sources,binding) {
    if(binding)verifyPolicyForkModeBinding(binding);
    if(sources?.kind===FULL_UNION_KIND){
        verifyFullTrainingUnion(sources);
        if(dataset.sourceRecordsHash!==digest(sources)||digest(dataset.sourceUnion)!==digest(fullUnionDatasetContract(sources)))throw Error('Prepared full union source/member contract mismatch');
        for(const record of dataset.records)if(!Number.isSafeInteger(record.sourceMemberIndex)||!sources.members[record.sourceMemberIndex]||record.sourceManifestHash!==sources.members[record.sourceMemberIndex].sources.teacherManifestHash)throw Error('Prepared full union record member mismatch');
        for(const[index,member]of sources.members.entries())verifyPreparedPolicyDataset({...dataset,sourceUnion:undefined,sourceRecordsHash:digest(member.sources),producerReplayProofHash:digest(member.sources.producerReplay),records:dataset.records.filter(r=>r.sourceMemberIndex===index)},member.sources,binding);
        const contracts=sources.members.map((m,index)=>referenceManifestContract(m.sources.teacherManifest,dataset.records.filter(r=>r.sourceMemberIndex===index).map(r=>r.input)));
        if(dataset.referenceContract!==null||digest(dataset.referenceContracts)!==digest(contracts))throw Error('Prepared full union separate reference contracts mismatch');
        return;
    }
    const policyMode=dataset.policyMode??originalMode;
    if(policyMode===originalMode)return;
    if(!isLatestPolicyMode(policyMode))throw Error('Unknown latest dataset policy mode');
    const proof=sources?.producerReplay;
    if (!proof||dataset.producerReplayProofHash!==digest(proof)||dataset.sourceRecordsHash!==digest(sources)) throw Error('Latest dataset producer replay proof/source commitment mismatch');
    verifyLatestPolicyTransition(policyMode,sources.sourceCompatibility?.policy);
    if(binding&&(binding.policyMode!==policyMode||binding.sourceTransition!==sources.sourceCompatibility?.policy)) throw Error('Latest dataset numerical/job source-transition binding mismatch');
    if([ALIGNED_SOURCE_TRANSITION,GROUP_COVER_SOURCE_TRANSITION,POLICY_FORK_SOURCE_TRANSITION].includes(sources.sourceCompatibility.policy)){
        if(digest(sources.sourceCompatibility.featureMigration)!==digest(FEATURE_MIGRATION_CONTRACT)||digest(dataset.featureMigration??null)!==digest(FEATURE_MIGRATION_CONTRACT)||dataset.featureManifestHash!==FEATURE_MIGRATION_CONTRACT.newHash||proof.featureManifestHash!==FEATURE_MIGRATION_CONTRACT.oldHash||(binding&&binding.featureMigration!==FEATURE_MIGRATION_ID))throw Error('Prepared feature migration contract mismatch');
    }else if(dataset.featureMigration||dataset.featureManifestHash!==proof.featureManifestHash)throw Error('Unexpected prepared feature migration');
    const expected=proof.records.map(r=>r.familyId).sort(),actual=dataset.records.map(r=>r.familyId).sort();
    if (digest(expected)!==digest(actual)) throw Error('Latest policy cannot silently change qualified producer cohort');
    for (const record of dataset.records) {
        if (record.policyMode!==policyMode) throw Error('Latest dataset record policy mismatch');
        const source=sources.records.find(r=>r.input.familyId===record.familyId&&digest(r.outcome)===record.teacherRecordHash);
        if(!source||digest(source.input)!==digest(record.input)) throw Error('Latest dataset original teacher source mismatch');
        const checked=verifyProducerReplayRecord(proof,source.input,source.outcome,record);
        if(!record.producerReplay||digest(checked)!==digest(record.producerReplay)) throw Error('Latest record producer replay proof mismatch');
    }
}
