/** Independent same-feature continuation checks. Caller must authenticate both raw runs and ancestor files. */
import { digest } from './state.mjs';
import { FEATURE_MIGRATION_CONTRACT as C, FEATURE_MIGRATION_SOURCE_PAIRS as featureSources, FEATURE_MIGRATION_ID, ALIGNED_SOURCE_TRANSITION } from './feature-migration-contract.mjs';
import { inspectPolicyBinary } from './parity-report-migration.mjs';
const ID = 'aligned-union-native-cover-continuation-v1', MODE = 'latest-native-group-cover-v3', TRANSITION = 'latest-default-to-aligned-group-cover-v4';
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const equal = (a, b, message) => requireThat(digest(a) === digest(b), message + ' mismatch');
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const binding = (manifest, dataset) => ({ datasetHash: digest(dataset), sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, featureManifestHash: dataset.featureManifestHash, ...manifest.config, ...(manifest.lineage ? { lineageHash: digest(manifest.lineage) } : {}) });
export function verifyAlignedContinuationEvidence({ lineage, manifest, dataset, parentManifest, parentState, parentDataset, parentDirectory, initialBytes, parentBytes, features, parentFeatures, parentReplays, childReplays, parentMigration, groupHelper }) {
    requireThat(lineage?.spec?.mode === 'aligned-continuation' && lineage.spec.continuationId === ID && parentManifest.lineage?.spec?.mode === 'feature-migration', 'Only direct migrated TRAIN continuation supported');
    equal(manifest.lineage, lineage, 'Continuation manifest lineage');
    const previous = parentManifest.config, current = manifest.config;
    requireThat(previous.purpose === 'train' && current.purpose === 'train' && previous.policyMode === 'latest-warmup-runorder-v2' && previous.sourceTransition === ALIGNED_SOURCE_TRANSITION && previous.featureMigration === FEATURE_MIGRATION_ID && !previous.continuationId && current.policyMode === MODE && current.sourceTransition === TRANSITION && current.continuationId === ID && current.featureMigration === FEATURE_MIGRATION_ID, 'Unsupported continuation policy/configuration');
    equal(omit(current, ['policyMode', 'sourceTransition', 'continuationId']), omit(previous, ['policyMode', 'sourceTransition']), 'Continuation immutable numerical/full population configuration');
    equal(digest(features), C.newManifestSha256, 'Continuation complete feature definitions'); equal(features, parentFeatures, 'Continuation unchanged parent features');
    requireThat(parentDataset.featureManifestHash === C.newHash && dataset.featureManifestHash === C.newHash && parentDataset.purpose === 'train' && dataset.purpose === 'train' && parentDataset.policyMode === previous.policyMode && dataset.policyMode === MODE, 'Continuation exact feature/population identity');
    const unionIdentity = data => {
        requireThat(data.sourceUnion?.kind === 'independent-full-train-union-v1' && data.sourceUnion.declaredFamilies === 24 && data.sourceUnion.members?.length === 2, 'Continuation needs the complete independent24 union');
        return { ...omit(data.sourceUnion, ['planHash', 'members']), members: data.sourceUnion.members.map(m => omit(m, ['sourceRecordsHash', 'producerReplayProofHash'])) };
    };
    equal(unionIdentity(dataset), unionIdentity(parentDataset), 'Continuation original members/exclusions');
    equal(omit(dataset, ['policyMode', 'sourceRecordsHash', 'sourceUnion', 'records']), omit(parentDataset, ['policyMode', 'sourceRecordsHash', 'sourceUnion', 'records']), 'Continuation preserved dataset contract');
    requireThat(parentDataset.records.length === 24 && dataset.records.length === 24 && new Set(parentDataset.records.map(r => r.familyId)).size === 24, 'Continuation complete unique24 families');
    equal(dataset.records.map(r => r.familyId), parentDataset.records.map(r => r.familyId), 'Continuation ordered family curriculum');
    requireThat(parentReplays?.length === 2 && childReplays?.length === 2, 'Continuation independent member proof chains missing');
    for (let i = 0; i < 2; i++) {
        const before = parentReplays[i], after = childReplays[i];
        requireThat(before?.proof && after?.proof && before.proofHash === digest(before.proof) && after.proofHash === digest(after.proof), 'Continuation original replay evidence mismatch');
        equal(omit(after.proof, ['preparationJobHash', 'preparationOutcomeHash']), omit(before.proof, ['preparationJobHash', 'preparationOutcomeHash']), 'Continuation unchanged original proof population');
    }
    const preserved = parentDataset.records.map((record, index) => {
        const next = dataset.records[index], member = record.sourceMemberIndex;
        requireThat([0, 1].includes(member) && record.input?.split === 'train' && next.input?.split === 'train' && record.policyMode === previous.policyMode && next.policyMode === MODE, 'Continuation TRAIN member policy mismatch');
        equal(omit(next, ['policyMode', 'actionIds', 'producerReplay']), omit(record, ['policyMode', 'actionIds', 'producerReplay']), 'Continuation exact input/teacher/member/native semantics');
        for (const [candidate, evidence] of [[record, parentReplays[member]], [next, childReplays[member]]]) {
            const originals = evidence.proof.records.filter(r => r.familyId === record.familyId);
            requireThat(originals.length === 1 && originals[0].inputHash === digest(record.input) && originals[0].teacherRecordHash === record.teacherRecordHash && originals[0].teacherSemanticHash === record.teacherSemanticHash, 'Continuation original replay family identity mismatch');
            equal(candidate.producerReplay, { producerReplayProofHash: evidence.proofHash, producerActionIdsHash: digest(originals[0].actionIds), producerSemanticHash: originals[0].teacherSemanticHash }, 'Continuation original replay record partial');
        }
        return { familyId: record.familyId, sourceMemberIndex: member, sourceManifestHash: record.sourceManifestHash, inputHash: digest(record.input), teacherRecordHash: record.teacherRecordHash, teacherSemanticHash: record.teacherSemanticHash };
    });
    const members = [0, 1].map(index => ({ index, families: preserved.filter(r => r.sourceMemberIndex === index).length }));
    requireThat(members[0].families === 8 && members[1].families === 16, 'Continuation requires exact8+16 membership');
    const population = { parentDatasetHash: digest(parentDataset), datasetHash: digest(dataset), families: 24, members, unionIdentityHash: digest(unionIdentity(parentDataset)), preserved };
    const oldSource = parentManifest.provenance, newSource = manifest.provenance;
    for (const source of [oldSource, newSource]) {
        equal(source.sourceHash, digest(source.sourceHashes), 'Continuation aggregate frozen source');
        for (const [path, pair] of Object.entries(featureSources)) equal(source.sourceHashes[path], pair.next, 'Continuation reviewed feature source');
        equal(source.sourceHashes[C.migrationModule], C.migrationModuleHash, 'Continuation inherited migrator implementation');
    }
    requireThat(groupHelper?.path === 'src/optimizer/neural/fullGroupCoverage.ts' && /^[a-f0-9]{64}$/.test(groupHelper.sha256) && groupHelper.sha256 !== '0'.repeat(64), 'Unreviewed group-cover source pin');
    equal(newSource.sourceHashes[groupHelper.path], groupHelper.sha256, 'Continuation exact group-cover dependency');
    const allowed = new Set(['src/optimizer/neural/fullActionSpace.ts', 'src/optimizer/neural/fullTransitions.ts', 'src/optimizer/neural/fullTeacherTraces.ts', 'src/optimizer/neural/fullDecode.ts']), actionDrifts = [];
    for (const [path, hash] of Object.entries(oldSource.sourceHashes).filter(([path]) => path.startsWith('src/'))) {
        const next = newSource.sourceHashes[path]; requireThat(next, 'Continuation dropped frozen source');
        if (next !== hash) { requireThat(allowed.has(path), 'Continuation changed immutable source'); actionDrifts.push({ path, parentHash: hash, sourceHash: next }); }
    }
    requireThat(Object.keys(newSource.sourceHashes).filter(path => path.startsWith('src/') && !oldSource.sourceHashes[path]).every(path => path === groupHelper.path), 'Continuation added unreviewed dependency');
    equal(parentState.binding, binding(parentManifest, parentDataset), 'Continuation parent checkpoint full binding');
    requireThat(parentState.pendingEvaluation === null && parentState.cursor.family === 0 && parentState.cursor.action === 0, 'Continuation requires completed outer boundary');
    requireThat(Buffer.from(initialBytes).equals(Buffer.from(parentBytes)) && digest(initialBytes) === parentState.modelHash, 'Continuation changed learned parent binary');
    const parsed = inspectPolicyBinary(initialBytes, { ...features, manifestHash: C.newHash }), metadata = parsed.header.metadata;
    requireThat(parsed.header.hiddenSize === current.hiddenSize && metadata.seed === current.seed && metadata.optimizerVersion === current.optimizer && metadata.trainingUpdates === parentState.cursor.updates && !Object.hasOwn(metadata, 'resume'), 'Continuation learned header/counter/numerics mismatch');
    const model = { modelHash: parsed.modelHash, byteLength: initialBytes.length, headerHash: digest(parsed.header), featureManifestHash: C.newHash, hiddenSize: parsed.header.hiddenSize, seed: metadata.seed, trainingUpdates: metadata.trainingUpdates, optimizer: metadata.optimizerVersion, exactBinary: true, headerReset: false, featureMigrationExecuted: false, outerCursor: { epoch: 0, family: 0, action: 0, updates: metadata.trainingUpdates }, newTrainingUpdates: 0 };
    const inheritedMigration = { receiptHash: parentMigration.receiptHash, manifestHash: digest(parentManifest), lineageHash: digest(parentManifest.lineage), datasetHash: digest(parentDataset), sourceHash: oldSource.sourceHash, bundleHash: oldSource.bundleHash, oldModelHash: parentMigration.originalModelHash, migratedModelHash: parentMigration.migratedModelHash, initialTrainingUpdates: parentMigration.inheritedTrainingUpdates };
    equal(parentState.initializationProofHash, inheritedMigration.receiptHash, 'Continuation parent migration checkpoint proof');
    requireThat(Number.isSafeInteger(inheritedMigration.initialTrainingUpdates) && inheritedMigration.initialTrainingUpdates >= 0 && metadata.trainingUpdates >= inheritedMigration.initialTrainingUpdates, 'Continuation migration counter regressed');
    if (metadata.trainingUpdates === inheritedMigration.initialTrainingUpdates) equal(model.modelHash, inheritedMigration.migratedModelHash, 'Untrained continuation initialization');
    equal(lineage.continuation, { id: ID, parentFeatureManifestHash: digest(features), parentNumericalConfig: Object.fromEntries(['optimizer', 'learningRate', 'hiddenSize', 'seed', 'chunkSize'].map(key => [key, previous[key]])), inheritedMigration: { directory: parentDirectory, manifestHash: inheritedMigration.manifestHash, lineageHash: inheritedMigration.lineageHash, receiptHash: inheritedMigration.receiptHash } }, 'Continuation exact inherited lineage declaration');
    const parent = { manifestHash: digest(parentManifest), modelHash: parentState.modelHash, sourceHash: oldSource.sourceHash, bundleHash: oldSource.bundleHash, datasetHash: digest(parentDataset), featureManifestHash: C.newHash, purpose: 'train', cursor: parentState.cursor };
    for (const [key, value] of Object.entries(parent)) equal(lineage.parent[key], value, 'Continuation original parent commitment');
    equal(lineage.initialModelHash, parent.modelHash, 'Continuation original learned initialization');
    return { schemaVersion: 1, kind: ID, policyMode: MODE, sourceTransition: TRANSITION, lineageHash: digest(lineage), featureManifestHash: digest(features), parent: { ...parent, stateHash: digest(parentState) }, model, population, sources: { parentSourceHash: oldSource.sourceHash, sourceHash: newSource.sourceHash, bundleHash: newSource.bundleHash, actionDrifts, addedDependencies: [groupHelper] }, inheritedMigration, newTrainingUpdates: 0 };
}

/** Initial migration's zero rows do not constrain subsequently learned continuation parameters. */
export function verifyContinuationCheckpointState(state, receipt) {
    requireThat(receipt?.kind === ID && receipt.policyMode === MODE && receipt.sourceTransition === TRANSITION, 'Unsupported continuation checkpoint receipt');
    equal(state.initializationProofHash, digest(receipt), 'TRAIN checkpoint continuation initialization proof');
    const initial = receipt.model?.trainingUpdates;
    requireThat(Number.isSafeInteger(initial) && initial >= 0 && Number.isSafeInteger(state.cursor?.updates) && state.cursor.updates >= initial, 'Continuation update counter regressed');
    if (state.cursor.updates === initial) {
        equal(state.modelHash, receipt.model.modelHash, 'Zero-new-update continuation exact learned parameters');
        equal(state.cursor, receipt.model.outerCursor, 'Zero-new-update continuation outer cursor');
    }
}
