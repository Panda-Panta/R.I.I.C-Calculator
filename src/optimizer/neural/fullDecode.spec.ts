import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { createFullScenario, initialFullState, legalFullActions, action } from './fullActionSpace';
import { applyFullAction } from './fullTransitions';
import { decodeFullRoster } from './fullDecode';
const scenario = () => createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()));
describe('full-v2 scorer and scoped reservation contracts', () => {
    it('reports invalid logits without fallback or mutation', () => {
        const s = scenario(), before = structuredClone(s.workspace), r = decodeFullRoster(s, () => [NaN]);
        expect(r.complete).toBe(false);
        expect(r.trace).toEqual([]);
        expect(r.diagnostics.some(d => d.code === 'INVALID_LOGITS')).toBe(true);
        expect(s.workspace).toEqual(before);
    });
    it('reports scorer failure without synthesizing staff', () => {
        const r = decodeFullRoster(scenario(), () => {
            throw Error('network failed');
        });
        expect(r.complete).toBe(false);
        expect(r.modelActions).toBe(0);
        expect(r.diagnostics.some(d => d.code === 'SCORER_ERROR')).toBe(true);
    });
    it('rejects forged action payload even if action ID is legal', () => {
        const s = scenario(), state = initialFullState(s), a = legalFullActions(s, state)[0]!;
        const r = applyFullAction(s, state, {
            ...a, value: 'forged'
        });
        expect(r.workspace).toEqual(state.workspace);
        expect(r.diagnostics[0]?.code).toBe('ILLEGAL_ACTION');
    });
    it('permits same-group main references but not cross-scope physical reuse', () => {
        const s = scenario(), state = initialFullState(s), a = state.workspace.mainPlan.facilities.room_1_1.slots[0]!, b = state.workspace.mainPlan.facilities.room_1_2.slots[0]!;
        a.occupant = {
            kind: 'operator', operatorId: id('砾')
        };
        a.groupId = 'a';
        b.occupant = {
            kind: 'operator', operatorId: id('斑点')
        };
        b.groupId = 'a';
        state.decisions = [{
                kind: 'replacement', roomId: 'room_1_1', slotIndex: 0, listIndex: 0
            }];
        expect(legalFullActions(s, state).some(x => x.id === action('operator', id('斑点')).id)).toBe(true);
        b.groupId = 'b';
        expect(legalFullActions(s, state).some(x => x.id === action('operator', id('斑点')).id)).toBe(false);
    });
    it('binds explicit simulator settings from input, not target workspace', () => {
        const s = scenario();
        expect(s.simulationConditioning).toEqual({
            droneTarget: 'gold', warmupHours: 24, sampleHours: 72, maxStepHours: .25, seed: 42
        });
        const changed = createFullScenario(s.workspace, s.inventory, { simulationConditioning: {
                droneTarget: 'trading', droneRoomId: 'room_3_1', seed: 9, maxStepHours: .125
            } });
        expect(changed.valid).toBe(true);
        expect(changed.simulationConditioning.droneTarget).toBe('trading');
        expect(changed.simulationConditioning.sampleHours).toBe(72);
        expect(createFullScenario(s.workspace, s.inventory, { simulationConditioning: { sampleHours: NaN } }).valid).toBe(false);
    });
    it('keeps unrelated locked ordinary references masked during prospective main placement', () => {
        const s = scenario(), state = initialFullState(s);
        const first = state.workspace.mainPlan.facilities.room_1_1.slots[0]!;
        first.occupant = {
            kind: 'operator', operatorId: id('砾')
        };
        first.replacements = [id('斑点')];
        state.decisions = [{
                kind: 'occupant', roomId: 'room_1_2', slotIndex: 0
            }];
        const spot = action('operator', id('斑点')).id;
        expect(legalFullActions(s, state).some(a => a.id === spot)).toBe(false);
        first.groupId = 'G';
        expect(legalFullActions(s, state).some(a => a.id === spot)).toBe(true);
        const other = state.workspace.mainPlan.facilities.room_1_3.slots[0]!;
        other.occupant = {
            kind: 'operator', operatorId: id('清流')
        };
        other.groupId = 'H';
        other.replacements = [id('斑点')];
        expect(legalFullActions(s, state).some(a => a.id === spot)).toBe(false);
        other.replacements = [];
        other.occupant = {
            kind: 'operator', operatorId: id('斑点')
        };
        expect(legalFullActions(s, state).some(a => a.id === spot)).toBe(false);
    });
    it('clones explicit nested scheduler assumptions instead of sharing mutable input settings', () => {
        const s = scenario();
        const assumptions = {
            restingThreshold: .65, operationDurationHours: 0, dormIsolation: [['a', 'b']]
        };
        const configured = createFullScenario(s.workspace, s.inventory, { simulationConditioning: { schedulerAssumptions: assumptions } });
        assumptions.dormIsolation[0]!.push('changed');
        expect(configured.simulationConditioning.schedulerAssumptions).toEqual({
            restingThreshold: .65, operationDurationHours: 0, dormIsolation: [['a', 'b']]
        });
        expect(s.simulationConditioning.schedulerAssumptions).toBeUndefined();
    });
    it.each(['room_1_1', 'room_3_1', 'room_1_3', 'central'] as const)('hard-masks irreparable empty occupancy in mandatory room %s', roomId => {
        const s = scenario(), state = initialFullState(s);
        state.decisions = [{
                kind: 'occupant', roomId, slotIndex: 0
            }];
        const actions = legalFullActions(s, state);
        expect(actions.length).toBeGreaterThan(0);
        expect(actions.every(a => a.kind === 'operator')).toBe(true);
    });
    it('retains empty optional slots, absent unbuilt decisions and explicit empty locks', () => {
        const s = scenario(), state = initialFullState(s);
        expect(state.decisions.some(d => d.roomId === 'recycle')).toBe(false);
        state.decisions = [{
                kind: 'occupant', roomId: 'meeting', slotIndex: 0
            }];
        expect(legalFullActions(s, state).some(a => a.kind === 'empty')).toBe(true);
        const locked = createFullScenario(s.workspace, s.inventory, { lockedSlots: ['room_1_1:0'] });
        expect(initialFullState(locked).decisions.some(d => d.roomId === 'room_1_1' && d.slotIndex === 0)).toBe(false);
        expect(initialFullState(locked).workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant.kind).toBe('empty');
    });
    it('requires a keeper only at the last still-fillable seat of a keeperless built dorm', () => {
        const s = scenario(), state = initialFullState(s);
        state.decisions = [{
                kind: 'occupant', roomId: 'dormitory_1', slotIndex: 3
            }, {
                kind: 'occupant', roomId: 'dormitory_1', slotIndex: 4
            }];
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(true);
        state.decisionIndex = 1;
        expect(legalFullActions(s, state).every(a => a.kind === 'operator')).toBe(true);
        state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.occupant = {
            kind: 'operator', operatorId: id('杜林')
        };
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(true);
    });
});
describe('optional staffing-first-v1 obligations', () => {
    function orderedScenario(order: 'legacy-v1' | 'staffing-first-v1' = 'staffing-first-v1') {
        return createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), { constructionOrder: order });
    }
    function reliefPrefix(order: 'legacy-v1' | 'staffing-first-v1' = 'staffing-first-v1') {
        const s = orderedScenario(order), state = initialFullState(s);
        state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = {
            kind: 'operator', operatorId: id('砾')
        };
        state.decisions = [{
                kind: 'replacement', roomId: 'room_1_1', slotIndex: 0, listIndex: 0
            }];
        return {
            s, state, slot: state.workspace.mainPlan.facilities.room_1_1.slots[0]!
        };
    }
    it('keeps the legacy default but puts declared workaholics before primary relief in the new order', () => {
        expect(scenario().constructionOrder).toBe('legacy-v1');
        for (const mode of ['legacy-v1', 'staffing-first-v1'] as const) {
            const s = orderedScenario(mode), state = initialFullState(s);
            const work = state.decisions.findIndex(d => d.kind === 'conf-list' && d.field === 'workaholic');
            const primary = state.decisions.findIndex(d => d.kind === 'replacement');
            expect(work < primary).toBe(mode === 'staffing-first-v1');
            expect(state.decisions.filter(d => d.kind === 'conf-list' && d.field === 'workaholic')).toHaveLength(1);
            expect(state.decisions.slice(0, work).some(d => d.kind === 'bindings')).toBe(true);
        }
    });
    it('defers binding references until after workaholics but before primary replacement closure', () => {
        const s = orderedScenario(), state = initialFullState(s);
        state.decisionIndex = state.decisions.findIndex(d => d.kind === 'bindings');
        const next = applyFullAction(s, state, action('binding'));
        expect(next.diagnostics).toEqual([]);
        const work = next.decisions.findIndex(d => d.kind === 'conf-list' && d.field === 'workaholic');
        const binding = next.decisions.findIndex(d => d.kind === 'binding-replacement');
        const primary = next.decisions.findIndex(d => d.kind === 'replacement');
        expect(work).toBeLessThan(binding);
        expect(binding).toBeLessThan(primary);
    });
    it('masks END exactly when occupied ordinary staffing lacks primary and binding cover', () => {
        const { s, state, slot } = reliefPrefix();
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(false);
        expect(applyFullAction(s, state, action('end')).diagnostics.some(d => d.code === 'ILLEGAL_ACTION')).toBe(true);
        state.workspace.mainPlan.conf.workaholic = ['砾'];
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(true);
        state.workspace.mainPlan.conf.workaholic = [];
        slot.groupBindings = [{
                groupId: 'G', replacements: [id('斑点')]
            }];
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(true);
        slot.groupBindings = [];
        slot.replacements = [id('斑点')];
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(true);
        slot.replacements = [];
        slot.occupant = { kind: 'empty' };
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(true);
        const legacy = reliefPrefix('legacy-v1');
        expect(legalFullActions(legacy.s, legacy.state).some(a => a.kind === 'end')).toBe(true);
    });
    it('does not mistake a runner reference for ordinary relief or synthesize a fallback at a dead end', () => {
        const { s, state, slot } = reliefPrefix();
        slot.replacements = [id('但书')];
        expect(legalFullActions(s, state).some(a => a.kind === 'end')).toBe(false);
        s.inventory = compileOperatorInventory([{
                operator: '砾', elitePhase: 0, level: 1
            }]);
        slot.replacements = [];
        expect(legalFullActions(s, state)).toEqual([]);
    });
    it('offers Free references only for a non-Fiammetta grouped dorm resident in the new mode', () => {
        const s = orderedScenario(), state = initialFullState(s), slot = state.workspace.mainPlan.facilities.dormitory_1.slots[0]!;
        slot.occupant = {
            kind: 'operator', operatorId: id('杜林')
        };
        state.decisions = [{
                kind: 'replacement', roomId: 'dormitory_1', slotIndex: 0, listIndex: 0
            }];
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(false);
        slot.groupId = 'G';
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(true);
        slot.occupant = {
            kind: 'operator', operatorId: id('菲亚梅塔')
        };
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(false);
        slot.occupant = {
            kind: 'operator', operatorId: id('杜林')
        };
        slot.groupId = null;
        slot.groupBindings = [{
                groupId: 'H', replacements: []
            }];
        state.decisions = [{
                kind: 'binding-replacement', roomId: 'dormitory_1', slotIndex: 0, bindingIndex: 0, listIndex: 0
            }];
        expect(legalFullActions(s, state).some(a => a.kind === 'free')).toBe(true);
    });
    it('reports forced versus actual model-choice actions rather than inflating creative choices', () => {
        const s = createFullScenario(createDefaultWorkspace(), compileOperatorInventory([{
                operator: '砾', elitePhase: 0, level: 1
            }]), { constructionOrder: 'staffing-first-v1' });
        const result = decodeFullRoster(s, ctx => ctx.actions.map(() => 0));
        expect(result.complete).toBe(false);
        expect(result.modelActions).toBe(1);
        expect(result.forcedActions).toBe(1);
        expect(result.modelChoiceActions).toBe(0);
        expect(result.constructionOrder).toBe('staffing-first-v1');
    });
});
describe('staffing-first native reference conflict masks', () => {
    function prefix(order: 'legacy-v1' | 'staffing-first-v1' = 'staffing-first-v1') {
        const s = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), { constructionOrder: order });
        const state = initialFullState(s);
        const keeper = state.workspace.mainPlan.facilities.dormitory_1.slots[0]!;
        keeper.occupant = {
            kind: 'operator', operatorId: id('杜林')
        };
        const worker = state.workspace.mainPlan.facilities.central.slots[0]!;
        worker.occupant = {
            kind: 'operator', operatorId: id('芙蓉')
        };
        state.decisions = [{
                kind: 'replacement', roomId: 'dormitory_1', slotIndex: 0, listIndex: 0
            }];
        const allowed = (name: string) => legalFullActions(s, state).some(a => a.id === action('operator', id(name)).id);
        return {
            s, state, keeper, worker, allowed
        };
    }
    it('masks observed non-Fiammetta keeper references to unrelated occupied workers, but preserves legacy and idle candidates', () => {
        const p = prefix();
        expect(p.allowed('芙蓉')).toBe(false);
        expect(p.allowed('杜林')).toBe(false);
        expect(p.allowed('斑点')).toBe(true);
        expect(prefix('legacy-v1').allowed('芙蓉')).toBe(true);
    });
    it('retains same-group primary and binding-column reference relationships', () => {
        const p = prefix();
        p.keeper.groupId = 'G';
        p.worker.groupId = 'G';
        expect(p.allowed('芙蓉')).toBe(true);
        p.worker.groupId = 'H';
        p.worker.groupBindings = [{
                groupId: 'G', replacements: []
            }];
        expect(p.allowed('芙蓉')).toBe(true);
        p.keeper.groupId = null;
        p.keeper.groupBindings = [{
                groupId: 'G', replacements: []
            }];
        p.state.decisions = [{
                kind: 'binding-replacement', roomId: 'dormitory_1', slotIndex: 0, bindingIndex: 0, listIndex: 0
            }];
        expect(p.allowed('芙蓉')).toBe(true);
        p.keeper.groupBindings[0]!.groupId = 'X';
        expect(p.allowed('芙蓉')).toBe(false);
    });
    it('retains Fiammetta cross-group refresh targets while rejecting her self-reference', () => {
        const p = prefix();
        p.keeper.occupant = {
            kind: 'operator', operatorId: id('菲亚梅塔')
        };
        expect(p.allowed('芙蓉')).toBe(true);
        expect(p.allowed('菲亚梅塔')).toBe(false);
    });
    it('retains the native ideal trading-runner exception, not a generic nonphysical exemption', () => {
        const p = prefix();
        p.worker.occupant = {
            kind: 'operator', operatorId: id('龙舌兰')
        };
        const trade = p.state.workspace.mainPlan.facilities.room_3_1.slots[0]!;
        trade.occupant = {
            kind: 'operator', operatorId: id('银灰')
        };
        p.state.decisions = [{
                kind: 'replacement', roomId: 'room_3_1', slotIndex: 0, listIndex: 0
            }];
        expect(p.allowed('龙舌兰')).toBe(true);
        const manufacture = p.state.workspace.mainPlan.facilities.room_1_1.slots[0]!;
        manufacture.occupant = {
            kind: 'operator', operatorId: id('砾')
        };
        p.state.decisions = [{
                kind: 'replacement', roomId: 'room_1_1', slotIndex: 0, listIndex: 0
            }];
        expect(p.allowed('龙舌兰')).toBe(false);
    });
});
