import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { fullCatalogIdleInventory, compileOperatorInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { evaluateFullParity, FULL_LATEST_REFERENCE_PROTOCOL, type FullParityManifest, type FullParityAttempt, type FullParityContract, type FullParityRun } from './fullParity';
import { applyGeneratedRecoveryPolicy } from '../generatedRecoveryPolicy';
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
function fixture() {
    const entries = fullCatalogIdleInventory(), inventory = compileOperatorInventory(entries), inputWorkspace = createDefaultWorkspace(), workspace = structuredClone(inputWorkspace);
    const operators = inventory.operators.filter(o => !['迷迭香', '絮雨', '黑键', '佩佩', 'U-Official', '菲亚梅塔', '但书', '龙舌兰'].includes(o.name));
    let i = 0;
    for (const room of Object.values(workspace.mainPlan.facilities))
        if (room.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(room.type))
            for (const slot of room.slots) {
                const ref = operators[i++]!.charId;
                slot.occupant = { kind: 'operator', operatorId: ref };
                workspace.mainPlan.conf.workaholic.push(ref);
            }
    for (const room of Object.values(workspace.mainPlan.facilities))
        if (room.level > 0 && room.type === 'dormitory')
            room.slots[0]!.occupant = { kind: 'operator', operatorId: operators[i++]!.charId };
    const contract: FullParityContract = {
        scenarioHash: 'scenario', inventoryHash: 'inventory', sharedEngineHash: 'engine', catalogHash: 'catalog', rulesHash: 'rules', weights: {
            exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0
        }, droneTarget: 'gold', droneRoomId: null, warmupHours: 24, sampleHours: 72, seed: 1, optimizerSeed: 2, maxStepHours: .25, generationWallBudgetMs: 1000, executionResourcesHash: 'cpu1', resolvedSimulatorOptionsHash: 'all-options'
    };
    const run: FullParityRun = {
        status: 'completed', contract, sourceHash: 'baseline-source', generationElapsedMs: 100, workspace, result: { completed: true, simScore: 100, diagnostics: [] }, authoritativeArtifactHash: 'raw-result', rawDaily: {
            exp: 100, gold: 0, orders: 0, fragments: 0, orundum: 0
        }, fallbackPhysicalPlacements: 0
    };
    const manifest: FullParityManifest = {
        mode: 'development', scope: 'Synthetic public-fixture layout only; aggregation unit tests, not measured parity', layoutStudy: { name: 'public-fixture', sizes: [entries.length] }, expectedCases: [{
                caseId: 'a', familyId: 'f', size: entries.length, stratum: 'actual-stage', contract
            }], minimumFamiliesPerStratum: { 'actual-stage': 1 }, splitFamilies: { training: [], development: ['f'], release: [] }, familyInventoryHashes: { f: 'inventory' }, checkpointHash: 'model'
    };
    const attempt: FullParityAttempt = {
        caseId: 'a', inputWorkspace, entries, baseline: structuredClone(run), neural: { ...structuredClone(run), sourceHash: 'neural-added-source', checkpointHash: 'model' }
    };
    return { manifest, attempt };
}
describe('strict finite-cohort parity', () => {
    it('accepts exact development ties with actual comparator wiring, never release claims', () => {
        const { manifest, attempt } = fixture(), before = structuredClone(attempt), r = evaluateFullParity(manifest, [attempt]);
        expect(r.pairs[0]!.issues).toEqual([]);
        expect(r.status).toBe('development-pass');
        expect(r.pairs[0]!.preferenceComparison).toBe(0);
        expect(r.pairs[0]!.efficiencyComparison).toBe(0);
        expect(attempt).toEqual(before);
    });
    it('fails any score loss including tiny losses by default', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.result!.simScore -= 1e-10;
        const r = evaluateFullParity(manifest, [attempt]);
        expect(r.status).toBe('fail');
        expect(r.overall.losses).toBe(1);
    });
    it('does not hide policy regression behind higher income (real preference comparator)', () => {
        const { manifest, attempt } = fixture(), b = attempt.baseline!.workspace!;
        b.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('迷迭香') };
        b.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'operator', operatorId: id('絮雨') };
        b.mainPlan.conf.workaholic.push(id('迷迭香'), id('絮雨'));
        attempt.neural!.result!.simScore = 200;
        const r = evaluateFullParity(manifest, [attempt]);
        expect(r.pairs[0]!.issues).toContain('PREFERENCE_REGRESSION');
        expect(r.status).toBe('fail');
    });
    it.each(['failed', 'timeout', 'incomplete'] as const)('retains %s baseline as inconclusive rather than zero', status => {
        const { manifest, attempt } = fixture();
        attempt.baseline!.status = status;
        const r = evaluateFullParity(manifest, [attempt]);
        expect(r.status).toBe('inconclusive');
        expect(r.overall.attempts).toBe(1);
        expect(r.pairs[0]!.baselineScore).toBeNull();
        expect(r.overall.meanDelta).toBeNull();
    });
    it('retains absent baseline as inconclusive', () => {
        const { manifest, attempt } = fixture();
        attempt.baseline = null;
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('inconclusive');
    });
    it('fails missing neural result when baseline completed', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.result = null;
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it.each([NaN, Infinity, -Infinity])('rejects nonfinite score %s', score => {
        const { manifest, attempt } = fixture();
        attempt.neural!.result!.simScore = score;
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('keeps missing expected pairs in denominator', () => {
        const { manifest } = fixture();
        const r = evaluateFullParity(manifest, []);
        expect(r.status).toBe('inconclusive');
        expect(r.overall.attempts).toBe(1);
        expect(r.pairs[0]!.issues).toContain('MISSING_PAIR');
    });
    it('fails duplicate attempts without discarding denominator', () => {
        const { manifest, attempt } = fixture();
        const r = evaluateFullParity(manifest, [attempt, attempt]);
        expect(r.status).toBe('fail');
        expect(r.overall.attempts).toBe(2);
    });
    it('fails split family leakage', () => {
        const { manifest, attempt } = fixture();
        manifest.splitFamilies.training = ['f'];
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('DUPLICATE_OR_LEAKED_SPLIT_FAMILY');
    });
    it('fails mismatched seeds and allows differing generator source only', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.contract.seed++;
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_CONFIG_MISMATCH');
    });
    it('fails fallback physical placements', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.fallbackPhysicalPlacements = 1;
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('fails missing size strata in general cohort', () => {
        const { manifest, attempt } = fixture();
        delete manifest.layoutStudy;
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('MISSING_SIZE:100');
    });
    it('requires declared minimum independent families, not replica count', () => {
        const { manifest, attempt } = fixture();
        manifest.minimumFamiliesPerStratum['actual-stage'] = 2;
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('requires release freeze before labels and disjoint release split', () => {
        const { manifest, attempt } = fixture();
        manifest.mode = 'release';
        manifest.splitFamilies = { training: [], development: [], release: ['f'] };
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
        manifest.release = {
            id: 'r1', cohortHash: 'cohort', splitHash: 'split', frozenAt: '2026-01-01', checkpointFrozenAt: '2026-01-02', labelsFirstOpenedAt: '2026-01-03', previouslyUsed: false
        };
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('release-parity');
    });
    it('does not permit an unexplained score tolerance', () => {
        const { manifest, attempt } = fixture();
        manifest.roundoff = {
            absolute: 5, proofArtifactHash: '', provenance: '', frozenBeforeLabels: false
        };
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('UNPROVEN_ROUNDOFF');
    });
    it('reports zero score ratio as undefined and actual completed zero as zero', () => {
        const { manifest, attempt } = fixture();
        attempt.baseline!.result!.simScore = 0;
        attempt.neural!.result!.simScore = 0;
        const r = evaluateFullParity(manifest, [attempt]);
        expect(r.pairs[0]!.ratio).toBeNull();
        expect(r.pairs[0]!.delta).toBe(0);
    });
    it('rejects changed layout, locked slots, ownership and unstaffed mandatory slots', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.workspace!.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'empty' };
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_UNSTAFFED_MANDATORY_SLOT');
    });
    it('rejects canonical inventory relabeled as a training family', () => {
        const { manifest, attempt } = fixture();
        manifest.splitFamilies.training = ['alias'];
        manifest.familyInventoryHashes.alias = 'inventory';
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('CANONICAL_INVENTORY_FAMILY_COLLISION');
    });
    it('rejects duplicate expected cases', () => {
        const { manifest, attempt } = fixture();
        manifest.expectedCases.push(structuredClone(manifest.expectedCases[0]!));
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('DUPLICATE_EXPECTED_CASE');
    });
    it('rejects mismatched shared engine even if generation source differs legitimately', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.contract.sharedEngineHash = 'changed-rules';
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('rejects over-budget generation', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.generationElapsedMs = 1001;
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_GENERATION_BUDGET_OR_SOURCE_INVALID');
    });
    it('preserves explicit input locks', () => {
        const { manifest, attempt } = fixture();
        attempt.inputWorkspace.mainPlan.facilities.room_1_1.slots[0] = structuredClone(attempt.baseline!.workspace!.mainPlan.facilities.room_1_1.slots[0]!);
        attempt.neural!.workspace!.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'new';
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INPUT_LOCK_CHANGED');
    });
    it('rejects invalid actual stages', () => {
        const { manifest, attempt } = fixture();
        attempt.entries[0]!.elitePhase = 99;
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INVALID_INVENTORY_STAGE');
    });
    it('requires complete raw authoritative evidence', () => {
        const { manifest, attempt } = fixture();
        attempt.neural!.authoritativeArtifactHash = '';
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('requires a declared release family to appear in expected cases', () => {
        const { manifest, attempt } = fixture();
        manifest.mode = 'release';
        manifest.splitFamilies = { training: [], development: [], release: ['f', 'missing'] };
        manifest.familyInventoryHashes.missing = 'different';
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('RELEASE_FAMILY_MISSING_FROM_COHORT');
    });
    it('rejects physical relief reused across unrelated slots', () => {
        const { manifest, attempt } = fixture();
        const room = attempt.neural!.workspace!.mainPlan.facilities.room_1_1;
        room.slots[0]!.replacements = [id('迷迭香')];
        room.slots[1]!.replacements = [id('迷迭香')];
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_CONFLICTING_PHYSICAL_RELIEF');
    });
    it('reports losses even when aggregate mean wins', () => {
        const { manifest, attempt } = fixture();
        const second = structuredClone(attempt);
        second.caseId = 'b';
        manifest.expectedCases.push({ ...structuredClone(manifest.expectedCases[0]!), caseId: 'b' });
        attempt.neural!.result!.simScore = 99;
        second.neural!.result!.simScore = 200;
        const r = evaluateFullParity(manifest, [attempt, second]);
        expect(r.overall.meanDelta).toBe(49.5);
        expect(r.overall.worstDelta).toBe(-1);
        expect(r.overall.totalRegret).toBe(1);
        expect(r.status).toBe('fail');
    });
});

const latestProtocol = {
    id: 'latest-default-two-stage-v1', revision: 1, construction: 'one-initial-plus-computed-manufacturing',
    ranking: 'finite-score-first-preference-efficiency-ties', warmupPolicy: 'generated-warmup-exhaustion-v1',
    recoveryPolicy: 'generated-recovery-v1', deepSearch: false, modelBudgetPolicy: 'exact-frozen-upstream-defaults',
    modelProofScope: 'quantified-manufacturing-model-only',
} as const;
function latestFixture() {
    const { manifest, attempt } = fixture();
    const binding = { referenceProtocol: structuredClone(latestProtocol), producerSourceHash: 'a'.repeat(64), producerBundleHash: 'b'.repeat(64) };
    const latestManifest = Object.assign(manifest, { objective: { version: 'latest-default-lexicographic-v2' as const, ...binding } });
    for (const run of [attempt.baseline!, attempt.neural!]) Object.assign(run, { referenceBinding: structuredClone(binding) });
    Object.assign(attempt.baseline!, { generationProvenance: { sourceHash: binding.producerSourceHash, bundleHash: binding.producerBundleHash } });
    return { manifest: latestManifest, attempt };
}
function prefer(workspace: ReturnType<typeof createDefaultWorkspace>) {
    workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('迷迭香') };
    workspace.mainPlan.facilities.contact.slots[0]!.occupant = { kind: 'operator', operatorId: id('絮雨') };
    workspace.mainPlan.conf.workaholic.push(id('迷迭香'), id('絮雨'));
}
function efficiencyFixture() {
    const value = latestFixture(), base = createDefaultWorkspace();
    for (const room of Object.values(base.mainPlan.facilities)) {
        if (!['room_1_1', 'room_1_3', 'dormitory_1'].includes(room.roomId)) { room.level = 0; room.slots = []; }
    }
    base.mainPlan.facilities.room_1_1.level = 1;
    base.mainPlan.facilities.room_1_1.slots.length = 1;
    value.attempt.inputWorkspace = base;
    for (const [run, name] of [[value.attempt.baseline!, '砾'], [value.attempt.neural!, '缠丸']] as const) {
        run.workspace = structuredClone(base);
        run.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id(name) };
        run.workspace.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('杜林') };
        run.workspace.mainPlan.facilities.room_1_3.slots[0]!.occupant = { kind: 'operator', operatorId: id('Lancet-2') };
        run.workspace.mainPlan.conf.workaholic = [id(name), id('Lancet-2')];
    }
    return value;
}
describe('versioned latest-default parity objective', () => {
    it('pins the exact native reference declaration, not only a caller-selected objective string', async () => {
        const moduleUrl = new URL('../../../scripts/neural/full-baseline/reference-protocol.mjs', import.meta.url).href;
        const { referenceProtocol } = await import(/* @vite-ignore */ moduleUrl);
        expect(FULL_LATEST_REFERENCE_PROTOCOL).toEqual(referenceProtocol('latest-default-two-stage-v1'));
        const { manifest, attempt } = latestFixture();
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('development-pass');
        Object.assign(manifest.objective.referenceProtocol, { deepSearch: true });
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('INVALID_LATEST_REFERENCE_BINDING');
    });
    it.each([-1, 0, 1])('score delta %i outranks soft preference except on an exact score tie', delta => {
        const { manifest, attempt } = latestFixture();
        prefer(attempt.baseline!.workspace!);
        attempt.neural!.result!.simScore += delta;
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.preferenceComparison).toBeLessThan(0);
        expect(report.status).toBe(delta > 0 ? 'development-pass' : 'fail');
        expect(report.pairs[0]!.issues.includes('PREFERENCE_REGRESSION')).toBe(delta === 0);
    });
    it.each([-1, 0, 1])('uses efficiency only after tied score and preference (delta %i)', delta => {
        const { manifest, attempt } = efficiencyFixture();
        attempt.neural!.result!.simScore += delta;
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.preferenceComparison).toBe(0);
        expect(report.pairs[0]!.efficiencyComparison).toBeLessThan(0);
        expect(report.status).toBe(delta > 0 ? 'development-pass' : 'fail');
        expect(report.pairs[0]!.issues.includes('EFFICIENCY_REGRESSION')).toBe(delta === 0);
    });
    it('accepts an exact score tie with a preferred roster and retains raw comparator evidence', () => {
        const { manifest, attempt } = latestFixture();
        prefer(attempt.neural!.workspace!);
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.preferenceComparison).toBeGreaterThan(0);
        expect(report.status).toBe('development-pass');
    });
    it.each(['missing-objective-binding', 'protocol', 'producer-source', 'producer-bundle', 'generation-source', 'generation-bundle'] as const)('fails closed on %s mismatch', kind => {
        const { manifest, attempt } = latestFixture();
        const run = attempt.baseline! as FullParityRun & { referenceBinding?: typeof manifest.objective; generationProvenance: { sourceHash: string; bundleHash: string } };
        if (kind === 'missing-objective-binding') delete run.referenceBinding;
        if (kind === 'protocol') Object.assign(run.referenceBinding!.referenceProtocol, { revision: 2 });
        if (kind === 'producer-source') run.referenceBinding!.producerSourceHash = 'c'.repeat(64);
        if (kind === 'producer-bundle') run.referenceBinding!.producerBundleHash = 'c'.repeat(64);
        if (kind === 'generation-source') run.generationProvenance.sourceHash = 'c'.repeat(64);
        if (kind === 'generation-bundle') run.generationProvenance.bundleHash = 'c'.repeat(64);
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('fail');
    });
    it('rejects unknown gate versions and nonzero tolerance rather than inventing latest score ties', () => {
        const { manifest, attempt } = latestFixture();
        Object.assign(manifest.objective, { version: 'arbitrary-bypass' });
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('UNKNOWN_PARITY_OBJECTIVE');
        manifest.objective.version = 'latest-default-lexicographic-v2';
        manifest.roundoff = { absolute: 1, proofArtifactHash: 'proof', provenance: 'proof', frozenBeforeLabels: true };
        expect(evaluateFullParity(manifest, [attempt]).issues).toContain('LATEST_OBJECTIVE_REQUIRES_EXACT_SCORE_COMPARISON');
    });
    it('keeps missing/failed attempts in the denominator and never compensates a loss with another win', () => {
        const { manifest, attempt } = latestFixture(), other = structuredClone(attempt);
        other.caseId = 'b';
        manifest.expectedCases.push({ ...structuredClone(manifest.expectedCases[0]!), caseId: 'b' });
        attempt.neural!.result!.simScore = 99;
        other.neural!.result!.simScore = 200;
        const report = evaluateFullParity(manifest, [attempt, other]);
        expect(report.status).toBe('fail');
        expect(report.overall).toMatchObject({ attempts: 2, losses: 1, meanDelta: 49.5 });
        attempt.baseline!.status = 'timeout';
        const missing = evaluateFullParity(manifest, [attempt]);
        expect(missing.status).toBe('inconclusive');
        expect(missing.overall).toMatchObject({ attempts: 2, inconclusive: 2, meanDelta: null });
    });
    it('keeps hard locks even when the neural score is higher', () => {
        const { manifest, attempt } = latestFixture();
        attempt.inputWorkspace.mainPlan.facilities.room_1_1.slots[0] = structuredClone(attempt.baseline!.workspace!.mainPlan.facilities.room_1_1.slots[0]!);
        attempt.neural!.workspace!.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'changed';
        attempt.neural!.result!.simScore = 200;
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INPUT_LOCK_CHANGED');
    });
    it('checks generated warmup policy on a clone without repairing the scored candidate', () => {
        const { manifest, attempt } = efficiencyFixture();
        for (const run of [attempt.baseline!, attempt.neural!]) {
            const ws = run.workspace!;
            ws.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('机械师') }, groupId: 'warmup', replacements: [id('断罪者')] };
            ws.mainPlan.conf.workaholic = [id('Lancet-2')];
            ws.mainPlan.conf.exhaust_require = [id('机械师')];
            for (const slot of ws.mainPlan.facilities.dormitory_1.slots.slice(1)) slot.occupant = { kind: 'free' };
        }
        attempt.neural!.workspace!.mainPlan.conf.exhaust_require = [];
        attempt.neural!.result!.simScore = 200;
        const before = structuredClone(attempt);
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.issues).toContain('NEURAL_LATEST_WARMUP_POLICY_MISSING');
        expect(report.status).toBe('fail');
        expect(attempt).toEqual(before);
    });
    it('retains canonical input policy prefixes while allowing generated additions', () => {
        const { manifest, attempt } = latestFixture();
        attempt.inputWorkspace.mainPlan.conf.exhaust_require = ['刻俄柏'];
        for (const run of [attempt.baseline!, attempt.neural!]) run.workspace!.mainPlan.conf.exhaust_require = [id('刻俄柏'), id('机械师')];
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('development-pass');
        attempt.neural!.workspace!.mainPlan.conf.exhaust_require.reverse();
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INPUT_POLICY_PREFIX_CHANGED:exhaust_require');
    });
    it('preserves non-generated configuration and unknown compatibility metadata', () => {
        const { manifest, attempt } = latestFixture();
        attempt.neural!.workspace!.mainPlan.conf.ling_xi = 3;
        attempt.neural!.workspace!.compatibility.unrecognizedFields.changed = true;
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.issues).toContain('NEURAL_INPUT_CONF_CHANGED');
        expect(report.pairs[0]!.issues).toContain('NEURAL_INPUT_COMPATIBILITY_CHANGED');
    });
    it('rejects declared evaluation weights that differ from the actual output workspace', () => {
        const { manifest, attempt } = latestFixture();
        attempt.neural!.workspace!.productionWeights = { exp: 0, gold: 1, orders: 0, fragments: 0, orundum: 0 };
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_PRODUCTION_WEIGHTS_MISMATCH');
    });
    it.each(['exhaust_require', 'rest_in_full'] as const)('does not neutralize caller %s obligations with a newly generated workaholic flag', field => {
        const { manifest, attempt } = latestFixture();
        attempt.inputWorkspace.mainPlan.conf[field] = ['刻俄柏'];
        for (const run of [attempt.baseline!, attempt.neural!]) run.workspace!.mainPlan.conf[field] = [id('刻俄柏')];
        attempt.neural!.workspace!.mainPlan.conf.workaholic.push(id('刻俄柏'));
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INPUT_REST_POLICY_NEUTRALIZED');
    });
    it('does not replace an explicit ordinary-rest priority with newly generated standby', () => {
        const { manifest, attempt } = efficiencyFixture();
        for (const run of [attempt.baseline!, attempt.neural!]) {
            const ws = run.workspace!;
            ws.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('砾') }, groupId: 'group', replacements: [id('断罪者')] };
            ws.mainPlan.conf.workaholic = [id('Lancet-2')];
            ws.mainPlan.conf.resting_priority = [id('砾')];
            for (const slot of ws.mainPlan.facilities.dormitory_1.slots.slice(1)) slot.occupant = { kind: 'free' };
        }
        attempt.inputWorkspace.mainPlan.conf.resting_priority = ['砾'];
        attempt.neural!.workspace!.mainPlan.conf.resting_standby = [id('砾')];
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_INPUT_REST_PRIORITY_CHANGED');
    });
    it('validates native generated recovery obligations without repairing a scored result', () => {
        const { manifest, attempt } = efficiencyFixture();
        const base = attempt.inputWorkspace;
        base.mainPlan.facilities.room_1_1.level = 2;
        base.mainPlan.facilities.room_1_1.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] });
        base.mainPlan.facilities.room_1_1.product = 'exp';
        for (const run of [attempt.baseline!, attempt.neural!]) {
            const ws = run.workspace!;
            ws.mainPlan.facilities.room_1_1.level = 2;
            ws.mainPlan.facilities.room_1_1.product = 'exp';
            ws.mainPlan.facilities.room_1_1.slots = ['铅踝', '红云'].map((name, index) => ({
                occupant: { kind: 'operator', operatorId: id(name) }, groupId: 'crew', replacements: [id(index ? '霜叶' : '断罪者')],
            }));
            ws.mainPlan.conf.workaholic = [id('Lancet-2')];
            for (const slot of ws.mainPlan.facilities.dormitory_1.slots.slice(1)) slot.occupant = { kind: 'free' };
            expect(compileRosterSchedule(ws).diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
            applyGeneratedRecoveryPolicy(ws);
        }
        expect(attempt.baseline!.workspace!.mainPlan.conf.rest_in_full).toEqual([id('铅踝')]);
        attempt.neural!.workspace!.mainPlan.conf.rest_in_full = [];
        const before = structuredClone(attempt);
        expect(evaluateFullParity(manifest, [attempt]).pairs[0]!.issues).toContain('NEURAL_LATEST_RECOVERY_POLICY_MISSING');
        expect(attempt).toEqual(before);
    });
    it.each(['duplicate', 'suffix', 'native-comma-string'] as const)('reports unsupported %s input policy shape instead of claiming broad native coverage', shape => {
        const { manifest, attempt } = latestFixture();
        if (shape === 'duplicate') attempt.inputWorkspace.mainPlan.conf.exhaust_require = ['刻俄柏', id('刻俄柏')];
        if (shape === 'suffix') attempt.inputWorkspace.mainPlan.conf.exhaust_require = ['刻俄柏(room_1_1)'];
        if (shape === 'native-comma-string') Object.assign(attempt.inputWorkspace.mainPlan.conf, { exhaust_require: '刻俄柏,机械师' });
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.issues).toContain('NEURAL_LATEST_UNSUPPORTED_POLICY_REFERENCE:exhaust_require');
        expect(report.status).toBe('fail');
    });
    it.each(['resting_priority', 'ope_resting_priority', 'resting_priority_replacement', 'resting_standby'] as const)('does not disable caller %s through newly permanent native operator state', field => {
        const { manifest, attempt } = efficiencyFixture();
        const protectedId = id(field === 'resting_priority_replacement' ? '断罪者' : '砾');
        attempt.inputWorkspace.mainPlan.conf[field] = [protectedId];
        for (const run of [attempt.baseline!, attempt.neural!]) {
            const ws = run.workspace!;
            ws.mainPlan.facilities.room_1_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('砾') }, groupId: field === 'resting_standby' ? null : 'crew', replacements: [id('断罪者')] };
            ws.mainPlan.conf.workaholic = [id('Lancet-2')];
            ws.mainPlan.conf[field] = [protectedId];
            for (const slot of ws.mainPlan.facilities.dormitory_1.slots.slice(1)) slot.occupant = { kind: 'free' };
        }
        attempt.neural!.workspace!.mainPlan.conf.workaholic.push(protectedId);
        attempt.neural!.result!.simScore = 200;
        const report = evaluateFullParity(manifest, [attempt]);
        expect(report.pairs[0]!.issues).toContain('NEURAL_INPUT_REST_POLICY_NEUTRALIZED');
        expect(report.status).toBe('fail');
    });
    it('preserves an explicit pre-existing caller workaholic/priority combination without inventing a new obligation', () => {
        const { manifest, attempt } = efficiencyFixture();
        attempt.inputWorkspace.mainPlan.conf.resting_priority = ['砾'];
        attempt.inputWorkspace.mainPlan.conf.workaholic = ['砾'];
        for (const run of [attempt.baseline!, attempt.neural!]) {
            run.workspace!.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('砾') };
            run.workspace!.mainPlan.conf.resting_priority = [id('砾')];
            run.workspace!.mainPlan.conf.workaholic = [id('砾'), id('Lancet-2')];
        }
        expect(evaluateFullParity(manifest, [attempt]).status).toBe('development-pass');
    });
});
