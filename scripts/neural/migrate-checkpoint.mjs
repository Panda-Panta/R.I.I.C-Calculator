/** Explicit v1 envelope migration. Does not relabel or alter original experiment evidence. */
import { readFileSync, writeFileSync } from 'node:fs';
import { sourceProvenance, inferenceContractHash, sha256 } from './provenance.mjs';
const [checkpointPath, manifestPath, outputPath] = process.argv.slice(2);
if (!checkpointPath || !manifestPath || !outputPath) throw Error('Usage: node scripts/neural/migrate-checkpoint.mjs OLD_CHECKPOINT MANIFEST NEW_OUTPUT');
const originalText = readFileSync(checkpointPath, 'utf8');
const checkpoint = JSON.parse(originalText);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const current = sourceProvenance(process.cwd());
if (checkpoint.schemaVersion !== 1 || checkpoint.sourceHash !== manifest.sourceHash || sha256(manifest.sourceHashes) !== manifest.sourceHash || sha256(checkpoint.model) !== checkpoint.modelHash || checkpoint.featureHash !== manifest.featureHash) throw Error('Original model/manifest evidence mismatch');
for (const key of ['modelHash', 'datasetHash', 'sourceHash', 'featureHash']) if (!/^[a-f0-9]{64}$/.test(checkpoint[key] ?? '')) throw Error(`Invalid original ${key}`);
const contract = inferenceContractHash(manifest.sourceHashes);
if (contract !== current.inferenceContractHash) throw Error('Inference source changed; cannot migrate without rerunning evidence');
const { sourceHash, ...rest } = checkpoint;
const migrated = { ...rest, schemaVersion: 2, trainingSourceHash: sourceHash, inferenceContractHash: contract, migration: { originalEnvelopeHash: sha256(originalText), originalManifestSignature: manifest.signature, reason: 'Contract-envelope migration only; all src numerical/decoder/catalog hashes verified identical.' } };
writeFileSync(outputPath, JSON.stringify(migrated, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, modelHash: migrated.modelHash, trainingSourceHash: sourceHash, runtimeSourceHash: current.sourceHash, inferenceContractHash: contract }));
