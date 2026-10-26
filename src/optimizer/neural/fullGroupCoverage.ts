import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { isTradeRunOrderOperator } from '../../domain/shiftRunPolicy';
import type { RosterWorkspace } from '../../domain/roster';

export function fullGroupReferenceKey(roomId: string, slotIndex: number, bindingIndex = -1): string {
    return `${roomId}:${slotIndex}:${bindingIndex}`;
}
export interface FullFutureGroupReferences {
    /** A real legal Free action, not an inferred recovery bed or synthesized reference. */
    free: boolean;
    /** Lazy legal operator alternatives; no chosen matching is exposed or written. */
    operators: () => Iterable<string>;
}

/** Existence of an injective cover. Ordering affects the witness, never the boolean result. */
function coverIdentities(options: Array<() => Iterable<string>>): Set<string> | undefined {
    const owners = new Map<string, number>();
    const reserve = (row: number, seen: Set<string>): boolean => {
        for (const candidate of options[row]!()) {
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            const owner = owners.get(candidate);
            if (owner === undefined || reserve(owner, seen)) {
                owners.set(candidate, row);
                return true;
            }
        }
        return false;
    };
    return options.every((_, row) => reserve(row, new Set())) ? new Set(owners.keys()) : undefined;
}

export interface FullGroupCoverageProof {
    /** Internal witness support only, NOT a member-to-replacement assignment or model feature. */
    relevantOperatorIds: Set<string>;
    /** Adding the first non-runner to these lists creates a previously exempt obligation. */
    optionalZeroMoodLists: Set<string>;
}

/**
 * Necessary prefix feasibility for precisely the coverage clause in mowerRosterRules.
 * Locked/closed lists are exact; still-open lists may append supplied legal alternatives.
 * This is NOT staffing search, group repair, a bed/anchor guarantee, or a global ban on
 * shared references. Native final validation remains authoritative for those constraints.
 */
export function fullGroupCoverageProof(workspace: RosterWorkspace, future: (key: string) => FullFutureGroupReferences | undefined = () => undefined): FullGroupCoverageProof | undefined {
    const proof: FullGroupCoverageProof = { relevantOperatorIds: new Set(), optionalZeroMoodLists: new Set() };
    const raw: unknown = workspace.mainPlan.conf.workaholic;
    const permanent = new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，]/) : []).map(ref => id(String(ref).trim())));
    const entries = Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
        .flatMap(room => room.slots.map((slot, slotIndex) => ({ room, slot, slotIndex })));
    const primaries = new Map(entries.flatMap(entry => entry.slot.occupant.kind === 'operator' ? [[id(entry.slot.occupant.operatorId), entry] as const] : []));
    const bindings = (entry: typeof entries[number]) => [entry.slot, ...(entry.slot.groupBindings ?? [])];
    const groups = new Map<string, string[]>();
    for (const [name, entry] of primaries) for (const binding of bindings(entry)) if (binding.groupId) {
        const members = groups.get(binding.groupId) ?? [];
        if (!members.includes(name)) members.push(name);
        groups.set(binding.groupId, members);
    }
    for (const [group, members] of groups) {
        const zeroMood = members.every(name => permanent.has(name) && primaries.get(name)!.room.type !== 'dormitory');
        const options: Array<() => Iterable<string>> = [];
        for (const name of members) {
            const entry = primaries.get(name)!, columns = bindings(entry);
            // Native matching uses the FIRST matching column; duplicate columns are invalid separately.
            const index = columns.findIndex(binding => binding.groupId === group), binding = columns[index]!;
            const candidates = binding.replacements.map(id).filter(candidate => !isTradeRunOrderOperator(candidate));
            const key = fullGroupReferenceKey(entry.room.roomId, entry.slotIndex, index - 1), pending = future(key);
            if (entry.room.type === 'dormitory' && (candidates.includes('Free') || pending?.free)) continue;
            // An empty zero-mood row can remain empty; adding its first non-runner creates an obligation.
            if (zeroMood && candidates.length === 0) { proof.optionalZeroMoodLists.add(key); continue; }
            options.push(function* () {
                yield* candidates;
                if (pending) for (const candidate of pending.operators()) if (!isTradeRunOrderOperator(candidate)) yield candidate;
            });
        }
        const identities = coverIdentities(options);
        if (!identities) return undefined;
        for (const candidate of identities) proof.relevantOperatorIds.add(candidate);
    }
    return proof;
}
export function fullGroupCoverageFeasible(workspace: RosterWorkspace, future: (key: string) => FullFutureGroupReferences | undefined = () => undefined): boolean {
    return fullGroupCoverageProof(workspace, future) !== undefined;
}
