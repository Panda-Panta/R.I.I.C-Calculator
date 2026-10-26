import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import { compiledScheduleToRuntimeConfig } from '../../scheduler/scheduleAdapter';
import { expect, it } from 'vitest';
import { compileOperatorInventory } from '../../domain/operatorInventory';
import { OPERATORS } from '../../domain/operators';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { createFullScenario, initialFullState, action } from './fullActionSpace';
import { encodeFullDecision, FULL_FEATURE_MANIFEST } from './fullFeatures';
function fixture() {
    const scenario = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(OPERATORS.map(o => ({
        operator: o.charId, elitePhase: 0, level: 1
    }))));
    return {
        scenario, state: initialFullState(scenario), decision: {
            kind: 'occupant' as const, roomId: 'room_1_1' as const, slotIndex: 0
        }, actions: scenario.inventory.operators.map(o => action('operator', o.charId))
    };
}
it('has collision-free catalog and candidate identities with compact shared context', () => {
    const c = fixture(), before = JSON.stringify(c), f = encodeFullDecision(c);
    expect(FULL_FEATURE_MANIFEST.operatorIds).toHaveLength(432);
    expect(FULL_FEATURE_MANIFEST.buffIds).toHaveLength(763);
    expect(new Set(f.candidates.map(x => JSON.stringify(x))).size).toBe(432);
    expect(JSON.stringify(f).length).toBeLessThan(150000);
    expect(JSON.stringify(c)).toBe(before);
});
it('conditions on role, remaining inventory, levels, layout, weights, drones and policy without labels', () => {
    const c = fixture(), a = encodeFullDecision(c);
    c.state.workspace.name = 'score999';
    expect(encodeFullDecision(c)).toEqual(a);
    c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = {
        kind: 'operator', operatorId: c.scenario.inventory.operators[0]!.name
    };
    const b = encodeFullDecision(c);
    expect(b.common).not.toEqual(a.common);
    c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'empty' };
    c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = [c.scenario.inventory.operators[0]!.charId];
    expect(encodeFullDecision(c).common).not.toEqual(b.common);
    for (const change of [() => {
            c.state.workspace.droneCapacity = 123;
        }, () => {
            c.state.workspace.productionWeights = {
                exp: 3, gold: 2, orders: 1, fragments: 4, orundum: 5
            };
        }, () => {
            c.state.workspace.mainPlan.facilities.room_1_1.level = 2;
        }, () => {
            c.state.workspace.mainPlan.conf.ling_xi = 3;
        }]) {
        const before = encodeFullDecision(c);
        change();
        expect(encodeFullDecision(c).common).not.toEqual(before.common);
    }
});
it('canonicalizes inventory order and operator aliases', () => {
    const c = fixture(), a = encodeFullDecision(c);
    c.scenario.inventory.operators.reverse();
    c.actions = c.actions.map(x => action('operator', OPERATORS.find(o => o.charId === x.value)!.name));
    expect(encodeFullDecision(c)).toEqual(a);
});
it('derives actual unlocked skills even if input skill payloads are forged', () => {
    const c = fixture(), a = encodeFullDecision(c);
    const o = c.scenario.inventory.operators.find(x => x.name === '白面鸮')!;
    o.skills = [];
    expect(encodeFullDecision(c)).toEqual(a);
    o.elitePhase = 1;
    expect(encodeFullDecision(c)).not.toEqual(a);
});
it('distinguishes ordinary physical replacements from reference-only trading actions', () => {
    const c = fixture();
    c.decision = {
        ...c.decision, roomId: 'room_1_1'
    };
    c.state.workspace.mainPlan.facilities.room_1_1.type = 'trading';
    const a = encodeFullDecision({
        ...c, decision: {
            ...c.decision, kind: 'replacement'
        }
    });
    expect(a.candidates.every(v => v.some(([i]) => FULL_FEATURE_MANIFEST.featureKeys[i] === 'candidate-physical') || v.some(([i]) => FULL_FEATURE_MANIFEST.featureKeys[i] === 'candidate-reference'))).toBe(true);
});
it('conditions on explicit input simulator protocol, not hidden evaluator settings', () => {
    const c = fixture();
    for (const patch of [{ droneTarget: 'exp' as const }, { droneRoomId: 'room_2_1' }, { warmupHours: 12 }, { sampleHours: 48 }, { maxStepHours: .5 }, { seed: 99 }]) {
        const a = encodeFullDecision(c);
        Object.assign(c.scenario.simulationConditioning, patch);
        expect(encodeFullDecision(c).common).not.toEqual(a.common);
    }
});
it('encodes effective advanced scheduler settings and ignores unused raw switches', () => {
    const c = fixture();
    c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: '芬' };
    const threshold = () => compiledScheduleToRuntimeConfig(compileRosterSchedule(c.state.workspace)).positions.find(p => p.primary === 'char_123_fang')!.shiftOffThreshold;
    const baseline = encodeFullDecision(c);
    expect(threshold()).toBe(15);
    c.state.workspace.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: .2 };
    expect(threshold()).toBe(4);
    expect(encodeFullDecision(c).common).not.toEqual(baseline.common);
    c.state.workspace.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: .65, enable_mastery: false, fia_threshold: .3 };
    expect(encodeFullDecision(c)).toEqual(baseline);
    c.state.workspace.compatibility.unrecognizedFields.advanced_settings = { fia_fool: false, fia_threshold: .3 };
    expect(encodeFullDecision(c).common).not.toEqual(baseline.common);
});
it('uses explicit scheduler overrides instead of ineffective raw settings', () => {
    const c = fixture();
    c.scenario.simulationConditioning.schedulerAssumptions = { restingThreshold: .65, operationDurationHours: 0 };
    const baseline = encodeFullDecision(c);
    c.state.workspace.compatibility.unrecognizedFields.advanced_settings = { resting_threshold: .2 };
    expect(encodeFullDecision(c)).toEqual(baseline);
    c.scenario.simulationConditioning.schedulerAssumptions.restingThreshold = .3;
    expect(encodeFullDecision(c).common).not.toEqual(baseline.common);
});
it('encodes native mood limits canonically and effective dorm order', () => {
    const c = fixture(), baseline = encodeFullDecision(c);
    c.state.workspace.mainPlan.conf.mood_limits = { lower: 2, upper: 20 };
    expect(encodeFullDecision(c).common).not.toEqual(baseline.common);
    c.state.workspace.mainPlan.conf.operator_mood_limits = { '芬': { lower: 3, upper: 18 } };
    const named = encodeFullDecision(c);
    c.state.workspace.mainPlan.conf.operator_mood_limits = { char_123_fang: { lower: '3', upper: '18' } };
    expect(encodeFullDecision(c)).toEqual(named);
    c.state.workspace.mainPlan.conf.dorm_order = 'dormitory_2,dormitory_1';
    const ordered = encodeFullDecision(c);
    expect(ordered.common).not.toEqual(named.common);
    c.state.workspace.mainPlan.conf.dorm_order = 'dormitory_2_2,dormitory_1';
    c.state.workspace.mainPlan.conf.dorm_order_override = false;
    expect(encodeFullDecision(c)).toEqual(ordered);
});
it('rejects scheduler relations without a supported feature representation', () => {
    const c = fixture();
    c.state.workspace.compatibility.unrecognizedFields.advanced_settings = { dorm_isolation: [['芬', '香草']] };
    expect(() => encodeFullDecision(c)).toThrow(/Unsupported.*dormIsolation/);
});
it('encodes effective per-room dorm atmosphere, including default-versus-explicit zero', () => {
    const c = fixture();
    const effective = () => {
        const schedule = compileRosterSchedule(c.state.workspace, c.scenario.simulationConditioning.schedulerAssumptions ?? {});
        return schedule.rooms.filter(r => r.type === 'dormitory').map(room => !schedule.assumptions.defaultsApplied.includes('dormAtmosphere') ? schedule.assumptions.dormAtmosphere : room.level * 1000);
    };
    const defaultFeatures = encodeFullDecision(c);
    expect(effective()).toEqual([5000, 5000, 5000, 5000]);
    c.scenario.simulationConditioning.schedulerAssumptions = { dormAtmosphere: 0 };
    expect(effective()).toEqual([0, 0, 0, 0]);
    expect(encodeFullDecision(c).common).not.toEqual(defaultFeatures.common);
    c.scenario.simulationConditioning.schedulerAssumptions.dormAtmosphere = 5000;
    expect(encodeFullDecision(c)).toEqual(defaultFeatures);
    c.state.workspace.mainPlan.facilities.dormitory_1.level = 3;
    const equivalentClamped = encodeFullDecision(c);
    c.scenario.simulationConditioning.schedulerAssumptions = {};
    expect(effective()).toEqual([3000, 5000, 5000, 5000]);
    expect(encodeFullDecision(c)).toEqual(equivalentClamped);
    c.scenario.simulationConditioning.schedulerAssumptions.dormAtmosphere = 2000;
    expect(encodeFullDecision(c).common).not.toEqual(equivalentClamped.common);
});
it('encodes Ling/Xi actions as four exact categories, not only an ordinal scalar', () => {
    const c = fixture();
    const encoded = encodeFullDecision({ ...c, decision: { kind: 'ling_xi' }, actions: [0, 1, 2, 3].map(n => action('value', n)) });
    for (let mode = 0; mode < 4; mode++) {
        const categories = encoded.candidates[mode]!.filter(([index]) => FULL_FEATURE_MANIFEST.featureKeys[index]!.startsWith('ling-mode-action:'));
        expect(categories).toEqual([[FULL_FEATURE_MANIFEST.featureKeys.indexOf(`ling-mode-action:${mode}`), 1]]);
    }
});
