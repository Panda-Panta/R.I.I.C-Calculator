/** Explicit reference populations. A source hash remains mandatory; this is not a drift waiver. */
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const HISTORICAL_REFERENCE = 'historical-branch10-deep-v1';
export const LATEST_DEFAULT_REFERENCE = 'latest-default-two-stage-v1';
export const LATEST_ENHANCED_REFERENCE = 'latest-enhanced-deep-v1';
export const LATEST_DATA_VERSION = 'latest-math-v3';
const latest = { id: LATEST_DEFAULT_REFERENCE, revision: 1, construction: 'one-initial-plus-computed-manufacturing', ranking: 'finite-score-first-preference-efficiency-ties', warmupPolicy: 'generated-warmup-exhaustion-v1', recoveryPolicy: 'generated-recovery-v1', deepSearch: false, modelBudgetPolicy: 'exact-frozen-upstream-defaults', modelProofScope: 'quantified-manufacturing-model-only' };
const historical = { id: HISTORICAL_REFERENCE, revision: 1, construction: 'ten-molecular-branches', ranking: 'preference-efficiency-before-score', warmupPolicy: 'historical-frozen-source-policy', recoveryPolicy: 'historical-frozen-source-policy', deepSearch: true, modelBudgetPolicy: 'historical-frozen-source-defaults', modelProofScope: 'no-global-optimum-proof' };
export function referenceProtocol(id = LATEST_DEFAULT_REFERENCE) {
    if (id === HISTORICAL_REFERENCE) return { ...historical };
    if (id === LATEST_DEFAULT_REFERENCE) return { ...latest };
    if (id === LATEST_ENHANCED_REFERENCE) return { ...latest, id, deepSearch: true };
    throw Error('Unknown full reference protocol: ' + id);
}
function declaredProtocol(value) {
    const expected = referenceProtocol(value?.id);
    if (!value || hash(value) !== hash(expected)) throw Error('Full reference protocol identity/revision mismatch');
    return expected;
}
export function resolveReferenceProtocol(input) {
    const protocol = input?.referenceProtocol ? declaredProtocol(input.referenceProtocol) : referenceProtocol(HISTORICAL_REFERENCE), options = input?.options;
    if (options?.simulationWarmupHours !== 24 || options?.simulationSampleHours !== 72 || options?.enableDeepSearch !== protocol.deepSearch)
        throw Error('Full reference protocol request/window mismatch');
    if (protocol.id === HISTORICAL_REFERENCE) {
        if (options.branchCount !== 10) throw Error('Historical full reference requires branch10/deeptrue');
    } else {
        if (input.dataVersion !== LATEST_DATA_VERSION || ['branchCount', 'trials', 'maxStaticEvals', 'simulationTopK'].some(key => Object.hasOwn(options, key)))
            throw Error('Latest reference protocol must not claim operative legacy branch/search settings');
        const supported = new Set(['seed', 'enableDeepSearch', 'simulationWarmupHours', 'simulationSampleHours', 'droneTarget', 'droneRoomId', 'productionWeights']);
        if (Object.keys(options).some(key => !supported.has(key))) throw Error('Unknown latest reference request option');
        if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff || options.droneTarget !== 'gold' || options.droneRoomId !== undefined ||
            hash(options.productionWeights) !== hash({ exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 }))
            throw Error('Latest reference calibration settings mismatch');
    }
    return protocol;
}
export function inspectReferenceEnvelope(input, envelope) {
    const reasons = []; let protocol = null;
    try { protocol = resolveReferenceProtocol(input); } catch (error) { reasons.push('REFERENCE_PROTOCOL_MISMATCH: ' + String(error)); }
    if (!protocol) return { referenceProtocol: null, reasons };
    if (protocol.id === HISTORICAL_REFERENCE) {
        if (envelope?.referenceProtocol && hash(envelope.referenceProtocol) !== hash(protocol)) reasons.push('REFERENCE_PROTOCOL_CONFLICT');
        return { referenceProtocol: protocol, reasons };
    }
    if (hash(envelope?.referenceProtocol ?? null) !== hash(protocol)) reasons.push('REFERENCE_PROTOCOL_CONFLICT');
    if (envelope?.requestOptionsHash !== hash(input.options)) reasons.push('REFERENCE_REQUEST_COMMITMENT_MISMATCH');
    const teacher = envelope?.result, phases = teacher?.phases, candidates = phases?.simulation?.candidates, initial = phases?.static?.candidates;
    if (phases?.calculation?.proofScope !== protocol.modelProofScope || !['complete', 'limited', 'unsupported'].includes(phases?.calculation?.status)) reasons.push('MISSING_COMPUTED_MODEL_DIAGNOSTICS');
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 2 || !Array.isArray(initial) || hash(initial.map(c => c.id).sort()) !== hash(candidates.map(c => c.id).sort())) {
        reasons.push('MISSING_LATEST_CANDIDATE_SET');
    } else {
        if (new Set(candidates.map(c => c.id)).size !== candidates.length || candidates.some(c => typeof c.id !== 'string' || !c.workspace || !Number.isFinite(c.simScore))) reasons.push('INCOMPLETE_LATEST_CANDIDATE_COMPARISON');
        if (initial.some(c => !candidates.some(s => s.id === c.id && hash(s.workspace) === hash(c.workspace)))) reasons.push('STATIC_SIMULATED_CANDIDATE_WORKSPACE_CONFLICT');
        const best = Math.max(...candidates.map(c => c.simScore));
        if (phases.simulation.bestScore !== best) reasons.push('LATEST_SCORE_FIRST_WINNER_CONFLICT');
        if (!protocol.deepSearch && (teacher.score !== best || !candidates.some(c => c.simScore === best && hash(c.workspace) === hash(teacher.workspace)))) reasons.push('LATEST_FINAL_WORKSPACE_NOT_SIMULATED_WINNER');
    }
    if (protocol.deepSearch && (typeof phases?.search?.improved !== 'boolean' || !Number.isFinite(phases?.search?.gain) || !Number.isSafeInteger(phases?.replacement?.swappedCount) || phases.replacement.swappedCount < 0 || !Array.isArray(phases.replacement.logs) || teacher.score < phases?.simulation?.bestScore)) reasons.push('MISSING_OR_DEGRADED_ENHANCED_SEARCH_EVIDENCE');
    if (!protocol.deepSearch && (phases?.search !== null || phases?.replacement !== undefined)) reasons.push('DEFAULT_REFERENCE_HAS_ENHANCED_SEARCH');
    return { referenceProtocol: protocol, reasons };
}
/** Bind exact producer plus request identities; callers additionally retain input/result hashes. */
export function referenceManifestContract(manifest, inputs = []) {
    const protocol = manifest?.referenceProtocol ? declaredProtocol(manifest.referenceProtocol) : referenceProtocol(HISTORICAL_REFERENCE);
    for (const input of inputs) if (hash(resolveReferenceProtocol(input)) !== hash(protocol)) throw Error('Teacher manifest/input reference protocol mismatch');
    if (protocol.id !== HISTORICAL_REFERENCE && manifest.dataVersion !== LATEST_DATA_VERSION) throw Error('Latest manifest data version mismatch');
    return { referenceProtocol: protocol, producerSourceHash: manifest?.provenance?.sourceHash ?? null, producerBundleHash: manifest?.provenance?.bundleHash ?? null,
        requests: inputs.map(input => ({ familyId: input.familyId, requestOptionsHash: hash(input.options) })).sort((a,b) => a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0) };
}
