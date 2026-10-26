import { isTradeRunOrderOperator } from '../../domain/shiftRunPolicy';
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import type { SimulationAssumptions } from '../../scheduler/types';
import type { ScheduleSimulationOptions } from '../../simulator/scheduleSimulation';
import type { ProductionOptions } from '../../simulator/productionTimeline';
import { compileOperatorInventory, type OperatorInventory } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { facilityCapacity } from '../../domain/facilities';
import { MOWER_ROOM_IDS, MOWER_OPERATOR_LIST_FIELDS, type MowerRoomId, type MowerOperatorListField, type RosterWorkspace } from '../../domain/roster';
import { physicalBackupOperatorIds } from '../combinationModel';
import { validatePhysicalRoster } from '../rosterDraft';
export interface FullDiagnostic {
    code: string;
    message: string;
}
export type FullConstructionOrder = 'legacy-v1' | 'staffing-first-v1';
export type FullDecisionKind = 'occupant' | 'resident' | 'group' | 'replacement' | 'bindings' | 'binding-group' | 'binding-replacement' | 'conf-list' | 'ling_xi';
export interface FullDecision {
    kind: FullDecisionKind;
    roomId?: MowerRoomId;
    slotIndex?: number;
    field?: MowerOperatorListField;
    bindingIndex?: number;
    listIndex?: number;
}
export interface FullAction {
    id: string;
    kind: 'operator' | 'empty' | 'free' | 'value' | 'end' | 'absent' | 'binding';
    value?: string | number | boolean | null;
}
export interface FullSimulationConditioning {
    /** Explicit simulator overrides; absent means compiler defaults and input advanced settings. */
    schedulerAssumptions?: Partial<SimulationAssumptions>;
    droneTarget: NonNullable<ProductionOptions['droneTarget']>;
    droneRoomId?: ProductionOptions['droneRoomId'];
    warmupHours: NonNullable<ScheduleSimulationOptions['warmupHours']>;
    sampleHours: NonNullable<ScheduleSimulationOptions['sampleHours']>;
    maxStepHours: NonNullable<ScheduleSimulationOptions['maxStepHours']>;
    seed: number;
}
export interface FullScenario {
    constructionOrder: FullConstructionOrder;
    simulationConditioning: FullSimulationConditioning;
    version: 'full-v2';
    valid: boolean;
    workspace: RosterWorkspace;
    inventory: OperatorInventory;
    lockedSlots: string[];
    /** Literal names referenced by locked input or effective scheduler settings. */
    retainedGroupNames: string[];
    diagnostics: FullDiagnostic[];
}
export interface FullState {
    workspace: RosterWorkspace;
    decisionIndex: number;
    decisions: FullDecision[];
    diagnostics: FullDiagnostic[];
    done: boolean;
}
export function createFullScenario(base: RosterWorkspace, inventory: OperatorInventory, options: {
    lockedSlots?: readonly string[];
    constructionOrder?: FullConstructionOrder;
    simulationConditioning?: Partial<FullSimulationConditioning>;
} = {}): FullScenario {
    const constructionOrder = options.constructionOrder ?? 'legacy-v1';
    const simulationConditioning: FullSimulationConditioning = structuredClone({
        droneTarget: 'gold', warmupHours: 24, sampleHours: 72, maxStepHours: .25, seed: 42, ...options.simulationConditioning
    });
    const workspace = structuredClone(base), locks = new Set(options.lockedSlots ?? []);
    const inv = compileOperatorInventory(inventory.operators.map(o => ({
        operator: o.charId, elitePhase: o.elitePhase, level: o.level
    })));
    inv.operators.sort((a, b) => a.charId.localeCompare(b.charId));
    const diagnostics: FullDiagnostic[] = [...inventory.diagnostics, ...inv.diagnostics, ...validatePhysicalRoster(workspace)];
    if (!['gold', 'exp', 'none', 'trading'].includes(simulationConditioning.droneTarget) || ![simulationConditioning.warmupHours, simulationConditioning.sampleHours, simulationConditioning.maxStepHours].every(Number.isFinite) || simulationConditioning.warmupHours < 0 || simulationConditioning.sampleHours <= 0 || simulationConditioning.maxStepHours <= 0 || !Number.isInteger(simulationConditioning.seed) || simulationConditioning.seed < 0 || simulationConditioning.seed > 0xffffffff) {
        diagnostics.push({
            code: 'INVALID_SIMULATION_CONDITIONING', message: 'Explicit finite protocol settings required'
        });
    }
    if (!['legacy-v1', 'staffing-first-v1'].includes(constructionOrder)) {
        diagnostics.push({
            code: 'INVALID_CONSTRUCTION_ORDER', message: String(constructionOrder)
        });
    }
    if (!inventory.valid) {
        diagnostics.push({
            code: 'INVALID_INVENTORY', message: 'Input inventory invalid'
        });
    }
    if (workspace.compatibility.backupPlans.length || Object.keys(workspace.compatibility.otherPlans).length) {
        diagnostics.push({
            code: 'BACKUP_PLANS', message: 'Only main-plan generation is supported'
        });
    }
    const owned = new Set(inv.operators.map(o => o.charId));
    for (const roomId of MOWER_ROOM_IDS) {
        const room = workspace.mainPlan.facilities[roomId];
        if (!room) {
            continue;
        }
        const cap = facilityCapacity(room.type, room.level);
        while (room.slots.length < cap) {
            room.slots.push({
                occupant: { kind: 'empty' }, groupId: null, replacements: []
            });
        }
        room.slots.forEach((slot, i) => {
            if (slot.occupant.kind === 'operator' || slot.replacements.length || slot.groupId || slot.groupBindings?.length) {
                locks.add(`${roomId}:${i}`);
            }
            for (const ref of [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements, ...(slot.groupBindings ?? []).flatMap(b => b.replacements)]) {
                if (ref !== 'Free' && !owned.has(id(ref))) {
                    diagnostics.push({
                        code: 'UNOWNED_OPERATOR', message: ref
                    });
                }
            }
        });
    }
    for (const key of locks) {
        const [r, i] = key.split(':');
        if (!workspace.mainPlan.facilities[r as MowerRoomId]?.slots[Number(i)]) {
            diagnostics.push({
                code: 'INVALID_LOCK', message: key
            });
        }
    }
    // Use the actual compiler precedence: explicit overrides > input advanced settings > defaults.
    // These labels are semantic runtime keys, not cosmetic generated group names.
    const resolved = compileRosterSchedule(workspace, simulationConditioning.schedulerAssumptions ?? {}).assumptions;
    const retainedGroupNames = new Set<string>(Array.isArray(resolved.groupMoodGapExclusions)
        ? resolved.groupMoodGapExclusions.filter((group): group is string => typeof group === 'string') : []);
    for (const key of locks) {
        const [roomId, index] = key.split(':');
        const slot = workspace.mainPlan.facilities[roomId as MowerRoomId]?.slots[Number(index)];
        for (const group of [slot?.groupId, ...(slot?.groupBindings ?? []).map(binding => binding.groupId)]) {
            if (group) {
                retainedGroupNames.add(group);
            }
        }
    }
    return {
        constructionOrder, simulationConditioning, version: 'full-v2', valid: diagnostics.length === 0, workspace, inventory: inv,
        lockedSlots: [...locks], retainedGroupNames: [...retainedGroupNames], diagnostics
    };
}
export function initialFullState(s: FullScenario): FullState {
    const workspace = structuredClone(s.workspace), decisions: FullDecision[] = [];
    for (const kind of [
        'occupant', 'resident', 'group', 'bindings', 'replacement'
    ] as const) {
        for (const roomId of MOWER_ROOM_IDS) {
            const room = workspace.mainPlan.facilities[roomId];
            if (!room || room.level <= 0) {
                continue;
            }
            room.slots.forEach((slot, slotIndex) => {
                if (slotIndex >= facilityCapacity(room.type, room.level) || s.lockedSlots.includes(`${roomId}:${slotIndex}`)) {
                    return;
                }
                decisions.push({
                    kind, roomId, slotIndex, ...(kind === 'replacement' ? { listIndex: 0 } : {})
                });
                if (kind === 'replacement') {
                    slot.replacements = [];
                }
                if (kind === 'bindings') {
                    delete slot.groupBindings;
                }
            });
        }
    }
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        decisions.push({
            kind: 'conf-list', field, listIndex: 0
        });
        if (Object.prototype.hasOwnProperty.call(s.workspace.mainPlan.conf, field)) {
            workspace.mainPlan.conf[field] = [];
        }
        else {
            delete workspace.mainPlan.conf[field];
        }
    }
    if (s.constructionOrder === 'staffing-first-v1') {
        const index = decisions.findIndex(d => d.kind === 'conf-list' && d.field === 'workaholic');
        const [workaholic] = decisions.splice(index, 1);
        const primary = decisions.findIndex(d => d.kind === 'replacement');
        // If every seat is locked, there is no staffing to close: policy precedes other conf lists.
        decisions.splice(primary >= 0 ? primary : decisions.findIndex(d => d.kind === 'conf-list'), 0, workaholic!);
    }
    decisions.push({ kind: 'ling_xi' });
    return {
        workspace, decisions, decisionIndex: 0, diagnostics: [...s.diagnostics], done: false
    };
}
export function nextDecision(_s: FullScenario, state: FullState): FullDecision | null {
    return state.done ? null : state.decisions[state.decisionIndex] ?? null;
}
export function action(kind: FullAction['kind'], value?: FullAction['value']): FullAction {
    return {
        id: kind + (value === undefined ? '' : ':' + JSON.stringify(value)), kind, ...(value === undefined ? {} : { value })
    };
}
export function fullPhysicalReservations(ws: RosterWorkspace): Set<string> {
    return new Set(Object.values(ws.mainPlan.facilities).flatMap(r => r.slots.flatMap(s => [...(s.occupant.kind === 'operator' ? [id(s.occupant.operatorId)] : []), ...physicalBackupOperatorIds(r, s), ...(s.groupBindings ?? []).flatMap(b => physicalBackupOperatorIds(r, b))])));
}
/**
 * A prefilled ordinary alternative is not necessarily a second physical actor.
 * It may later become a main of that same nonempty group. Permit only this
 * prospective relation; final group decisions and canReferencePhysical must
 * establish it. Ungrouped/cross-group reservations cannot become mains.
 */
function canPlacePhysicalMain(ws: RosterWorkspace, operatorId: string): boolean {
    let referenceGroup: string | undefined;
    for (const room of Object.values(ws.mainPlan.facilities)) {
        for (const slot of room.slots) {
            if (slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === operatorId) {
                return false;
            }
            for (const binding of [slot, ...(slot.groupBindings ?? [])]) {
                if (!physicalBackupOperatorIds(room, binding).includes(operatorId)) {
                    continue;
                }
                if (!binding.groupId || referenceGroup !== undefined && referenceGroup !== binding.groupId) {
                    return false;
                }
                referenceGroup = binding.groupId;
            }
        }
    }
    return true;
}
/** Ordinary alternatives may reuse actors within one simultaneous group, not across unrelated shifts. */
export function canReferencePhysical(ws: RosterWorkspace, d: FullDecision, operatorId: string): boolean {
    const room = ws.mainPlan.facilities[d.roomId!], slot = room.slots[d.slotIndex!]!;
    const binding = d.kind === 'binding-replacement' ? slot.groupBindings![d.bindingIndex!]! : slot;
    const scope = binding.groupId ?? `${d.roomId}:${d.slotIndex}`;
    for (const r of Object.values(ws.mainPlan.facilities)) {
        for (const [i, p] of r.slots.entries()) {
            if (p.occupant.kind === 'operator' && id(p.occupant.operatorId) === operatorId) {
                if (!binding.groupId) {
                    return false;
                }
                if (![p.groupId, ...(p.groupBindings ?? []).map(b => b.groupId)].includes(binding.groupId)) {
                    return false;
                }
                if (r.roomId === d.roomId && i === d.slotIndex) {
                    return false;
                }
            }
            for (const b of [p, ...(p.groupBindings ?? [])]) {
                if (physicalBackupOperatorIds(r, b).includes(operatorId) && (b.groupId ?? `${r.roomId}:${i}`) !== scope) {
                    return false;
                }
            }
        }
    }
    return true;
}
/**
 * Native mowerRosterRules primary-reference compatibility, without assuming that
 * every dorm reference is a Fiammetta refresh. This does not reserve dormant
 * references as additional physical actors or rank replacement candidates.
 */
function nativePrimaryReferenceAllowed(workspace: RosterWorkspace, decision: FullDecision, operatorId: string): boolean {
    const room = workspace.mainPlan.facilities[decision.roomId!];
    const slot = room.slots[decision.slotIndex!]!;
    // Native primary-reference validation applies only to actual primary actors.
    if (slot.occupant.kind !== 'operator') {
        return true;
    }
    const primary = id(slot.occupant.operatorId), candidate = id(operatorId);
    if (room.type === 'dormitory' && primary === id('菲亚梅塔') && candidate !== primary) {
        return true;
    }
    const cover = Object.values(workspace.mainPlan.facilities)
        .filter(facility => facility.level > 0)
        .flatMap(facility => facility.slots)
        .find(other => other.occupant.kind === 'operator' && id(other.occupant.operatorId) === candidate);
    if (!cover) {
        return true;
    }
    const binding = decision.kind === 'binding-replacement' ? slot.groupBindings![decision.bindingIndex!]! : slot;
    const sameGroup = candidate !== primary && !!binding.groupId
        && [cover.groupId, ...(cover.groupBindings ?? []).map(other => other.groupId)].includes(binding.groupId);
    return sameGroup || candidate !== primary && room.type === 'trading' && isTradeRunOrderOperator(candidate);
}
/** The same necessary ordinary-cover condition used at terminal validation. */
export function needsOrdinaryRelief(workspace: RosterWorkspace, roomId: MowerRoomId, slotIndex: number): boolean {
    const room = workspace.mainPlan.facilities[roomId], slot = room?.slots[slotIndex];
    return !!room && room.level > 0 && room.type !== 'dormitory' && slot?.occupant.kind === 'operator'
        && !workspace.mainPlan.conf.workaholic.some(ref => id(ref) === id(slot.occupant.kind === 'operator' ? slot.occupant.operatorId : ''))
        && !physicalBackupOperatorIds(room, slot).length
        && !(slot.groupBindings ?? []).some(binding => physicalBackupOperatorIds(room, binding).length);
}
export function legalFullActions(s: FullScenario, state: FullState): FullAction[] {
    const d = nextDecision(s, state);
    if (!s.valid || !d || state.diagnostics.length) {
        return [];
    }
    const room = d.roomId ? state.workspace.mainPlan.facilities[d.roomId] : undefined, slot = room?.slots[d.slotIndex!];
    const ops = s.inventory.operators.filter(o => room?.type !== 'trading' || !['佩佩', 'U-Official'].includes(o.name));
    if (d.kind === 'occupant') {
        // A one-pass occupant decision cannot refill this seat later. These are
        // necessary terminal constraints, not a staffing preference or ranker.
        const mandatoryWorkSeat = room!.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(room!.type);
        const lastKeeperSeat = room!.type === 'dormitory'
            && !room!.slots.some(candidate => candidate.occupant.kind === 'operator')
            && !state.decisions.slice(state.decisionIndex + 1).some(next => next.kind === 'occupant' && next.roomId === d.roomId);
        const requireOperator = mandatoryWorkSeat || lastKeeperSeat;
        return [
            ...(!requireOperator ? [action('empty')] : []),
            ...(!requireOperator && room?.type === 'dormitory' ? [action('free')] : []),
            ...ops.filter(o => canPlacePhysicalMain(state.workspace, o.charId)).map(o => action('operator', o.charId)),
        ];
    }
    if (d.kind === 'resident') {
        return [action('absent'), action('value', false), ...(room?.type === 'dormitory' && slot?.occupant.kind === 'operator' ? [action('value', true)] : [])];
    }
    if (d.kind === 'group' || d.kind === 'binding-group') {
        const groups = new Set([...s.retainedGroupNames, ...Object.values(state.workspace.mainPlan.facilities).flatMap(r => r.slots.flatMap(s => [s.groupId, ...(s.groupBindings ?? []).map(b => b.groupId)]).filter((g): g is string => g !== null))]);
        let fresh = 'neural_group_0';
        for (let i = 0; groups.has(fresh); i++) {
            fresh = `neural_group_${i + 1}`;
        }
        return [action('value', null), ...[...groups].map(g => action('value', g)), action('value', fresh)];
    }
    if (d.kind === 'bindings') {
        return [...(d.listIndex === undefined ? [action('absent')] : []), action('end'), ...((slot?.groupBindings?.length ?? 0) < s.inventory.operators.length ? [action('binding')] : [])];
    }
    if (d.kind === 'ling_xi') {
        return [0, 1, 2, 3].map(n => action('value', n));
    }
    const refs = d.kind === 'conf-list' ? state.workspace.mainPlan.conf[d.field!] ?? [] : d.kind === 'replacement' ? slot!.replacements : slot!.groupBindings![d.bindingIndex!]!.replacements;
    const staffingFirst = s.constructionOrder === 'staffing-first-v1';
    const coverRequired = staffingFirst && d.kind === 'replacement' && needsOrdinaryRelief(state.workspace, d.roomId!, d.slotIndex!);
    const binding = d.kind === 'binding-replacement' ? slot!.groupBindings![d.bindingIndex!] : slot;
    const freeAllowed = room?.type === 'dormitory' && !refs.includes('Free') && (!staffingFirst ||
        slot?.occupant.kind === 'operator' && id(slot.occupant.operatorId) !== id('菲亚梅塔') && !!binding?.groupId);
    return [
        ...(d.kind === 'conf-list' && d.listIndex === 0 && !Object.prototype.hasOwnProperty.call(s.workspace.mainPlan.conf, d.field!) ? [action('absent')] : []),
        ...(!coverRequired ? [action('end')] : []),
        ...(freeAllowed ? [action('free')] : []),
        ...ops.filter(o => !refs.some(r => id(r) === o.charId)
            && (!staffingFirst || d.kind === 'conf-list' || nativePrimaryReferenceAllowed(state.workspace, d, o.charId))
            && (d.kind === 'conf-list' || room?.type === 'dormitory' || !physicalBackupOperatorIds(room!, { replacements: [o.charId] }).length || canReferencePhysical(state.workspace, d, o.charId))).map(o => action('operator', o.charId)),
    ];
}
