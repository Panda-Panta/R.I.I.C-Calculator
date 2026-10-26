import { describe, it, expect } from 'vitest';
import { createDefaultWorkspace } from '../../workbench/defaults';
import { compileOperatorInventory, fullCatalogIdleInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { createFullScenario, initialFullState, legalFullActions, action } from './fullActionSpace';
import { applyFullAction } from './fullTransitions';
import { replayFullTeacher, fullSemanticWorkspace } from './fullTeacherTraces';
function fixture() {
    const base = createDefaultWorkspace();
    const inv = compileOperatorInventory(fullCatalogIdleInventory());
    return {
        base, inv
    };
}
function staffMissing(t: ReturnType<typeof createDefaultWorkspace>, inv: ReturnType<typeof compileOperatorInventory>) {
    const used = new Set(Object.values(t.mainPlan.facilities).flatMap(r => r.slots.flatMap(p => [...(p.occupant.kind === 'operator' ? [id(p.occupant.operatorId)] : []), ...p.replacements.map(id)])));
    for (const r of Object.values(t.mainPlan.facilities)) {
        if (r.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(r.type)) {
            for (const p of r.slots) {
                if (p.occupant.kind === 'empty') {
                    const o = inv.operators.find(o => !used.has(o.charId) && ![
                        '佩佩', 'U-Official', '菲亚梅塔', '但书', '龙舌兰'
                    ].includes(o.name))!;
                    used.add(o.charId);
                    p.occupant = {
                        kind: 'operator', operatorId: o.charId
                    };
                    t.mainPlan.conf.workaholic.push(o.charId);
                }
            }
        }
    }
    for (const r of Object.values(t.mainPlan.facilities)) {
        if (r.level > 0 && r.type === 'dormitory') {
            if (!r.slots.some(p => p.occupant.kind === 'operator')) {
                const o = inv.operators.find(o => !used.has(o.charId) && o.name !== '菲亚梅塔')!;
                used.add(o.charId);
                r.slots[0]!.occupant = {
                    kind: 'operator', operatorId: o.charId
                };
            }
            for (const p of r.slots) {
                if (p.occupant.kind === 'empty') {
                    p.occupant = { kind: 'free' };
                }
            }
        }
    }
    return t;
}
describe('full-v2 factored teacher semantics', () => {
    it.each(['legacy-v1', 'staffing-first-v1'] as const)('replays cross-room groups, workaholics, dorm resident, ordered runner/ordinary/Fiammetta references and policies from empty input (%s)', constructionOrder => {
        const { base, inv } = fixture();
        base.mainPlan.conf.custom = { preserve: ['z', 'a'] };
        base.compatibility.unrecognizedFields = { extra: 42 };
        const teacher = structuredClone(base);
        const put = (r: keyof typeof teacher.mainPlan.facilities, i: number, name: string, group: string | null, refs: string[] = []) => {
            teacher.mainPlan.facilities[r].slots[i] = {
                occupant: {
                    kind: 'operator', operatorId: id(name)
                }, groupId: group, replacements: refs.map(id)
            };
        };
        put('room_1_1', 0, '砾', 'cross', ['斑点']);
        put('room_1_2', 0, '苍苔', 'cross', ['清流']);
        put('central', 0, '阿米娅', null);
        put('dormitory_1', 0, '菲亚梅塔', null, ['苍苔', '砾']);
        put('dormitory_2', 0, '杜林', null);
        teacher.mainPlan.facilities.dormitory_2.slots[0]!.dormitoryResident = true;
        for (const room of Object.values(teacher.mainPlan.facilities)) {
            if (room.type === 'dormitory') {
                for (const slot of room.slots) {
                    if (slot.occupant.kind === 'empty') {
                        slot.occupant = { kind: 'free' };
                    }
                }
            }
        }
        put('room_3_1', 0, '空弦', null, ['龙舌兰', '但书', '能天使']);
        teacher.mainPlan.conf.workaholic = [id('阿米娅')];
        teacher.mainPlan.conf.rest_in_full = [id('苍苔'), id('砾')];
        teacher.mainPlan.conf.ling_xi = 3;
        staffMissing(teacher, inv);
        const s = createFullScenario(base, inv, { constructionOrder }), result = replayFullTeacher(s, teacher);
        expect(result.diagnostics).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.samples.length).toBeGreaterThan(250);
        expect(fullSemanticWorkspace(s, result.workspace)).toBe(fullSemanticWorkspace(s, teacher));
        expect(base.mainPlan.facilities.room_1_1.slots[0]!.occupant.kind).toBe('empty');
    });
    it('rejects changed unknown metadata rather than dropping it', () => {
        const { base, inv } = fixture();
        const teacher = structuredClone(base);
        teacher.compatibility.unrecognizedFields.newSemantics = true;
        staffMissing(teacher, inv);
        const r = replayFullTeacher(createFullScenario(base, inv), teacher);
        expect(r.complete).toBe(false);
        expect(r.diagnostics.some(d => d.code === 'TEACHER_SEMANTIC_MISMATCH')).toBe(true);
        expect(r.samples).toEqual([]);
    });
    it('preserves input locked slots and immutable metadata', () => {
        const { base, inv } = fixture();
        base.mainPlan.facilities.dormitory_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('杜林')
            }, groupId: null, replacements: [], metadata: { future: 7 }
        };
        const s = createFullScenario(base, inv), r = replayFullTeacher(s, staffMissing(structuredClone(base), inv));
        expect(r.diagnostics).toEqual([]);
        expect(r.complete).toBe(true);
        expect(r.frozenSlots).toBe(1);
    });
    it('rejects an illegal action transactionally and masks duplicate physical placement', () => {
        const { base, inv } = fixture();
        const s = createFullScenario(base, inv), state = initialFullState(s), a = action('operator', id('砾'));
        const next = applyFullAction(s, state, a);
        expect(state.workspace).toEqual(s.workspace);
        expect(legalFullActions(s, next).some(x => x.id === a.id)).toBe(false);
        const rejected = applyFullAction(s, next, a);
        expect(rejected.workspace).toEqual(next.workspace);
        expect(rejected.diagnostics[0]?.code).toBe('ILLEGAL_ACTION');
    });
    it('preserves list order and rejects forbidden trade roles', () => {
        const { base, inv } = fixture();
        const t = structuredClone(base);
        t.mainPlan.facilities.room_3_1.slots[0]!.occupant = {
            kind: 'operator', operatorId: id('佩佩')
        };
        const r = replayFullTeacher(createFullScenario(base, inv), t);
        expect(r.complete).toBe(false);
        expect(r.diagnostics.some(d => d.code === 'TEACHER_ACTION_MASKED')).toBe(true);
    });
    it.each(['legacy-v1', 'staffing-first-v1'] as const)('replays multiple binding columns including Free reference and preserves binding order (%s)', constructionOrder => {
        const { base, inv } = fixture(), t = structuredClone(base);
        t.mainPlan.facilities.room_1_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('砾')
            }, groupId: 'a', replacements: [id('斑点')]
        };
        t.mainPlan.facilities.room_1_2.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('苍苔')
            }, groupId: 'b', replacements: [id('清流')]
        };
        t.mainPlan.facilities.dormitory_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('杜林')
            }, groupId: 'a', replacements: ['Free'], groupBindings: [{
                    groupId: 'b', replacements: ['Free']
                }]
        };
        for (const room of Object.values(t.mainPlan.facilities)) {
            if (room.type === 'dormitory') {
                for (const slot of room.slots) {
                    if (slot.occupant.kind === 'empty') {
                        slot.occupant = { kind: 'free' };
                    }
                }
            }
        }
        staffMissing(t, inv);
        const s = createFullScenario(base, inv, { constructionOrder }), r = replayFullTeacher(s, t);
        expect(r.diagnostics).toEqual([]);
        expect(r.complete).toBe(true);
        expect(fullSemanticWorkspace(s, r.workspace)).toBe(fullSemanticWorkspace(s, t));
    });
    it('recompiles actual low-stage skills and rejects absent operators', () => {
        const { base } = fixture();
        const inv = compileOperatorInventory([{
                operator: '砾', elitePhase: 0, level: 1
            }]);
        const s = createFullScenario(base, inv);
        expect(s.inventory.operators[0]?.elitePhase).toBe(0);
        const t = structuredClone(base);
        t.mainPlan.facilities.room_1_1.slots[0]!.occupant = {
            kind: 'operator', operatorId: id('苍苔')
        };
        expect(replayFullTeacher(s, t).diagnostics.some(d => d.code === 'TEACHER_ACTION_MASKED')).toBe(true);
    });
    it('distinguishes an exact immutable empty lock from qualified completion', () => {
        const { base, inv } = fixture();
        const teacher = staffMissing(structuredClone(base), inv);
        teacher.mainPlan.facilities.room_1_1.slots[0]!.occupant = { kind: 'empty' };
        const r = replayFullTeacher(createFullScenario(base, inv, { lockedSlots: ['room_1_1:0'] }), teacher);
        expect(r.exactReplay).toBe(true);
        expect(r.complete).toBe(false);
        expect(r.samples).toEqual([]);
        expect(r.diagnostics.some(d => d.code === 'UNSTAFFED_MANDATORY_SLOT')).toBe(true);
    });
    it.each(['primary', 'binding'] as const)('replays a same-group main actor already referenced by a locked %s relief list', column => {
        const { base, inv } = fixture();
        for (const [i, room] of Object.values(base.mainPlan.facilities).filter(r => r.type === 'dormitory').entries()) {
            room.slots[0]!.occupant = {
                kind: 'operator', operatorId: id(['杜林', '闪灵', '芙蓉', '安赛尔'][i]!)
            };
            for (const slot of room.slots.slice(1)) {
                slot.occupant = { kind: 'free' };
            }
        }
        const teacher = structuredClone(base);
        teacher.mainPlan.facilities.room_1_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('砾')
            }, groupId: 'G', replacements: [id('斑点')],
        };
        teacher.mainPlan.facilities.room_1_2.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('斑点')
            }, groupId: 'G', replacements: [id('清流')],
        };
        if (column === 'binding') {
            teacher.mainPlan.facilities.room_1_1.slots[0] = {
                occupant: {
                    kind: 'operator', operatorId: id('砾')
                },
                groupId: 'H', replacements: [id('梓兰')],
                groupBindings: [{
                        groupId: 'G', replacements: [id('斑点')]
                    }],
            };
            teacher.mainPlan.facilities.room_1_1.slots[1] = {
                occupant: {
                    kind: 'operator', operatorId: id('芬')
                }, groupId: 'H', replacements: [id('翎羽')],
            };
            teacher.mainPlan.facilities.room_1_1.slots[2] = {
                occupant: {
                    kind: 'operator', operatorId: id('香草')
                }, groupId: 'G', replacements: [id('克洛丝')],
            };
        }
        staffMissing(teacher, inv);
        const fromEmpty = replayFullTeacher(createFullScenario(base, inv), teacher);
        expect(fromEmpty.diagnostics).toEqual([]);
        expect(fromEmpty.complete).toBe(true);
        const lockedBase = structuredClone(base);
        lockedBase.mainPlan.facilities.room_1_1.slots[0] = structuredClone(teacher.mainPlan.facilities.room_1_1.slots[0]!);
        if (column === 'binding') {
            lockedBase.mainPlan.facilities.room_1_1.slots[1] = structuredClone(teacher.mainPlan.facilities.room_1_1.slots[1]!);
            lockedBase.mainPlan.facilities.room_1_1.slots[2] = structuredClone(teacher.mainPlan.facilities.room_1_1.slots[2]!);
        }
        const scenario = createFullScenario(lockedBase, inv);
        expect(scenario.valid).toBe(true);
        const fromLocked = replayFullTeacher(scenario, teacher);
        expect(fromLocked.diagnostics).toEqual([]);
        expect(fromLocked.exactReplay).toBe(true);
        expect(fromLocked.complete).toBe(true);
        const wrongGroup = structuredClone(teacher);
        wrongGroup.mainPlan.facilities.room_1_2.slots[0]!.groupId = 'H';
        const rejected = replayFullTeacher(scenario, wrongGroup);
        expect(rejected.complete).toBe(false);
        expect(rejected.samples).toEqual([]);
        expect(rejected.diagnostics.some(d => d.code === 'CONFLICTING_PHYSICAL_RELIEF')).toBe(true);
    });
    it.each(['explicit', 'workspace'] as const)('preserves group labels referenced by effective %s scheduler exclusions', source => {
        const { base, inv } = fixture();
        if (source === 'workspace') {
            base.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_exclusions: ['G'] };
        }
        const teacher = structuredClone(base);
        teacher.mainPlan.facilities.room_1_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('砾')
            }, groupId: 'G', replacements: [id('斑点')],
        };
        staffMissing(teacher, inv);
        const options = source === 'explicit' ? { simulationConditioning: { schedulerAssumptions: { groupMoodGapExclusions: ['G'] } } } : {};
        const scenario = createFullScenario(base, inv, options);
        const result = replayFullTeacher(scenario, teacher);
        expect(result.diagnostics).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.exactReplay).toBe(true);
        expect(result.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('G');
        const wronglyRenamed = structuredClone(teacher);
        wronglyRenamed.mainPlan.facilities.room_1_1.slots[0]!.groupId = 'unrelated';
        expect(fullSemanticWorkspace(scenario, wronglyRenamed)).not.toBe(fullSemanticWorkspace(scenario, teacher));
    });
    it('keeps canonical renaming for groups not referenced by effective scheduler settings', () => {
        const { base, inv } = fixture();
        base.compatibility.unrecognizedFields.advanced_settings = { group_mood_gap_exclusions: ['G'] };
        const teacher = structuredClone(base);
        teacher.mainPlan.facilities.room_1_1.slots[0] = {
            occupant: {
                kind: 'operator', operatorId: id('砾')
            }, groupId: 'G', replacements: [id('斑点')],
        };
        staffMissing(teacher, inv);
        const scenario = createFullScenario(base, inv, { simulationConditioning: { schedulerAssumptions: { groupMoodGapExclusions: [] } } });
        const result = replayFullTeacher(scenario, teacher);
        expect(result.complete).toBe(true);
        expect(result.exactReplay).toBe(true);
        expect(result.workspace.mainPlan.facilities.room_1_1.slots[0]!.groupId).toBe('neural_group_0');
    });
});
