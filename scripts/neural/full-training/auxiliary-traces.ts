/** Independent auxiliary validator. Not wired into the active FULL100 run's frozen bundle. */
import { compileOperatorInventory } from '../../../src/domain/operatorInventory';
import { normalizeProductionWeights } from '../../../src/domain/productionWeights';
import { createFullScenario } from '../../../src/optimizer/neural/fullActionSpace';
import { replayFullTeacher, fullSemanticWorkspace } from '../../../src/optimizer/neural/fullTeacherTraces';
import { validatePhysicalRoster } from '../../../src/optimizer/rosterDraft';
import { compareWorkspacePreference } from '../../../src/optimizer/automaticCombinationPreferences';
import { compareProductionEfficiency } from '../../../src/optimizer/productionEfficiencyPriority';
import { auditTradingReferences } from '../molecular-training/policy.mjs';
import { digest } from './state.mjs';
import { inspectAuxiliaryEvidence, MOLECULAR_TEACHER_KIND } from './auxiliary-evidence.mjs';
const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : x;
const same = (a: any, b: any) => digest(canonical(a)) === digest(canonical(b));
export function compactMolecularTeacher(input: any, outcome: any, authorization: any) {
    const admission = inspectAuxiliaryEvidence(input, outcome, authorization);
    const constructionOrder = authorization?.constructionOrder ?? 'legacy-v1';
    if (!['legacy-v1', 'staffing-first-v1'].includes(constructionOrder))
        return { record: null, audit: { ...admission, qualified: false, reasons: [...admission.reasons, 'UNKNOWN_CONSTRUCTION_ORDER'] } };
    if (!admission.eligibleEvidence)
        return { record: null, audit: { ...admission, qualified: false } };
    const envelope = outcome.result, inventory = compileOperatorInventory(input.entries), base = structuredClone(input.workspace), assumptions = { restingThreshold: .65, operationDurationHours: 0 };
    base.productionWeights = normalizeProductionWeights(input.options.productionWeights ?? base.productionWeights);
    const scenario = createFullScenario(base, inventory, { simulationConditioning: { droneTarget: input.options.droneTarget, droneRoomId: input.options.droneRoomId, warmupHours: 24, sampleHours: 72, maxStepHours: .25, seed: input.options.seed, schedulerAssumptions: assumptions } });
    const reasons: string[] = [], audits: any[] = [], qualified: any[] = [];
    if (!inventory.valid || !scenario.valid)
        reasons.push('INVALID_ORIGINAL_SCENARIO');
    const expectedSettings = { options: { warmupHours: 24, sampleHours: 72, maxStepHours: .25, productionWeights: base.productionWeights, operatorInventory: input.entries, production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: input.options.droneTarget, ...(input.options.droneRoomId ? { droneRoomId: input.options.droneRoomId } : {}), seed: input.options.seed } }, assumptions };
    for (const c of envelope.candidates) {
        const issues: string[] = [];
        if (!c.workspace || c.workspaceHash !== digest(c.workspace)) {
            reasons.push(`CANDIDATE_WORKSPACE_COMMITMENT:${c.id}`);
            continue;
        }
        const physical = validatePhysicalRoster(c.workspace), exclusions = auditTradingReferences(c.workspace);
        if (physical.length)
            issues.push('PHYSICAL_INVALID');
        if (!exclusions.imitationPolicyCompatible)
            issues.push('TRADING_POLICY_CONFLICT');
        if (c.workspace.compatibility.backupPlans.length)
            issues.push('AUTOMATIC_BACKUP_PLANS_FORBIDDEN');
        if (!same(c.physical, physical) || c.exclusions?.imitationPolicyCompatible !== exclusions.imitationPolicyCompatible)
            reasons.push(`CANDIDATE_VALIDATION_CONFLICT:${c.id}`);
        let replay: any = null;
        if (!issues.length) {
            if (!c.simulation || !same(c.simulationSettings, expectedSettings))
                reasons.push(`MISSING_OR_CHANGED_SIMULATION_EVIDENCE:${c.id}`);
            if (c.simulation?.completed !== true || !Number.isFinite(c.simulation?.simScore) || !c.simulation?.calculationReport)
                issues.push('SIMULATION_INCOMPLETE');
            if (c.simulation?.completed !== true && c.score !== null)
                reasons.push(`FAILED_SIMULATION_HAS_SCORE:${c.id}`);
            if (c.simulation?.completed === true && (c.score !== c.simulation.simScore || !Number.isFinite(c.score)))
                reasons.push(`CANDIDATE_SCORE_CONFLICT:${c.id}`);
            replay = replayFullTeacher(scenario, c.workspace);
            if (!replay.complete || !replay.exactReplay || replay.diagnostics.length)
                issues.push('UNSUPPORTED_EXACT_REPLAY');
        }
        const valid = issues.length === 0;
        if (c.qualified !== valid)
            reasons.push(`CANDIDATE_QUALIFICATION_CONFLICT:${c.id}`);
        if (valid) {
            const actionIds = replay.trace.map((t: any) => t.action.id), semanticHash = digest(fullSemanticWorkspace(scenario, c.workspace));
            if (!same(c.actionIds, actionIds) || c.teacherSemanticHash !== digest(JSON.stringify(fullSemanticWorkspace(scenario, c.workspace))))
                reasons.push(`CANDIDATE_TRACE_CONFLICT:${c.id}`);
            qualified.push({ candidate: c, actionIds, semanticHash });
        }
        audits.push({ id: c.id, qualified: valid, issues, physical, exclusions, score: valid ? c.score : null, exactReplay: replay?.exactReplay ?? null, complete: replay?.complete ?? null });
    }
    let selected: any = null;
    for (const q of qualified) {
        if (!selected) {
            selected = q;
            continue;
        }
        const a = q.candidate, b = selected.candidate, preference = compareWorkspacePreference(a.workspace, b.workspace), efficiency = compareProductionEfficiency(a.workspace, b.workspace, inventory);
        if (preference > 0 || (preference === 0 && (efficiency > 0 || (efficiency === 0 && a.score > b.score))))
            selected = q;
    }
    if (!selected || selected.candidate.id !== envelope.selectedId)
        reasons.push('AUXILIARY_OBJECTIVE_ORDER_MISMATCH');
    if (selected && (!same(envelope.result.workspace, selected.candidate.workspace) || envelope.score !== selected.candidate.score || !same(envelope.result.calculationReport, selected.candidate.simulation.calculationReport)))
        reasons.push('SELECTED_EVIDENCE_CONFLICT');
    let trainingActionIds = selected?.actionIds;
    if (selected && !reasons.length && constructionOrder !== 'legacy-v1') {
        const trainingScenario = createFullScenario(base, inventory, { constructionOrder, simulationConditioning: scenario.simulationConditioning });
        if (trainingScenario.constructionOrder !== constructionOrder)
            throw Error('Construction-order API did not honor the declared training protocol');
        const reinverted = replayFullTeacher(trainingScenario, selected.candidate.workspace);
        if (!reinverted.complete || !reinverted.exactReplay || digest(fullSemanticWorkspace(trainingScenario, selected.candidate.workspace)) !== selected.semanticHash)
            reasons.push('TRAINING_ORDER_EXACT_REPLAY_FAILED');
        else
            trainingActionIds = reinverted.trace.map((t: any) => t.action.id);
    }
    const audit = { constructionOrder, producerConstructionOrder: 'legacy-v1', ...admission, qualified: !reasons.length && !!selected, reasons: [...admission.reasons, ...reasons], candidateAudits: audits, selectedId: envelope.selectedId, allCandidateEvidenceHash: digest(envelope.candidates), ordering: 'workspace preference, production efficiency, completed simulated score; stable producer tie order' };
    if (!audit.qualified)
        return { record: null, audit };
    return { audit, record: { familyId: input.familyId, originalSplit: input.split, input, constructionOrder, actionIds: trainingActionIds, teacherSemanticHash: selected.semanticHash, teacherScore: selected.candidate.score, teacherRecordHash: digest(outcome), degradedBaseline: null, producerFallback: selected.candidate.id === 'singleton_fallback', producerCandidateId: selected.candidate.id, producerDiagnostics: selected.candidate.producerDiagnostics ?? [], baselineEligible: false, sourceKind: MOLECULAR_TEACHER_KIND, inputProfile: admission.inputProfile, purpose: 'training', fullOptimizerTeacher: false, teacherProvenance: { producerConstructionOrder: 'legacy-v1', inputProfile: admission.inputProfile, manifestHash: admission.manifestHash, producerSourceHash: admission.producerSourceHash, producerBundleHash: admission.producerBundleHash, allCandidateEvidenceHash: audit.allCandidateEvidenceHash, selectedId: envelope.selectedId, selectedEvidenceHash: digest(selected.candidate), selectionOrdering: audit.ordering } } };
}
