/** Pure membership checks. Filesystem/original teacher/source authentication remains mandatory. */
import { digest } from './state.mjs';
import { verifyProducerReplayRecord } from './policy-replay-contract.mjs';
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const equal = (a, b, message) => requireThat(digest(a) === digest(b), message + ' mismatch');
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
export function verifyPreparedUnionMembership(dataset, sources) {
    requireThat(sources.kind === 'independent-full-train-union-v1' && sources.purpose === 'train' && dataset.purpose === 'train' && dataset.referenceContract === null && !dataset.producerReplayProofHash, 'Unsupported synthetic union population');
    requireThat(Array.isArray(sources.members) && sources.members.length >= 2 && Array.isArray(dataset.records), 'Missing union member populations');
    requireThat(new Set(dataset.records.map(r => r.familyId)).size === dataset.records.length, 'Duplicate union family');
    requireThat(dataset.records.every(r => Number.isSafeInteger(r.sourceMemberIndex) && r.sourceMemberIndex >= 0 && r.sourceMemberIndex < sources.members.length && r.originalSplit === 'train' && r.input?.split === 'train'), 'Invalid TRAIN union member index or split');
    for (const [index, member] of sources.members.entries()) {
        const sources = member.sources, proof = sources.producerReplay, records = dataset.records.filter(r => r.sourceMemberIndex === index);
        requireThat(Array.isArray(proof?.records) && proof.records.length > 0 && new Set(proof.records.map(r => r.familyId)).size === proof.records.length, 'Missing or duplicate independent union proof');
        const expected = proof.records.map(r => r.familyId).sort();
        equal(sources.teacherManifest.cases.map(r => r.familyId).sort(), expected, 'Union complete declared original cohort');
        equal(records.map(r => r.familyId).sort(), expected, 'Union complete prepared member cohort');
        for (const record of records) {
            requireThat(record.sourceManifestHash === sources.teacherManifestHash, 'Union record original manifest mismatch');
            const matches = sources.records.filter(r => r.input?.familyId === record.familyId && r.resultHash === record.teacherRecordHash);
            requireThat(matches.length === 1, 'Union exact raw teacher unavailable');
            equal(record.input, matches[0].input, 'Union exact raw input');
            const partial = verifyProducerReplayRecord(proof, record.input, matches[0].outcome, record);
            equal(record.producerReplay, partial, 'Union independently replayed record partial');
        }
    }
}
export function verifyMigrationParentMembership({ parentDataset, childDataset, parentReplay, childReplay }) {
    requireThat(parentDataset.purpose === 'train' && childDataset.purpose === 'train' && parentDataset.records.length > 0, 'Migration requires actual TRAIN populations');
    const parentProof = parentReplay?.proof, childProof = childReplay?.proof;
    requireThat(parentProof && childProof && parentReplay.proofHash === digest(parentProof) && childReplay.proofHash === digest(childProof), 'Migration needs both authenticated original producer proofs');
    equal(omit(childProof, ['preparationJobHash', 'preparationOutcomeHash']), omit(parentProof, ['preparationJobHash', 'preparationOutcomeHash']), 'Migration unchanged original parent producer');
    const records = childDataset.records.filter(r => r.sourceMemberIndex === 0), parentFamilies = parentDataset.records.map(r => r.familyId).sort();
    requireThat(new Set(parentFamilies).size === parentFamilies.length, 'Duplicate parent TRAIN family');
    equal(records.map(r => r.familyId).sort(), parentFamilies, 'Migration complete parent member zero');
    for (const record of records) {
        const parent = parentDataset.records.find(r => r.familyId === record.familyId), originals = childProof.records.filter(r => r.familyId === record.familyId);
        requireThat(originals.length === 1 && record.input?.split === 'train', 'Missing original migration family');
        equal(omit(record, ['policyMode', 'producerReplay', 'actionIds', 'sourceMemberIndex', 'sourceManifestHash']), omit(parent, ['policyMode', 'producerReplay', 'actionIds', 'sourceMemberIndex', 'sourceManifestHash']), 'Migration exact parent input/teacher/native semantics');
        const partial = { producerActionIdsHash: digest(originals[0].actionIds), producerSemanticHash: originals[0].teacherSemanticHash };
        equal(parent.producerReplay, { producerReplayProofHash: parentReplay.proofHash, ...partial }, 'Migration parent original replay partial');
        equal(record.producerReplay, { producerReplayProofHash: childReplay.proofHash, ...partial }, 'Migration member original replay partial');
    }
    return { parentMemberIndex: 0, parentDatasetHash: digest(parentDataset), newDatasetHash: digest(childDataset), parentFamilyCount: parentFamilies.length, additionalFamilies: childDataset.records.length - parentFamilies.length, preservedFamilyIds: parentFamilies };
}
