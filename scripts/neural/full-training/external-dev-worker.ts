/** Read-only FULL DEV inference, never a training update or teacher-assisted decode. */
import { readFileSync } from 'node:fs';
import { decodeFullRoster } from '../../../src/optimizer/neural/fullDecode';
import { encodeFullDecision } from '../../../src/optimizer/neural/fullFeatures';
import { deserializeFullPolicy, createFullPolicyScorer } from '../../../src/optimizer/neural/fullPolicy';
import { fullSemanticWorkspace } from '../../../src/optimizer/neural/fullTeacherTraces';
import { fullPlacementMetrics } from './placement-metrics';
import { digest } from './state.mjs';
process.argv.push('--library');
const { scenarioFromInput, compactTeacher } = await import('../full-train-worker');
export function decodeExternalDev(job: any) {
    if (job.input?.split !== 'dev')
        throw Error('External evaluator accepts exposed DEV only');
    if (job.outcome?.result?.degradedBaseline === true)
        throw Error('Degraded output is not a full mathematical reference');
    const archived = job.archivedTeacherTrace;
    if (!archived || !Array.isArray(archived.actionIds) || !archived.teacherSemanticHash)
        throw Error('Missing archived FULL DEV trace commitment');
    if (archived) {
        const original = compactTeacher(job.input, job.outcome, 'dev-overfit', archived.constructionOrder ?? 'legacy-v1');
        if (!original.record || digest(original.record.actionIds) !== digest(archived.actionIds) || original.record.teacherSemanticHash !== archived.teacherSemanticHash)
            throw Error('Archived FULL DEV trace/semantics no longer reproduce exactly');
    }
    const qualified = compactTeacher(job.input, job.outcome, 'dev-overfit', job.constructionOrder ?? 'legacy-v1');
    if (job.referenceContract && digest(job.referenceContract.reference?.referenceProtocol) !== digest(qualified.record?.referenceProtocol)) throw Error('External DEV reference protocol mismatch');
    if (!qualified.record)
        throw Error('Unqualified full DEV teacher: ' + JSON.stringify(qualified.audit));
    const canonical = (input: any) => digest(scenarioFromInput(input).inventory.operators.map((o: any) => ({ operator: o.charId, phase: o.elitePhase, level: o.level })));
    const devInventory = canonical(job.input);
    if (job.trainingInputs.some((input: any) => input.familyId === job.input.familyId || canonical(input) === devInventory))
        throw Error('TRAIN/DEV family or canonical inventory overlap');
    const bytes = readFileSync(job.modelPath);
    if (digest(bytes) !== job.modelHash)
        throw Error('Immutable model snapshot mismatch');
    const model = deserializeFullPolicy(bytes), score = createFullPolicyScorer(model), scenario = scenarioFromInput(job.input, job.constructionOrder ?? 'legacy-v1'), started = performance.now();
    const result = decodeFullRoster(scenario, ctx => score(encodeFullDecision(ctx)));
    return { referenceProtocol: qualified.record.referenceProtocol, familyId: job.input.familyId, modelHash: job.modelHash, complete: result.complete, exactTeacherSemantics: result.complete && digest(fullSemanticWorkspace(scenario, result.workspace)) === qualified.record.teacherSemanticHash, workspace: result.workspace, diagnostics: result.diagnostics, modelActions: result.modelActions, forcedActions: result.forcedActions, modelChoiceActions: result.modelChoiceActions, constructionOrder: result.constructionOrder, frozenInputSlots: result.frozenSlots, ...fullPlacementMetrics(scenario, result), generationElapsedMs: performance.now() - started, qualification: qualified.audit, scope: 'EXPOSED FULL DEV TRANSFER ONLY; NOT RELEASE OR PARITY', parity: false };
}
if (!process.argv.includes('--external-library')) {
    try {
        process.stdout.write(JSON.stringify(decodeExternalDev(JSON.parse(readFileSync(0, 'utf8')))));
    }
    catch (error) {
        process.stderr.write(String(error) + '\n');
        process.exitCode = 1;
    }
}
