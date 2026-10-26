import { compileOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory';
import { resolveOperatorCharId as operatorId } from '../../domain/operatorIdentifiers';
import { MOWER_OPERATOR_LIST_FIELDS, type RosterWorkspace } from '../../domain/roster';
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import { compareWorkspacePreference } from '../automaticCombinationPreferences';
import { compareProductionEfficiency } from '../productionEfficiencyPriority';
import { validatePhysicalRoster } from '../rosterDraft';
import { recoveryGroupCapacityIssues } from '../recoveryGroupCapacity';
import { facilityCapacity } from '../../domain/facilities';
import { canReferencePhysical } from './fullActionSpace';
import { physicalBackupOperatorIds } from '../combinationModel';
import type { CandidateSimulationResult } from '../candidateSimulation';
import { applyGeneratedWarmupPolicy } from '../generatedWarmupPolicy';
import { applyGeneratedRecoveryPolicy } from '../generatedRecoveryPolicy';
import { normalizeProductionWeights } from '../../domain/productionWeights';
import { compiledScheduleToRuntimeConfig } from '../../scheduler/scheduleAdapter';
import { createRosterRuntime } from '../../scheduler/rosterRuntime';
import { getMowerSourceRuntime } from '../../scheduler/mowerSourceRuntime';
/** Browser-safe mirror, cross-checked against the teacher protocol module in tests. */
export const FULL_LATEST_REFERENCE_PROTOCOL = Object.freeze({
    id: 'latest-default-two-stage-v1', revision: 1, construction: 'one-initial-plus-computed-manufacturing',
    ranking: 'finite-score-first-preference-efficiency-ties', warmupPolicy: 'generated-warmup-exhaustion-v1',
    recoveryPolicy: 'generated-recovery-v1', deepSearch: false, modelBudgetPolicy: 'exact-frozen-upstream-defaults',
    modelProofScope: 'quantified-manufacturing-model-only',
} as const);
export interface FullParityReferenceBinding {
    referenceProtocol: typeof FULL_LATEST_REFERENCE_PROTOCOL;
    producerSourceHash: string;
    producerBundleHash: string;
}
export type FullParityObjective = { version: 'legacy-componentwise-v1' }
    | ({ version: 'latest-default-lexicographic-v2' } & FullParityReferenceBinding);
/** Hashes are external commitments, not authenticated by this pure evaluator. */
export interface FullParityContract {
    scenarioHash: string;
    inventoryHash: string;
    sharedEngineHash: string;
    catalogHash: string;
    rulesHash: string;
    weights: {
        exp: number;
        gold: number;
        orders: number;
        fragments: number;
        orundum: number;
    };
    droneTarget: string;
    droneRoomId: string | null;
    warmupHours: number;
    sampleHours: number;
    seed: number;
    optimizerSeed: number;
    maxStepHours: number;
    generationWallBudgetMs: number;
    executionResourcesHash: string;
    resolvedSimulatorOptionsHash: string;
}
export interface FullParityCase {
    caseId: string;
    familyId: string;
    size: number;
    stratum: string;
    contract: FullParityContract;
}
export interface FullParityManifest {
    /** Absence preserves historical componentwise semantics; latest is an explicit new gate. */
    objective?: FullParityObjective;
    mode: 'development' | 'release';
    scope: string;
    /** Nonstandard sizes require an explicitly named, narrower layout study. */
    layoutStudy?: {
        name: string;
        sizes: number[];
    };
    expectedCases: FullParityCase[];
    minimumFamiliesPerStratum: Record<string, number>;
    splitFamilies: {
        training: string[];
        development: string[];
        release: string[];
    };
    /** Canonical inventory+stage commitments for ALL split families, including prior training. */
    familyInventoryHashes: Record<string, string>;
    checkpointHash: string;
    release?: {
        id: string;
        cohortHash: string;
        splitHash: string;
        frozenAt: string;
        checkpointFrozenAt: string;
        labelsFirstOpenedAt: string;
        previouslyUsed: boolean;
    };
    /** Absolute score envelope only, justified by a preregistered identical-replay proof. Default zero. */
    roundoff?: {
        absolute: number;
        proofArtifactHash: string;
        provenance: string;
        frozenBeforeLabels: boolean;
    };
}
export interface FullParityRun {
    referenceBinding?: FullParityReferenceBinding;
    /** Original roster generator provenance, distinct from authoritative rescoring sourceHash. */
    generationProvenance?: { sourceHash: string; bundleHash: string };
    status: 'completed' | 'failed' | 'timeout' | 'incomplete';
    contract: FullParityContract;
    sourceHash: string;
    checkpointHash?: string;
    generationElapsedMs: number;
    workspace: RosterWorkspace | null;
    result: CandidateSimulationResult | null;
    /** Exact authoritative verification artifact, containing the raw result, not an optimizer's predicted score. */
    authoritativeArtifactHash: string;
    rawDaily: FullParityContract['weights'] | null;
    fallbackPhysicalPlacements: number;
}
export interface FullParityAttempt {
    caseId: string;
    inputWorkspace: RosterWorkspace;
    entries: OwnedOperatorInput[];
    baseline: FullParityRun | null;
    neural: FullParityRun | null;
}
export interface FullParityPairReport {
    caseId: string;
    familyId: string | null;
    size: number | null;
    stratum: string | null;
    status: 'pass' | 'fail' | 'inconclusive';
    issues: string[];
    baselineAvailable: boolean;
    neuralAvailable: boolean;
    baselineScore: number | null;
    neuralScore: number | null;
    delta: number | null;
    ratio: number | null;
    preferenceComparison: number | null;
    efficiencyComparison: number | null;
    baselineRawDaily: FullParityRun['rawDaily'];
    neuralRawDaily: FullParityRun['rawDaily'];
}
export interface FullParitySummary {
    attempts: number;
    independentFamilies: number;
    successes: number;
    failures: number;
    inconclusive: number;
    baselineAvailable: number;
    neuralAvailable: number;
    comparable: number;
    wins: number;
    ties: number;
    losses: number;
    meanDelta: number | null;
    worstDelta: number | null;
    totalRegret: number | null;
}
export interface FullParityReport {
    objectiveVersion: FullParityObjective['version'];
    referenceBinding: FullParityReferenceBinding | null;
    status: 'release-parity' | 'development-pass' | 'fail' | 'inconclusive';
    scope: string;
    issues: string[];
    scoreRoundoff: number;
    pairs: FullParityPairReport[];
    overall: FullParitySummary;
    bySize: Record<string, FullParitySummary>;
    byStratum: Record<string, FullParitySummary>;
    limitation: string;
}
function stable(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}
function validContract(c: FullParityContract): boolean {
    return [c.scenarioHash, c.inventoryHash, c.sharedEngineHash, c.catalogHash, c.rulesHash, c.executionResourcesHash, c.resolvedSimulatorOptionsHash, c.droneTarget].every(s => typeof s === 'string' && s.length > 0)
        && Object.values(c.weights).length === 5 && Object.values(c.weights).every(Number.isFinite)
        && Number.isFinite(c.warmupHours) && c.warmupHours >= 0 && Number.isFinite(c.sampleHours) && c.sampleHours > 0
        && Number.isFinite(c.maxStepHours) && c.maxStepHours > 0 && Number.isSafeInteger(c.seed) && Number.isSafeInteger(c.optimizerSeed)
        && Number.isFinite(c.generationWallBudgetMs) && c.generationWallBudgetMs > 0;
}
function available(r: FullParityRun | null): boolean {
    return !!r && r.status === 'completed' && r.result?.completed === true && (!r.result.incomeCase || r.result.incomeCase.eligible === true) && Number.isFinite(r.result.simScore)
        && !!r.workspace && !!r.authoritativeArtifactHash && !!r.rawDaily && Object.values(r.rawDaily).length === 5 && Object.values(r.rawDaily).every(Number.isFinite);
}
function validLatestBinding(binding: FullParityReferenceBinding): boolean {
    return stable(binding.referenceProtocol) === stable(FULL_LATEST_REFERENCE_PROTOCOL)
        && [binding.producerSourceHash, binding.producerBundleHash].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}
/** Protocol-specific admissibility, not universal game legality; never repair a scored workspace. */
function latestWorkspaceIssues(input: RosterWorkspace, output: RosterWorkspace, entries: OwnedOperatorInput[], weights: FullParityContract['weights']): string[] {
    const issues: string[] = [], inventory = compileOperatorInventory(entries), owned = new Set(inventory.operators.map(op => op.charId));
    if (stable(normalizeProductionWeights(output.productionWeights)) !== stable(weights)) issues.push('PRODUCTION_WEIGHTS_MISMATCH');
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        const before = input.mainPlan.conf[field], after = output.mainPlan.conf[field];
        const canonical = (refs: typeof before) => refs === undefined ? undefined : Array.isArray(refs) && refs.every(ref => typeof ref === 'string') ? refs.map(operatorId) : null;
        const a = canonical(before), b = canonical(after);
        // Duplicate/suffixed/unknown references need a richer action domain, not lossy normalization.
        if ([a, b].some(refs => refs === null || refs && (new Set(refs).size !== refs.length || refs.some(ref => !owned.has(ref))))) {
            issues.push(`LATEST_UNSUPPORTED_POLICY_REFERENCE:${field}`);
        }
        if (a !== undefined && (!b || stable(b.slice(0, a?.length)) !== stable(a))) {
            issues.push(`INPUT_POLICY_PREFIX_CHANGED:${field}`);
        }
    }
    const otherConf = (ws: RosterWorkspace) => Object.fromEntries(Object.entries(ws.mainPlan.conf).filter(([key]) => !(MOWER_OPERATOR_LIST_FIELDS as readonly string[]).includes(key)));
    if (stable(otherConf(input)) !== stable(otherConf(output))) issues.push('INPUT_CONF_CHANGED');
    if (stable(input.compatibility) !== stable(output.compatibility)) issues.push('INPUT_COMPATIBILITY_CHANGED');
    if (input.schemaVersion !== output.schemaVersion || input.mainPlan.id !== output.mainPlan.id || input.droneCapacity !== output.droneCapacity) issues.push('INPUT_METADATA_CHANGED');
    for (const room of Object.values(output.mainPlan.facilities)) {
        room.slots.forEach((slot, index) => {
            if (stable(input.mainPlan.facilities[room.roomId]?.slots[index]?.metadata) !== stable(slot.metadata)) issues.push('INPUT_SLOT_METADATA_CHANGED');
            if (room.type === 'trading') {
                const refs = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements, ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements)];
                if (refs.some(ref => ['佩佩', 'U-Official'].some(name => operatorId(ref) === operatorId(name)))) issues.push('FORBIDDEN_TRADE_OPERATOR');
            }
        });
    }
    if (issues.some(issue => issue.startsWith('LATEST_UNSUPPORTED_POLICY_REFERENCE:'))) return [...new Set(issues)];
    const originalPermanent = new Set(input.mainPlan.conf.workaholic.map(operatorId)), permanent = new Set(output.mainPlan.conf.workaholic.map(operatorId));
    if ([...input.mainPlan.conf.exhaust_require, ...input.mainPlan.conf.rest_in_full].some(ref => !originalPermanent.has(operatorId(ref)) && permanent.has(operatorId(ref)))) {
        issues.push('INPUT_REST_POLICY_NEUTRALIZED');
    }
    const priorities = [...input.mainPlan.conf.resting_priority, ...input.mainPlan.conf.ope_resting_priority,
        ...(input.mainPlan.conf.resting_standby ?? []), ...(input.mainPlan.conf.resting_priority_replacement ?? [])].map(operatorId);
    if (priorities.length) {
        // Compare the native effective policy on the SAME final roles; do not infer thresholds or simulate.
        const originalPolicies = structuredClone(output);
        originalPolicies.mainPlan.conf = structuredClone(input.mainPlan.conf);
        const operators = (ws: RosterWorkspace) => {
            const config = compiledScheduleToRuntimeConfig(compileRosterSchedule(ws));
            config.mowerAlpha = true; // Latest reference executes the alpha scheduler, including ungrouped standby.
            return getMowerSourceRuntime(createRosterRuntime(config)).data.operators;
        };
        const before = operators(originalPolicies), after = operators(output);
        if (priorities.some(ref => before[ref] && after[ref] && before[ref]!.restingPriority !== after[ref]!.restingPriority)) issues.push('INPUT_REST_PRIORITY_CHANGED');
        if (priorities.some(ref => before[ref] && after[ref] && !before[ref]!.workaholic && after[ref]!.workaholic)) issues.push('INPUT_REST_POLICY_NEUTRALIZED');
    }
    const checked = structuredClone(output), warmup = applyGeneratedWarmupPolicy(checked, inventory);
    if (!warmup.valid) issues.push('LATEST_WARMUP_POLICY_UNSUPPORTED');
    if (warmup.addedExhaustOperatorIds.length) issues.push('LATEST_WARMUP_POLICY_MISSING');
    applyGeneratedRecoveryPolicy(checked);
    if (stable(checked.mainPlan.conf.rest_in_full.map(operatorId)) !== stable(output.mainPlan.conf.rest_in_full.map(operatorId))) issues.push('LATEST_RECOVERY_POLICY_MISSING');
    return [...new Set(issues)];
}
function workspaceIssues(input: RosterWorkspace, output: RosterWorkspace, entries: OwnedOperatorInput[]): string[] {
    const issues: string[] = [], owned = compileOperatorInventory(entries);
    if (!owned.valid)
        issues.push('INVALID_INVENTORY_STAGE');
    const ids = new Set(owned.operators.map(o => o.charId));
    const layout = (w: RosterWorkspace) => Object.fromEntries(Object.entries(w.mainPlan.facilities).map(([key, room]) => {
        const { slots, ...rest } = room;
        return [key, { ...rest, slotCount: slots.length }];
    }));
    if (stable(layout(input)) !== stable(layout(output)))
        issues.push('INPUT_LAYOUT_CHANGED');
    if (output.compatibility.backupPlans.length)
        issues.push('BACKUP_PLANS_FORBIDDEN');
    for (const room of Object.values(output.mainPlan.facilities)) {
        if (room.level > 0 && room.type === 'dormitory' && !room.slots.some(s => s.occupant.kind === 'operator'))
            issues.push('DORM_KEEPER_MISSING');
        if (room.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(room.type) && room.slots.length < facilityCapacity(room.type, room.level))
            issues.push('UNSTAFFED_MANDATORY_SLOT');
        room.slots.forEach((slot, index) => {
            const before = input.mainPlan.facilities[room.roomId]?.slots[index];
            if (before && (before.occupant.kind === 'operator' || before.replacements.length || before.groupId || before.groupBindings?.length) && stable(before) !== stable(slot))
                issues.push('INPUT_LOCK_CHANGED');
            if (room.level > 0 && index < facilityCapacity(room.type, room.level) && ['manufacture', 'trading', 'power', 'central'].includes(room.type) && slot.occupant.kind !== 'operator')
                issues.push('UNSTAFFED_MANDATORY_SLOT');
            if (room.level > 0 && room.type !== 'dormitory' && slot.occupant.kind === 'operator' && !output.mainPlan.conf.workaholic.map(operatorId).includes(operatorId(slot.occupant.operatorId)) && !physicalBackupOperatorIds(room, slot).length && !(slot.groupBindings ?? []).some(b => physicalBackupOperatorIds(room, b).length))
                issues.push('MISSING_ORDINARY_RELIEF');
            for (const [bindingIndex, binding] of [slot, ...(slot.groupBindings ?? [])].entries())
                for (const ref of physicalBackupOperatorIds(room, binding)) {
                    if (!canReferencePhysical(output, {
                        kind: bindingIndex === 0 ? 'replacement' : 'binding-replacement', roomId: room.roomId, slotIndex: index, bindingIndex: bindingIndex - 1
                    }, ref))
                        issues.push('CONFLICTING_PHYSICAL_RELIEF');
                }
            const refs = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements, ...(slot.groupBindings ?? []).flatMap(b => b.replacements)];
            if (refs.some(ref => ref !== 'Free' && !ids.has(operatorId(ref))))
                issues.push('UNOWNED_OPERATOR');
        });
    }
    const permanent = new Set(output.mainPlan.conf.workaholic.map(operatorId));
    if (Object.values(output.mainPlan.facilities).some(r => r.level > 0 && r.type !== 'dormitory' && r.slots.some(s => s.occupant.kind === 'operator' && !permanent.has(operatorId(s.occupant.operatorId)))) && !Object.values(output.mainPlan.facilities).some(r => r.level > 0 && r.type === 'dormitory' && r.slots.some(s => s.occupant.kind === 'free' || s.replacements.includes('Free'))))
        issues.push('NO_RECOVERY_BEDS');
    for (const field of MOWER_OPERATOR_LIST_FIELDS)
        if (output.mainPlan.conf[field]?.some(ref => !ids.has(operatorId(ref))))
            issues.push('UNOWNED_POLICY_REFERENCE');
    issues.push(...validatePhysicalRoster(output).map(d => d.code), ...recoveryGroupCapacityIssues(output).map(d => d.code), ...compileRosterSchedule(output).diagnostics.filter(d => d.severity === 'error' || d.code === 'UNKNOWN_OPERATOR').map(d => d.code));
    return [...new Set(issues)];
}
function summarize(rows: FullParityPairReport[]): FullParitySummary {
    const deltas = rows.flatMap(r => r.delta === null ? [] : [r.delta]);
    return {
        attempts: rows.length, independentFamilies: new Set(rows.flatMap(r => r.familyId ? [r.familyId] : [])).size,
        successes: rows.filter(r => r.status === 'pass').length, failures: rows.filter(r => r.status === 'fail').length, inconclusive: rows.filter(r => r.status === 'inconclusive').length,
        baselineAvailable: rows.filter(r => r.baselineAvailable).length, neuralAvailable: rows.filter(r => r.neuralAvailable).length,
        comparable: deltas.length, wins: deltas.filter(d => d > 0).length, ties: deltas.filter(d => d === 0).length, losses: deltas.filter(d => d < 0).length,
        meanDelta: deltas.length ? deltas.reduce((a, b) => a + b / deltas.length, 0) : null,
        worstDelta: deltas.length ? Math.min(...deltas) : null, totalRegret: deltas.length ? deltas.reduce((a, b) => a + Math.max(0, -b), 0) : null
    };
}
/** No simulation, fallback, optimizer generation, mutation, or score imputation. */
export function evaluateFullParity(manifest: FullParityManifest, attempts: readonly FullParityAttempt[]): FullParityReport {
    const issues: string[] = [], expected = new Map<string, FullParityCase>(), seenFamilies = new Map<string, string>(), inventoryOwners = new Map<string, string>();
    const objectiveVersion = manifest.objective?.version ?? 'legacy-componentwise-v1';
    if (!['legacy-componentwise-v1', 'latest-default-lexicographic-v2'].includes(objectiveVersion)) issues.push('UNKNOWN_PARITY_OBJECTIVE');
    const latestObjective = manifest.objective?.version === 'latest-default-lexicographic-v2' ? manifest.objective : undefined;
    const latest = latestObjective !== undefined;
    const referenceBinding: FullParityReferenceBinding | null = latestObjective ? {
        referenceProtocol: latestObjective.referenceProtocol, producerSourceHash: latestObjective.producerSourceHash,
        producerBundleHash: latestObjective.producerBundleHash,
    } : null;
    if (referenceBinding && !validLatestBinding(referenceBinding)) issues.push('INVALID_LATEST_REFERENCE_BINDING');
    if (!manifest.scope.trim() || !manifest.checkpointHash)
        issues.push('MISSING_SCOPE_OR_CHECKPOINT');
    for (const [split, families] of Object.entries(manifest.splitFamilies))
        for (const family of families) {
            if (seenFamilies.has(family))
                issues.push('DUPLICATE_OR_LEAKED_SPLIT_FAMILY');
            seenFamilies.set(family, split);
            const hash = manifest.familyInventoryHashes?.[family];
            if (!hash)
                issues.push('MISSING_FAMILY_INVENTORY_HASH');
            else {
                if (inventoryOwners.has(hash) && inventoryOwners.get(hash) !== family)
                    issues.push('CANONICAL_INVENTORY_FAMILY_COLLISION');
                inventoryOwners.set(hash, family);
            }
        }
    for (const c of manifest.expectedCases) {
        if (expected.has(c.caseId))
            issues.push('DUPLICATE_EXPECTED_CASE');
        expected.set(c.caseId, c);
        if (manifest.familyInventoryHashes?.[c.familyId] !== c.contract.inventoryHash)
            issues.push('FAMILY_INVENTORY_HASH_MISMATCH');
        if (!c.caseId || !c.familyId || !c.stratum || !Number.isSafeInteger(c.size) || c.size < 1 || !validContract(c.contract))
            issues.push('INVALID_EXPECTED_CASE');
        if (seenFamilies.get(c.familyId) !== manifest.mode)
            issues.push('CASE_SPLIT_MISMATCH');
    }
    if (!expected.size)
        issues.push('EMPTY_COHORT');
    const sizes = manifest.layoutStudy?.sizes ?? [100, 200, 300, 400];
    if (manifest.layoutStudy && (!manifest.layoutStudy.name.trim() || !sizes.length))
        issues.push('INVALID_LAYOUT_STUDY');
    for (const size of sizes)
        if (!manifest.expectedCases.some(c => c.size === size))
            issues.push(`MISSING_SIZE:${size}`);
    for (const c of manifest.expectedCases) {
        if (!sizes.includes(c.size))
            issues.push(`UNDECLARED_SIZE:${c.size}`);
        if (!(c.stratum in manifest.minimumFamiliesPerStratum))
            issues.push(`UNDECLARED_STRATUM:${c.stratum}`);
    }
    for (const [stratum, min] of Object.entries(manifest.minimumFamiliesPerStratum)) {
        if (!Number.isSafeInteger(min) || min < 1)
            issues.push(`INVALID_MINIMUM:${stratum}`);
        for (const size of sizes)
            if (new Set(manifest.expectedCases.filter(c => c.size === size && c.stratum === stratum).map(c => c.familyId)).size < min)
                issues.push(`INSUFFICIENT_FAMILIES:${size}:${stratum}`);
    }
    if (manifest.mode === 'release') {
        const expectedFamilies = new Set(manifest.expectedCases.map(c => c.familyId));
        if (manifest.splitFamilies.release.some(f => !expectedFamilies.has(f)))
            issues.push('RELEASE_FAMILY_MISSING_FROM_COHORT');
        const r = manifest.release;
        if (!r || !r.id || !r.cohortHash || !r.splitHash || r.previouslyUsed || ![r.frozenAt, r.checkpointFrozenAt, r.labelsFirstOpenedAt].every(t => Number.isFinite(Date.parse(t)))
            || Date.parse(r.frozenAt) >= Date.parse(r.labelsFirstOpenedAt) || Date.parse(r.checkpointFrozenAt) >= Date.parse(r.labelsFirstOpenedAt))
            issues.push('RELEASE_NOT_FROZEN_BEFORE_LABELS');
    }
    const tolerance = manifest.roundoff?.absolute ?? 0;
    if (latest && tolerance !== 0) issues.push('LATEST_OBJECTIVE_REQUIRES_EXACT_SCORE_COMPARISON');
    if (!Number.isFinite(tolerance) || tolerance < 0 || (tolerance > 0 && (!manifest.roundoff?.proofArtifactHash || !manifest.roundoff.provenance || !manifest.roundoff.frozenBeforeLabels)))
        issues.push('UNPROVEN_ROUNDOFF');
    const counts = new Map<string, number>();
    for (const a of attempts)
        counts.set(a.caseId, (counts.get(a.caseId) ?? 0) + 1);
    const all = [...attempts, ...manifest.expectedCases.filter(c => !counts.has(c.caseId)).map(c => ({ caseId: c.caseId, baseline: null, neural: null } as FullParityAttempt))];
    const pairs = all.map(a => {
        const c = expected.get(a.caseId), b = a.baseline, n = a.neural, local: string[] = [];
        const ba = available(b), na = available(n);
        const row: FullParityPairReport = {
            caseId: a.caseId, familyId: c?.familyId ?? null, size: c?.size ?? null, stratum: c?.stratum ?? null, status: 'inconclusive', issues: local,
            baselineAvailable: ba, neuralAvailable: na, baselineScore: ba ? b!.result!.simScore : null, neuralScore: na ? n!.result!.simScore : null,
            delta: null, ratio: null, preferenceComparison: null, efficiencyComparison: null, baselineRawDaily: b?.rawDaily ?? null, neuralRawDaily: n?.rawDaily ?? null
        };
        if (!c)
            local.push('UNEXPECTED_ATTEMPT');
        if (c && a.entries && compileOperatorInventory(a.entries).operators.length !== c.size)
            local.push('INVENTORY_SIZE_MISMATCH');
        if ((counts.get(a.caseId) ?? 0) > 1)
            local.push('DUPLICATE_ATTEMPT');
        if (!counts.has(a.caseId))
            local.push('MISSING_PAIR');
        for (const [role, run] of [['BASELINE', b], ['NEURAL', n]] as const)
            if (run) {
                if (referenceBinding && stable(run.referenceBinding) !== stable(referenceBinding)) local.push(`${role}_REFERENCE_BINDING_MISMATCH`);
                if (role === 'BASELINE' && referenceBinding && (run.generationProvenance?.sourceHash !== referenceBinding.producerSourceHash
                    || run.generationProvenance?.bundleHash !== referenceBinding.producerBundleHash)) local.push('BASELINE_GENERATION_PROVENANCE_MISMATCH');
                if (!c || stable(run.contract) !== stable(c.contract))
                    local.push(`${role}_CONFIG_MISMATCH`);
                if (!run.sourceHash || !Number.isFinite(run.generationElapsedMs) || run.generationElapsedMs < 0 || run.generationElapsedMs > run.contract.generationWallBudgetMs)
                    local.push(`${role}_GENERATION_BUDGET_OR_SOURCE_INVALID`);
                if (run.workspace) {
                    try {
                        local.push(...workspaceIssues(a.inputWorkspace, run.workspace, a.entries).map(s => `${role}_${s}`));
                        if (latest) local.push(...latestWorkspaceIssues(a.inputWorkspace, run.workspace, a.entries, run.contract.weights).map(s => `${role}_${s}`));
                    }
                    catch {
                        local.push(`${role}_INVALID_WORKSPACE`);
                    }
                }
            }
        if (n && (n.fallbackPhysicalPlacements !== 0 || n.checkpointHash !== manifest.checkpointHash))
            local.push('NEURAL_FALLBACK_OR_CHECKPOINT_MISMATCH');
        if (!ba)
            local.push('BASELINE_UNAVAILABLE');
        if (!na)
            local.push('NEURAL_UNAVAILABLE');
        if (ba && na) {
            row.delta = row.neuralScore! - row.baselineScore!;
            row.ratio = row.baselineScore === 0 ? null : row.neuralScore! / row.baselineScore!;
            if (!Number.isFinite(row.delta) || (row.ratio !== null && !Number.isFinite(row.ratio)))
                local.push('NONFINITE_COMPARISON');
            try {
                row.preferenceComparison = compareWorkspacePreference(n!.workspace!, b!.workspace!);
                row.efficiencyComparison = compareProductionEfficiency(n!.workspace!, b!.workspace!, compileOperatorInventory(a.entries));
                if (row.preferenceComparison < 0 && (!latest || row.delta === 0))
                    local.push('PREFERENCE_REGRESSION');
                if (row.efficiencyComparison < 0 && (!latest || row.delta === 0 && row.preferenceComparison === 0))
                    local.push('EFFICIENCY_REGRESSION');
            }
            catch {
                local.push('COMPARATOR_ERROR');
            }
            if (row.delta < -(latest ? 0 : tolerance))
                local.push('SCORE_REGRESSION');
        }
        row.status = local.some(s => !['BASELINE_UNAVAILABLE', 'NEURAL_UNAVAILABLE', 'MISSING_PAIR'].includes(s)) || (ba && !na) ? 'fail' : local.length ? 'inconclusive' : 'pass';
        return row;
    });
    const overall = summarize(pairs), bySize: Record<string, FullParitySummary> = {}, byStratum: Record<string, FullParitySummary> = {};
    for (const size of new Set([...sizes, ...pairs.flatMap(r => r.size === null ? [] : [r.size])]))
        bySize[size] = summarize(pairs.filter(r => r.size === size));
    for (const key of new Set(manifest.expectedCases.map(c => `${c.size}:${c.stratum}`)))
        byStratum[key] = summarize(pairs.filter(r => `${r.size}:${r.stratum}` === key));
    return {
        objectiveVersion, referenceBinding,
        status: issues.length || overall.failures ? 'fail' : overall.inconclusive ? 'inconclusive' : manifest.mode === 'release' ? 'release-parity' : 'development-pass',
        scope: manifest.scope, issues: [...new Set(issues)], scoreRoundoff: tolerance, pairs, overall, bySize, byStratum,
        limitation: 'Finite declared cohort only; no universal, real-game, or statistical population parity claim. Means use comparable pairs only; every attempt and missing expected pair remains in the denominator. External artifact hashes and freeze attestations must be independently verified.'
    };
}
