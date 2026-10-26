import { describe, expect, it } from 'vitest';
import { compileOperatorInventory } from '../../domain/operatorInventory';
import { OPERATORS } from '../../domain/operators';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { createNeuralScenario } from './actionSpace';
import { decodeRoster } from './decode';
import { replayTeacherTrace } from './teacherTraces';
function fixture() {
    const inventory = compileOperatorInventory(OPERATORS.map(o => ({ operator: o.charId, elitePhase: 0, level: 1 })));
    const ws = createDefaultWorkspace();
    for (const room of Object.values(ws.mainPlan.facilities)) {
        room.level = 0;
    }
    ws.mainPlan.facilities.room_1_1.level = 1;
    ws.mainPlan.facilities.room_1_3.level = 3;
    const dorm = ws.mainPlan.facilities.dormitory_1;
    dorm.level = 5;
    dorm.slots.forEach(s => s.occupant = { kind: 'free' });
    dorm.slots[0]!.occupant = { kind: 'operator', operatorId: inventory.operators.find(o => o.name === '安赛尔')!.charId };
    const scenario = createNeuralScenario(ws, inventory);
    const generated = decodeRoster(scenario, rows => rows.map(() => 0));
    expect(generated.complete, JSON.stringify(generated.diagnostics)).toBe(true);
    return { scenario, teacher: generated.workspace };
}
describe('teacher traces', () => {
    it('rejects forbidden prefixes and emits no partial training samples', () => {
        const { scenario, teacher } = fixture();
        teacher.mainPlan.facilities.room_1_1.slots[0]!.replacements = ['not-owned'];
        const replay = replayTeacherTrace(scenario, teacher);
        expect(replay.complete).toBe(false);
        expect(replay.samples).toEqual([]);
        expect(replay.diagnostics.some(d => d.message.includes('TEACHER_ACTION_MASKED'))).toBe(true);
    });
    it.each(['layout', 'frozen', 'policy', 'advanced', 'weights', 'backups', 'otherPlans', 'droneCapacity'])('rejects teacher %s changes even when every predicted action is legal', kind => {
        const { scenario, teacher } = fixture();
        if (kind === 'layout') {
            teacher.mainPlan.facilities.room_1_1.level = 2;
        }
        if (kind === 'frozen') {
            teacher.mainPlan.facilities.dormitory_1.slots[0]!.occupant = { kind: 'free' };
        }
        if (kind === 'policy') {
            teacher.mainPlan.conf.workaholic = ['安赛尔'];
        }
        if (kind === 'advanced') teacher.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: 0.1 };
        if (kind === 'weights') teacher.productionWeights = { exp: 9, gold: 1, orders: 1, fragments: 0, orundum: 0 };
        if (kind === 'backups') teacher.compatibility.backupPlans = [{ unsupported: true }];
        if (kind === 'otherPlans') teacher.compatibility.otherPlans = { unsupported: {} };
        if (kind === 'droneCapacity') teacher.droneCapacity = 100;
        const replay = replayTeacherTrace(scenario, teacher);
        expect(replay.complete).toBe(false);
        expect(replay.samples).toEqual([]);
        expect(replay.diagnostics.some(d => d.code === 'TEACHER_PROJECTION_MISMATCH')).toBe(true);
    });
    it.each([true, false])('requires recovery beds even when all ordinary slots are locked (beds=%s)', hasBeds => {
        const { scenario, teacher } = fixture();
        const locks: string[] = [];
        for (const room of Object.values(teacher.mainPlan.facilities)) {
            if (room.type === 'dormitory' && !hasBeds) {
                room.level = 0;
                room.slots.forEach(slot => { slot.occupant = { kind: 'empty' }; slot.replacements = []; });
            } else if (room.type !== 'dormitory' && room.level > 0) {
                room.slots.forEach((slot, index) => { if (slot.occupant.kind === 'operator') locks.push(`${room.roomId}:${index}`); });
            }
        }
        const lockedScenario = createNeuralScenario(teacher, scenario.inventory, locks);
        expect(lockedScenario.positions).toHaveLength(0);
        expect(lockedScenario.valid).toBe(hasBeds);
        const result = decodeRoster(lockedScenario, () => { throw new Error('A fully locked roster must not call the scorer'); });
        expect(result.complete).toBe(hasBeds);
        if (!hasBeds) expect(result.diagnostics.some(d => d.code === 'NO_RECOVERY_BEDS')).toBe(true);
        else expect(result.workspace).toEqual(teacher);
    });
    it('accepts object-key permutations and cosmetic names without changing teacher semantics', () => {
        const { scenario, teacher } = fixture();
        teacher.name = 'cosmetic'; teacher.mainPlan.name = 'cosmetic';
        teacher.mainPlan.conf = Object.fromEntries(Object.entries(teacher.mainPlan.conf).reverse()) as typeof teacher.mainPlan.conf;
        expect(replayTeacherTrace(scenario, teacher).complete).toBe(true);
    });

});
