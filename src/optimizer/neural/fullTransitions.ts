import { facilityCapacity } from '../../domain/facilities';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import { physicalBackupOperatorIds } from '../combinationModel';
import { validatePhysicalRoster } from '../rosterDraft';
import { recoveryGroupCapacityIssues } from '../recoveryGroupCapacity';
import { applyGeneratedWarmupPolicy } from '../generatedWarmupPolicy';
import { compiledScheduleToRuntimeConfig } from '../../scheduler/scheduleAdapter';
import { createRosterRuntime } from '../../scheduler/rosterRuntime';
import { getMowerSourceRuntime } from '../../scheduler/mowerSourceRuntime';
import type { SimulationAssumptions } from '../../scheduler/types';
import { fullGroupCoverageFeasible } from './fullGroupCoverage';
import { legalFullActions, nextDecision, canReferencePhysical, needsOrdinaryRelief, type FullScenario, type FullState, type FullAction, type FullDiagnostic } from './fullActionSpace';
import { MOWER_OPERATOR_LIST_FIELDS, type RosterWorkspace } from '../../domain/roster';
export interface FullFinalResult {
    complete: boolean;
    workspace: RosterWorkspace;
    diagnostics: FullDiagnostic[];
}
/** Latest full-reference runtime admission only. Construct native state on a clone; never repair output.
 * simulateSchedule enables native ideal-order wakes independently of scheduler-assumption overrides.
 */
export function fullNativeRuntimeAdmissionIssues(workspace: RosterWorkspace, assumptions: Partial<SimulationAssumptions> = {}): FullDiagnostic[] {
    try {
        const schedule = compileRosterSchedule(structuredClone(workspace), { ...assumptions, idealRunOrderWakeOnly: true });
        const config = compiledScheduleToRuntimeConfig(schedule);
        config.mowerAlpha = true;
        const native = getMowerSourceRuntime(createRosterRuntime(config));
        const trading = new Set<string>(schedule.rooms.filter(room => room.type === 'trading').map(room => room.roomId));
        return Object.keys(native.data.runOrderRooms).filter(room => !trading.has(room)).map(room => ({
            code: 'LATEST_NATIVE_RUNORDER_NONTRADING_ROOM', message: room,
        }));
    }
    catch (error) {
        return [{ code: 'LATEST_NATIVE_RUNTIME_UNSUPPORTED', message: String(error) }];
    }
}
/** Pure, transactional transition: an illegal action cannot partially mutate a prefix. */
export function applyFullAction(s: FullScenario, input: FullState, a: FullAction): FullState {
    if (!legalFullActions(s, input).some(x => x.id === a.id && JSON.stringify(x) === JSON.stringify(a))) {
        return {
            ...structuredClone(input), diagnostics: [...input.diagnostics, {
                    code: 'ILLEGAL_ACTION', message: a.id
                }]
        };
    }
    const state = structuredClone(input), d = nextDecision(s, state)!, room = d.roomId ? state.workspace.mainPlan.facilities[d.roomId] : undefined, slot = room?.slots[d.slotIndex!];
    let advance = true;
    switch (d.kind) {
        case 'occupant':
            slot!.occupant = a.kind === 'operator' ? {
                kind: 'operator', operatorId: String(a.value)
            } : { kind: a.kind as 'empty' | 'free' };
            break;
        case 'resident':
            if (a.kind === 'absent') {
                delete slot!.dormitoryResident;
            }
            else {
                slot!.dormitoryResident = Boolean(a.value);
            }
            break;
        case 'group':
            slot!.groupId = a.value as string | null;
            break;
        case 'binding-group':
            slot!.groupBindings![d.bindingIndex!]!.groupId = a.value as string | null;
            break;
        case 'ling_xi':
            state.workspace.mainPlan.conf.ling_xi = a.value as 0 | 1 | 2 | 3;
            break;
        case 'bindings':
            if (a.kind === 'absent') {
                delete slot!.groupBindings;
            }
            else {
                slot!.groupBindings ??= [];
                if (a.kind === 'binding') {
                    const bindingIndex = slot!.groupBindings.length;
                    slot!.groupBindings.push({
                        groupId: null, replacements: []
                    });
                    state.decisions.splice(state.decisionIndex + 1, 0, {
                        kind: 'binding-group', roomId: d.roomId, slotIndex: d.slotIndex, bindingIndex
                    }, {
                        ...d, listIndex: bindingIndex + 1
                    });
                    // New mode resolves every binding alternative before primary END can close its slot.
                    const referenceIndex = s.constructionOrder === 'staffing-first-v1'
                        ? state.decisions.findIndex(x => x.kind === 'replacement')
                        : state.decisions.findIndex(x => x.kind === 'conf-list');
                    state.decisions.splice(referenceIndex, 0, {
                        kind: 'binding-replacement', roomId: d.roomId, slotIndex: d.slotIndex, bindingIndex, listIndex: 0
                    });
                }
            }
            break;
        default: {
            if (a.kind === 'absent') {
                break;
            }
            const refs = d.kind === 'conf-list' ? (state.workspace.mainPlan.conf[d.field!] ??= []) : d.kind === 'replacement' ? slot!.replacements : slot!.groupBindings![d.bindingIndex!]!.replacements;
            if (a.kind !== 'end') {
                refs.push(a.kind === 'free' ? 'Free' : String(a.value));
                state.decisions[state.decisionIndex] = {
                    ...d, listIndex: (d.listIndex ?? 0) + 1
                };
                advance = false;
            }
        }
    }
    if (advance) {
        state.decisionIndex++;
    }
    state.done = state.decisionIndex >= state.decisions.length;
    return state;
}
export function finalizeFullState(s: FullScenario, state: FullState): FullFinalResult {
    const workspace = structuredClone(state.workspace), diagnostics = [...state.diagnostics];
    const issue = (code: string, message: string) => diagnostics.push({
        code, message
    });
    if (!state.done) {
        issue('INCOMPLETE_ACTION_SEQUENCE', 'Pending decisions remain');
    }
    if (!s.valid || !state.done || diagnostics.length) {
        return {
            complete: false, workspace, diagnostics
        };
    }
    diagnostics.push(...validatePhysicalRoster(workspace), ...recoveryGroupCapacityIssues(workspace), ...compileRosterSchedule(workspace, s.simulationConditioning.schedulerAssumptions ?? {}).diagnostics.filter(d => d.severity === 'error' || d.code === 'UNKNOWN_OPERATOR'));
    if (s.policyMode !== 'legacy-unconstrained-v1') {
        const checked = applyGeneratedWarmupPolicy(structuredClone(workspace), s.inventory);
        if (!checked.valid) issue('LATEST_WARMUP_POLICY_UNSUPPORTED', checked.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '));
        if (checked.addedExhaustOperatorIds.length) issue('LATEST_WARMUP_POLICY_MISSING', checked.addedExhaustOperatorIds.join(', '));
    }
    if (['latest-warmup-runorder-v2', 'latest-native-group-cover-v3', 'latest-native-group-occupants-v4'].includes(s.policyMode)) diagnostics.push(...fullNativeRuntimeAdmissionIssues(workspace, s.simulationConditioning.schedulerAssumptions));
    if (['latest-native-group-cover-v3', 'latest-native-group-occupants-v4'].includes(s.policyMode) && !fullGroupCoverageFeasible(workspace)) issue('LATEST_GROUP_COVERAGE_INFEASIBLE', 'Closed group replacement lists have no native injective cover');
    const owned = new Set(s.inventory.operators.map(o => o.charId)), reserved = new Set<string>(), permanent = new Set(workspace.mainPlan.conf.workaholic.map(id));
    for (const room of Object.values(workspace.mainPlan.facilities)) {
        if (room.level > 0 && room.type === 'dormitory' && !room.slots.some(p => p.occupant.kind === 'operator')) {
            issue('DORM_KEEPER_MISSING', room.roomId);
        }
        if (room.level > 0 && ['manufacture', 'trading', 'power', 'central'].includes(room.type)) {
            for (let i = 0; i < facilityCapacity(room.type, room.level); i++) {
                if (room.slots[i]?.occupant.kind !== 'operator') {
                    issue('UNSTAFFED_MANDATORY_SLOT', `${room.roomId}:${i}`);
                }
            }
        }
        for (const [i, slot] of room.slots.entries()) {
            const physical = [...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, slot), ...(slot.groupBindings ?? []).flatMap(b => physicalBackupOperatorIds(room, b))];
            if (slot.occupant.kind === 'operator') {
                const ref = id(slot.occupant.operatorId);
                if (reserved.has(ref)) {
                    issue('DUPLICATE_PHYSICAL_RESERVATION', ref);
                }
                reserved.add(ref);
            }
            for (const [bindingIndex, b] of [slot, ...(slot.groupBindings ?? [])].entries()) {
                for (const ref of physicalBackupOperatorIds(room, b)) {
                    if (!canReferencePhysical(workspace, {
                        kind: bindingIndex === 0 ? 'replacement' : 'binding-replacement', roomId: room.roomId, slotIndex: i, bindingIndex: bindingIndex - 1
                    }, ref)) {
                        issue('CONFLICTING_PHYSICAL_RELIEF', ref);
                    }
                }
            }
            for (const ref of [...physical, ...slot.replacements, ...(slot.groupBindings ?? []).flatMap(b => b.replacements)]) {
                if (ref !== 'Free' && !owned.has(id(ref))) {
                    issue('UNOWNED_OPERATOR', ref);
                }
                if (room.type === 'trading' && ['佩佩', 'U-Official'].some(n => id(n) === id(ref))) {
                    issue('FORBIDDEN_TRADE_OPERATOR', ref);
                }
            }
            if (needsOrdinaryRelief(workspace, room.roomId, i)) {
                issue('MISSING_ORDINARY_RELIEF', `${room.roomId}:${i}`);
            }
            if (s.lockedSlots.includes(`${room.roomId}:${i}`) && JSON.stringify(slot) !== JSON.stringify(s.workspace.mainPlan.facilities[room.roomId].slots[i])) {
                issue('LOCK_CHANGED', `${room.roomId}:${i}`);
            }
        }
    }
    if (Object.values(workspace.mainPlan.facilities).some(r => r.level > 0 && r.type !== 'dormitory' && r.slots.some(p => p.occupant.kind === 'operator' && !permanent.has(id(p.occupant.operatorId)))) && !Object.values(workspace.mainPlan.facilities).some(r => r.level > 0 && r.type === 'dormitory' && r.slots.some(p => p.occupant.kind === 'free' || p.replacements.includes('Free')))) {
        issue('NO_RECOVERY_BEDS', 'Ordinary workers require recovery capacity');
    }
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        const refs = workspace.mainPlan.conf[field];
        if (Array.isArray(refs) && refs.some(r => typeof r === 'string' && !owned.has(id(r)))) {
            issue('UNOWNED_POLICY_REFERENCE', field);
        }
    }
    return {
        complete: diagnostics.length === 0, workspace, diagnostics
    };
}
