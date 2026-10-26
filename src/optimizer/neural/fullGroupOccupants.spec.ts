import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { validateMowerRosterRules } from '../../domain/mowerRosterRules';
import { createFullScenario, initialFullState, legalFullActions, action, type FullDecision, type FullPolicyMode } from './fullActionSpace';
import { applyFullAction, finalizeFullState } from './fullTransitions';
const MODE = 'latest-native-group-occupants-v4' as FullPolicyMode;
function context(occupant: 'free' | 'empty' | string = '菲亚梅塔', kind: FullDecision['kind'] = 'group', mode: FullPolicyMode = MODE) {
    const s = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), { constructionOrder: 'staffing-first-v1', policyMode: 'latest-native-group-cover-v3' });
    s.policyMode = mode;
    const state = initialFullState(s), room = state.workspace.mainPlan.facilities.dormitory_1;
    room.slots[0] = { occupant: occupant === 'free' || occupant === 'empty' ? { kind: occupant } : { kind: 'operator', operatorId: occupant }, groupId: null, replacements: [] };
    state.decisions = [{ kind, roomId: room.roomId, slotIndex: 0 }];
    s.retainedGroupNames = ['', ' ', 'G'];
    return { s, state };
}
const ids = (c: ReturnType<typeof context>) => legalFullActions(c.s, c.state).map(a => a.id);
const groupIssues = (c: ReturnType<typeof context>) => validateMowerRosterRules(c.state.workspace).filter(i => i.message.includes('Free 不能配置绑组') || i.message.includes('菲亚梅塔不能参与绑组'));
describe('opt-in native Free/Fiammetta occupant group invariants', () => {
    it('recognizes v4 only with staffing-first construction', () => {
        const { s } = context();
        expect(createFullScenario(s.workspace, s.inventory, { constructionOrder: 'staffing-first-v1', policyMode: MODE }).valid).toBe(true);
        expect(createFullScenario(s.workspace, s.inventory, { policyMode: MODE }).diagnostics.some(d => d.code === 'INVALID_POLICY_MODE')).toBe(true);
    });
    it.each(['free', '菲亚梅塔', id('菲亚梅塔')])('masks only native-truthy group names for %s', occupant => {
        const c = context(occupant);
        expect(ids(c)).toEqual([action('value', null).id, action('value', '').id]);
        const before = structuredClone(c.state), rejected = applyFullAction(c.s, c.state, action('value', 'G'));
        expect(rejected.diagnostics.some(d => d.code === 'ILLEGAL_ACTION')).toBe(true);
        expect(rejected.workspace).toEqual(before.workspace);
        expect(c.state).toEqual(before);
    });
    it.each(['free', '菲亚梅塔'])('allows absent or empty binding array but no added column for %s', occupant => {
        const c = context(occupant, 'bindings');
        expect(ids(c)).toEqual([action('absent').id, action('end').id]);
        expect(applyFullAction(c.s, c.state, action('absent')).workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupBindings).toBeUndefined();
        expect(applyFullAction(c.s, c.state, action('end')).workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupBindings).toEqual([]);
        c.state.decisions[0]!.listIndex = 0;
        expect(ids(c)).toEqual([action('end').id]);
    });
    it.each(['free', '菲亚梅塔'])('keeps native empty-group semantics but rejects even a null-name extra column for %s', occupant => {
        const c = context(occupant);
        for (const groupId of [null, '']) { c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupId = groupId; expect(groupIssues(c)).toEqual([]); }
        c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupBindings = [{ groupId: null, replacements: [] }];
        expect(groupIssues(c)).toHaveLength(1);
        c.state.done = true;
        expect(finalizeFullState(c.s, c.state).diagnostics.some(d => d.code === 'INVALID_CONFIG')).toBe(true);
    });
    it('also filters binding-group values on an externally supplied unsupported prefix without repairing it', () => {
        const c = context('菲亚梅塔', 'binding-group');
        c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupBindings = [{ groupId: null, replacements: [] }];
        c.state.decisions[0]!.bindingIndex = 0;
        expect(ids(c)).toEqual([action('value', null).id, action('value', '').id]);
        const before = structuredClone(c.state.workspace);
        c.state.done = true;
        expect(finalizeFullState(c.s, c.state).complete).toBe(false);
        expect(c.state.workspace).toEqual(before);
    });
    it.each(['legacy-unconstrained-v1', 'latest-warmup-exhaustion-v1', 'latest-warmup-runorder-v2', 'latest-native-group-cover-v3'] as const)('leaves prior %s group and binding domains unchanged', mode => {
        for (const occupant of ['free', '菲亚梅塔']) {
            const c = context(occupant, 'group', mode);
            expect(ids(c)).toContain(action('value', 'G').id);
            c.state.decisions[0]!.kind = 'bindings';
            expect(ids(c)).toContain(action('binding').id);
        }
    });
    it('does not broaden the mask to empty slots or ordinary dorm primaries', () => {
        for (const occupant of ['empty', '杜林']) for (const kind of ['group', 'bindings'] as const) {
            const c = context(occupant, kind), old = { ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' as const } };
            expect(ids(c)).toEqual(ids(old));
        }
    });
    it('retains Fiammetta refresh targets that are working primaries', () => {
        const c = context('菲亚梅塔', 'replacement');
        c.state.workspace.mainPlan.facilities.room_1_1.level = 3;
        c.state.workspace.mainPlan.facilities.room_1_1.slots = [{ occupant: { kind: 'operator', operatorId: id('砾') }, groupId: null, replacements: [] }];
        expect(ids(c)).toContain(action('operator', id('砾')).id);
        expect(ids(c)).toEqual(ids({ ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' } }));
    });
    it('retains Free replacements on an ordinary grouped dorm primary', () => {
        const c = context('杜林', 'replacement');
        c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupId = 'G';
        expect(ids(c)).toContain(action('free').id);
        expect(ids(c)).toEqual(ids({ ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' } }));
    });
    it('inherits V3 same-group primary reuse and native runorder/coverage domains exactly', () => {
        const c = context('杜林', 'replacement'), room = c.state.workspace.mainPlan.facilities.room_1_1;
        room.slots = ['砾', '霜叶', '断罪者'].map(operatorId => ({ occupant: { kind: 'operator' as const, operatorId: id(operatorId) }, groupId: 'G', replacements: [] }));
        c.state.decisions = [{ kind: 'replacement', roomId: room.roomId, slotIndex: 0, listIndex: 0 }, { kind: 'replacement', roomId: room.roomId, slotIndex: 1, listIndex: 0 }, { kind: 'replacement', roomId: room.roomId, slotIndex: 2, listIndex: 0 }];
        expect(ids(c)).toContain(action('operator', id('霜叶')).id);
        expect(ids(c)).not.toContain(action('operator', id('龙舌兰')).id);
        expect(ids(c)).toEqual(ids({ ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' } }));
        room.slots[0]!.replacements = [id('斑点')]; room.slots[1]!.replacements = [id('斑点')];
        c.state.decisions.shift(); c.state.decisions[0]!.listIndex = 1;
        expect(ids(c)).not.toContain(action('end').id);
        expect(ids(c)).toEqual(ids({ ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' } }));
    });
    it('matches the two native occupant prohibitions across falsy/truthy names and column forms', () => {
        for (const occupant of ['free', '菲亚梅塔', id('菲亚梅塔'), '杜林', 'empty']) {
            const c = context(occupant), old = { ...c, s: { ...c.s, policyMode: 'latest-native-group-cover-v3' as const } };
            for (const choice of legalFullActions(old.s, old.state)) {
                const projected = { ...c, state: structuredClone(c.state) };
                projected.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupId = choice.value as string | null;
                expect(ids(c).includes(choice.id)).toBe(groupIssues(projected).length === 0);
            }
            c.state.decisions[0]!.kind = 'bindings';
            for (const choice of legalFullActions(old.s, old.state)) {
                const projected = { ...c, state: structuredClone(c.state) };
                if (choice.kind !== 'absent') projected.state.workspace.mainPlan.facilities.dormitory_1.slots[0]!.groupBindings = choice.kind === 'binding' ? [{ groupId: null, replacements: [] }] : [];
                expect(ids(c).includes(choice.id)).toBe(groupIssues(projected).length === 0);
            }
        }
    });

});
