import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileOperatorInventory } from '../../src/domain/operatorInventory';
import { createNeuralScenario } from '../../src/optimizer/neural/actionSpace';
import { decodeRoster } from '../../src/optimizer/neural/decode';
import { NEURAL_FEATURE_COUNT, NEURAL_FEATURE_VERSION } from '../../src/optimizer/neural/features';
import { validatePolicyModel, policyLogits } from '../../src/optimizer/neural/policy';
const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log('Usage: node scripts/neural/run.mjs infer --checkpoint checkpoint-model.json --scenario scenario.json --output decoded.json\nScenario JSON: {workspace: RosterWorkspace, entries: OwnedOperatorInput[]}. Built dorm keepers and Free beds must be explicit. No heuristic staffing or simulation is performed. Output creation is exclusive; model and feature contract are verified.');
    process.exit(0);
}
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
    if (!['--checkpoint', '--scenario', '--output'].includes(args[i]!) || !args[i + 1])
        throw Error('Invalid inference arguments; see infer --help');
    options[args[i]!.slice(2)] = args[i + 1]!;
}
if (!options.checkpoint || !options.scenario || !options.output)
    throw Error('Missing --checkpoint, --scenario or --output');
const checkpoint = JSON.parse(readFileSync(options.checkpoint, 'utf8'));
const provenance = JSON.parse(readFileSync(process.env.NEURAL_SOURCE_PROVENANCE!, 'utf8'));
for (const field of ['modelHash', 'datasetHash', 'trainingSourceHash', 'featureHash', 'inferenceContractHash']) {
    if (typeof checkpoint[field] !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint[field])) throw Error(`Missing or invalid checkpoint ${field}`);
}
if (checkpoint.schemaVersion !== 2 || checkpoint.featureVersion !== NEURAL_FEATURE_VERSION || checkpoint.featureCount !== NEURAL_FEATURE_COUNT || checkpoint.featureHash !== provenance.sourceHashes['src/optimizer/neural/features.ts'] || checkpoint.inferenceContractHash !== provenance.inferenceContractHash) throw Error('Incompatible checkpoint inference contract');
const model = validatePolicyModel(checkpoint.model);
if (model.featureCount !== NEURAL_FEATURE_COUNT) throw Error('Checkpoint model feature count mismatch');
const modelHash = createHash('sha256').update(JSON.stringify(model)).digest('hex');
if (modelHash !== checkpoint.modelHash)
    throw Error('Checkpoint model hash mismatch');
const input = JSON.parse(readFileSync(options.scenario, 'utf8'));
const inventory = compileOperatorInventory(input.entries);
const scenario = createNeuralScenario(input.workspace, inventory);
const decoded = decodeRoster(scenario, candidates => policyLogits(model, candidates));
writeFileSync(options.output, JSON.stringify({
    ...decoded, modelHash, trainingSourceHash: checkpoint.trainingSourceHash, runtimeSourceHash: provenance.sourceHash, datasetHash: checkpoint.datasetHash, inferenceContractHash: checkpoint.inferenceContractHash, fallbackPlacements: 0, simulation: null, warning: 'Unsimulated experimental neural output. Do not interpret decode completion as simulator qualification.'
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({
    complete: decoded.complete, modelPlacements: decoded.modelPlacements, frozenAssignments: decoded.frozenAssignments, diagnostics: decoded.diagnostics, output: options.output
}));
if (!decoded.complete)
    process.exitCode = 2;
