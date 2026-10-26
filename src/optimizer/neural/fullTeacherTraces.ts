import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { MOWER_ROOM_IDS, MOWER_OPERATOR_LIST_FIELDS, type RosterWorkspace } from '../../domain/roster';
import { action, type FullScenario } from './fullActionSpace';
import { decodeFullRoster, type FullDecodeResult } from './fullDecode';
function canonical(v: unknown): unknown {
    return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
}
/** Categorize invariant/coverage failures without discarding unrecognized fields. */
function differencePaths(actual: unknown, expected: unknown, path = '$'): string[] {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        return [];
    }
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) {
        return [path];
    }
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const result: string[] = [];
    for (const key of keys) {
        result.push(...differencePaths(a[key], b[key], `${path}.${key}`));
        if (result.length >= 32) {
            break;
        }
    }
    return result.slice(0, 32);
}
/** No semantic arrays are sorted. Only operator aliases and a bijection of generated labels normalize. */
export function fullSemanticWorkspace(s: FullScenario, input: RosterWorkspace): string {
    const ws = structuredClone(input), groups = new Map<string, string>();
    const locked = new Set(s.retainedGroupNames);
    const group = (g: string | null) => {
        if (g === null) {
            return g;
        }
        if (locked.has(g)) {
            return `$locked:${JSON.stringify(g)}`;
        }
        if (!groups.has(g)) {
            groups.set(g, `$generated:${groups.size}`);
        }
        return groups.get(g)!;
    };
    for (const roomId of MOWER_ROOM_IDS) {
        const room = ws.mainPlan.facilities[roomId];
        if (!room) {
            continue;
        }
        for (const slot of room.slots) {
            if (slot.occupant.kind === 'operator') {
                slot.occupant.operatorId = id(slot.occupant.operatorId);
            }
            slot.groupId = group(slot.groupId);
            slot.replacements = slot.replacements.map(r => r === 'Free' ? r : id(r));
            for (const b of slot.groupBindings ?? []) {
                b.groupId = group(b.groupId);
                b.replacements = b.replacements.map(r => r === 'Free' ? r : id(r));
            }
        }
    }
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        if (ws.mainPlan.conf[field]) {
            ws.mainPlan.conf[field] = ws.mainPlan.conf[field]!.map(id);
        }
    }
    ws.name = '';
    ws.mainPlan.name = '';
    return JSON.stringify(canonical(ws));
}
export interface FullTeacherTraceResult extends FullDecodeResult {
    coverage: 'exact' | 'unsupported';
    exactReplay: boolean;
    samples: {
        decision: import('./fullActionSpace').FullDecision;
        actionIds: string[];
        targetIndex: number;
    }[];
}
export function replayFullTeacher(s: FullScenario, teacher: RosterWorkspace): FullTeacherTraceResult {
    const groupMap = new Map(s.retainedGroupNames.map(group => [group, group]));
    let failure = '';
    const result = decodeFullRoster(s, ({ decision: d, actions }) => {
        const slot = d.roomId ? teacher.mainPlan.facilities[d.roomId]?.slots[d.slotIndex!] : undefined;
        let target = action('end');
        if (d.kind === 'occupant') {
            if (!slot) {
                throw Error('TEACHER_SLOT_MISSING');
            }
            target = slot.occupant.kind === 'operator' ? action('operator', id(slot.occupant.operatorId)) : action(slot.occupant.kind as 'empty' | 'free');
        }
        else if (d.kind === 'resident') {
            target = slot?.dormitoryResident === undefined ? action('absent') : action('value', slot.dormitoryResident);
        }
        else if (d.kind === 'group' || d.kind === 'binding-group') {
            const g = d.kind === 'group' ? slot!.groupId : slot!.groupBindings![d.bindingIndex!]!.groupId;
            if (g !== null && !groupMap.has(g)) {
                const fresh = actions.filter(a => a.kind === 'value' && typeof a.value === 'string' && ![...groupMap.values()].includes(a.value)).slice(-1)[0];
                if (fresh) {
                    groupMap.set(g, String(fresh.value));
                }
            }
            target = action('value', g === null ? null : groupMap.get(g));
        }
        else if (d.kind === 'ling_xi') {
            target = action('value', teacher.mainPlan.conf.ling_xi);
        }
        else if (d.kind === 'bindings') {
            target = slot!.groupBindings === undefined ? action('absent') : (d.listIndex ?? 0) < slot!.groupBindings.length ? action('binding') : action('end');
        }
        else {
            const refs = d.kind === 'conf-list' ? teacher.mainPlan.conf[d.field!] : d.kind === 'replacement' ? slot!.replacements : slot!.groupBindings![d.bindingIndex!]!.replacements;
            const ref = refs?.[d.listIndex ?? 0];
            target = refs === undefined ? action('absent') : ref === undefined ? action('end') : ref === 'Free' ? action('free') : action('operator', id(ref));
        }
        const index = actions.findIndex(a => a.id === target.id);
        if (index < 0) {
            failure = `${JSON.stringify(d)} -> ${target.id}`;
            throw Error(`TEACHER_ACTION_MASKED: ${failure}`);
        }
        return actions.map((_, i) => i === index ? 1 : 0);
    });
    if (failure) {
        result.diagnostics.push({
            code: 'TEACHER_ACTION_MASKED', message: failure
        });
    }
    const exactReplay = !failure && result.trace.length > 0 && fullSemanticWorkspace(s, result.workspace) === fullSemanticWorkspace(s, teacher);
    if (!exactReplay && !failure) {
        result.complete = false;
        const paths = differencePaths(JSON.parse(fullSemanticWorkspace(s, result.workspace)), JSON.parse(fullSemanticWorkspace(s, teacher)));
        result.diagnostics.push({
            code: 'TEACHER_SEMANTIC_MISMATCH', message: `Full semantic differences (no fields dropped): ${paths.join(', ')}`
        });
        for (const path of paths) {
            const category = path.startsWith('$.compatibility') ? 'COMPATIBILITY' : /\.(level|type|product|roomId)$/.test(path) ? 'LAYOUT' : path.startsWith('$.mainPlan.conf.') ? 'CONF' : 'METADATA_OR_UNREPRESENTED_FIELD';
            result.diagnostics.push({
                code: `TEACHER_INVARIANT_${category}_CHANGED`, message: path
            });
        }
    }
    return {
        ...result, exactReplay, coverage: exactReplay ? 'exact' : 'unsupported', samples: result.complete ? result.trace.map(t => ({
            decision: t.decision, actionIds: t.actions.map(a => a.id), targetIndex: t.chosenIndex
        })) : []
    };
}
