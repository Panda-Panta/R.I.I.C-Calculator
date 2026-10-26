/** Explicit completed-family retry union. Never mutates the parent or admits candidate snapshots. */
import { digest } from './state.mjs';
export function mergeLinkedAuxiliarySources(parent, retry, parentCheckpoint) {
    const pm = parent.teacherManifest, rm = retry.teacherManifest, lineage = rm?.lineage;
    for (const source of [parent, retry])
        if (source.teacherKind !== 'molecular-simulated' || source.purpose !== 'train' || source.teacherManifest?.sourceKind !== 'molecular-simulated' || source.teacherManifest?.purpose !== 'training' || source.teacherManifestHash !== digest(source.teacherManifest))
            throw Error('Linked sources require explicitly bound molecular TRAIN manifests');
    if (!lineage || lineage.parentManifestHash !== digest(pm) || lineage.parentCheckpointHash !== digest(parentCheckpoint) || lineage.parentSourceHash !== pm.provenance.sourceHash || lineage.parentBundleHash !== pm.provenance.bundleHash || lineage.sameInput !== true || lineage.sameFamilies !== true)
        throw Error('Linked retry parent provenance mismatch');
    if (parentCheckpoint.manifestHash !== digest(pm))
        throw Error('Parent checkpoint manifest mismatch');
    const expectedFamilies = new Set();
    for (const c of rm.cases) {
        if (expectedFamilies.has(c.familyId))
            throw Error('Duplicate linked family');
        expectedFamilies.add(c.familyId);
        const original = pm.cases.find(p => p.familyId === c.familyId);
        if (!original || original.inputHash !== c.inputHash || original.inventoryHash !== c.inventoryHash || original.seed !== c.seed)
            throw Error('Linked retry changed family/input/seed');
        const attempts = parentCheckpoint.cases[c.familyId] ?? [], attempt = attempts.find(a => a.resultPath === c.parentResultPath && a.resultHash === c.parentResultHash);
        if (!attempt || digest(attempt) !== c.parentAttemptHash)
            throw Error('Linked retry parent attempt mismatch');
        const record = parent.records.find(r => r.resultPath === c.parentResultPath && r.resultHash === c.parentResultHash);
        if (!record || digest(record.outcome) !== c.parentResultHash || record.outcome.completed === true)
            throw Error('Linked retry must retain its failed parent family result');
    }
    for (const r of retry.records) {
        const c = rm.cases.find(c => c.familyId === r.input.familyId);
        if (!c || digest(r.input) !== c.inputHash || digest(r.outcome) !== r.resultHash)
            throw Error('Linked retry record commitment mismatch');
    }
    const records = [...parent.records.map(r => ({ ...r, sourceManifest: pm, sourceManifestHash: digest(pm), sourceCompatibility: parent.sourceCompatibility })), ...retry.records.map(r => ({ ...r, sourceManifest: rm, sourceManifestHash: digest(rm), sourceCompatibility: retry.sourceCompatibility }))];
    const completed = new Set();
    for (const r of records)
        if (r.outcome.completed === true) {
            if (completed.has(r.input.familyId))
                throw Error('Conflicting completed family retries; explicit selection required');
            completed.add(r.input.familyId);
        }
    return { ...parent, schemaVersion: 3, linkedSourceManifests: [rm], linkedSourceManifestHashes: [digest(rm)], linkedSourceCompatibilities: [retry.sourceCompatibility], parentCheckpointHash: digest(parentCheckpoint), cohortAccounting: { originalDeclaredFamilies: pm.cases.length, originalAttempts: parent.records.length, originalCompleted: parent.records.filter(r => r.outcome.completed === true).length, linkedRetryAttempts: retry.records.length, linkedRetryCompleted: retry.records.filter(r => r.outcome.completed === true).length, finalCompletedFamilies: completed.size }, records, pending: [...parent.pending, ...retry.pending], scope: 'Explicit linked auxiliary TRAIN union; original failures retained; no full baseline/parity eligibility' };
}
