/** Read-only report helpers: no training, autonomous model decoding, simulation, or roster repair. */
import { compileOperatorInventory } from '../../../src/domain/operatorInventory';
import { deserializeFullPolicy } from '../../../src/optimizer/neural/fullPolicy';
import { FULL_FEATURE_MANIFEST, FULL_FEATURE_MANIFEST_HASH } from '../../../src/optimizer/neural/fullFeatures';
export { evaluateFullParity, FULL_LATEST_REFERENCE_PROTOCOL } from '../../../src/optimizer/neural/fullParity';
export { FULL_FEATURE_MANIFEST, FULL_FEATURE_MANIFEST_HASH };
export function canonicalInventory(entries: any[]) {
    const inventory = compileOperatorInventory(entries);
    if (!inventory.valid || inventory.operators.length !== entries.length) throw Error('Invalid or duplicate inventory');
    return inventory.operators.map(op => ({ operator: op.charId, phase: op.elitePhase, level: op.level })).sort((a, b) => a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0);
}
export function modelMetadata(bytes: Uint8Array) {
    const model = deserializeFullPolicy(bytes);
    return { ...model.metadata, hiddenSize: model.hiddenSize, manifestHash: model.manifestHash };
}

export { replayPolicyForkTeacher } from './parity-report-teacher-replay';
