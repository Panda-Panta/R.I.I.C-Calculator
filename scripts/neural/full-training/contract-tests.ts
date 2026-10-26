/** Synthetic contract fixtures only: no scored teacher or promoted training artifact. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { captureLineage } from './lineage.mjs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { atomic, digest, loadCheckpoint, saveCheckpoint } from './state.mjs';
import { normalizeProductionWeights } from '../../../src/domain/productionWeights';
import { createDefaultWorkspace } from '../../../src/workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../../src/domain/operatorInventory';
import { compactTeacher, regenerateChunk, trainPreparedDataset, scenarioFromInput } from '../full-train-worker';
import { createFullPolicy, serializeFullPolicy, deserializeFullPolicy } from '../../../src/optimizer/neural/fullPolicy';
import { trainFullPolicy } from '../../../src/optimizer/neural/fullTraining';
import { FULL_FEATURE_VERSION, FULL_FEATURE_MANIFEST_HASH, FULL_FEATURE_COUNT } from '../../../src/optimizer/neural/fullFeatures';
const entries = fullCatalogIdleInventory(), inventory = compileOperatorInventory(entries), base = createDefaultWorkspace(), teacher = structuredClone(base), used = new Set<string>();
const choose = () => { const o = inventory.operators.find(o => !used.has(o.charId) && !['佩佩', 'U-Official', '菲亚梅塔', '但书', '龙舌兰'].includes(o.name))!; used.add(o.charId); return o.charId; };
for (const r of Object.values(teacher.mainPlan.facilities))
    if (r.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(r.type))
        for (const p of r.slots) {
            const op = choose();
            p.occupant = { kind: 'operator', operatorId: op };
            teacher.mainPlan.conf.workaholic.push(op);
        }
for (const r of Object.values(teacher.mainPlan.facilities))
    if (r.level > 0 && r.type === 'dormitory') {
        r.slots[0]!.occupant = { kind: 'operator', operatorId: choose() };
        for (const p of r.slots)
            if (p.occupant.kind === 'empty')
                p.occupant = { kind: 'free' };
    }
teacher.productionWeights = normalizeProductionWeights(base.productionWeights);
const input = { familyId: 'UNSCORED-STRUCTURAL-FIXTURE', split: 'dev', workspace: base, entries, options: { branchCount: 10, enableDeepSearch: true, simulationWarmupHours: 24, simulationSampleHours: 72, droneTarget: 'gold', seed: 42, productionWeights: base.productionWeights } }, result = { status: 'draft', score: 0, workspace: teacher, calculationReport: { fixture: true } }, outcome = { status: 'completed', completed: true, score: 0, result: { completed: true, score: 0, result, validation: { physical: [] } } };
assert.deepEqual(scenarioFromInput({ ...input, inputProfile: 'TRAIN-enriched-catalog-high-stage-v1', enrichment: { targetAtomicId: 'ANNOTATION-ONLY', forcedOperators: ['NOT-A-FEATURE'] }, offlineValidation: { targetCoverage: 'ANNOTATION-ONLY' } }), scenarioFromInput(input));
assert.deepEqual(scenarioFromInput({ ...input, options: { ...input.options, productionWeights: { gold: 2 } } }).workspace.productionWeights, normalizeProductionWeights({ gold: 2 }));
const compact = compactTeacher(input, outcome, 'dev-overfit');
assert.equal(compact.audit.qualified, true, JSON.stringify(compact.audit));
assert.ok(compact.record);
assert.ok(compact.record!.actionIds.length > 200);
assert.equal('samples' in compact.record!, false);
const reordered = compactTeacher(input, outcome, 'dev-overfit', 'staffing-first-v1');
assert.equal(reordered.audit.qualified, true, JSON.stringify(reordered.audit));
assert.equal(reordered.record!.constructionOrder, 'staffing-first-v1');
assert.notDeepEqual(reordered.record!.actionIds, compact.record!.actionIds);
assert.equal(reordered.record!.teacherSemanticHash, compact.record!.teacherSemanticHash);
assert.equal(regenerateChunk(reordered.record, reordered.record!.actionIds.length - 1, 1).length, 1);
assert.throws(() => scenarioFromInput(input, 'unknown' as any), /Unknown construction order/);
const chunk = regenerateChunk(compact.record, 0, 2);
assert.equal(chunk.length, 2);
const tail = regenerateChunk(compact.record, compact.record!.actionIds.length - 1, 1);
assert.equal(tail.length, 1);
assert.throws(() => regenerateChunk({ ...compact.record, actionIds: ['NOT-ACTION'] }, 0, 1), /TRACE_CONTRACT/);
const bad = structuredClone(outcome);
bad.result.result.workspace.compatibility.unrecognizedFields.changed = 1;
assert.equal(compactTeacher(input, bad, 'dev-overfit').record, null);
const model = createFullPolicy({ hiddenSize: 2, seed: 42 }), decision = { version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: [[0, .25] as [
            number,
            number
        ]], candidates: [[[1, 1] as [
                number,
                number
            ]], [[2, 1] as [
                number,
                number
            ]]] }, samples = [{ decision, targetIndex: 0 }, { decision, targetIndex: 1 }];
const uninterrupted = trainFullPolicy(model, samples, { epochs: 3, learningRate: .03 });
let interrupted = trainFullPolicy(model, samples, { epochs: 3, maxUpdates: 1, learningRate: .03 });
interrupted = trainFullPolicy(deserializeFullPolicy(serializeFullPolicy(interrupted.model)), samples, { epochs: 3, learningRate: .03 });
assert.deepEqual(serializeFullPolicy(interrupted.model), serializeFullPolicy(uninterrupted.model));
const cancelled = trainFullPolicy(model, samples, { epochs: 3, shouldCancel: () => true });
assert.equal(cancelled.diagnostics.updates, 0);
assert.deepEqual(cancelled.model, model);
console.log(JSON.stringify({ structuralFixture: 'UNSCORED; NOT A TRAINING CHECKPOINT', exactTraceActions: compact.record!.actionIds.length, numericResume: 'bitwise equal', cancel: 'zero updates' }));
// Exercise the real outer loop on a tiny no-production structural fixture.
// These deliberately unscored temp artifacts are deleted, never published as training evidence.
const tinyBase = createDefaultWorkspace();
for (const room of Object.values(tinyBase.mainPlan.facilities)) {
    room.level = 0;
    room.slots = [];
}
const tinyInput = { ...input, workspace: tinyBase, entries: entries.slice(0, 2) }, tinyOutcome = structuredClone(outcome);
tinyOutcome.result.result.workspace = structuredClone(tinyBase);
tinyOutcome.result.result.workspace.productionWeights = normalizeProductionWeights(tinyInput.options.productionWeights);
const tiny = compactTeacher(tinyInput, tinyOutcome, 'dev-overfit');
assert.equal(tiny.audit.qualified, true, JSON.stringify(tiny.audit));
const dataset = { records: [tiny.record], featureManifestHash: FULL_FEATURE_MANIFEST_HASH, scope: 'UNSCORED TEMPORARY LOOP TEST' };
const binding = { datasetHash: digest(dataset), hiddenSize: 2, seed: 42, learningRate: .03 };
const dirs = [mkdtempSync(join(tmpdir(), 'full-loop-')), mkdtempSync(join(tmpdir(), 'full-loop-resume-'))];
try {
    for (const directory of dirs)
        atomic(join(directory, 'dataset.json'), dataset);
    const job = { mode: 'train', binding, epochs: 2, budgetMs: 30000, chunkSize: 4 };
    const a = trainPreparedDataset({ ...job, directory: dirs[0] });
    assert.equal(a.status, 'epoch-stop');
    const prefixSamples = regenerateChunk(tiny.record, 0, 2);
    const prefix = trainFullPolicy(createFullPolicy({ hiddenSize: 2, seed: 42 }), prefixSamples, { epochs: 1, resetCursor: true });
    delete prefix.model.metadata.resume;
    saveCheckpoint(dirs[1], serializeFullPolicy(prefix.model), { binding, cursor: { epoch: 0, family: 0, action: 2, updates: 2 } });
    const b = trainPreparedDataset({ ...job, directory: dirs[1] });
    assert.equal(b.status, 'epoch-stop');
    assert.deepEqual(loadCheckpoint(dirs[0], binding).bytes, loadCheckpoint(dirs[1], binding).bytes);
    assert.deepEqual(a.cursor, b.cursor);
    const saved = loadCheckpoint(dirs[0], binding);
    saveCheckpoint(dirs[0], saved.bytes, { ...saved.state, gate: null });
    unlinkSync(join(dirs[0], 'decode-latest.json'));
    const recovered = trainPreparedDataset({ ...job, directory: dirs[0] });
    assert.ok(recovered.gate, 'completed epoch resumes must recover pending free-running gate');
    assert.equal(recovered.gate.cursor.updates, recovered.cursor.updates);
    const expired = trainPreparedDataset({ ...job, epochs: 3, deadlineUtcMs: Date.now() - 1, directory: dirs[1] });
    assert.equal(expired.status, 'budget-exhausted');
    assert.deepEqual(expired.cursor, b.cursor);
    writeFileSync(join(dirs[1], 'CANCEL'), 'test');
    const c = trainPreparedDataset({ ...job, epochs: 3, directory: dirs[1] });
    assert.equal(c.status, 'cancelled');
    assert.deepEqual(c.cursor, b.cursor);
    const lineageDirs = [mkdtempSync(join(tmpdir(), 'lineage-parent-')), mkdtempSync(join(tmpdir(), 'lineage-fork-')), mkdtempSync(join(tmpdir(), 'lineage-fresh-'))];
    try {
        const parent = loadCheckpoint(dirs[0], binding), config = { purpose: 'dev-overfit', hiddenSize: 2, seed: 42, learningRate: .03 }, provenance = { sourceHash: 'fixture-source', bundleHash: digest('fixture-worker') }, parentBinding = { ...config, datasetHash: digest(dataset), featureManifestHash: FULL_FEATURE_MANIFEST_HASH, ...provenance };
        atomic(join(lineageDirs[0], 'manifest.json'), { config, provenance });
        atomic(join(lineageDirs[0], 'dataset.json'), dataset);
        writeFileSync(join(lineageDirs[0], 'worker.mjs'), 'fixture-worker');
        saveCheckpoint(lineageDirs[0], parent.bytes, { binding: parentBinding, cursor: parent.state.cursor });
        const fork = captureLineage(tmpdir(), lineageDirs[1], { mode: 'fork', parentRun: basename(lineageDirs[0]), reason: 'explicit test continuation' }, 'dev-overfit');
        atomic(join(lineageDirs[1], 'dataset.json'), dataset);
        const forkBinding = { ...parentBinding, lineageHash: digest(fork) }, forked = trainPreparedDataset({ ...job, directory: lineageDirs[1], binding: forkBinding, epochs: 0 });
        assert.equal(forked.cursor.epoch, 0);
        assert.equal(forked.cursor.updates, parent.state.cursor.updates);
        assert.deepEqual(loadCheckpoint(lineageDirs[1], forkBinding).bytes, parent.bytes);
        const fresh = captureLineage(tmpdir(), lineageDirs[2], { mode: 'fresh', parentRun: basename(lineageDirs[0]), reason: 'explicit diagnosed fresh test' }, 'dev-overfit');
        atomic(join(lineageDirs[2], 'dataset.json'), dataset);
        const freshBinding = { ...parentBinding, seed: 77, optimizer: 'common-l2-sgd-v1', lineageHash: digest(fresh) }, freshResult = trainPreparedDataset({ ...job, directory: lineageDirs[2], binding: freshBinding, epochs: 0 });
        assert.equal(freshResult.cursor.updates, 0);
        assert.deepEqual(loadCheckpoint(lineageDirs[2], freshBinding).bytes, Buffer.from(serializeFullPolicy(createFullPolicy({ hiddenSize: 2, seed: 77 }))));
        trainPreparedDataset({ ...job, directory: lineageDirs[2], binding: freshBinding, epochs: 1 });
        assert.equal(deserializeFullPolicy(loadCheckpoint(lineageDirs[2], freshBinding).bytes).metadata.optimizerVersion, 'common-l2-sgd-v1');
        assert.throws(() => trainPreparedDataset({ ...job, directory: lineageDirs[2], binding: { ...freshBinding, optimizer: 'sgd-v1' }, epochs: 2 }), /mismatch/);
        assert.deepEqual(loadCheckpoint(lineageDirs[0], parentBinding).bytes, parent.bytes);
        assert.throws(() => captureLineage(tmpdir(), lineageDirs[2], { mode: 'fork', parentRun: basename(lineageDirs[0]), reason: 'forbidden promotion' }, 'train'), /promote/);
    }
    finally {
        for (const directory of lineageDirs)
            rmSync(directory, { recursive: true, force: true });
    }
    console.log('real outer loop resume: bitwise equal; bounded cancellation checkpoint retained');
}
finally {
    for (const directory of dirs)
        rmSync(directory, { recursive: true, force: true });
}
