/** Independent narrow policy/curriculum-fork checks; caller must authenticate raw runs, original proofs and parent files. */
import { digest } from './state.mjs';
import { FEATURE_MIGRATION_CONTRACT as C, FEATURE_MIGRATION_ID } from './feature-migration-contract.mjs';
import { inspectPolicyBinary } from './parity-report-migration.mjs';
export const REPORT_POLICY_FORK_ID = 'aligned-policy-curriculum-fork-v1', REPORT_POLICY_FORK_MODE = 'latest-native-group-occupants-v4', REPORT_POLICY_FORK_TRANSITION = 'latest-default-to-aligned-group-occupants-v5';
export const REPORT_POLICY_FORK_PARENT = Object.freeze({ modelHash: '39b47bd3856c4e70c2b9a530696abe7a4f8ef51e3e7baf522fd7f35150cd9a19', updates: 248335, stateHash: 'ae5110baf24d4cc1235b3e563d4b009d2d00791da5456fb43298cc7c4d88954b', manifestHash: 'c2e303472094203264ebf8a9e8d701ec641fba0675e996443dc408baaa741ddb', continuationHash: '8d81eb6584a92353459ecb5cce7d39ba4b0cba5887e25d7b8f5bd7b71e3238a8', migrationHash: 'e645aa4a673b3105f7a65aa098af9b1cd0f6edbaea0f0b476df68436db5c4e24' });
export const REPORT_POLICY_FORK_ACTION_PAIRS = Object.freeze({
    'src/optimizer/neural/fullActionSpace.ts': { parent: '328c48d6799e770f1e10b93c2668c9007c3bf5f013e6fbe61ac5540cdcea2d00', child: '3ae4f70bc5f34895622cb25dfd7cc05fe45f345c96265f4f2c30baf735e8b754' },
    'src/optimizer/neural/fullTransitions.ts': { parent: 'f2c42db9bf47f3190e9065b1e87b3490ff6df63bb654a5f993cb9a3c205c7686', child: '5cfe11c1ed25adb20e1a7459f92a6b11f9261d5f07642404e29af9a77922cc44' },
});
const ID = REPORT_POLICY_FORK_ID, MODE = REPORT_POLICY_FORK_MODE, TRANSITION = REPORT_POLICY_FORK_TRANSITION, P = REPORT_POLICY_FORK_PARENT;
const need = (condition, message) => { if (!condition) throw Error(message); }, equal = (a, b, message) => need(digest(a) === digest(b), message + ' mismatch');
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
export function verifyPolicyForkConfigurationEvidence(parent, child) {
    need(parent.purpose === 'train' && child.purpose === 'train' && parent.policyMode === 'latest-native-group-cover-v3' && parent.sourceTransition === 'latest-default-to-aligned-group-cover-v4' && parent.continuationId === 'aligned-union-native-cover-continuation-v1' && !parent.policyForkId && child.policyMode === MODE && child.sourceTransition === TRANSITION && child.policyForkId === ID && !child.continuationId && parent.featureMigration === FEATURE_MIGRATION_ID && child.featureMigration === FEATURE_MIGRATION_ID && parent.learningRate === .01 && child.learningRate === .003 && parent.hiddenSize === 64 && parent.seed === 43 && parent.chunkSize === 512 && parent.optimizer === 'common-l2-sgd-v1' && parent.fullSourceUnion && child.fullSourceUnion && parent.teacherKind === 'full-optimizer', 'Unsupported explicit policy/curriculum fork');
    equal(omit(child, ['source', 'fullSourceUnion', 'learningRate', 'policyMode', 'sourceTransition', 'policyForkId']), omit(parent, ['source', 'fullSourceUnion', 'learningRate', 'policyMode', 'sourceTransition', 'continuationId']), 'Policy fork unchanged configuration');
    return { learningRate: { from: .01, to: .003 }, unchanged: { optimizer: child.optimizer, hiddenSize: child.hiddenSize, seed: child.seed, chunkSize: child.chunkSize } };
}
export function verifyPolicyForkPopulationEvidence({ parentDataset: parent, dataset: child, parentReplays, childReplays, parentSources, childSources }) {
    need(parent.purpose === 'train' && child.purpose === 'train' && parent.policyMode === 'latest-native-group-cover-v3' && child.policyMode === MODE && parent.featureManifestHash === C.newHash && child.featureManifestHash === C.newHash && parent.records?.length === 24 && child.records?.length === 40, 'Policy fork needs complete TRAIN24 to40');
    const p = parent.sourceUnion, c = child.sourceUnion;
    need(p?.kind === 'independent-full-train-union-v1' && c?.kind === p.kind && p.declaredFamilies === 24 && c.declaredFamilies === 40 && p.members?.length === 2 && c.members?.length === 3 && parentReplays?.length === 2 && childReplays?.length === 3, 'Policy fork complete independent original populations');
    equal(p.excludedCohortsHash, c.excludedCohortsHash, 'Excluded cohorts'); equal(parentSources.excludedCohorts, childSources.excludedCohorts, 'Actual excluded DEV/calibration artifacts');
    equal(omit(parentSources.definition, ['name', 'members']), omit(childSources.definition, ['name', 'members']), 'Unchanged original union/exclusion definition');
    equal(parentSources.definition.members, childSources.definition.members.slice(0, 2), 'Original producer directory prefix');
    for (let i = 0; i < 2; i++) {
        equal(omit(p.members[i], ['sourceRecordsHash', 'producerReplayProofHash']), omit(c.members[i], ['sourceRecordsHash', 'producerReplayProofHash']), 'Original member identity');
        const a = parentReplays[i], b = childReplays[i]; need(a?.proof && b?.proof && a.proofHash === digest(a.proof) && b.proofHash === digest(b.proof), 'Missing original member replay');
        equal(omit(a.proof, ['preparationJobHash', 'preparationOutcomeHash']), omit(b.proof, ['preparationJobHash', 'preparationOutcomeHash']), 'Complete common original producer proof');
    }
    need(c.members[2].index === 2 && c.members[2].teacherManifestHash === '51d8c58be206546847cfc917db8c9cb40a5def8aa7ee48bb56876ded7c4ebbde' && c.members[2].checkpointHash === 'c39eecee4363158a13ff4c3fcd7d76e24010fe199e40b3cd2a94e8a2bd9505f6' && c.members[2].originalDatasetHash === '9e5e835e2dd30786ec9514e58b581c01bd6f82998541c9a8c414c9f065813bdd', 'Unapproved additional original TRAIN member');
    const extra = childReplays[2]; need(extra?.proof && extra.proofHash === digest(extra.proof), 'Missing additional original proof');
    for (const [key, value] of Object.entries({ producerManifestHash: '6799ebb85a3bcf371c8b2ff123acba2cb262ee0734b532e6ff5bb93b74ffe5c9', producerSourceHash: '93a952c03aa9f0846e89ee1a2807bf31501821358da5f265996e6994c6dce4dc', producerBundleHash: '9d99ce6372423d543b0f51107c2c86200c6ff1469398fce5644f369dd561baa9', archivedDatasetHash: '9e5e835e2dd30786ec9514e58b581c01bd6f82998541c9a8c414c9f065813bdd', replayedDatasetHash: '9e5e835e2dd30786ec9514e58b581c01bd6f82998541c9a8c414c9f065813bdd' })) equal(extra.proof[key], value, 'Exact added original worker/dataset');
    for (const [index, count] of [8, 16, 16].entries()) {
        need(c.members[index].declaredFamilies === count && c.members[index].qualifiedOriginalFamilies === count && child.records.filter(r => r.sourceMemberIndex === index).length === count, 'Incomplete policy fork member');
        const proof = childReplays[index].proof; equal(proof.records.map(r => r.familyId).sort(), child.records.filter(r => r.sourceMemberIndex === index).map(r => r.familyId).sort(), 'Full original proof cohort');
    }
    equal(omit(parent, ['policyMode', 'sourceRecordsHash', 'sourceUnion', 'records', 'referenceContracts']), omit(child, ['policyMode', 'sourceRecordsHash', 'sourceUnion', 'records', 'referenceContracts']), 'Policy fork fixed dataset contract');
    equal(parent.referenceContracts, child.referenceContracts?.slice(0, 2), 'Preserved mathematical references'); need(child.referenceContracts?.length === 3, 'Missing added reference');
    for (const data of [parent, child]) need(new Set(data.records.map(r => r.familyId)).size === data.records.length && data.records.every(r => r.input?.split === 'train' && r.originalSplit === 'train'), 'Duplicate/DEV fork population');
    const partial = (record, replay) => {
        const originals = replay.proof.records.filter(r => r.familyId === record.familyId); need(originals.length === 1, 'Original record missing'); const original = originals[0];
        equal(original.inputHash, digest(record.input), 'Original input'); equal(original.teacherRecordHash, record.teacherRecordHash, 'Original teacher'); equal(original.teacherSemanticHash, record.teacherSemanticHash, 'Original semantics');
        equal(record.producerReplay, { producerReplayProofHash: replay.proofHash, producerActionIdsHash: digest(original.actionIds), producerSemanticHash: original.teacherSemanticHash }, 'Original replay record partial');
    };
    const preserved = parent.records.map((a, i) => {
        const b = child.records[i]; need(a.policyMode === parent.policyMode && b.policyMode === MODE, 'Policy fork record mode');
        equal(omit(a, ['policyMode', 'producerReplay', 'teacherActionAccounting']), omit(b, ['policyMode', 'producerReplay', 'teacherActionAccounting']), 'Exact ordered parent24 action/input/teacher prefix');
        partial(a, parentReplays[a.sourceMemberIndex]); partial(b, childReplays[b.sourceMemberIndex]);
        return { familyId: a.familyId, inputHash: digest(a.input), teacherRecordHash: a.teacherRecordHash, teacherSemanticHash: a.teacherSemanticHash, actionIdsHash: digest(a.actionIds), sourceMemberIndex: a.sourceMemberIndex };
    });
    for (const r of child.records.slice(24)) { need(r.sourceMemberIndex === 2 && r.policyMode === MODE && r.sourceManifestHash === c.members[2].teacherManifestHash, 'Added complete16 suffix'); partial(r, extra); }
    return { parentDatasetHash: digest(parent), datasetHash: digest(child), families: 40, preservedFamilies: 24, additionalFamilies: 16, members: c.members, excludedCohortsHash: c.excludedCohortsHash, preserved, orderedFamilyIds: child.records.map(r => r.familyId) };
}
export function verifyPolicyForkSourceEvidence(parent, child) {
    for (const p of [parent, child]) equal(p.sourceHash, digest(p.sourceHashes), 'Policy fork source map');
    const before = Object.keys(parent.sourceHashes).filter(p => p.startsWith('src/')).sort(), after = Object.keys(child.sourceHashes).filter(p => p.startsWith('src/')).sort(); equal(before, after, 'Exact source dependency population'); const actionDrifts = [];
    for (const path of before) { const pair = REPORT_POLICY_FORK_ACTION_PAIRS[path]; if (pair) { equal(parent.sourceHashes[path], pair.parent, 'Original reviewed action source'); equal(child.sourceHashes[path], pair.child, 'New reviewed action source'); actionDrifts.push({ path, parentHash: pair.parent, sourceHash: pair.child }); } else equal(child.sourceHashes[path], parent.sourceHashes[path], 'Immutable feature/numeric/physics/helper source'); }
    need(actionDrifts.length === 2, 'Both explicit action pairs required'); return actionDrifts;
}
export function verifyPolicyForkAccountingEvidence(dataset, actual) {
    need(Array.isArray(actual) && actual.length === dataset.records.length, 'Actual native teacher replay accounting missing');
    const families = dataset.records.map((r, i) => { const a = actual[i]; need(a?.familyId === r.familyId && ['total', 'forced', 'modelChoice'].every(k => Number.isSafeInteger(a[k]) && a[k] >= 0) && a.total === r.actionIds.length && a.forced + a.modelChoice === a.total, 'Native teacher action accounting'); equal(r.teacherActionAccounting, { total: a.total, forced: a.forced, modelChoice: a.modelChoice }, 'Prepared versus replayed teacher accounting'); return a; });
    return { total: families.reduce((n, r) => n + r.total, 0), forced: families.reduce((n, r) => n + r.forced, 0), modelChoice: families.reduce((n, r) => n + r.modelChoice, 0), families, note: 'Counters include all explicit teacher action steps; singleton-forced choices receive no learned-credit claim' };
}
export function reconstructPolicyForkReceipt(args) {
    const { lineage, manifest, dataset, parentManifest, parentDataset, parentState, initialBytes, parentBytes, features, parentFeatures, parentContinuation, evidenceHash, replayAccounting } = args;
    need(lineage?.spec?.mode === 'aligned-policy-fork' && lineage.spec.policyForkId === ID && parentManifest.lineage?.spec?.mode === 'aligned-continuation', 'Only explicit direct known continuation policy fork supported');
    equal(manifest.lineage, lineage, 'Policy fork manifest lineage'); equal(digest(parentManifest), P.manifestHash, 'Selected official parent manifest'); equal(digest(parentState), P.stateHash, 'Selected official parent state'); equal(digest(parentContinuation), P.continuationHash, 'Original parent continuation'); equal(parentContinuation.inheritedMigration.receiptHash, P.migrationHash, 'Original inherited migration');
    equal(parentState.cursor, { epoch: 10, family: 0, action: 0, updates: P.updates }, 'Selected completed parent cursor'); need(parentState.pendingEvaluation === null, 'Parent gate pending'); equal(parentState.initializationProofHash, P.continuationHash, 'Parent initialization proof');
    need(Buffer.from(initialBytes).equals(Buffer.from(parentBytes)) && digest(initialBytes) === P.modelHash, 'Exact official learned parent bytes required'); equal(parentState.modelHash, P.modelHash, 'Parent checkpoint model'); equal(lineage.initialModelHash, P.modelHash, 'Fork initialization model');
    equal(features, parentFeatures, 'Unchanged complete features'); equal(digest(features), C.newManifestSha256, 'Reviewed aligned features');
    const numericalDelta = verifyPolicyForkConfigurationEvidence(parentManifest.config, manifest.config), population = verifyPolicyForkPopulationEvidence(args), actionDrifts = verifyPolicyForkSourceEvidence(parentManifest.provenance, manifest.provenance), accounting = verifyPolicyForkAccountingEvidence(dataset, replayAccounting);
    need(accounting.total === 13059 && replayAccounting.slice(0, 24).reduce((n, r) => n + r.total, 0) === 7830 && replayAccounting.slice(0, 24).reduce((n, r) => n + r.forced, 0) === 290, 'Exact forty-family step/forced denominator');
    const parsed = inspectPolicyBinary(initialBytes, { ...features, manifestHash: C.newHash }), m = parsed.header.metadata;
    need(parsed.header.hiddenSize === 64 && m.seed === 43 && m.trainingUpdates === P.updates && m.optimizerVersion === 'common-l2-sgd-v1' && !Object.hasOwn(m, 'resume'), 'Exact unchanged learned model metadata');
    const model = { modelHash: parsed.modelHash, byteLength: initialBytes.length, headerHash: digest(parsed.header), featureManifestHash: C.newHash, hiddenSize: parsed.header.hiddenSize, seed: m.seed, trainingUpdates: m.trainingUpdates, optimizer: m.optimizerVersion, exactBinary: true, headerReset: false, featureMigrationExecuted: false, outerCursor: { epoch: 0, family: 0, action: 0, updates: m.trainingUpdates }, newTrainingUpdates: 0 };
    return { schemaVersion: 1, kind: ID, policyMode: MODE, sourceTransition: TRANSITION, lineageHash: digest(lineage), featureManifestHash: digest(features), parent: { ...lineage.parent, stateHash: digest(parentState), evidenceHash }, model, numericalDelta, population, teacherActionAccounting: accounting, sources: { parentSourceHash: parentManifest.provenance.sourceHash, sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, actionDrifts }, ancestry: { parentContinuationReceiptHash: digest(parentContinuation), inheritedMigrationReceiptHash: parentContinuation.inheritedMigration.receiptHash, originalMigrationUpdates: parentContinuation.inheritedMigration.initialTrainingUpdates, continuationInitialUpdates: parentContinuation.model.trainingUpdates }, newTrainingUpdates: 0 };
}
export function verifyPolicyForkCheckpointState(state, receipt) {
    need(receipt?.kind === ID && receipt.policyMode === MODE && receipt.sourceTransition === TRANSITION && receipt.model?.trainingUpdates === P.updates && receipt.model.modelHash === P.modelHash, 'Unsupported policy fork checkpoint receipt');
    equal(state.initializationProofHash, digest(receipt), 'Policy fork checkpoint initialization proof'); need(Number.isSafeInteger(state.cursor?.updates) && state.cursor.updates >= P.updates, 'Policy fork update counter regression');
    const c = state.cursor, lengths = receipt.teacherActionAccounting?.families?.map(r => r.total);
    need(lengths?.length === 40 && lengths.every(n => Number.isSafeInteger(n) && n > 0 && n <= 512) && lengths.reduce((n, v) => n + v, 0) === 13059 && receipt.teacherActionAccounting.total === 13059, 'Policy fork complete action-step denominator');
    need(Number.isSafeInteger(c.epoch) && c.epoch >= 0 && Number.isSafeInteger(c.family) && c.family >= 0 && c.family < 40 && Number.isSafeInteger(c.action) && c.action >= 0 && c.action < lengths[c.family], 'Policy fork curriculum cursor');
    equal(c.updates, P.updates + c.epoch * 13059 + lengths.slice(0, c.family).reduce((n, v) => n + v, 0) + c.action, 'Policy fork cumulative/outer step relation');
    if (state.cursor.updates === P.updates) { equal(state.modelHash, P.modelHash, 'Zero-new-update exact learned model'); equal(state.cursor, receipt.model.outerCursor, 'Zero-new-update outer cursor'); }
}
