/** Trace transitions retain their four-module allowlist; aligned features use separate exact reviewed source pairs. Physics and update arithmetic remain immutable. */
import {ALIGNED_SOURCE_TRANSITION,FEATURE_MIGRATION_CONTRACT,verifyFeatureMigrationImplementation,isReviewedFeatureSourceDrift} from './feature-migration-contract.mjs';
export const STAFFING_SOURCE_TRANSITION = 'legacy-action-replay-to-staffing-first-v1';
export const LATEST_POLICY_SOURCE_TRANSITION = 'latest-default-to-warmup-policy-v1';
export const LATEST_RUNORDER_SOURCE_TRANSITION = 'latest-default-to-warmup-runorder-v2';
export const LATEST_POLICY_TRANSITIONS = Object.freeze({ [LATEST_POLICY_SOURCE_TRANSITION]: 'latest-warmup-exhaustion-v1', [LATEST_RUNORDER_SOURCE_TRANSITION]: 'latest-warmup-runorder-v2', [ALIGNED_SOURCE_TRANSITION]:'latest-warmup-runorder-v2' });
export const isLatestPolicyMode = mode => Object.values(LATEST_POLICY_TRANSITIONS).includes(mode);
export function verifyLatestPolicyTransition(policyMode, sourceTransition) {
    if (!isLatestPolicyMode(policyMode) || LATEST_POLICY_TRANSITIONS[sourceTransition] !== policyMode) throw Error('Latest policy-mode/source-transition binding mismatch');
}
const actionModules = new Set(['src/optimizer/neural/fullActionSpace.ts', 'src/optimizer/neural/fullTransitions.ts', 'src/optimizer/neural/fullTeacherTraces.ts', 'src/optimizer/neural/fullDecode.ts']);
export function verifyTeacherSourceCompatibility(producer, trainer, policy = 'none') {
    if (!['none', STAFFING_SOURCE_TRANSITION, ...Object.keys(LATEST_POLICY_TRANSITIONS)].includes(policy))
        throw Error('Unknown teacher source transition');
    if(policy===ALIGNED_SOURCE_TRANSITION)verifyFeatureMigrationImplementation(trainer);
    const drifts = [];
    for (const [path, producerHash] of Object.entries(producer.sourceHashes)) {
        const trainerHash = trainer.sourceHashes[path];
        if (!trainerHash || trainerHash === producerHash)
            continue;
        if (!(policy===ALIGNED_SOURCE_TRANSITION&&isReviewedFeatureSourceDrift(path,producerHash,trainerHash))&&(![STAFFING_SOURCE_TRANSITION, ...Object.keys(LATEST_POLICY_TRANSITIONS)].includes(policy) || !actionModules.has(path)))
            throw Error('Teacher/trainer shared source mismatch: ' + path);
        drifts.push({ path, producerHash, trainerHash });
    }
    if (Object.hasOwn(LATEST_POLICY_TRANSITIONS, policy))
        return { policy, drifts, legacyProofRequired: false, producerReplayProofRequired: true, ...(policy===ALIGNED_SOURCE_TRANSITION?{featureMigration:FEATURE_MIGRATION_CONTRACT}:{}), reason: 'Explicit latest full-reference policy transition; the original frozen prepared worker must independently reproduce archived action IDs and semantic workspace before new policy inversion; unchanged physics is not resimulated' };
    return { policy, drifts, legacyProofRequired: policy === STAFFING_SOURCE_TRANSITION, reason: policy === 'none' ? 'Exact shared-source bytes required' : 'Explicit replay-preserving action protocol transition; legacy producer action IDs and semantic workspace must be independently reproduced before staffing-first selected-target inversion; unchanged physics is not resimulated' };
}
