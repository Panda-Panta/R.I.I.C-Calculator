import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { createFullScenario, initialFullState, legalFullActions, action } from './fullActionSpace';
import { fullGroupCoverageFeasible, fullGroupReferenceKey } from './fullGroupCoverage';
import { validateMowerRosterRules } from '../../domain/mowerRosterRules';
import { applyFullAction } from './fullTransitions';
import { replayFullTeacher } from './fullTeacherTraces';
function context(mode = 'latest-native-group-cover-v3') {
    const s = createFullScenario(createDefaultWorkspace(), compileOperatorInventory(fullCatalogIdleInventory()), { constructionOrder: 'staffing-first-v1', policyMode: mode as any }), state = initialFullState(s);
    const slots = state.workspace.mainPlan.facilities.room_1_1.slots;
    ['砾', '霜叶', '断罪者'].forEach((name, i) => slots[i] = { occupant: { kind: 'operator', operatorId: id(name) }, groupId: 'G', replacements: i < 2 ? [id('斑点')] : [] });
    state.decisions = [{ kind: 'replacement', roomId: 'room_1_1', slotIndex: 1, listIndex: 1 }, { kind: 'replacement', roomId: 'room_1_1', slotIndex: 2, listIndex: 0 }];
    return { s, state };
}
const permits = (c: ReturnType<typeof context>, a: ReturnType<typeof action>) => legalFullActions(c.s, c.state).some(v => v.id === a.id);
describe('prefix native coverage', () => {
    it('recognizes explicit v3 but leaves v2 END unchanged', () => { expect(context().s.valid).toBe(true); expect(permits(context('latest-warmup-runorder-v2'), action('end'))).toBe(true); });
    it('masks the irreversible second shared-Spot END, not adding a valid explicit alternative', () => { const c = context(); expect(permits(c, action('end'))).toBe(false); expect(permits(c, action('operator', id('香草')))).toBe(true); });
    it('allows shared candidates when later lists still permit an injective assignment', () => { const c = context(); c.state.workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements.push(id('香草')); expect(permits(c, action('end'))).toBe(true); });
    it('allows zero-mood empty-list exemption but not duplicate-only nonempty closed rows', () => { const c = context(); c.state.workspace.mainPlan.conf.workaholic = ['砾', '霜叶', '断罪者']; for (const p of c.state.workspace.mainPlan.facilities.room_1_1.slots)
        p.replacements = []; expect(permits(c, action('end'))).toBe(true); });
});
function nativeFixture(options: string[][], permanent = false, dormLast = false) {
    const ws = createDefaultWorkspace();
    for (const room of Object.values(ws.mainPlan.facilities)) {
        room.level = 0;
        room.slots = [];
    }
    const room = ws.mainPlan.facilities.room_1_1;
    room.level = 3;
    options.forEach((refs, i) => room.slots.push({ occupant: { kind: 'operator', operatorId: id(['砾', '霜叶', '断罪者'][i]!) }, groupId: 'G', replacements: refs }));
    if (permanent)
        ws.mainPlan.conf.workaholic = ['砾', '霜叶', '断罪者'];
    if (dormLast) {
        const dorm = ws.mainPlan.facilities.dormitory_1;
        dorm.level = 5;
        dorm.slots = [room.slots.pop()!];
    }
    return ws;
}
const nativeCovered = (ws: ReturnType<typeof nativeFixture>) => !validateMowerRosterRules(ws).some(issue => issue.message.includes('替班名单不能覆盖所有成员'));
const candidates = ['斑点', '香草', '夜刀'].map(id);
const subset = (mask: number, values = candidates) => values.filter((_, i) => mask & (1 << i));
describe('native coverage existence, without choosing or writing assignments', () => {
    it('matches final native coverage for 3,072 finite domains including zero-mood and dorm-Free exemptions', () => {
        let cases = 0;
        for (let a = 0; a < 8; a++)
            for (let b = 0; b < 8; b++)
                for (let c = 0; c < 8; c++)
                    for (const permanent of [false, true])
                        for (const variant of ['work', 'dorm', 'dorm-free']) {
                            const ws = nativeFixture([subset(a), subset(b), [...subset(c), ...(variant === 'dorm-free' ? ['Free'] : [])]], permanent, variant !== 'work');
                            expect(fullGroupCoverageFeasible(ws)).toBe(nativeCovered(ws));
                            cases++;
                        }
        expect(cases).toBe(3072);
    });
    it('matches existence over every subset extension of 256 small partial-list cases', () => {
        for (let seed = 0; seed < 256; seed++) {
            const existing = [subset(seed & 3, candidates.slice(0, 2)), subset((seed >> 2) & 3, candidates.slice(0, 2))];
            const future = [subset((seed >> 4) & 3, candidates.slice(0, 2)), subset((seed >> 6) & 3, candidates.slice(0, 2))];
            for (const permanent of [false, true]) {
                const ws = nativeFixture(existing, permanent), before = structuredClone(ws);
                const feasible = fullGroupCoverageFeasible(ws, key => { const i = [0, 1].find(i => key === fullGroupReferenceKey('room_1_1', i)); return i === undefined ? undefined : { free: false, operators: () => future[i]! }; });
                let completion = false;
                for (let a = 0; a < (1 << future[0]!.length); a++)
                    for (let b = 0; b < (1 << future[1]!.length); b++) {
                        const final = structuredClone(ws);
                        [a, b].forEach((mask, i) => final.mainPlan.facilities.room_1_1.slots[i]!.replacements = [...new Set([...existing[i]!, ...subset(mask, future[i]!)])]);
                        completion ||= nativeCovered(final);
                    }
                expect(feasible).toBe(completion);
                expect(ws).toEqual(before);
            }
        }
    });
    it('uses first matching binding and treats closed missing bindings as obligations rather than future imaginary lists', () => {
        const ws = nativeFixture([[id('斑点')], [id('香草')]]);
        ws.mainPlan.facilities.room_1_1.slots[0]!.groupBindings = [{ groupId: 'H', replacements: [] }];
        expect(fullGroupCoverageFeasible(ws)).toBe(false);
        expect(fullGroupCoverageFeasible(ws, key => key === fullGroupReferenceKey('room_1_1', 0, 0) ? { free: false, operators: () => [id('夜刀')] } : undefined)).toBe(true);
        expect(fullGroupCoverageFeasible(ws)).toBe(nativeCovered(ws));
    });
    it('permits a real future dorm-Free action but never invents it for a closed list', () => {
        const ws = nativeFixture([[id('斑点')], []], false, true);
        expect(fullGroupCoverageFeasible(ws)).toBe(false);
        expect(fullGroupCoverageFeasible(ws, key => key === fullGroupReferenceKey('dormitory_1', 0) ? { free: true, operators: () => [] } : undefined)).toBe(true);
        expect(ws.mainPlan.facilities.dormitory_1.slots[0]!.replacements).toEqual([]);
    });
    it('preserves same-group primary reuse and excludes all native trade runners from coverage', () => {
        const ws = nativeFixture([[id('霜叶')], [id('砾')]]);
        expect(fullGroupCoverageFeasible(ws)).toBe(true);
        for (const ref of ['但书', '龙舌兰', '佩佩', '可露希尔', 'U-Official']) {
            ws.mainPlan.facilities.room_1_1.slots[0]!.replacements = [id(ref)];
            expect(fullGroupCoverageFeasible(ws)).toBe(false);
            expect(nativeCovered(ws)).toBe(false);
        }
    });
    it('masks a reservation that destroys another unfinished group without banning same-group alternatives', () => {
        const c = context(), ws = c.state.workspace;
        c.s.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['砾', '霜叶', '断罪者', '斑点', '香草'].some(name => entry.operator === id(name))));
        ws.mainPlan.facilities.room_1_1.slots[1]!.replacements = [];
        ws.mainPlan.facilities.room_1_1.slots[2]!.groupId = 'H';
        c.state.decisions[0]!.listIndex = 0;
        const before = structuredClone(c.state);
        expect(permits(c, action('operator', id('香草')))).toBe(false);
        expect(permits(c, action('operator', id('砾')))).toBe(true);
        expect(c.state).toEqual(before);
        const rejected = applyFullAction(c.s, c.state, action('operator', id('香草')));
        expect(rejected.diagnostics.some(d => d.code === 'ILLEGAL_ACTION')).toBe(true);
        expect(rejected.workspace).toEqual(before.workspace);
    });
    it('does not admit duplicate/self references, or reinterpret an unrelated Fiammetta target as physical cover', () => {
        const c = context();
        expect(permits(c, action('operator', id('霜叶')))).toBe(false);
        expect(permits(c, action('operator', id('斑点')))).toBe(false);
        c.state.workspace.mainPlan.facilities.room_1_1.slots[1]!.replacements.push(id('香草'));
        c.state.workspace.mainPlan.facilities.dormitory_1.slots[0]! = { occupant: { kind: 'operator', operatorId: id('菲亚梅塔') }, groupId: null, replacements: [] };
        c.state.decisions.unshift({ kind: 'replacement', roomId: 'dormitory_1', slotIndex: 0, listIndex: 0 });
        expect(permits(c, action('operator', id('砾')))).toBe(true);
    });
});
describe('memoized witness fast path preserves full prospective feasibility', () => {
    it('matches a slow V2-legality oracle on 128 alias/Free/zero-mood and cross-group prefixes', () => {
        for (let seed = 0; seed < 128; seed++) {
            const c = context(), ws = c.state.workspace, slots = ws.mainPlan.facilities.room_1_1.slots;
            c.s.inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['砾', '霜叶', '断罪者', '斑点', '香草'].some(name => entry.operator === id(name))));
            slots.forEach((slot, i) => { slot.replacements = subset((seed >> (i * 2)) & 3, candidates.slice(0, 2)); slot.groupId = i === 0 ? 'G' : (seed & (1 << (i + 4))) ? 'H' : 'G'; });
            if (seed & 1)
                for (const slot of slots)
                    slot.replacements = slot.replacements.map(ref => ref === id('斑点') ? '斑点' : '香草');
            if (seed % 3 === 0)
                ws.mainPlan.conf.workaholic = ['砾', '霜叶', '断罪者'];
            c.state.decisions[0]!.listIndex = slots[1]!.replacements.length;
            if (seed % 4 >= 2) {
                ws.mainPlan.facilities.dormitory_1.slots[0] = slots[2]!;
                slots[2] = { occupant: { kind: 'empty' }, groupId: null, replacements: [] };
                c.state.decisions = [{ kind: 'replacement', roomId: 'dormitory_1', slotIndex: 0, listIndex: ws.mainPlan.facilities.dormitory_1.slots[0]!.replacements.length }, c.state.decisions[0]!];
            }
            const v2 = { ...c.s, policyMode: 'latest-warmup-runorder-v2' as const }, before = structuredClone(c.state);
            const raw = legalFullActions(v2, c.state);
            const expected = raw.filter(a => {
                const after = applyFullAction(v2, c.state, a);
                const lists = new Map(after.decisions.slice(after.decisionIndex).map(d => [fullGroupReferenceKey(d.roomId!, d.slotIndex!, d.kind === 'binding-replacement' ? d.bindingIndex! : -1), d]));
                return fullGroupCoverageFeasible(after.workspace, key => {
                    const d = lists.get(key);
                    if (!d)
                        return undefined;
                    const options = legalFullActions(v2, { ...after, decisions: [d], decisionIndex: 0, done: false });
                    return { free: options.some(a => a.kind === 'free'), operators: () => options.filter(a => a.kind === 'operator').map(a => String(a.value)) };
                });
            }).map(a => a.id);
            expect(legalFullActions(c.s, c.state).map(a => a.id)).toEqual(expected);
            expect(c.state).toEqual(before);
        }
    });
    it('adding legal dorm Free leaves every other operator V2 eligibility unchanged, including alias references', () => {
        const c = context('latest-warmup-runorder-v2'), ws = c.state.workspace;
        ws.mainPlan.facilities.dormitory_1.slots[0] = { occupant: { kind: 'operator', operatorId: id('杜林') }, groupId: 'G', replacements: ['香草'] };
        const decisions = [...c.state.decisions, { kind: 'replacement' as const, roomId: 'dormitory_1' as const, slotIndex: 0, listIndex: 1 }];
        const operators = () => decisions.map(d => legalFullActions(c.s, { ...c.state, decisions: [d], decisionIndex: 0 }).filter(a => a.kind === 'operator').map(a => a.id));
        const before = operators();
        ws.mainPlan.facilities.dormitory_1.slots[0]!.replacements.push('Free');
        expect(operators()).toEqual(before);
    });
    it('keeps literal native group strings distinct rather than trimming or globally banning shared references', () => {
        const ws = nativeFixture([[id('斑点')], [id('斑点')], [id('斑点')]]);
        ws.mainPlan.facilities.room_1_1.slots.forEach((slot, i) => slot.groupId = ['G', ' G', 'G '][i]!);
        expect(nativeCovered(ws)).toBe(true);
        expect(fullGroupCoverageFeasible(ws)).toBe(true);
    });
});
describe('valid native target prefixes', () => {
    it('accepts every explicit prefix of twelve native-complete shared-reference teachers', () => {
        const inventory = compileOperatorInventory(fullCatalogIdleInventory().filter(entry => ['砾', '霜叶', '断罪者', '斑点', '香草', '夜刀', 'Lancet-2', '杜林'].some(name => entry.operator === id(name))));
        let checked = 0;
        outer: for (let a = 1; a < 8; a++)
            for (let b = 1; b < 8; b++)
                for (let c = 1; c < 8; c++) {
                    const teacher = nativeFixture([subset(a), subset(b), subset(c)]);
                    teacher.mainPlan.facilities.room_1_3.level = 3;
                    teacher.mainPlan.facilities.room_1_3.slots = [{ occupant: { kind: 'operator', operatorId: id('Lancet-2') }, groupId: null, replacements: [] }];
                    teacher.mainPlan.conf.workaholic = [id('Lancet-2')];
                    const dorm = teacher.mainPlan.facilities.dormitory_1;
                    dorm.level = 5;
                    dorm.slots = Array.from({ length: 5 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] }));
                    dorm.slots[0]!.occupant = { kind: 'operator', operatorId: id('杜林') };
                    if (validateMowerRosterRules(teacher).length)
                        continue;
                    const base = structuredClone(teacher);
                    base.mainPlan.facilities.room_1_1.slots = base.mainPlan.facilities.room_1_1.slots.map(() => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] }));
                    const replay = replayFullTeacher(createFullScenario(base, inventory, { constructionOrder: 'staffing-first-v1', policyMode: 'latest-native-group-cover-v3' }), teacher);
                    expect(replay.diagnostics).toEqual([]);
                    expect(replay.complete && replay.exactReplay).toBe(true);
                    if (++checked === 12)
                        break outer;
                }
        expect(checked).toBe(12);
    });
});
