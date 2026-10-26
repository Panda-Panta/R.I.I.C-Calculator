/** UNSCORED tiny fixture; deleted temporary model, not quality evidence. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultWorkspace } from '../../../src/workbench/defaults';
import { fullCatalogIdleInventory } from '../../../src/domain/operatorInventory';
import { normalizeProductionWeights } from '../../../src/domain/productionWeights';
import { createFullPolicy, serializeFullPolicy } from '../../../src/optimizer/neural/fullPolicy';
import { digest } from './state.mjs';
process.argv.push('--external-library');
const { decodeExternalDev } = await import('./external-dev-worker');
const workspace = createDefaultWorkspace();
for (const room of Object.values(workspace.mainPlan.facilities)) {
    room.level = 0;
    room.slots = [];
}
const input = { familyId: 'UNSCORED-DEV', split: 'dev', workspace, entries: fullCatalogIdleInventory().slice(0, 2), options: { branchCount: 10, enableDeepSearch: true, simulationWarmupHours: 24, simulationSampleHours: 72, droneTarget: 'gold', seed: 42, productionWeights: workspace.productionWeights } };
const target = structuredClone(workspace);
target.productionWeights = normalizeProductionWeights(input.options.productionWeights);
const outcome = { status: 'completed', completed: true, score: 0, result: { completed: true, score: 0, result: { status: 'draft', workspace: target, score: 0, calculationReport: { fixture: true } }, validation: { physical: [] } } };
const dir = mkdtempSync(join(tmpdir(), 'external-dev-contract-'));
try {
    const bytes = serializeFullPolicy(createFullPolicy({ hiddenSize: 2, seed: 42 })), modelPath = join(dir, 'model.bin');
    writeFileSync(modelPath, bytes);
    const { compactTeacher } = await import('../full-train-worker');
    const original = compactTeacher(input, outcome, 'dev-overfit').record!;
    const job = { input, outcome, trainingInputs: [], modelPath, modelHash: digest(bytes), archivedTeacherTrace: { constructionOrder: 'legacy-v1', actionIds: original.actionIds, teacherSemanticHash: original.teacherSemanticHash } };
    assert.throws(() => decodeExternalDev({ ...job, archivedTeacherTrace: { ...job.archivedTeacherTrace, actionIds: ['TAMPERED'] } }), /Archived FULL DEV/);
    assert.throws(() => decodeExternalDev({ ...job, archivedTeacherTrace: undefined }), /Missing archived/);
    assert.throws(() => decodeExternalDev({ ...job, constructionOrder: 'staffing-first-v1', policyMode: 'latest-warmup-exhaustion-v1' }), /producer replay proof/i);
    assert.throws(() => decodeExternalDev({ ...job, constructionOrder: 'staffing-first-v1', policyMode: 'latest-warmup-runorder-v2' }), /producer replay proof/i);
    assert.throws(() => decodeExternalDev({ ...job, constructionOrder: 'staffing-first-v1', policyMode: 'latest-warmup-runorder-v2', producerReplayProof: {}, referenceContract: { policy: 'latest-default-to-warmup-policy-v1' } }), /transition/i);
    assert.throws(() => decodeExternalDev({ ...job, trainingInputs: [{ ...input, familyId: 'DIFFERENT-FAMILY' }] }), /canonical inventory overlap/);
    assert.throws(() => decodeExternalDev({ ...job, modelHash: 'bad' }), /snapshot mismatch/);
    const result = decodeExternalDev(job);
    assert.equal(result.fallbackPhysicalPlacements, 0);
    assert.equal(result.mechanicalPlacements, 0);
    assert.ok(result.modelActions > 0);
    assert.equal(result.forcedActions + result.modelChoiceActions, result.modelActions);
    assert.equal(result.constructionOrder, 'legacy-v1');
    const reordered = decodeExternalDev({ ...job, constructionOrder: 'staffing-first-v1' });
    assert.equal(reordered.constructionOrder, 'staffing-first-v1');
    assert.equal(reordered.forcedActions + reordered.modelChoiceActions, reordered.modelActions);
    assert.equal(result.parity, false);
    const degraded: any = structuredClone(outcome);
    degraded.result.degradedBaseline = true;
    assert.throws(() => decodeExternalDev({ ...job, outcome: degraded }), /Degraded output/);
    const weaker: any = structuredClone(outcome);
    weaker.result.sourceKind = 'molecular-simulated';
    assert.throws(() => decodeExternalDev({ ...job, outcome: weaker }), /Archived FULL DEV|Unqualified full DEV/);
    console.log('UNSCORED external DEV boundary and actual model-only decode checks passed');
}
finally {
    rmSync(dir, { recursive: true, force: true });
}
const { fullPlacementMetrics } = await import('./placement-metrics');
const metricWorkspace: any = { mainPlan: { facilities: { room_1_1: { roomId: 'room_1_1', type: 'manufacture', slots: [{ occupant: { kind: 'operator', operatorId: 'a' }, replacements: [] }, { occupant: { kind: 'operator', operatorId: 'b' }, replacements: [] }] } } } };
const metricResult: any = { workspace: metricWorkspace, trace: [{ decision: { kind: 'occupant', roomId: 'room_1_1', slotIndex: 0 }, actions: [{}], action: { kind: 'operator', value: 'a' } }, { decision: { kind: 'occupant', roomId: 'room_1_1', slotIndex: 1 }, actions: [{}, {}], action: { kind: 'operator', value: 'b' } }] };
const counts = fullPlacementMetrics({ lockedSlots: [] }, metricResult);
assert.equal(counts.forcedPhysicalPlacements, 1);
assert.equal(counts.mechanicalPlacements, 1);
assert.equal(counts.modelPhysicalPlacements, 1);
assert.equal(counts.totalGeneratedPhysicalPlacements, 2);
assert.equal(counts.fallbackPhysicalPlacements, 0);
