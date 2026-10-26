import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { fullCatalogIdleInventory, compileOperatorInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { evaluateFullParity, type FullParityManifest, type FullParityAttempt, type FullParityContract, type FullParityRun } from './fullParity';
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
