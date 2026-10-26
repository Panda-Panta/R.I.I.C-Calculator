import { compileOperatorInventory, type OperatorInventory, type OwnedOperator } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { facilityCapacity } from '../../domain/facilities';
import { MOWER_ROOM_IDS, type MowerRoomId, type RosterWorkspace } from '../../domain/roster';
import { isTradeRunOrderOperator } from '../../domain/shiftRunPolicy';
import { isShiftRunOperator, isOrdinaryReplacementCandidate } from '../../scheduler/scheduleAdapter';
import { validatePhysicalRoster } from '../rosterDraft';
import { isProductionSingletonCandidate } from '../productionSingletons';
export interface NeuralDiagnostic {
    code: string;
    message: string;
}
export interface NeuralPosition {
    roomId: MowerRoomId;
    slotIndex: number;
    role: 'main' | 'relief';
}
export interface NeuralScenario {
    version: 'singleton-v1';
    valid: boolean;
    workspace: RosterWorkspace;
    inventory: OperatorInventory;
    positions: NeuralPosition[];
    diagnostics: NeuralDiagnostic[];
    reserved: string[];
    lockedSlots: string[];
    frozenAssignments: number;
}
const supported = new Set(['manufacture', 'trading', 'power', 'central']);
export function createNeuralScenario(workspace: RosterWorkspace, inventory: OperatorInventory, lockedSlots: readonly string[] = []): NeuralScenario {
    const ws = structuredClone(workspace);
    // Trust stage inputs, never externally supplied maximum-skill snapshots.
    const inv = compileOperatorInventory(inventory.operators.map(o => ({ operator: o.charId, elitePhase: o.elitePhase, level: o.level })));
    inv.operators.sort((a, b) => a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0);
    const diagnostics: NeuralDiagnostic[] = [...(!inventory.valid ? inventory.diagnostics : []), ...inv.diagnostics, ...validatePhysicalRoster(ws)];
    const issue = (code: string, message: string) => diagnostics.push({ code, message });
    if (!inventory.valid) {
        issue('INVALID_INVENTORY', 'Input inventory is marked invalid');
    }
    const reserved = new Set<string>(), positions: NeuralPosition[] = [], locks = new Set(lockedSlots);
    const conf = ws.mainPlan.conf;
    for (const [key, value] of Object.entries(conf)) {
        if (key !== 'ling_xi' && !(Array.isArray(value) && value.length === 0)) {
            issue('UNSUPPORTED_POLICY', `First curriculum requires empty policy lists: ${key}`);
        }
    }
    if (ws.compatibility.backupPlans.length || Object.keys(ws.compatibility.otherPlans).length) {
        issue('UNSUPPORTED_BACKUP', 'First curriculum has one main plan only');
    }
    const owned = new Set(inv.operators.map(o => o.charId));
    for (const roomId of MOWER_ROOM_IDS) {
        const room = ws.mainPlan.facilities[roomId];
        if (!room) {
            issue('MISSING_ROOM', roomId);
            continue;
        }
        const cap = facilityCapacity(room.type, room.level);
        if (room.level > 0 && supported.has(room.type)) {
            while (room.slots.length < cap) {
                room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] });
            }
        }
        let beds = 0, keepers = 0;
        room.slots.forEach((slot, slotIndex) => {
            const key = `${roomId}:${slotIndex}`, locked = locks.has(key);
            if (slotIndex >= cap && slot.replacements.length) {
                issue('SLOT_INDEX', `Relief outside room capacity: ${key}`);
            }
            if (slot.groupId || slot.groupBindings?.length) {
                issue('UNSUPPORTED_GROUP', key);
            }
            if (slot.occupant.kind === 'current') {
                issue('UNSUPPORTED_CURRENT', key);
            }
            if (room.level <= 0 && (slot.occupant.kind !== 'empty' || slot.replacements.length)) {
                issue('UNBUILT_ASSIGNMENT', key);
            }
            const refs = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements];
            for (const ref of refs) {
                const refId = id(ref);
                if (!owned.has(refId)) {
                    issue('UNOWNED_OPERATOR', ref);
                }
                if (reserved.has(refId)) {
                    issue('DUPLICATE_RESERVATION', ref);
                }
                reserved.add(refId);
            }
            if (room.type === 'dormitory' && room.level > 0) {
                if (slot.occupant.kind === 'operator') {
                    keepers++;
                    if (id(slot.occupant.operatorId) === id('菲亚梅塔')) {
                        issue('UNSUPPORTED_DORM_POLICY', 'Fiammetta swapping is outside the singleton curriculum');
                    }
                }
                if (slot.occupant.kind === 'free') {
                    beds++;
                }
                if (slot.replacements.length || slot.occupant.kind === 'empty') {
                    issue('UNSUPPORTED_DORM', 'Provide fixed keeper(s) and explicit free beds');
                }
                return;
            }
            if (!supported.has(room.type)) {
                if (refs.length) {
                    issue('UNSUPPORTED_FACILITY', key);
                }
                return;
            }
            if (room.level <= 0 || slotIndex >= cap) {
                return;
            }
            if (slot.occupant.kind === 'free') {
                issue('UNSUPPORTED_FREE', key);
            }
            if (refs.length && !locked) {
                issue('UNLOCKED_PREFILL', `Non-dorm assignments must be explicitly locked: ${key}`);
            }
            if (slot.replacements.length > 1 || slot.replacements.some(ref => !isOrdinaryReplacementCandidate(ref, room.type))) {
                issue('UNSUPPORTED_RELIEF', key);
            }
            if (locked) {
                if (slot.occupant.kind !== 'operator' || slot.replacements.length !== 1) {
                    issue('INCOMPLETE_LOCK', key);
                }
                return;
            }
            positions.push({ roomId, slotIndex, role: 'main' }, { roomId, slotIndex, role: 'relief' });
        });
        if (room.type === 'dormitory' && room.level > 0 && (!keepers || !beds)) {
            issue('DORM_CONTEXT_REQUIRED', roomId);
        }
    }
    for (const key of locks) {
        if (!MOWER_ROOM_IDS.some(r => ws.mainPlan.facilities[r]?.slots.some((_, i) => `${r}:${i}` === key))) {
            issue('INVALID_LOCK', key);
        }
    }
    const result: NeuralScenario = { version: 'singleton-v1', valid: false, workspace: ws, inventory: inv, positions, diagnostics, reserved: [...reserved].sort(), lockedSlots: [...locks].sort(), frozenAssignments: reserved.size };
    // Fixed assignments obey the same actual-stage/special-operator admission rules.
    for (const key of locks) {
        const [roomId, index] = key.split(':');
        const room = ws.mainPlan.facilities[roomId as MowerRoomId], slot = room?.slots[Number(index)];
        if (!slot) {
            continue;
        }
        for (const [role, ref] of [['main', slot.occupant.kind === 'operator' ? slot.occupant.operatorId : ''], ['relief', slot.replacements[0] ?? '']] as const) {
            const op = inv.operators.find(o => o.charId === id(ref));
            if (op && !admitted(result, { roomId: roomId as MowerRoomId, slotIndex: Number(index), role }, op)) {
                issue('UNSUPPORTED_LOCK_OPERATOR', ref);
            }
        }
    }
    const hasOrdinaryStaffing = positions.length > 0 || Object.values(ws.mainPlan.facilities).some(room =>
        room.level > 0 && supported.has(room.type) && room.slots.some(slot => slot.occupant.kind === 'operator'));
    if (hasOrdinaryStaffing && !Object.values(ws.mainPlan.facilities).some(r => r.level > 0 && r.type === 'dormitory' && r.slots.some(s => s.occupant.kind === 'free'))) {
        issue('NO_RECOVERY_BEDS', 'Ordinary shifts require recovery beds');
    }
    result.valid = diagnostics.length === 0;
    return result;
}
/** Admission is intentionally conservative, not a staffing score. Neutral skill rows remain legal. */
function admitted(s: NeuralScenario, p: NeuralPosition, o: OwnedOperator): boolean {
    const room = s.workspace.mainPlan.facilities[p.roomId];
    if (isShiftRunOperator(o.charId) || isTradeRunOrderOperator(o.charId) || o.name === '菲亚梅塔') {
        return false;
    }
    if (p.role === 'relief' && !isOrdinaryReplacementCandidate(o.charId, room.type)) {
        return false;
    }
    if (room.type === 'manufacture' || room.type === 'trading') {
        const relevant = o.skills.filter(k => k.roomType === (room.type === 'manufacture' ? 'MANUFACTURE' : 'TRADING'));
        return relevant.length === 0 || isProductionSingletonCandidate(s.workspace, p.roomId, o.skills);
    }
    return true;
}
export function legalCandidates(s: NeuralScenario, _workspace: RosterWorkspace, p: NeuralPosition, used: ReadonlySet<string>): OwnedOperator[] {
    return s.inventory.operators.filter(o => !s.reserved.includes(o.charId) && !used.has(o.charId) && admitted(s, p, o));
}
/** Hall feasibility via augmenting paths, not a heuristic completion. No match is written to the roster. */
export function feasibleCandidates(s: NeuralScenario, workspace: RosterWorkspace, index: number, used: ReadonlySet<string>): OwnedOperator[] {
    const current = legalCandidates(s, workspace, s.positions[index]!, used);
    const remaining = s.positions.slice(index + 1), pools = remaining.map(p => legalCandidates(s, workspace, p, used).map(o => o.charId));
    const cache = new Map<string, boolean>();
    return current.filter(candidate => {
        const signature = pools.map(pool => pool.includes(candidate.charId) ? '1' : '0').join('');
        const cached = cache.get(signature);
        if (cached !== undefined) {
            return cached;
        }
        const owner = new Map<string, number>();
        function match(i: number, seen: Set<string>): boolean {
            for (const ref of pools[i]!) {
                if (ref === candidate.charId || seen.has(ref)) {
                    continue;
                }
                seen.add(ref);
                const old = owner.get(ref);
                if (old === undefined || match(old, seen)) {
                    owner.set(ref, i);
                    return true;
                }
            }
            return false;
        }
        const ok = pools.map((_, i) => i).sort((a, b) => pools[a]!.length - pools[b]!.length).every(i => match(i, new Set()));
        cache.set(signature, ok);
        return ok;
    });
}
