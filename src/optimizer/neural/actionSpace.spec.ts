import { describe, expect, it } from 'vitest';
import { compileOperatorInventory } from '../../domain/operatorInventory';
import { OPERATORS } from '../../domain/operators';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { ensureBuiltDormKeepers } from '../dormKeepers';
import { createNeuralScenario, feasibleCandidates, legalCandidates, type NeuralPosition } from './actionSpace';
import { candidateFeatures } from './features';
function fixture() {
    const inv = compileOperatorInventory(OPERATORS.map(o => ({ operator: o.charId, elitePhase: 0, level: 1 })));
    const ws = createDefaultWorkspace();
    ensureBuiltDormKeepers(ws, inv);
    for (const r of Object.values(ws.mainPlan.facilities)) {
        if (r.type === 'dormitory') {
            for (const slot of r.slots) {
                if (slot.occupant.kind === 'empty') {
                    slot.occupant = { kind: 'free' };
                }
            }
        }
    }
    return { inv, ws };
}
describe('neural action space feasibility and actual skills', () => {
    it('masks a legal greedy choice that would strand a later constrained position', () => {
        const { inv, ws } = fixture(), s = createNeuralScenario(ws, inv);
        const manufacture: NeuralPosition = { roomId: 'room_1_1', slotIndex: 0, role: 'main' }, trade: NeuralPosition = { roomId: 'room_3_1', slotIndex: 0, role: 'main' };
        const a = legalCandidates(s, ws, manufacture, new Set()), b = legalCandidates(s, ws, trade, new Set());
        const flexible = a.find(o => b.some(p => p.charId === o.charId))!, restricted = a.find(o => !b.some(p => p.charId === o.charId))!;
        expect(flexible).toBeDefined();
        expect(restricted).toBeDefined();
        s.inventory.operators = [flexible, restricted];
        s.positions = [manufacture, trade];
        expect(legalCandidates(s, ws, manufacture, new Set()).length).toBe(2);
        expect(feasibleCandidates(s, ws, 0, new Set()).map(o => o.charId)).toEqual([restricted.charId]);
        expect(feasibleCandidates(s, ws, 1, new Set([restricted.charId])).map(o => o.charId)).toEqual([flexible.charId]);
    });
    it('recompiles owned skills, ignoring forged maximum-stage skill payloads', () => {
        const { inv, ws } = fixture(), before = createNeuralScenario(ws, inv);
        const op = inv.operators.find(o => o.name === '白面鸮')!, max = OPERATORS.find(o => o.name === op.name)!;
        op.skills = structuredClone(max.skills);
        op.matchesMaximumSkills = true;
        const after = createNeuralScenario(ws, inv);
        expect(after.inventory).toEqual(before.inventory);
        const p = after.positions[0]!;
        expect(candidateFeatures(after, ws, p, after.inventory.operators)).toEqual(candidateFeatures(before, ws, p, before.inventory.operators));
    });
    it('features change with actual stage and prefix, not with unrelated workspace labels', () => {
        const { inv, ws } = fixture(), s = createNeuralScenario(ws, inv), p = s.positions[0]!, candidate = s.inventory.operators.find(o => o.name === '白面鸮')!;
        const row = candidateFeatures(s, ws, p, [candidate])[0];
        ws.name = 'arbitrary-score-9999';
        ws.mainPlan.name = 'teacher-label';
        expect(candidateFeatures(s, ws, p, [candidate])[0]).toEqual(row);
        ws.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: candidate.charId };
        expect(candidateFeatures(s, ws, p, [candidate])[0]).not.toEqual(row);
        const promoted = compileOperatorInventory([{ operator: candidate.charId, elitePhase: 2, level: 1 }]).operators[0]!;
        expect(candidateFeatures(s, s.workspace, p, [promoted])[0]).not.toEqual(row);
    });
});
