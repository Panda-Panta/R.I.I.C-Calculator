/** CPU-only full-v2 trainer. Teacher optimizer is deliberately not imported. */
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProductionWeights } from '../../src/domain/productionWeights';
import { compileOperatorInventory } from '../../src/domain/operatorInventory';
import { createFullScenario, initialFullState, nextDecision, legalFullActions } from '../../src/optimizer/neural/fullActionSpace';
import { applyFullAction, finalizeFullState } from '../../src/optimizer/neural/fullTransitions';
import { replayFullTeacher, fullSemanticWorkspace } from '../../src/optimizer/neural/fullTeacherTraces';
import { decodeFullRoster } from '../../src/optimizer/neural/fullDecode';
import { encodeFullDecision, FULL_FEATURE_MANIFEST, FULL_FEATURE_MANIFEST_HASH } from '../../src/optimizer/neural/fullFeatures';
import { createFullPolicy, createFullPolicyScorer, serializeFullPolicy, deserializeFullPolicy } from '../../src/optimizer/neural/fullPolicy';
import { trainFullPolicy, type FullPolicySample } from '../../src/optimizer/neural/fullTraining';
import { fullPlacementMetrics } from './full-training/placement-metrics';
import { simulateCandidate } from '../../src/optimizer/candidateSimulation';
import { qualifyEnvelope, digest, atomic, advanceCursor, saveCheckpoint, loadCheckpoint } from './full-training/state.mjs';
import { compactMolecularTeacher } from './full-training/auxiliary-traces';
import { verifyInitialization } from './full-training/lineage.mjs';
import { referenceManifestContract } from './full-baseline/reference-protocol.mjs';
import { auditTradingExclusions } from './full-baseline/semantic-audit.mjs';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
export function scenarioFromInput(input: any, constructionOrder: 'legacy-v1' | 'staffing-first-v1' = 'legacy-v1') {
    if (!['legacy-v1', 'staffing-first-v1'].includes(constructionOrder))
        throw Error('Unknown construction order');
    const workspace = structuredClone(input.workspace);
    // Optimizer resolves explicit options over the input; conditioning must match, never use output context.
    workspace.productionWeights = normalizeProductionWeights(input.options.productionWeights ?? workspace.productionWeights);
    return createFullScenario(workspace, compileOperatorInventory(input.entries), { constructionOrder, simulationConditioning: { schedulerAssumptions: { restingThreshold: .65, operationDurationHours: 0 }, droneTarget: input.options.droneTarget, droneRoomId: input.options.droneRoomId, warmupHours: input.options.simulationWarmupHours, sampleHours: input.options.simulationSampleHours, maxStepHours: input.simulationDefaults?.maxStepHours ?? .25, seed: input.options.seed } });
}
export function compactTeacher(input: any, outcome: any, purpose: string, constructionOrder: 'legacy-v1' | 'staffing-first-v1' = 'legacy-v1') {
    const qualification = qualifyEnvelope(input, outcome, purpose);
    if (!qualification.qualified)
        return { record: null, audit: qualification };
    const target = outcome.result.result.workspace, exclusions = auditTradingExclusions(target), scenario = scenarioFromInput(input, constructionOrder), replay = replayFullTeacher(scenario, target);
    const reasons = [...qualification.reasons, ...(!exclusions.imitationPolicyCompatible ? ['TRADING_POLICY_CONFLICT'] : []), ...(!scenario.valid ? ['INVALID_INPUT_SCENARIO'] : []), ...(!replay.exactReplay ? ['NOT_EXACT_REPLAY'] : []), ...(!replay.complete ? ['INVALID_TEACHER_SEMANTICS'] : [])];
    return { audit: { ...qualification, qualified: !reasons.length, reasons, exclusions, diagnostics: replay.diagnostics, exactReplay: replay.exactReplay, complete: replay.complete }, record: reasons.length ? null : { familyId: input.familyId, originalSplit: input.split, input, constructionOrder, actionIds: replay.trace.map(t => t.action.id), teacherSemanticHash: digest(fullSemanticWorkspace(scenario, target)), teacherScore: qualification.score, referenceProtocol: qualification.referenceProtocol, degradedBaseline: qualification.degradedBaseline, teacherRecordHash: digest(outcome), sourceKind: 'full-optimizer', fullOptimizerTeacher: true, baselineEligible: true } };
}
/** Rebuild only this family's prefix; do not persist repeated sparse matrices. */
export function regenerateChunk(record: any, start: number, count: number) {
    const scenario = scenarioFromInput(record.input, record.constructionOrder ?? 'legacy-v1');
    let state = initialFullState(scenario);
    const samples: FullPolicySample[] = [];
    for (let i = 0; i < Math.min(record.actionIds.length, start + count); i++) {
        const decision = nextDecision(scenario, state), actions = legalFullActions(scenario, state), targetIndex = actions.findIndex(a => a.id === record.actionIds[i]);
        if (!decision || targetIndex < 0)
            throw Error(`TRACE_CONTRACT_MISMATCH ${record.familyId} action ${i}`);
        if (i >= start)
            samples.push({ decision: encodeFullDecision({ scenario, state, decision, actions }), targetIndex });
        state = applyFullAction(scenario, state, actions[targetIndex]!);
    }
    if (start + count >= record.actionIds.length) {
        const result = finalizeFullState(scenario, state);
        if (!result.complete || digest(fullSemanticWorkspace(scenario, result.workspace)) !== record.teacherSemanticHash)
            throw Error('Compact full trace no longer exactly reconstructs qualified teacher');
    }
    return samples;
}
function prepare(job: any) {
    const sources = read(join(job.directory, 'source-records.json')), records: any[] = [], audits: any[] = [];
    const teacherKind = job.teacherKind ?? 'full-optimizer';
    if (sources.sourceCompatibility?.legacyProofRequired && job.constructionOrder !== 'staffing-first-v1')
        throw Error('Replay-preserving transition requires staffing-first learning protocol');
    if (sources.teacherKind !== teacherKind)
        throw Error('Teacher kind source/caller mismatch');
    if (teacherKind === 'molecular-simulated' && job.purpose !== 'train')
        throw Error('Auxiliary target cannot be used outside TRAIN');
    for (const source of sources.records) {
        try {
            const result = teacherKind === 'molecular-simulated' ? compactMolecularTeacher(source.input, source.outcome, { purpose: 'training', allowedTeacherKinds: [teacherKind], allowedInputProfiles: [job.inputProfile ?? 'actual-mixture-v1'], constructionOrder: job.constructionOrder ?? 'legacy-v1', manifest: source.sourceManifest ?? sources.teacherManifest, manifestHash: source.sourceManifestHash ?? sources.teacherManifestHash }) : compactTeacher(source.input, source.outcome, job.purpose, job.constructionOrder ?? 'legacy-v1');
            audits.push({ familyId: source.input.familyId, ...result.audit });
            if (result.record)
                records.push(result.record);
        }
        catch (e) {
            audits.push({ familyId: source.input?.familyId, qualified: false, reasons: ['EXTRACTION_ERROR'], error: String(e) });
        }
    }
    const referenceContract = teacherKind === 'full-optimizer' ? referenceManifestContract(sources.teacherManifest, records.map(r => r.input)) : null;
    if (sources.referenceContract && digest(sources.referenceContract) !== digest(referenceManifestContract(sources.teacherManifest, sources.records.map((r: any) => r.input)))) throw Error('Full reference source contract mismatch');
    const referenceProtocols = teacherKind === 'full-optimizer' ? [...new Map(records.map(r => [digest(r.referenceProtocol), r.referenceProtocol])).values()] : [];
    if (referenceProtocols.length > 1) throw Error('Mixed full reference protocol populations require separate datasets');
    records.sort((a, b) => a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0);
    const seen = new Set(), inventories = new Set();
    for (const r of records) {
        if (seen.has(r.familyId))
            throw Error('Duplicate family');
        seen.add(r.familyId);
        const canonicalInventory = digest(scenarioFromInput(r.input).inventory.operators.map(o => ({ operator: o.charId, phase: o.elitePhase, level: o.level })));
        if (inventories.has(canonicalInventory))
            throw Error('Duplicate canonical inventory family');
        inventories.add(canonicalInventory);
    }
    const dataset = { schemaVersion: 4, dataVersion: sources.teacherManifest.dataVersion ?? 'historical-full-v2', referenceContract, referenceProtocols, inputProfile: job.inputProfile ?? 'actual-mixture-v1', constructionOrder: job.constructionOrder ?? 'legacy-v1', purpose: job.purpose, teacherKinds: [teacherKind], baselineEligible: teacherKind === 'full-optimizer', scope: teacherKind === 'molecular-simulated' ? 'AUXILIARY MOLECULAR-SIMULATED TRAINING ONLY; NOT FULL OPTIMIZER BASELINE/PARITY/RELEASE' : job.purpose === 'dev-overfit' ? 'EXPOSED DEVELOPMENT OVERFIT ONLY; NOT RELEASE OR PROMOTED TRAINING' : 'training only; no release claims', sourceRecordsHash: digest(sources), featureManifestHash: FULL_FEATURE_MANIFEST_HASH, records };
    atomic(join(job.directory, 'qualification.json'), { teacherKind, baselineEligible: teacherKind === 'full-optimizer', attempted: sources.records.length, qualified: records.length, cohortAccounting: sources.cohortAccounting ?? null, audits, pending: sources.pending });
    atomic(join(job.directory, 'dataset.json'), dataset);
    atomic(join(job.directory, 'feature-manifest.json'), FULL_FEATURE_MANIFEST);
    return { status: records.length ? 'dataset-ready' : 'waiting-qualified-teacher', datasetHash: digest(dataset), qualified: records.length, rejected: audits.filter(a => !a.qualified).length, pending: sources.pending };
}
function evaluateDecode(dataset: any, model: any, directory: string, cursor: any, shouldCancel: () => boolean = () => false) {
    const scorer = createFullPolicyScorer(model), reports = [];
    for (const record of dataset.records) {
        const scenario = scenarioFromInput(record.input, record.constructionOrder ?? 'legacy-v1'), start = performance.now(), result = decodeFullRoster(scenario, context => {
            if (shouldCancel())
                throw Error('DECODE_BUDGET_CANCELLED');
            return scorer(encodeFullDecision(context));
        }), ids = result.trace.map(t => t.action.id);
        if (shouldCancel())
            throw Error('PENDING_DECODE_INTERRUPTED');
        let prefix = 0;
        while (prefix < ids.length && ids[prefix] === record.actionIds[prefix])
            prefix++;
        const placementCounts = fullPlacementMetrics(scenario, result);
        const report = { familyId: record.familyId, complete: result.complete, exactTeacherSemantics: result.complete && digest(fullSemanticWorkspace(scenario, result.workspace)) === record.teacherSemanticHash, matchingPrefixActions: prefix, firstDivergence: prefix === record.actionIds.length && prefix === ids.length ? null : { index: prefix, decision: result.trace[prefix]?.decision ?? null, expectedActionId: record.actionIds[prefix] ?? null, chosenActionId: ids[prefix] ?? null }, teacherActions: record.actionIds.length, decodedActions: ids.length, diagnostics: result.diagnostics, generationElapsedMs: performance.now() - start, modelActions: result.modelActions, forcedActions: result.forcedActions, modelChoiceActions: result.modelChoiceActions, constructionOrder: result.constructionOrder, ...placementCounts, frozenInputSlots: result.frozenSlots, score: null, scoreStatus: 'not-simulated', workspace: result.workspace };
        reports.push(report);
    }
    const gateModel = serializeFullPolicy(model);
    writeFileSync(join(directory, 'decode-model.bin.tmp'), gateModel, { mode: 0o600 });
    renameSync(join(directory, 'decode-model.bin.tmp'), join(directory, 'decode-model.bin'));
    const report = { cursor, modelHash: digest(gateModel), reports, gate: reports.every(r => r.complete && r.exactTeacherSemantics) ? 'exact-overfit' : 'failed-free-running-overfit', parity: false, scope: dataset.scope };
    atomic(join(directory, `decode-${cursor.updates}.json`), report);
    atomic(join(directory, 'decode-latest.json'), report);
    return { ...report, reports: reports.map(({ workspace, ...r }) => r) };
}
function initialModel(job: any) {
    if (!job.binding.lineageHash)
        return createFullPolicy({ hiddenSize: job.binding.hiddenSize, seed: job.binding.seed });
    const lineage = read(join(job.directory, 'lineage.json'));
    verifyInitialization(lineage, job.binding);
    if (lineage.spec.mode === 'fresh')
        return createFullPolicy({ hiddenSize: job.binding.hiddenSize, seed: job.binding.seed });
    const bytes = readFileSync(join(job.directory, 'initial-model.bin'));
    if (digest(bytes) !== lineage.initialModelHash)
        throw Error('Fork parameter snapshot mismatch');
    const model = deserializeFullPolicy(bytes);
    if (model.hiddenSize !== job.binding.hiddenSize || model.metadata.seed !== job.binding.seed || model.metadata.trainingUpdates !== lineage.parent.cursor.updates)
        throw Error('Fork model dimensions/seed/cumulative updates mismatch');
    if (digest(serializeFullPolicy(model)) !== lineage.initialModelHash)
        throw Error('Fork initialization did not preserve exact binary');
    return model;
}
export function trainPreparedDataset(job: any) {
    const directory = job.directory, dataset = read(join(directory, 'dataset.json'));
    if (!dataset.records.length)
        return { status: 'waiting-qualified-teacher', parity: false };
    if ((dataset.inputProfile ?? 'actual-mixture-v1') !== (job.binding.inputProfile ?? 'actual-mixture-v1'))
        throw Error('Dataset input-profile binding mismatch');
    if ((dataset.constructionOrder ?? 'legacy-v1') !== (job.binding.constructionOrder ?? 'legacy-v1') || dataset.records.some((r: any) => (r.constructionOrder ?? 'legacy-v1') !== (dataset.constructionOrder ?? 'legacy-v1')))
        throw Error('Dataset construction-order binding mismatch');
    if (digest(dataset) !== job.binding.datasetHash || dataset.featureManifestHash !== FULL_FEATURE_MANIFEST_HASH)
        throw Error('Dataset/feature manifest mismatch');
    const checkpoint = loadCheckpoint(directory, job.binding);
    let model = checkpoint ? deserializeFullPolicy(checkpoint.bytes) : initialModel(job), cursor = checkpoint?.state.cursor ?? { epoch: 0, family: 0, action: 0, updates: model.metadata.trainingUpdates };
    if (model.metadata.trainingUpdates !== cursor.updates)
        throw Error('Model/outer cursor update mismatch');
    const started = performance.now(), cancel = () => existsSync(join(directory, 'CANCEL')), expired = () => Date.now() >= (job.deadlineUtcMs ?? Infinity) || performance.now() - started >= job.budgetMs, stop = () => cancel() || expired(), lengths = dataset.records.map((r: any) => r.actionIds.length);
    const phaseTimings = { encodingMs: 0, trainingAndLossMs: 0, checkpointSerializationMs: 0, checkpointWriteMs: 0, freeDecodeGateMs: 0, ...checkpoint?.state.phaseTimings };
    let gate = checkpoint?.state.gate ?? null, latestLoss = checkpoint?.state.latestLoss ?? null;
    const publish = (status: string) => {
        const serializeStart = performance.now(), bytes = serializeFullPolicy(model), modelHash = digest(bytes);
        phaseTimings.checkpointSerializationMs += performance.now() - serializeStart;
        const pendingEvaluation = cursor.epoch > 0 && cursor.family === 0 && cursor.action === 0 && (gate?.cursor?.updates !== cursor.updates || gate?.modelHash !== modelHash) ? { epoch: cursor.epoch, updates: cursor.updates, modelHash } : null;
        const state = { binding: job.binding, cursor, status, gate, phaseTimings: { ...phaseTimings }, timingNote: 'Training includes clone/validation/initial+final loss passes; gate includes decode artifact writes; checkpoint timing snapshot excludes its own write', pendingEvaluation, currentModelHash: modelHash, latestLoss, optimizationElapsedMs: (checkpoint?.state.optimizationElapsedMs ?? 0) + performance.now() - started, updatedUtc: new Date().toISOString(), parity: false };
        const writeStart = performance.now();
        saveCheckpoint(directory, bytes, state);
        phaseTimings.checkpointWriteMs += performance.now() - writeStart;
        atomic(join(directory, 'status.json'), { ...state, phaseTimings: { ...phaseTimings }, scope: dataset.scope });
        process.stderr.write(JSON.stringify({ event: 'training-status', ...state }) + '\n');
    };
    const gateCurrent = () => {
        if (!gate || gate.cursor?.updates !== cursor.updates || gate.modelHash !== digest(serializeFullPolicy(model)))
            return false;
        try {
            const report = read(join(directory, 'decode-latest.json'));
            return report.modelHash === gate.modelHash && report.cursor?.updates === cursor.updates && digest(readFileSync(join(directory, 'decode-model.bin'))) === gate.modelHash;
        }
        catch {
            return false;
        }
    };
    const recoverGate = () => {
        if (gateCurrent() || stop())
            return;
        try {
            const gateStart = performance.now();
            gate = evaluateDecode(dataset, model, directory, cursor, stop);
            phaseTimings.freeDecodeGateMs += performance.now() - gateStart;
            publish(gate.gate);
        }
        catch (error) {
            if (!(stop() && String(error).includes('PENDING_DECODE_INTERRUPTED')))
                throw error;
        }
    };
    if (!checkpoint)
        publish('initialized');
    // A crash can occur after committing an epoch's weights but before its decode gate.
    // Recover that gate before any further numerical updates or successful epoch-stop.
    if (cursor.epoch > 0 && cursor.family === 0 && cursor.action === 0)
        recoverGate();
    while (cursor.epoch < job.epochs && !stop()) {
        const encodingStart = performance.now(), family = dataset.records[cursor.family], samples = regenerateChunk(family, cursor.action, job.chunkSize - (cursor.action % job.chunkSize)), previousEpoch = cursor.epoch;
        phaseTimings.encodingMs += performance.now() - encodingStart;
        if (stop())
            break;
        const trainingStart = performance.now(), result = trainFullPolicy(model, samples, { epochs: 1, learningRate: job.binding.learningRate, optimizer: job.binding.optimizer ?? 'sgd-v1', maxUpdates: samples.length, resetCursor: true, shouldCancel: stop });
        phaseTimings.trainingAndLossMs += performance.now() - trainingStart;
        model = result.model;
        delete model.metadata.resume;
        cursor = advanceCursor(cursor, result.diagnostics.updates, lengths);
        latestLoss = result.diagnostics.finalLoss;
        // Commit the updated numerical state BEFORE a potentially expensive free-running gate.
        publish('training');
        if (cursor.epoch !== previousEpoch && !stop())
            recoverGate();
        if (!result.diagnostics.updates)
            break;
    }
    if (cursor.epoch >= job.epochs)
        recoverGate();
    // Bounded elapsed budget is not an epoch convergence claim. Parent continues/diagnoses explicitly.
    const status = cancel() ? 'cancelled' : expired() ? 'budget-exhausted' : cursor.epoch >= job.epochs ? 'epoch-stop' : 'interrupted';
    publish(status);
    return { status, cursor, gate, latestLoss, phaseTimings, parity: false };
}
export function simulationJob(input: any, workspace: any, seed: number, maxStepHours: number) { return { workspace, options: { warmupHours: input.options.simulationWarmupHours, sampleHours: input.options.simulationSampleHours, maxStepHours, productionWeights: input.options.productionWeights, operatorInventory: input.entries, production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: input.options.droneTarget, droneRoomId: input.options.droneRoomId, seed } }, assumptions: { restingThreshold: .65, operationDurationHours: 0 } }; }
function evaluate(job: any) { const result = simulateCandidate(simulationJob(job.input, job.workspace, job.seed, job.maxStepHours)); return { result, completed: result.completed, score: result.completed && Number.isFinite(result.simScore) ? result.simScore : null, settings: simulationJob(job.input, job.workspace, job.seed, job.maxStepHours).options, fallbackPhysicalPlacements: 0 }; }
if (!process.argv.includes('--library')) {
    try {
        const job = JSON.parse(readFileSync(0, 'utf8')), result = job.mode === 'prepare' ? prepare(job) : job.mode === 'train' ? trainPreparedDataset(job) : job.mode === 'evaluate' ? evaluate(job) : (() => { throw Error('Unknown worker mode'); })();
        process.stdout.write(JSON.stringify(result));
    }
    catch (error) {
        process.stderr.write(JSON.stringify({ event: 'worker-error', error: String(error), stack: error instanceof Error ? error.stack : null }) + '\n');
        process.exitCode = 1;
    }
}
