/** Synthetic model metadata only; no real model inference, training, optimizer or simulator. */
import assert from 'node:assert/strict';
import { createFullPolicy, serializeFullPolicy } from '../../../src/optimizer/neural/fullPolicy';
import { modelMetadata, FULL_FEATURE_MANIFEST_HASH } from './parity-report-runtime';
const model = createFullPolicy({ hiddenSize: 1, seed: 42 });
Object.assign(model.metadata, { hiddenSize: 2, manifestHash: 'spoofed-extra-field' });
const metadata = modelMetadata(serializeFullPolicy(model));
assert.equal(metadata.hiddenSize, 1);
assert.equal(metadata.manifestHash, FULL_FEATURE_MANIFEST_HASH);
console.log('pure report contracts passed');
