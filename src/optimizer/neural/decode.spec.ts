import { describe, expect, it } from 'vitest';
import { compileOperatorInventory } from '../../domain/operatorInventory';
import { OPERATORS } from '../../domain/operators';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { ensureBuiltDormKeepers } from '../dormKeepers';
import { createNeuralScenario, legalCandidates } from './actionSpace';
import { decodeRoster } from './decode';
import { replayTeacherTrace } from './teacherTraces';
import { NEURAL_FEATURE_COUNT } from './features';
const inventory = () => compileOperatorInventory(OPERATORS.map(o => ({ operator: o.charId, elitePhase: 0, level: 1 })));
function fixture() {
    const inv = inventory(), ws = createDefaultWorkspace();
    ensureBuiltDormKeepers(ws, inv);
    for (const r of Object.values(ws.mainPlan.facilities)) {
        if (r.type === 'dormitory') {
            for (const s of r.slots) {
                if (s.occupant.kind === 'empty') {
                    s.occupant = { kind: 'free' };
                }
            }
        }
    }
    return { inv, ws };
}
describe('constrained neural roster decoder', () => {
    it('generates main AND unique ordinary relief from actual owned stages without mutation', () => {
        const { inv, ws } = fixture(), before = JSON.stringify({ inv, ws }), scenario = createNeuralScenario(ws, inv);
        expect(scenario.diagnostics).toEqual([]);
        const result = decodeRoster(scenario, rows => { expect(rows.every(r => r.length === NEURAL_FEATURE_COUNT && r.every(Number.isFinite))).toBe(true); return rows.map((_, i) => -i); });
        expect(result.diagnostics).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.trace.some(t => t.position.role === 'relief')).toBe(true);
        expect(result.trace.some(t => t.position.role === 'main')).toBe(true);
        const assigned = result.trace.map(t => t.operatorId);
        expect(new Set(assigned).size).toBe(assigned.length);
        expect(result.trace.every(t => inv.operators.some(o => o.charId === t.operatorId))).toBe(true);
        expect(JSON.stringify({ inv, ws })).toBe(before);
        const replay = replayTeacherTrace(scenario, result.workspace);
        expect(replay.complete).toBe(true);
        expect(replay.samples.length).toBe(result.trace.length);
        expect(replay.workspace).toEqual(result.workspace);
    });
    it('is canonical under inventory and facility insertion permutation', () => {
        const { inv, ws } = fixture();
        const first = decodeRoster(createNeuralScenario(ws, inv), r => r.map(() => 0));
        inv.operators.reverse();
        ws.mainPlan.facilities = Object.fromEntries(Object.entries(ws.mainPlan.facilities).reverse()) as typeof ws.mainPlan.facilities;
        const next = decodeRoster(createNeuralScenario(ws, inv), r => r.map(() => 0));
        expect(next.trace).toEqual(first.trace);
    });
    it('rejects unowned, duplicate reservations, grouping, incomplete locks and bad capacity', () => {
        for (const kind of ['unowned', 'duplicate', 'group', 'lock', 'capacity', 'invalidInventory', 'overflowRelief', 'fiammetta']) {
            const { inv, ws } = fixture(), r = ws.mainPlan.facilities.room_1_1;
            if (kind === 'invalidInventory') {
                inv.valid = false;
            }
            if (kind === 'overflowRelief') {
                r.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [inv.operators[20]!.charId] });
            }
            if (kind === 'fiammetta') {
                ws.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'operator', operatorId: inv.operators.find(o => o.name === '菲亚梅塔')!.charId };
            }
            if (kind === 'unowned') {
                r.slots[0]!.occupant = { kind: 'operator', operatorId: 'not-owned' };
            }
            if (kind === 'duplicate') {
                r.slots[0]!.replacements = [inv.operators[0]!.charId, inv.operators[0]!.charId];
            }
            if (kind === 'group') {
                r.slots[0]!.groupId = 'team';
            }
            if (kind === 'capacity') {
                r.slots.push({ occupant: { kind: 'operator', operatorId: inv.operators[20]!.charId }, groupId: null, replacements: [] });
            }
            expect(createNeuralScenario(ws, inv, kind === 'lock' ? ['room_1_1:0'] : []).valid, kind).toBe(false);
        }
    });
    it('preserves complete locked slots and masks Pepe/U-Official in trade', () => {
        const { inv, ws } = fixture();
        const initial = decodeRoster(createNeuralScenario(ws, inv), r => r.map(() => 0));
        const slot = structuredClone(initial.workspace.mainPlan.facilities.room_1_1.slots[0]!);
        ws.mainPlan.facilities.room_1_1.slots[0] = slot;
        const s = createNeuralScenario(ws, inv, ['room_1_1:0']);
        expect(s.valid).toBe(true);
        expect(decodeRoster(s, r => r.map(() => 0)).workspace.mainPlan.facilities.room_1_1.slots[0]).toEqual(slot);
        const p = s.positions.find(p => s.workspace.mainPlan.facilities[p.roomId].type === 'trading')!;
        expect(legalCandidates(s, s.workspace, p, new Set()).some(o => ['佩佩', 'U-Official'].includes(o.name))).toBe(false);
    });
    it('fails closed on insufficient inventory, invalid logits and illegal teacher', () => {
        const { inv, ws } = fixture();
        const s = createNeuralScenario(ws, inv);
        expect(decodeRoster(s, () => [NaN]).complete).toBe(false);
        inv.operators = inv.operators.slice(0, 4);
        expect(decodeRoster(createNeuralScenario(ws, inv), r => r.map(() => 0)).complete).toBe(false);
        const t = structuredClone(ws);
        t.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: 'unknown' };
        expect(replayTeacherTrace(s, t).complete).toBe(false);
    });
    it('rejects a mechanical Pepe run-order insertion rather than labeling it a complete neural roster', () => {
        const { inv, ws } = fixture();
        inv.operators = inv.operators.filter(o => !['但书', '龙舌兰', '可露希尔', 'U-Official', '佩佩'].includes(o.name));
        inv.operators.push(compileOperatorInventory([{ operator: '佩佩', elitePhase: 2, level: 1 }]).operators[0]!);
        const result = decodeRoster(createNeuralScenario(ws, inv), rows => rows.map(() => 0));
        expect(result.complete).toBe(false);
        expect(result.diagnostics.some(d => d.code === 'FORBIDDEN_TRADE_OPERATOR')).toBe(true);
    });

});
