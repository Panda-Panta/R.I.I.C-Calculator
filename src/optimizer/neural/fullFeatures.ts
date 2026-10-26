import { compileRosterSchedule } from '../../scheduler/compileRosterSchedule';
import { readMowerMoodLimits } from '../../scheduler/mowerMoodLimits';
import { readMowerOperatorList } from '../../scheduler/mowerBackupConfig';
import { effectiveMowerDormOrder } from '../../domain/mowerDormOrder';
import { OPERATORS } from '../../domain/operators';
import { compileOperatorInventory, type OwnedOperator } from '../../domain/operatorInventory';
import { resolveOperatorCharId as id } from '../../domain/operatorIdentifiers';
import { MOWER_ROOM_IDS, MOWER_OPERATOR_LIST_FIELDS } from '../../domain/roster';
import { normalizeProductionWeights } from '../../domain/productionWeights';
import { physicalBackupOperatorIds } from '../combinationModel';
import { fullPhysicalReservations } from './fullActionSpace';
import type { FullScorerContext } from './fullDecode';
import source from '../../data/riic-gamedata-source-manifest.json';
// Input policy is independent from the generated prefix; old artifacts are incompatible.
export const FULL_FEATURE_VERSION = 'full-v2-sparse-catalog-3-slot-group-alignment';
export type SparseVector = [
    number,
    number
][];
export interface FullEncodedDecision {
    version: typeof FULL_FEATURE_VERSION;
    manifestHash: string;
    featureCount: number;
    common: SparseVector;
    candidates: SparseVector[];
}
/** Noncryptographic structural checksum; pinned upstream hashes below are SHA-256. */
export function fullFingerprint(value: unknown): string {
    const text = JSON.stringify(value);
    return [2166136261, 3339675911, 2246822519, 3266489917].map(seed => {
        let h = seed;
        for (let i = 0; i < text.length; i++)
            h = Math.imul(h ^ text.charCodeAt(i), 16777619);
        return (h >>> 0).toString(16).padStart(8, '0');
    }).join('');
}
const operatorIds = Object.freeze(OPERATORS.map(o => o.charId).sort());
const buffIds = Object.freeze([...new Set(OPERATORS.flatMap(o => o.skillSlots!.flat().map(s => s.buffId)))].sort());
const schedulerNumericScales = {
    initialMorale: 24, restingThreshold: 1, rescueThreshold: 1,
    groupMoodGapThresholdMinutes: 60, groupMoodGapMaxExtraWaitHours: 24,
    mergeIntervalMinutes: 60, droneIntervalHours: 3, droneCountLimit: 200,
    maaGapHours: 3, initialGold: 1000,
    initialFragments: 1000, initialDrones: 200, collectionIntervalHours: 24,
    operationDurationHours: 1, horizonHours: 2160, elitePhase: 2,
} as const;
const schedulerSwitches = ['freeRoom', 'groupRestInFullOnMoodGap', 'enableMastery', 'leifengMode', 'fiammettaFool'] as const;
const keys: string[] = [];
const indices = new Map<string, number>();
function register(key: string) {
    if (indices.has(key))
        throw Error(`Duplicate feature ${key}`);
    indices.set(key, keys.length);
    keys.push(key);
}
for (const field of [...Object.keys(schedulerNumericScales), ...schedulerSwitches,
    'fiammettaEffectiveThreshold', 'initialMoraleExplicit', 'majorMaintenancePresent',
    'majorMaintenanceStartHours', 'idealRunOrderWakeOnly', 'reloadRoomsNull'])
    register(`scheduler:${field}`);
for (const field of ['present', 'lower', 'upper']) {
    register(`mood:global:${field}`);
    for (const op of operatorIds)
        register(`mood:${op}:${field}`);
}
for (const op of operatorIds) {
    register(`scheduler-morale:${op}`);
    register(`scheduler-morale-present:${op}`);
    register(`scheduler-idle:${op}`);
}
for (const room of ['none', ...MOWER_ROOM_IDS]) {
    register(`scheduler-drone-room:${room}`);
    register(`scheduler-reload:${room}`);
}
for (let dorm = 1; dorm <= 4; dorm++) {
    register(`scheduler-dorm-atmosphere:dormitory_${dorm}`);
    for (const suffix of ['', '_low'])
        register(`scheduler-dorm-order:dormitory_${dorm}${suffix}`);
    for (let slot = 0; slot < 5; slot++)
        register(`scheduler-bed-order:dormitory_${dorm}_${slot}`);
}
const roles = ['main', 'physical', 'reference'] as const;
const types = ['', 'manufacture', 'trading', 'power', 'dormitory', 'central', 'meeting', 'factory', 'contact', 'train', 'recycle', 'gaming'];
const products = ['none', 'gold', 'exp', 'fragment', 'money', 'orundum'];
const kinds = ['occupant', 'resident', 'group', 'replacement', 'bindings', 'binding-group', 'binding-replacement', 'conf-list', 'ling_xi'];
for (const k of ['candidate-physical', 'candidate-reference', 'slot', 'binding', 'list', 'physical-role', 'reference-role', 'drone-capacity', 'ling_xi', 'candidate-phase', 'candidate-level', 'candidate-value', 'candidate-group-new', 'candidate-group-size', 'candidate-group-local', 'candidate-group-index'])
    register(k);
for (const k of ['warmupHours', 'sampleHours', 'maxStepHours', 'seed'])
    register(`simulation:${k}`);
for (const k of ['gold', 'exp', 'none', 'trading'])
    register(`drone-target:${k}`);
for (const k of ['none', ...MOWER_ROOM_IDS])
    register(`drone-room:${k}`);
for (const k of ['exp', 'gold', 'orders', 'fragments', 'orundum'])
    register(`weight:${k}`);
for (const k of kinds)
    register(`decision:${k}`);
for (const k of ['operator', 'empty', 'free', 'value', 'end', 'absent', 'binding'])
    register(`action:${k}`);
for (const k of ['null', 'true', 'false', 'number', 'string'])
    register(`value:${k}`);
for (const room of MOWER_ROOM_IDS) {
    register(`decision-room:${room}`);
    register(`level:${room}`);
    for (const t of types)
        register(`type:${room}:${t}`);
    for (const p of products)
        register(`product:${room}:${p}`);
    for (let s = 0; s < 5; s++)
        for (const field of ['empty', 'free', 'current', 'resident-present', 'resident', 'group', 'bindings', 'locked'])
            register(`slot:${room}:${s}:${field}`);
    for (const role of roles)
        for (const op of operatorIds) {
            register(`room:${room}:${role}:${op}`);
        }
}
for (const field of MOWER_OPERATOR_LIST_FIELDS) {
    register(`decision-field:${field}`);
    register(`conf-present:${field}`);
    for (const op of operatorIds)
        register(`conf:${field}:${op}`);
}
for (const op of operatorIds)
    for (const role of roles) {
        register(`order:${role}:${op}`);
        register(`group:${role}:${op}`);
    }
for (const op of operatorIds)
    for (const role of ['owned', 'phase', 'level', 'remaining', 'candidate'])
        register(`${role}:${op}`);
for (const scope of ['global', 'local'])
    for (const role of roles)
        for (const buff of buffIds)
            register(`skill:${scope}:${role}:${buff}`);
for (const role of ['remaining', 'candidate'])
    for (const buff of buffIds)
        register(`skill:${role}:${buff}`);
// Categorical policy modes: append to preserve every existing vocabulary index.
for (const mode of [0, 1, 2, 3]) register(`ling-mode-action:${mode}`);
// Append an immutable-input namespace. Do not reinterpret existing prefix features
// or migrate old model rows: version/hash validation requires a fresh model.
for (const field of MOWER_OPERATOR_LIST_FIELDS) {
    register(`input-conf-present:${field}`);
    for (const op of operatorIds)
        register(`input-conf:${field}:${op}`);
}
for (const mode of [0, 1, 2, 3]) register(`input-conf-ling-mode:${mode}`);
/** Exact prior contract, retained only for explicit zero-row migration. */
export const LEGACY_FULL_FEATURE_MANIFEST = Object.freeze({
    version: 'full-v2-sparse-catalog-2-input-conf', operatorIds, buffIds, catalogContentFingerprint: fullFingerprint(OPERATORS), catalogSha256: 'c63e372a237a6c80194360536c4c5673f0db729cab7c77d778878aa54349e930', sourceCommit: source.commit, sourceHashes: Object.freeze(Object.fromEntries(Object.entries(source.sources).map(([k, v]) => [k, v.sha256]))), featureCount: keys.length, featureKeys: Object.freeze(keys.slice())
});
const facilitySkillTypes: Readonly<Record<string, string>> = Object.freeze({
    manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', central: 'CONTROL',
    meeting: 'MEETING', factory: 'WORKSHOP', contact: 'HIRE', train: 'TRAINING',
    dormitory: 'DORMITORY', recycle: 'RECYCLE', gaming: 'GAMING',
});
for (const op of operatorIds) register(`align:decision-occupant:${op}`);
for (const buff of buffIds) register(`align:decision-occupant-skill:${buff}`);
for (const op of operatorIds) register(`align:group-primary:${op}`);
for (const buff of buffIds) register(`align:group-primary-skill:${buff}`);
for (const type of types) register(`align:decision-facility:${type}`);
for (const product of products) register(`align:decision-product:${product}`);
for (const buff of buffIds) register(`align:candidate-facility-skill:${buff}`);
export const FULL_FEATURE_COUNT = keys.length;
export const FULL_FEATURE_MANIFEST = Object.freeze({
    ...LEGACY_FULL_FEATURE_MANIFEST, version: FULL_FEATURE_VERSION, featureCount: FULL_FEATURE_COUNT, featureKeys: Object.freeze(keys),
    diagnosticAlignment: Object.freeze({ baseFeatureCount: LEGACY_FULL_FEATURE_MANIFEST.featureCount, currentOccupantKinds: Object.freeze(['resident', 'group']), facilityContextKinds: 'all decisions with an actual room',
        currentOccupant: 'committed current slot primary only', groupMembers: 'distinct committed slot.groupId primary identities only',
        skillSemantics: 'binary union of actual unlocked skills compatible with each primary own facility; not runtime activation',
        facilitySkillTypes, facilityTypes: Object.freeze(types), products: Object.freeze(products),
        candidateSkillSemantics: 'operator candidates actual unlocked skills compatible with current decision facility; preserve old all-skills features', noTeacherLookahead: true })
});
export const FULL_FEATURE_MANIFEST_HASH = fullFingerprint(FULL_FEATURE_MANIFEST);
/** Append-only binary presence features; no runtime activation or teacher lookahead. */
function appendAlignment(c: FullScorerContext, base: FullEncodedDecision, ops: ReadonlyMap<string, OwnedOperator>): FullEncodedDecision {
    const d = c.decision;
    if (!d.roomId) return base;
    const facilities = c.state.workspace.mainPlan.facilities, room = facilities[d.roomId];
    if (!room) throw Error('Missing alignment decision room');
    const common = new Map(base.common), candidates = base.candidates.map(v => new Map(v));
    const add = (map: Map<number, number>, key: string) => {
        const index = indices.get(key);
        if (index === undefined) throw Error(`Unknown alignment feature ${key}`);
        map.set(index, 1);
    };
    const emit = (map: Map<number, number>, op: OwnedOperator | undefined, type: string, identity: string, skill: string) => {
        if (!op) throw Error('Unowned alignment prefix operator');
        add(map, identity + op.charId);
        const compatible = facilitySkillTypes[type];
        if (!compatible && type !== '') throw Error(`Unsupported alignment facility ${type}`);
        for (const s of op.skills) if (s.roomType === compatible) add(map, skill + s.buffId);
    };
    add(common, `align:decision-facility:${room.type}`);
    add(common, `align:decision-product:${room.product ?? 'none'}`);
    if (d.kind === 'resident' || d.kind === 'group') {
        const slot = room.slots[d.slotIndex!];
        if (!slot) throw Error('Missing alignment decision slot');
        if (slot.occupant.kind === 'operator') emit(common, ops.get(id(slot.occupant.operatorId)), room.type, 'align:decision-occupant:', 'align:decision-occupant-skill:');
    }
    c.actions.forEach((a, i) => {
        if (a.kind !== 'operator') return;
        const op = ops.get(id(String(a.value)));
        if (!op) throw Error('Unowned alignment candidate operator');
        for (const s of op.skills) if (s.roomType === facilitySkillTypes[room.type]) add(candidates[i]!, 'align:candidate-facility-skill:' + s.buffId);
    });
    if (d.kind === 'group') {
        const groups = new Map<string, Map<string, { operator: OwnedOperator | undefined; roomType: string }>>();
        for (const r of Object.values(facilities)) for (const slot of r.slots) {
            if (slot.groupId == null || slot.occupant.kind !== 'operator') continue;
            let members = groups.get(slot.groupId);
            if (!members) { members = new Map(); groups.set(slot.groupId, members); }
            const op = id(slot.occupant.operatorId);
            if (!members.has(op)) members.set(op, { operator: ops.get(op), roomType: r.type });
        }
        c.actions.forEach((a, i) => {
            if (a.kind !== 'value' || typeof a.value !== 'string') return;
            for (const member of groups.get(a.value)?.values() ?? []) emit(candidates[i]!, member.operator, member.roomType, 'align:group-primary:', 'align:group-primary-skill:');
        });
    }
    const finish = (map: Map<number, number>): SparseVector => [...map].sort((a, b) => a[0] - b[0]);
    return { ...base, common: finish(common), candidates: candidates.map(finish) };
}
function builder() {
    const m = new Map<number, number>();
    return {
        add(key: string, value = 1) {
            if (!Number.isFinite(value))
                throw Error(`Nonfinite feature ${key}`);
            const i = indices.get(key);
            if (i === undefined)
                throw Error(`Unknown feature ${key}`);
            if (value)
                m.set(i, (m.get(i) ?? 0) + value);
        }, finish(): SparseVector {
            return [...m].filter(([, v]) => v !== 0).sort((a, b) => a[0] - b[0]);
        }
    };
}
// Cache by actual input records, not object identity: callers may edit inventories between decisions.
const ownedCache = new Map<string, ReadonlyMap<string, OwnedOperator>>();
function owned(c: FullScorerContext) {
    const rows = c.scenario.inventory.operators.map(o => ({
        operator: id(o.charId), elitePhase: o.elitePhase, level: o.level
    })).sort((a, b) => a.operator.localeCompare(b.operator));
    const key = JSON.stringify(rows);
    let value = ownedCache.get(key);
    if (!value) {
        const inv = compileOperatorInventory(rows);
        if (!inv.valid)
            throw Error('Invalid owned inventory');
        value = new Map(inv.operators.map(o => [o.charId, o]));
        if (ownedCache.size >= 32)
            ownedCache.delete(ownedCache.keys().next().value!);
        ownedCache.set(key, value);
    }
    return value;
}
/** Resolve the same precedence as the evaluator; never give unused raw keys false effects. */
function encodeSchedulerConditioning(c: FullScorerContext, b: ReturnType<typeof builder>): void {
    const explicit = c.scenario.simulationConditioning.schedulerAssumptions ?? {};
    const supported = new Set([
        ...Object.keys(schedulerNumericScales), ...schedulerSwitches,
        'fiammettaThreshold', 'dormAtmosphere', 'dormOrder', 'operatorMorale', 'idleOperators',
        'majorMaintenanceStartHours', 'idealRunOrderWakeOnly', 'droneRoom',
        'reloadRooms', 'dormIsolation', 'groupMoodGapExclusions', 'currentOccupants',
        'schemaVersion', 'enableParty', 'runOrderSimulationMode',
        // The compiler intentionally discards these retired settings.
        'masteryPlanPresent', 'mowerMasteryPlanPresent',
    ]);
    for (const [key, value] of Object.entries(explicit)) {
        if (value !== undefined && !supported.has(key))
            throw Error(`Unsupported scheduler assumption ${key}`);
    }
    const schedule = compileRosterSchedule(c.state.workspace, explicit);
    const invalid = schedule.diagnostics.find(d => d.code === 'INVALID_ASSUMPTION' || d.code === 'INVALID_MOOD_LIMITS');
    if (invalid)
        throw Error(`Invalid scheduler conditioning: ${invalid.path}: ${invalid.message}`);
    const a = schedule.assumptions;
    // These relation sets need an explicit relation encoder before accepting them.
    if (a.dormIsolation?.some(group => group.length))
        throw Error('Unsupported scheduler dormIsolation');
    if (a.groupMoodGapExclusions?.length)
        throw Error('Unsupported scheduler groupMoodGapExclusions');
    if (Object.keys(a.currentOccupants).length)
        throw Error('Unsupported scheduler currentOccupants');
    for (const [field, scale] of Object.entries(schedulerNumericScales)) {
        b.add(`scheduler:${field}`, Number(a[field as keyof typeof schedulerNumericScales]) / scale);
    }
    // scheduleSimulation uses room.level*1000 only when the assumption was not
    // explicit; dormitoryRecovery then clamps atmosphere to the room's cap.
    // Encoding the effective value makes equivalent overrides identical.
    for (const room of schedule.rooms.filter(room => room.type === 'dormitory')) {
        const atmosphere = a.defaultsApplied.includes('dormAtmosphere') ? room.level * 1000 : a.dormAtmosphere;
        if (typeof atmosphere !== 'number' || !Number.isFinite(atmosphere)) throw Error('Invalid scheduler dormAtmosphere');
        b.add(`scheduler-dorm-atmosphere:${room.roomId}`, Math.min(room.level * 1000, Math.max(0, atmosphere)) / 5000);
    }
    for (const field of schedulerSwitches)
        b.add(`scheduler:${field}`, Number(a[field]));
    b.add('scheduler:fiammettaEffectiveThreshold', a.fiammettaFool === false ? a.fiammettaThreshold ?? .9 : .9);
    b.add('scheduler:initialMoraleExplicit', Number(!a.defaultsApplied.includes('initialMorale')));
    b.add('scheduler:majorMaintenancePresent', Number(a.majorMaintenanceStartHours !== undefined));
    b.add('scheduler:majorMaintenanceStartHours', (a.majorMaintenanceStartHours ?? 0) / 72);
    b.add('scheduler:idealRunOrderWakeOnly', Number(a.idealRunOrderWakeOnly !== false));
    b.add('scheduler:reloadRoomsNull', Number(a.reloadRooms === null));
    b.add(`scheduler-drone-room:${a.droneRoom == null ? 'none' : a.droneRoom}`);
    for (const [i, room] of (a.reloadRooms ?? []).entries())
        b.add(`scheduler-reload:${room}`, (i + 1) / 22);
    for (const [ref, morale] of Object.entries(a.operatorMorale)) {
        if (ref !== id(ref)) throw Error('Unsupported scheduler operatorMorale alias: use canonical ID');
        b.add(`scheduler-morale-present:${id(ref)}`);
        b.add(`scheduler-morale:${id(ref)}`, morale / 24);
    }
    for (const ref of a.idleOperators ?? [])
        b.add(`scheduler-idle:${id(ref)}`);
    const mood = readMowerMoodLimits(schedule.rawConf, id);
    if (mood?.all) {
        b.add('mood:global:present');
        b.add('mood:global:lower', mood.all.lower / 24);
        b.add('mood:global:upper', mood.all.upper / 24);
    }
    for (const [op, limit] of Object.entries(mood?.operators ?? {})) {
        b.add(`mood:${op}:present`);
        b.add(`mood:${op}:lower`, limit.lower / 24);
        b.add(`mood:${op}:upper`, limit.upper / 24);
    }
    const order = a.dormOrder ? a.dormOrder : typeof schedule.rawConf.dorm_order === 'string' ? schedule.rawConf.dorm_order : '';
    effectiveMowerDormOrder(order.split(',')).forEach((room, i) => b.add(`scheduler-dorm-order:${room}`, (i + 1) / 8));
    // Explicit global bed order also changes VIP assignment; raw native room order does not.
    if (a.dormOrder)
        a.dormOrder.split(',').filter(Boolean).forEach((bed, i) => b.add(`scheduler-bed-order:${bed}`, (i + 1) / 20));
    // dorm_order_override only merges backup layers. FULL-v2 rejects backup plans,
    // so encoding this unused main-plan flag would invent a false effect.
}
/**
 * Preserve the policy the caller supplied before initialFullState clears generated
 * lists. This never fills output policy or reads a teacher/completion. Native list
 * parsing supplies aliases and order; the exact-action domain is unique catalog
 * operators, not duplicate entries or refresh_trading operator(room) expressions.
 * Unsupported forms fail explicitly instead of colliding with a different input.
 * Non-generated mood/dorm/advanced settings already use compiler conditioning.
 */
function encodeInputConf(c: FullScorerContext, b: ReturnType<typeof builder>): void {
    const conf = c.scenario.workspace.mainPlan.conf;
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        b.add(`input-conf-present:${field}`, Number(Object.prototype.hasOwnProperty.call(conf, field)));
        const seen = new Set<string>();
        for (const [index, op] of readMowerOperatorList(field, conf[field]).entries()) {
            if (!indices.has(`input-conf:${field}:${op}`))
                throw Error(`Unsupported input policy operator ${field}: ${op}`);
            if (seen.has(op))
                throw Error(`Duplicate input policy operator ${field}: ${op}`);
            seen.add(op);
            b.add(`input-conf:${field}:${op}`, (index + 1) / operatorIds.length);
        }
    }
    // Match the native adapter's absent/null fallback and numeric coercion.
    const mode = Number(conf.ling_xi ?? 1);
    if (![0, 1, 2, 3].includes(mode))
        throw Error(`Unsupported input policy ling_xi: ${String(conf.ling_xi)}`);
    b.add(`input-conf-ling-mode:${mode}`);
}
/** Only immutable input and committed prefix are read; no trace, future actions or teacher score. */
export function encodeFullDecision(c: FullScorerContext): FullEncodedDecision {
    const b = builder(), ws = c.state.workspace, d = c.decision, ops = owned(c), reserved = fullPhysicalReservations(ws), groups = new Map<string, number>(), groupMembers = new Map<string, {
        size: number;
        local: number;
    }>();
    function groupIndex(g: string | null) {
        if (g === null)
            return 0;
        if (!groups.has(g))
            groups.set(g, groups.size + 1);
        return groups.get(g)!;
    }
    b.add(`decision:${d.kind}`);
    if (d.roomId)
        b.add(`decision-room:${d.roomId}`);
    if (d.field)
        b.add(`decision-field:${d.field}`);
    b.add('slot', (d.slotIndex ?? -1) + 1);
    b.add('binding', (d.bindingIndex ?? -1) + 1);
    b.add('list', (d.listIndex ?? -1) + 1);
    const room = d.roomId ? ws.mainPlan.facilities[d.roomId] : undefined;
    b.add('physical-role', Number(d.kind === 'occupant' || ((d.kind === 'replacement' || d.kind === 'binding-replacement') && room?.type !== 'dormitory')));
    b.add('reference-role', Number(d.kind === 'conf-list' || ((d.kind === 'replacement' || d.kind === 'binding-replacement') && room?.type === 'dormitory')));
    encodeSchedulerConditioning(c, b);
    encodeInputConf(c, b);
    const sim = c.scenario.simulationConditioning;
    b.add(`drone-target:${sim.droneTarget}`);
    b.add(`drone-room:${sim.droneRoomId?.replace(/^B([123])0([123])$/, 'room_$1_$2') ?? 'none'}`);
    for (const k of ['warmupHours', 'sampleHours', 'maxStepHours', 'seed'] as const)
        b.add(`simulation:${k}`, sim[k] / (k === 'seed' ? 0xffffffff : k === 'maxStepHours' ? 1 : 72));
    b.add('drone-capacity', (ws.droneCapacity ?? 200) / 200);
    b.add('ling_xi', Number(ws.mainPlan.conf.ling_xi) / 3);
    for (const [k, v] of Object.entries(normalizeProductionWeights(ws.productionWeights)))
        b.add(`weight:${k}`, v);
    for (const o of ops.values()) {
        b.add(`owned:${o.charId}`);
        b.add(`phase:${o.charId}`, o.elitePhase / 2);
        b.add(`level:${o.charId}`, o.level / 90);
        if (!reserved.has(o.charId)) {
            b.add(`remaining:${o.charId}`);
            for (const s of o.skills)
                b.add(`skill:remaining:${s.buffId}`, 1 / 32);
        }
    }
    for (const rid of MOWER_ROOM_IDS) {
        const r = ws.mainPlan.facilities[rid];
        if (!r)
            continue;
        b.add(`level:${rid}`, r.level / 5);
        b.add(`type:${rid}:${r.type}`);
        b.add(`product:${rid}:${r.product ?? 'none'}`);
        r.slots.forEach((slot, si) => {
            if (si >= 5)
                throw Error('Unsupported slot index');
            const prefix = `slot:${rid}:${si}:`;
            if (slot.occupant.kind !== 'operator')
                b.add(prefix + slot.occupant.kind);
            b.add(prefix + 'resident-present', Number(slot.dormitoryResident !== undefined));
            b.add(prefix + 'resident', Number(slot.dormitoryResident === true));
            b.add(prefix + 'group', groupIndex(slot.groupId) / 128);
            b.add(prefix + 'bindings', slot.groupBindings?.length ?? 0);
            b.add(prefix + 'locked', Number(c.scenario.lockedSlots.includes(`${rid}:${si}`)));
            const emit = (ref: string, role: typeof roles[number], order: number, g: string | null) => {
                if (ref === 'Free')
                    return;
                const op = ops.get(id(ref));
                if (!op)
                    throw Error(`Unowned prefix operator ${ref}`);
                b.add(`room:${rid}:${role}:${op.charId}`);
                b.add(`order:${role}:${op.charId}`, order / 512);
                b.add(`group:${role}:${op.charId}`, groupIndex(g) / 128);
                if (g !== null) {
                    const count = groupMembers.get(g) ?? {
                        size: 0, local: 0
                    };
                    count.size++;
                    count.local += Number(rid === d.roomId);
                    groupMembers.set(g, count);
                }
                for (const s of op.skills) {
                    b.add(`skill:global:${role}:${s.buffId}`, 1 / 32);
                    if (rid === d.roomId)
                        b.add(`skill:local:${role}:${s.buffId}`, 1 / 5);
                }
            };
            if (slot.occupant.kind === 'operator')
                emit(slot.occupant.operatorId, 'main', si + 1, slot.groupId);
            [slot, ...slot.groupBindings ?? []].forEach((binding, bi) => {
                groupIndex(binding.groupId);
                const physical = new Set(physicalBackupOperatorIds(r, binding));
                binding.replacements.forEach((ref, ri) => emit(ref, physical.has(id(ref)) ? 'physical' : 'reference', 1 + si * 64 + bi * 8 + ri, binding.groupId));
            });
        });
    }
    for (const field of MOWER_OPERATOR_LIST_FIELDS) {
        b.add(`conf-present:${field}`, Number(Object.prototype.hasOwnProperty.call(ws.mainPlan.conf, field)));
        (ws.mainPlan.conf[field] ?? []).forEach((ref, i) => b.add(`conf:${field}:${id(ref)}`, (i + 1) / 432));
    }
    const candidates = c.actions.map(a => {
        const x = builder();
        x.add(`action:${a.kind}`);
        if (a.kind === 'operator') {
            const o = ops.get(id(String(a.value)));
            if (!o)
                throw Error('Unowned candidate');
            x.add(`candidate:${o.charId}`);
            const physical = d.kind === 'occupant' || ((d.kind === 'replacement' || d.kind === 'binding-replacement') && room !== undefined && physicalBackupOperatorIds(room, { replacements: [o.charId] }).length > 0);
            x.add(physical ? 'candidate-physical' : 'candidate-reference');
            x.add('candidate-phase', o.elitePhase / 2);
            x.add('candidate-level', o.level / 90);
            for (const s of o.skills)
                x.add(`skill:candidate:${s.buffId}`);
        }
        else if (a.kind === 'value') {
            x.add(`value:${a.value === null ? 'null' : typeof a.value === 'boolean' ? String(a.value) : typeof a.value}`);
            if (typeof a.value === 'number') {
                x.add('candidate-value', a.value / 3);
                if (d.kind === 'ling_xi') x.add(`ling-mode-action:${a.value}`);
            }
            if (typeof a.value === 'string') {
                x.add('candidate-group-new', Number(!groups.has(a.value)));
                x.add('candidate-group-index', (groups.get(a.value) ?? groups.size + 1) / 128);
                x.add('candidate-group-size', (groupMembers.get(a.value)?.size ?? 0) / 64);
                x.add('candidate-group-local', (groupMembers.get(a.value)?.local ?? 0) / 5);
            }
        }
        return x.finish();
    });
    return appendAlignment(c, {
        version: FULL_FEATURE_VERSION, manifestHash: FULL_FEATURE_MANIFEST_HASH, featureCount: FULL_FEATURE_COUNT, common: b.finish(), candidates
    }, ops);
}
export function validateFullDecision(d: FullEncodedDecision): void {
    if (!d || d.version !== FULL_FEATURE_VERSION || d.manifestHash !== FULL_FEATURE_MANIFEST_HASH || d.featureCount !== FULL_FEATURE_COUNT)
        throw Error('Feature contract mismatch');
    if (!Array.isArray(d.candidates) || !d.candidates.length)
        throw Error('No legal candidates');
    for (const v of [d.common, ...d.candidates]) {
        if (!Array.isArray(v))
            throw Error('Invalid sparse vector');
        let last = -1;
        for (const pair of v) {
            if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] <= last || pair[0] >= FULL_FEATURE_COUNT || !Number.isFinite(pair[1]) || pair[1] === 0)
                throw Error('Invalid sparse feature');
            last = pair[0];
        }
    }
}
