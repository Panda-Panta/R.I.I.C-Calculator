/** Narrow opt-in migration of trace protocol only. Physics/features/numerics never migrate here. */
export const STAFFING_SOURCE_TRANSITION = 'legacy-action-replay-to-staffing-first-v1';
const actionModules = new Set(['src/optimizer/neural/fullActionSpace.ts', 'src/optimizer/neural/fullTransitions.ts', 'src/optimizer/neural/fullTeacherTraces.ts', 'src/optimizer/neural/fullDecode.ts']);
export function verifyTeacherSourceCompatibility(producer, trainer, policy = 'none') {
    if (!['none', STAFFING_SOURCE_TRANSITION].includes(policy))
        throw Error('Unknown teacher source transition');
    const drifts = [];
    for (const [path, producerHash] of Object.entries(producer.sourceHashes)) {
        const trainerHash = trainer.sourceHashes[path];
        if (!trainerHash || trainerHash === producerHash)
            continue;
        if (policy !== STAFFING_SOURCE_TRANSITION || !actionModules.has(path))
            throw Error('Teacher/trainer shared source mismatch: ' + path);
        drifts.push({ path, producerHash, trainerHash });
    }
    return { policy, drifts, legacyProofRequired: policy === STAFFING_SOURCE_TRANSITION, reason: policy === 'none' ? 'Exact shared-source bytes required' : 'Explicit replay-preserving action protocol transition; legacy producer action IDs and semantic workspace must be independently reproduced before staffing-first selected-target inversion; unchanged physics is not resimulated' };
}
