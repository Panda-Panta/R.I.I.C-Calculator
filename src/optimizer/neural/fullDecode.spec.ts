import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { createFullScenario, initialFullState, legalFullActions, action } from './fullActionSpace';
import { applyFullAction, finalizeFullState, fullNativeRuntimeAdmissionIssues } from './fullTransitions';
import { applyGeneratedWarmupPolicy, isWarmupOperatorInFacility } from '../generatedWarmupPolicy';
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

const mode = 'latest-warmup-exhaustion-v1' as const;
function context(latest = true) {
    const scenario = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), Object.assign({ constructionOrder: 'staffing-first-v1' as const }, latest ? { policyMode: mode } : {}));
    const state = initialFullState(scenario);
    state.workspace.mainPlan.facilities.room_1_1.slots[0]! = { occupant: { kind: 'operator', operatorId: id('砾') }, groupId: 'G', replacements: [] };
    state.decisions = [{ kind: 'replacement', roomId: 'room_1_1', slotIndex: 0, listIndex: 0 }];
    return { scenario, state };
}
const permits = (c: ReturnType<typeof context>, ref: string) => legalFullActions(c.scenario, c.state).some(a => a.id === action('operator', id(ref)).id);
describe('opt-in latest native warmup policy', () => {
    it('declares mode and moves explicit workaholic choices before bindings without changing legacy order', () => {
        const c = context();
        expect(c.scenario.policyMode).toBe(mode);
        const decisions = initialFullState(c.scenario).decisions;
        expect(decisions.findIndex(d => d.field === 'workaholic')).toBeLessThan(decisions.findIndex(d => d.kind === 'bindings'));
        const old = initialFullState(context(false).scenario).decisions;
        expect(old.findIndex(d => d.field === 'workaholic')).toBeGreaterThan(old.findIndex(d => d.kind === 'bindings'));
    });
    it('rejects policy-mode misuse rather than silently falling back', () => {
        const input = createDefaultWorkspace(), inv = compileOperatorInventory(fullCatalogIdleInventory());
        for (const options of [{ policyMode: 'unknown' }, { policyMode: mode, constructionOrder: 'legacy-v1' }])
            expect(createFullScenario(input, inv, options as any).valid).toBe(false);
    });
    it('masks the actual epoch20 Fen ordinary-warmup-relief failure while old staffing keeps its old action domain', () => {
        expect(permits(context(), '芬')).toBe(false);
        expect(permits(context(false), '芬')).toBe(true);
    });
    it.each(['same-facility-group', 'wrong-facility', 'wrong-group', 'multi-group', 'permanent', 'unbuilt'] as const)('matches native warmup primary-reference exception for %s', kind => {
        const c = context(), ws = c.state.workspace;
        const room = kind === 'wrong-facility' ? ws.mainPlan.facilities.room_3_1 : ws.mainPlan.facilities.room_1_2;
        room.slots[0]! = { occupant: { kind: 'operator', operatorId: id('芬') }, groupId: kind === 'wrong-group' ? 'H' : 'G', replacements: [] };
        if (kind === 'multi-group')
            room.slots[0]!.groupBindings = [{ groupId: 'H', replacements: [] }];
        if (kind === 'permanent')
            ws.mainPlan.conf.workaholic = ['芬'];
        if (kind === 'unbuilt')
            room.level = 0;
        const native = structuredClone(ws);
        native.mainPlan.facilities.room_1_1.slots[0]!.replacements = ['芬'];
        const allowed = applyGeneratedWarmupPolicy(native, c.scenario.inventory).valid;
        expect(allowed).toBe(kind === 'same-facility-group');
        expect(permits(c, '芬')).toBe(allowed);
    });
    it('preserves Fiammetta reference-only warmup targets', () => {
        const c = context();
        c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]! = { occupant: { kind: 'operator', operatorId: id('菲亚梅塔') }, groupId: null, replacements: [] };
        c.state.decisions = [{ kind: 'replacement', roomId: 'dormitory_1', slotIndex: 0, listIndex: 0 }];
        expect(permits(c, '芬')).toBe(true);
    });
    it('allows multi-group warmup primaries only after an explicit workaholic decision', () => {
        const c = context();
        c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('芬') };
        c.state.decisions = [{ kind: 'bindings', roomId: 'room_1_1', slotIndex: 0 }];
        expect(legalFullActions(c.scenario, c.state).some(a => a.kind === 'binding')).toBe(false);
        c.state.workspace.mainPlan.conf.workaholic = ['芬'];
        expect(legalFullActions(c.scenario, c.state).some(a => a.kind === 'binding')).toBe(true);
    });
    it('keeps exhaustion as explicit actions; END is unavailable while a required warmup primary remains', () => {
        const c = context();
        c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('芬') };
        c.state.decisions = [{ kind: 'conf-list', field: 'exhaust_require', listIndex: 0 }];
        const before = structuredClone(c.state);
        expect(legalFullActions(c.scenario, c.state).some(a => a.kind === 'end')).toBe(false);
        expect(applyFullAction(c.scenario, c.state, action('end')).diagnostics.some(d => d.code === 'ILLEGAL_ACTION')).toBe(true);
        expect(c.state).toEqual(before);
        const next = applyFullAction(c.scenario, c.state, action('operator', id('芬')));
        expect(next.workspace.mainPlan.conf.exhaust_require).toEqual([id('芬')]);
        expect(legalFullActions(c.scenario, next).some(a => a.kind === 'end')).toBe(true);
    });
    it('terminal validation rejects missing native warmup policy on a clone instead of repairing the workspace', () => {
        const c = context();
        c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'operator', operatorId: id('芬') };
        c.state.done = true;
        const before = structuredClone(c.state.workspace), result = finalizeFullState(c.scenario, c.state);
        expect(result.diagnostics.some(d => d.code === 'LATEST_WARMUP_POLICY_MISSING')).toBe(true);
        expect(result.workspace).toEqual(before);
    });
    it('uses unlocked skills in the actual facility, not a global warmup operator blacklist', () => {
        for (const phase of [0, 2] as const) {
            const c = context();
            c.scenario.inventory = compileOperatorInventory([{ operator: '砾', elitePhase: 2, level: 70 }, { operator: '机械师', elitePhase: phase, level: 1 }]);
            const warmup = isWarmupOperatorInFacility(id('机械师'), 'manufacture', c.scenario.inventory);
            expect(warmup).toBe(phase === 2);
            expect(permits(c, '机械师')).toBe(!warmup);
        }
    });
    it('applies the native exception to binding replacements and every existing reference group', () => {
        const c = context(), ws = c.state.workspace;
        ws.mainPlan.facilities.room_1_2.slots[0]! = { occupant: { kind: 'operator', operatorId: id('芬') }, groupId: 'G', replacements: [] };
        const slot = ws.mainPlan.facilities.room_1_1.slots[0]!;
        slot.groupBindings = [{ groupId: 'G', replacements: [] }];
        c.state.decisions = [{ kind: 'binding-replacement', roomId: 'room_1_1', slotIndex: 0, bindingIndex: 0, listIndex: 0 }];
        expect(permits(c, '芬')).toBe(true);
        slot.groupId = 'H';
        slot.replacements = ['芬'];
        expect(permits(c, '芬')).toBe(false);
    });
    it('requires explicit permanent coverage for a locked multi-group warmup primary before closing workaholic', () => {
        const c = context();
        const slot = c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!;
        slot.occupant = { kind: 'operator', operatorId: id('芬') };
        slot.groupBindings = [{ groupId: 'H', replacements: [] }];
        c.state.decisions = [{ kind: 'conf-list', field: 'workaholic', listIndex: 0 }];
        expect(legalFullActions(c.scenario, c.state).some(a => a.kind === 'end' || a.kind === 'absent')).toBe(false);
        const next = applyFullAction(c.scenario, c.state, action('operator', id('芬')));
        expect(next.workspace.mainPlan.conf.workaholic).toEqual([id('芬')]);
        expect(legalFullActions(c.scenario, next).some(a => a.kind === 'end')).toBe(true);
    });
    it('does not manufacture policy references for empty, inactive, non-warmup or explicit permanent primaries', () => {
        for (const kind of ['empty', 'inactive', 'non-warmup', 'permanent'] as const) {
            const c = context(), room = c.state.workspace.mainPlan.facilities.room_1_1, slot = room.slots[0]!;
            slot.occupant = kind === 'empty' ? { kind: 'empty' } : { kind: 'operator', operatorId: id(kind === 'non-warmup' ? '砾' : '芬') };
            if (kind === 'inactive')
                room.level = 0;
            if (kind === 'permanent')
                c.state.workspace.mainPlan.conf.workaholic = ['芬'];
            c.state.decisions = [{ kind: 'conf-list', field: 'exhaust_require', listIndex: 0 }];
            expect(legalFullActions(c.scenario, c.state).some(a => a.kind === 'end')).toBe(true);
            expect(c.state.workspace.mainPlan.conf.exhaust_require).toEqual([]);
        }
    });
    it('fails closed for unsupported final warmup relief without changing candidate policies', () => {
        const c = context();
        c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = ['芬'];
        c.state.done = true;
        const before = structuredClone(c.state.workspace), result = finalizeFullState(c.scenario, c.state);
        expect(result.complete).toBe(false);
        expect(result.diagnostics.some(d => d.code === 'LATEST_WARMUP_POLICY_UNSUPPORTED')).toBe(true);
        expect(result.workspace).toEqual(before);
        expect(c.state.workspace).toEqual(before);
    });
    it('counts a singleton required permanent-policy choice as forced, not as hidden completion or model choice', () => {
        const base = createDefaultWorkspace();
        for (const room of Object.values(base.mainPlan.facilities)) {
            room.level = 0;
            room.slots = [];
        }
        const room = base.mainPlan.facilities.room_1_1;
        room.level = 1;
        room.slots = [{ occupant: { kind: 'operator', operatorId: id('芬') }, groupId: 'G', replacements: [], groupBindings: [{ groupId: 'H', replacements: [] }] }];
        base.mainPlan.conf.workaholic = ['芬', 'Lancet-2'];
        const power = base.mainPlan.facilities.room_1_3;
        power.level = 3;
        power.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }];
        const s = createFullScenario(base, compileOperatorInventory([{ operator: '芬', elitePhase: 1, level: 55 }, { operator: 'Lancet-2', elitePhase: 0, level: 30 }]), { constructionOrder: 'staffing-first-v1', policyMode: mode });
        const result = decodeFullRoster(s, ({ actions }) => actions.map(a => a.id === action('operator', id('Lancet-2')).id ? 3 : a.kind === 'end' || a.kind === 'absent' ? 2 : 1));
        expect(result.diagnostics).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.policyMode).toBe(mode);
        const forced = result.trace.filter(t => t.actions.length === 1);
        expect(forced).toHaveLength(2);
        expect(forced[0]!.decision.field).toBe('workaholic');
        expect(forced[0]!.action).toEqual(action('operator', id('芬')));
        expect(result.forcedActions).toBe(2);
        expect(result.modelActions).toBe(result.trace.length);
        expect(result.modelChoiceActions).toBe(result.trace.length - 2);
        expect(forced[1]!.action.kind).toBe('end');
        expect(base.mainPlan.conf.workaholic).toEqual(['芬', 'Lancet-2']);
    });
});

function runtimeFixture(mode = 'latest-warmup-runorder-v2') {
    const s = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), { constructionOrder: 'staffing-first-v1', policyMode: mode as any }), state = initialFullState(s);
    state.workspace.mainPlan.facilities.room_1_1.slots[0]! = { occupant: { kind: 'operator', operatorId: id('砾') }, groupId: null, replacements: [] };
    state.decisions = [{ kind: 'replacement', roomId: 'room_1_1', slotIndex: 0, listIndex: 0 }];
    return { s, state };
}
const runtimeAllows = (c: ReturnType<typeof runtimeFixture>, name: string) => legalFullActions(c.s, c.state).some(a => a.id === action('operator', id(name)).id);
describe('explicit latest runtime admission v2', () => {
    it('recognizes v2 without changing v1', () => { expect(runtimeFixture().s.valid).toBe(true); expect(runtimeFixture('latest-warmup-exhaustion-v1').s.valid).toBe(true); });
    it.each(['但书', '龙舌兰', '佩佩', '可露希尔'])('masks the native direct nontrade trigger %s only in v2', name => { expect(runtimeAllows(runtimeFixture('latest-warmup-exhaustion-v1'), name)).toBe(true); expect(runtimeAllows(runtimeFixture(), name)).toBe(false); });
    it('preserves U-Official nontrade exception', () => expect(runtimeAllows(runtimeFixture(), 'U-Official')).toBe(true));
    it.each(['trading', 'central', 'binding', 'trailing-empty', 'gaming'] as const)('preserves native non-trigger domain %s', kind => {
        const contexts = [runtimeFixture(), runtimeFixture('latest-warmup-exhaustion-v1')];
        for (const c of contexts) {
            const r = c.state.workspace.mainPlan.facilities.room_1_1;
            if (kind === 'trading')
                r.type = 'trading';
            if (kind === 'gaming')
                r.type = 'gaming';
            if (kind === 'trailing-empty')
                r.slots[0]!.occupant = { kind: 'empty' };
            if (kind === 'central') {
                c.state.workspace.mainPlan.facilities.central.slots[0] = r.slots[0]!;
                c.state.decisions[0]!.roomId = 'central';
            }
            if (kind === 'binding') {
                r.slots[0]!.groupBindings = [{ groupId: 'G', replacements: [] }];
                c.state.decisions = [{ kind: 'binding-replacement', roomId: 'room_1_1', slotIndex: 0, bindingIndex: 0, listIndex: 0 }];
            }
        }
        expect(runtimeAllows(contexts[0]!, '龙舌兰')).toBe(runtimeAllows(contexts[1]!, '龙舌兰'));
        expect(runtimeAllows(contexts[1]!, '龙舌兰')).toBe(true);
    });
    it('clone-native terminal admission rejects preserved bad refs without repairing or honoring inert wake false', () => {
        const c = runtimeFixture();
        c.state.workspace.mainPlan.facilities.room_1_1.slots[0]!.replacements = ['龙舌兰'];
        const before = structuredClone(c.state.workspace);
        const issues = fullNativeRuntimeAdmissionIssues(c.state.workspace, { idealRunOrderWakeOnly: false });
        expect(issues.some((d) => d.code === 'LATEST_NATIVE_RUNORDER_NONTRADING_ROOM' && d.message === 'room_1_1')).toBe(true);
        expect(c.state.workspace).toEqual(before);
    });
});
