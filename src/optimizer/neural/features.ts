import type { OwnedOperator } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { MOWER_ROOM_IDS, type RosterWorkspace } from '../../domain/roster';
import type { NeuralPosition, NeuralScenario } from './actionSpace';
export const NEURAL_FEATURE_VERSION = 'actual-stage-prefix-hash-v1';
export const NEURAL_FEATURE_COUNT = 132;
function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function skillBag(ops: readonly OwnedOperator[]): number[] {
    const out = Array<number>(32).fill(0);
    for (const o of ops) {
        for (const skill of o.skills) {
            const h = hash(`${skill.roomType}:${skill.buffId}`);
            out[h % 32]! += (h & 32) ? -1 : 1;
        }
    }
    return out.map(v => v / 16);
}
/** Fixed numerical contract. Only actual skills, layout, and already committed prefix are observed. */
export function candidateFeatures(s: NeuralScenario, workspace: RosterWorkspace, p: NeuralPosition, candidates: readonly OwnedOperator[]): number[][] {
    const room = workspace.mainPlan.facilities[p.roomId], byId = new Map(s.inventory.operators.map(o => [o.charId, o]));
    const global: OwnedOperator[] = [], local: OwnedOperator[] = [];
    let mainCount = 0, reliefCount = 0;
    for (const roomId of MOWER_ROOM_IDS) {
        for (const slot of workspace.mainPlan.facilities[roomId]?.slots ?? []) {
            const refs = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements];
            mainCount += Number(slot.occupant.kind === 'operator');
            reliefCount += slot.replacements.length;
            for (const ref of refs) {
                const op = byId.get(id(ref));
                if (op) {
                    global.push(op);
                    if (roomId === p.roomId) {
                        local.push(op);
                    }
                }
            }
        }
    }
    const globalBag = skillBag(global), localBag = skillBag(local);
    return candidates.map(o => {
        const identity = Array<number>(16).fill(0), h = hash(o.charId);
        identity[h % 16] = (h & 16) ? -1 : 1;
        const scalars = [o.elitePhase / 2, o.level / 90, o.skills.length / 4, Number(o.matchesMaximumSkills),
            Number(p.role === 'main'), Number(p.role === 'relief'),
            ...['manufacture', 'trading', 'power', 'central'].map(t => Number(room.type === t)),
            ...['gold', 'exp', 'fragment', 'money', 'orundum'].map(t => Number(room.product === t)),
            room.level / 5, p.slotIndex / 5, mainCount / 64, reliefCount / 64, s.inventory.operators.length / 432];
        const row = [...scalars, ...skillBag([o]), ...globalBag, ...localBag, ...identity];
        if (row.length !== NEURAL_FEATURE_COUNT || !row.every(Number.isFinite)) {
            throw new Error('Invalid neural feature vector');
        }
        return row;
    });
}
