/** Admission metadata for explicitly authorized auxiliary TRAIN evidence, never a full baseline. */
import { digest } from './state.mjs';
export const MOLECULAR_TEACHER_KIND = 'molecular-simulated';
export function inspectAuxiliaryEvidence(input, outcome, authorization) {
    const reasons = [], manifest = authorization?.manifest, envelope = outcome?.result;
    const fail = (condition, reason) => {
        if (condition)
            reasons.push(reason);
    };
    fail(authorization?.purpose !== 'training' || !authorization?.allowedTeacherKinds?.includes(MOLECULAR_TEACHER_KIND), 'AUXILIARY_NOT_EXPLICITLY_AUTHORIZED');
    fail(!manifest || authorization?.manifestHash !== digest(manifest), 'MANIFEST_COMMITMENT_MISMATCH');
    fail(manifest?.sourceKind !== MOLECULAR_TEACHER_KIND || input?.sourceKind !== MOLECULAR_TEACHER_KIND || envelope?.sourceKind !== MOLECULAR_TEACHER_KIND, 'SOURCE_KIND_MISMATCH');
    fail(manifest?.purpose !== 'training' || input?.purpose !== 'training' || envelope?.purpose !== 'training' || input?.split !== 'train', 'AUXILIARY_IS_TRAIN_ONLY');
    const inputProfile = input?.inputProfile ?? 'actual-mixture-v1', manifestProfile = manifest?.inputProfile ?? 'actual-mixture-v1', envelopeProfile = envelope?.inputProfile ?? 'actual-mixture-v1';
    fail(!['actual-mixture-v1', 'TRAIN-enriched-catalog-high-stage-v1'].includes(inputProfile) || !(authorization?.allowedInputProfiles ?? ['actual-mixture-v1']).includes(inputProfile), 'INPUT_PROFILE_NOT_AUTHORIZED');
    fail(inputProfile !== manifestProfile || inputProfile !== envelopeProfile, 'INPUT_PROFILE_MARKER_CONFLICT');
    const declared = manifest?.cases?.find(c => c.familyId === input?.familyId);
    fail(!declared || declared.inputHash !== digest(input), 'ORIGINAL_INPUT_COMMITMENT_MISMATCH');
    fail(!manifest?.provenance?.sourceHash || !manifest?.provenance?.bundleHash, 'MISSING_PRODUCER_PROVENANCE');
    fail(envelope?.comparisonComplete === false || envelope?.admittedTarget === false || outcome?.admittedTarget === false, 'PARTIAL_FAMILY_NOT_ADMITTED');
    fail(outcome?.status !== 'completed' || outcome?.completed !== true || envelope?.completed !== true, 'AUXILIARY_NOT_COMPLETED');
    fail(!Number.isFinite(outcome?.score) || !Number.isFinite(envelope?.score) || !Number.isFinite(envelope?.result?.score), 'UNKNOWN_SELECTED_SCORE');
    fail(outcome?.score !== envelope?.score || envelope?.score !== envelope?.result?.score, 'SELECTED_SCORE_CONFLICT');
    fail(envelope?.result?.status !== 'draft' || !envelope?.result?.workspace || !envelope?.result?.calculationReport, 'MISSING_SELECTED_FINAL_RESULT');
    fail(input?.options?.branchCount !== 3 || input?.options?.enableDeepSearch !== false || envelope?.branchCount !== 3 || envelope?.enableDeepSearch !== false, 'AUXILIARY_PRODUCER_POLICY_MISMATCH');
    fail(input?.options?.simulationWarmupHours !== 24 || input?.options?.simulationSampleHours !== 72, 'AUXILIARY_SIMULATION_WINDOW_MISMATCH');
    fail(!Array.isArray(envelope?.candidates) || !envelope.candidates.length || envelope.candidates.length > 3, 'MISSING_ALL_CANDIDATE_EVIDENCE');
    if (Array.isArray(envelope?.candidates)) {
        const ids = envelope.candidates.map(c => c.id);
        fail(ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length || !ids.includes(envelope.selectedId), 'CANDIDATE_ID_CONFLICT');
    }
    return { eligibleEvidence: !reasons.length, reasons, sourceKind: MOLECULAR_TEACHER_KIND, inputProfile, purpose: 'training', fullOptimizerTeacher: false, baselineEligible: false, manifestHash: authorization?.manifestHash ?? null, producerSourceHash: manifest?.provenance?.sourceHash ?? null, producerBundleHash: manifest?.provenance?.bundleHash ?? null };
}
