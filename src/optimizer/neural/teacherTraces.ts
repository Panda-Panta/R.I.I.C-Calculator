import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { type RosterWorkspace } from '../../domain/roster';
import { isOrdinaryReplacementCandidate } from '../../scheduler/scheduleAdapter';
import type { NeuralScenario } from './actionSpace';
import { decodeRoster, type NeuralDecodeResult } from './decode';
export interface TeacherSample {
    candidates: number[][];
    targetIndex: number;
}
export interface TeacherTraceResult extends NeuralDecodeResult {
    samples: TeacherSample[];
}
/** Object insertion order is not semantic; array ordering (including relief priority) is. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
}
function projection(ws: RosterWorkspace): string {
    // Preserve the complete compatibility envelope: advanced_settings, backup plans,
    // imported metadata and future semantic extensions must never evade replay checks.
    // Only display names are cosmetic. Weights and drone settings affect scoring.
    const projected = structuredClone(ws);
    projected.name = '';
    projected.mainPlan.name = '';
    return JSON.stringify(canonical(projected));
}
/** Replay through exactly the free-running masks; illegal teacher actions are never unmasked. */
export function replayTeacherTrace(s: NeuralScenario, teacher: RosterWorkspace): TeacherTraceResult {
    const samples: TeacherSample[] = [];
    const decoded = decodeRoster(s, (rows, context) => {
        const p = context.position, room = teacher.mainPlan.facilities[p.roomId], slot = room?.slots[p.slotIndex];
        const ref = p.role === 'main' ? (slot?.occupant.kind === 'operator' ? slot.occupant.operatorId : '') : slot?.replacements.find(ref => isOrdinaryReplacementCandidate(ref, room.type)) ?? '';
        const targetIndex = context.candidates.findIndex(o => o.charId === id(ref));
        if (targetIndex < 0) {
            throw new Error(`TEACHER_ACTION_MASKED: ${p.roomId}:${p.slotIndex}:${p.role}: ${ref}`);
        }
        samples.push({ candidates: rows.map(r => [...r]), targetIndex });
        return rows.map((_, i) => i === targetIndex ? 1 : 0);
    });
    if (decoded.complete && projection(decoded.workspace) !== projection(teacher)) {
        decoded.complete = false;
        decoded.diagnostics.push({ code: 'TEACHER_PROJECTION_MISMATCH', message: 'Teacher differs from exact supported workspace semantics, including layout, frozen context, policies, compatibility and scoring settings' });
    }
    return { ...decoded, samples: decoded.complete ? samples : [] };
}
