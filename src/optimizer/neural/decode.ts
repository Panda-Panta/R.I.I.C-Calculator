import type { RosterWorkspace } from '../../domain/roster';
import type { OwnedOperator } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import { isOrdinaryReplacementCandidate } from '../../scheduler/scheduleAdapter';
import { configureRunOrder } from '../configureRunOrder';
import { applySingletonWorkPolicy } from '../productionSingletons';
import { recoveryGroupCapacityIssues } from '../recoveryGroupCapacity';
import { validatePhysicalRoster } from '../rosterDraft';
import { feasibleCandidates, type NeuralScenario, type NeuralDiagnostic, type NeuralPosition } from './actionSpace';
import { candidateFeatures } from './features';
export interface NeuralScorerContext {
    position: NeuralPosition;
    candidates: readonly OwnedOperator[];
    workspace: RosterWorkspace;
}
export type NeuralScorer = (candidates: number[][], context: NeuralScorerContext) => number[];
export interface NeuralPlacement {
    position: NeuralPosition;
    operatorId: string;
    candidateIds: string[];
    chosenIndex: number;
}
export interface NeuralDecodeResult {
    complete: boolean;
    workspace: RosterWorkspace;
    trace: NeuralPlacement[];
    diagnostics: NeuralDiagnostic[];
    modelPlacements: number;
    frozenAssignments: number;
    mechanicalChanges: {
        kind: string;
        detail: string;
    }[];
}
/** No complete-roster generator, staffing ranker, or heuristic fallback is called here. */
export function decodeRoster(s: NeuralScenario, scorer: NeuralScorer): NeuralDecodeResult {
    const workspace = structuredClone(s.workspace), trace: NeuralPlacement[] = [];
    const result: NeuralDecodeResult = { complete: false, workspace, trace, diagnostics: [...s.diagnostics], modelPlacements: 0, frozenAssignments: s.frozenAssignments, mechanicalChanges: [] };
    if (!s.valid) {
        return result;
    }
    const used = new Set<string>();
    for (let index = 0; index < s.positions.length; index++) {
        const position = s.positions[index]!, candidates = feasibleCandidates(s, workspace, index, used);
        if (!candidates.length) {
            result.diagnostics.push({ code: 'DECODE_DEAD_END', message: `No feasible action at ${position.roomId}:${position.slotIndex}:${position.role}` });
            return result;
        }
        let logits: number[];
        try {
            logits = scorer(candidateFeatures(s, workspace, position, candidates), { position: structuredClone(position), candidates: structuredClone(candidates), workspace: structuredClone(workspace) });
        }
        catch (error) {
            result.diagnostics.push({ code: 'SCORER_ERROR', message: String(error) });
            return result;
        }
        if (!Array.isArray(logits) || logits.length !== candidates.length || !logits.every(Number.isFinite)) {
            result.diagnostics.push({ code: 'INVALID_LOGITS', message: 'Scorer must return one finite logit per legal candidate' });
            return result;
        }
        let chosenIndex = 0;
        for (let i = 1; i < logits.length; i++) {
            if (logits[i]! > logits[chosenIndex]!) {
                chosenIndex = i;
            }
        }
        const operatorId = candidates[chosenIndex]!.charId, slot = workspace.mainPlan.facilities[position.roomId].slots[position.slotIndex]!;
        if (position.role === 'main') {
            slot.occupant = { kind: 'operator', operatorId };
        }
        else {
            slot.replacements = [operatorId];
        }
        used.add(operatorId);
        trace.push({ position: { ...position }, operatorId, candidateIds: candidates.map(o => o.charId), chosenIndex });
        result.modelPlacements++;
    }
    const confBefore = JSON.stringify(workspace.mainPlan.conf);
    for (const p of s.positions.filter(p => p.role === 'main')) {
        applySingletonWorkPolicy(workspace, p.roomId, p.slotIndex);
    }
    if (JSON.stringify(workspace.mainPlan.conf) !== confBefore) {
        result.mechanicalChanges.push({ kind: 'singleton-work-policy', detail: 'Applied existing singleton exhaustion policy (no staffing change)' });
    }
    const beforeRun = structuredClone(workspace);
    if (!configureRunOrder(workspace, s.inventory)) {
        result.diagnostics.push({ code: 'RUN_ORDER_FAILED', message: 'Existing run-order policy rejected roster' });
        return result;
    }
    for (const room of Object.values(workspace.mainPlan.facilities)) {
        room.slots.forEach((slot, index) => {
            const old = beforeRun.mainPlan.facilities[room.roomId].slots[index]!;
            if (room.type === 'trading') {
                const refs = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements];
                if (refs.some(ref => id(ref) === id('佩佩') || id(ref) === id('U-Official'))) {
                    result.diagnostics.push({ code: 'FORBIDDEN_TRADE_OPERATOR', message: `Neural curriculum excludes Pepe and U-Official from all trade roles: ${room.roomId}:${index}` });
                }
            }

            if (JSON.stringify(slot) !== JSON.stringify(old)) {
                if (s.lockedSlots.includes(`${room.roomId}:${index}`)) {
                    result.diagnostics.push({ code: 'LOCK_POSTPROCESS_CONFLICT', message: `Run-order policy would change locked slot ${room.roomId}:${index}` });
                }
                const ordinary = (refs: string[]) => refs.filter(ref => isOrdinaryReplacementCandidate(ref, room.type)).map(id);
                if (JSON.stringify(ordinary(slot.replacements)) !== JSON.stringify(ordinary(old.replacements)) || JSON.stringify(slot.occupant) !== JSON.stringify(old.occupant)) {
                    result.diagnostics.push({ code: 'POSTPROCESS_STAFFING_CHANGE', message: 'Mechanical policy changed ordinary staffing' });
                }
                result.mechanicalChanges.push({ kind: 'ideal-run-order', detail: `${room.roomId}:${index}: ${JSON.stringify(old.replacements)} -> ${JSON.stringify(slot.replacements)}` });
            }
        });
    }
    // On rejected postprocessing return the unchanged locked/policy-free learned projection.
    if (result.diagnostics.length) {
        result.workspace = beforeRun;
        return result;
    }
    result.diagnostics.push(...validatePhysicalRoster(workspace), ...recoveryGroupCapacityIssues(workspace), ...compileRosterSchedule(workspace).diagnostics.filter(d => d.severity === 'error' || d.code === 'UNKNOWN_OPERATOR'));
    result.complete = result.diagnostics.length === 0;
    return result;
}
