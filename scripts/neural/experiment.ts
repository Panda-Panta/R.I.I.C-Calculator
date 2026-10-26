/** CPU-only, explicitly restricted singleton curriculum. See --help. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { OPERATORS } from '../../src/domain/operators';
import { compileOperatorInventory, fullCatalogIdleInventory, type OwnedOperatorInput } from '../../src/domain/operatorInventory';
import { createDefaultWorkspace } from '../../src/workbench/defaults';
import { ensureBuiltDormKeepers } from '../../src/optimizer/dormKeepers';
import { buildSingletonFallback } from '../../src/optimizer/singletonFallback';
import { createNeuralScenario } from '../../src/optimizer/neural/actionSpace';
import { decodeRoster } from '../../src/optimizer/neural/decode';
import { replayTeacherTrace } from '../../src/optimizer/neural/teacherTraces';
import { NEURAL_FEATURE_COUNT, NEURAL_FEATURE_VERSION } from '../../src/optimizer/neural/features';
import { createPolicyModel, policyLogits, validatePolicyModel, type PolicySample } from '../../src/optimizer/neural/policy';
import { trainPolicy } from '../../src/optimizer/neural/training';
import { seededRandom, splitInventoryFamilies, qualifiedTrainingRecords } from '../../src/optimizer/neural/experiment';
import { validatePhysicalRoster } from '../../src/optimizer/rosterDraft';
import { runBoundedProcess } from './process.mjs';
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log(`Usage: node scripts/neural/run.mjs --output artifacts/neural/experiment/NAME [options]
 --families N       Independent inventory families, 3..60 (default 8)
 --sizes N,N        Inventory sizes, 8..432 (default 100,200,300,400)
 --layout tiny|243  Tiny=1 manufacturing slot + 1 power slot + fixed dorm; default tiny
 --seed N          uint32 deterministic inventory/split/model/simulator seed (default 20261026)
 --warmup N        Warmup hours, 0..72 (default 24)
 --sample N        Sample hours, 1..168 (default 72); <48 is smoke, NOT acceptance
 --timeout-ms N    Hard child-process timeout per simulation (default 120000)
 --epochs N        Fixed training epochs, 1..500 (default 60); no test tuning
 --resume          Resume matching source/config checkpoint only; never silently overwrite
All four policies get one decode and one simulation per held-out family, identical budgets.
Teacher=existing singleton fallback, qualified by completed authoritative simulator run.
No heuristic completion in neural inference. Fixed dorm keeper context is NOT neural output.
Unsupported atomic teams, runners, grouping, auxiliary staffing remain outside curriculum.`);
    process.exit(0);
}
const options: Record<string, string> = {};
let resume = false;
for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--resume') {
        resume = true;
        continue;
    }
    if (!key.startsWith('--') || !args[i + 1] || args[i + 1]!.startsWith('--'))
        throw Error(`Missing argument: ${key}`);
    options[key.slice(2)] = args[++i]!;
}
const allowed = ['output', 'families', 'sizes', 'layout', 'seed', 'warmup', 'sample', 'timeout-ms', 'epochs'];
for (const key of Object.keys(options))
    if (!allowed.includes(key))
        throw Error(`Unknown option: ${key}`);
function numberOption(key: string, fallback: number, min: number, max: number) {
    const n = Number(options[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
        throw Error(`Invalid ${key} (${min}..${max})`);
    return n;
}
const config = {
    families: numberOption('families', 8, 3, 60), sizes: (options.sizes ?? '100,200,300,400').split(',').map(Number), layout: options.layout ?? 'tiny', seed: numberOption('seed', 20261026, 0, 0xffffffff), warmupHours: numberOption('warmup', 24, 0, 72), sampleHours: numberOption('sample', 72, 1, 168), timeoutMs: numberOption('timeout-ms', 120000, 100, 600000), epochs: numberOption('epochs', 60, 1, 500)
};
if (!['tiny', '243'].includes(config.layout) || config.sizes.some(n => !Number.isInteger(n) || n < 8 || n > OPERATORS.length))
    throw Error('Invalid curriculum layout or inventory sizes');
if (!options.output)
    throw Error('--output required (new directory, or exact matching --resume)');
const output = resolve(options.output);
const hash = (x: unknown) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const { sourceHashes, sourceHash, inferenceContractHash } = JSON.parse(readFileSync(process.env.NEURAL_SOURCE_PROVENANCE!, 'utf8'));
const signature = hash({
    config, sourceHash, featureVersion: NEURAL_FEATURE_VERSION
});
function write(name: string, value: unknown) { const target = join(output, name); writeFileSync(`${target}.tmp`, JSON.stringify(value, null, ['checkpoint.json', 'dataset.json'].includes(name) ? undefined : 2)); renameSync(`${target}.tmp`, target); }
if (existsSync(output)) {
    if (!resume || !existsSync(join(output, 'manifest.json')))
        throw Error('Output exists; refusing overwrite without matching --resume manifest');
    if (JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).signature !== signature)
        throw Error('Resume source/config signature mismatch; use a new output directory');
}
else
    mkdirSync(output, { recursive: true });
const familyIds = Array.from({ length: config.families }, (_, i) => `inventory-${config.seed}-${i}`);
const sizeGroups = [...new Set(config.sizes)].map(size => familyIds.filter((_, i) => config.sizes[i % config.sizes.length] === size));
const stratified = sizeGroups.every(group => group.length >= 3);
const splits = stratified ? Object.assign({}, ...sizeGroups.map((group, i) => splitInventoryFamilies(group, (config.seed + i) >>> 0))) : splitInventoryFamilies(familyIds, config.seed);
const maxEntries = fullCatalogIdleInventory();
const families = familyIds.map((familyId, index) => {
    const random = seededRandom((config.seed + index * 104729) >>> 0), cards = [...maxEntries];
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [cards[i], cards[j]] = [cards[j]!, cards[i]!];
    }
    const selected = cards.slice(0, config.sizes[index % config.sizes.length]);
    const provisoId = OPERATORS.find(o => o.name === '但书')!.charId;
    if (!selected.some(o => o.operator === provisoId))
        selected[selected.length - 1] = maxEntries.find(o => o.operator === provisoId)!;
    const entries = selected.map(entry => {
        // Explicit mixture: 50% E0L1, 25% maximum unlocked stage, 25% E1L1 where valid.
        const roll = random();
        return roll < 0.5 ? {
            ...entry, elitePhase: 0, level: 1
        } : roll < 0.75 ? entry : {
            ...entry, elitePhase: Math.min(1, entry.elitePhase), level: 1
        };
    }).sort((a, b) => a.operator.localeCompare(b.operator));
    const inventory = compileOperatorInventory(entries);
    if (!inventory.valid)
        throw Error(JSON.stringify(inventory.diagnostics));
    const workspace = createDefaultWorkspace();
    if (config.layout === 'tiny')
        for (const room of Object.values(workspace.mainPlan.facilities)) {
            if (room.roomId === 'room_1_1') {
                room.level = 1;
                room.slots = room.slots.slice(0, 1);
            }
            else if (!['room_1_3', 'dormitory_1'].includes(room.roomId)) {
                room.level = 0;
                room.slots = [];
            }
        }
    if (!ensureBuiltDormKeepers(workspace, inventory))
        throw Error(`Cannot freeze dorm context ${familyId}`);
    for (const room of Object.values(workspace.mainPlan.facilities))
        if (room.type === 'dormitory')
            for (const slot of room.slots)
                if (slot.occupant.kind === 'empty')
                    slot.occupant = { kind: 'free' };
    return {
        familyId, split: splits[familyId]!, entries, inventory, workspace, inventoryHash: hash(entries), requiredProviso: entries.find(o => o.operator === provisoId)
    };
});
if (new Set(families.map(f => f.inventoryHash)).size !== families.length)
    throw Error('Duplicate inventory content across family IDs');
const manifest = {
    schemaVersion: 1, signature, config, sourceHash, sourceHashes, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), featureVersion: NEURAL_FEATURE_VERSION, featureCount: NEURAL_FEATURE_COUNT, featureHash: sourceHashes['src/optimizer/neural/features.ts'], node: process.version, createdUtc: new Date().toISOString(), normalization: 'fixed feature scales; no label-fitted normalization', splitRule: `seeded family shuffle before teacher candidates/traces; variants inherit family; size-stratified=${stratified}`, simulation: {
        engine: 'candidateSimulation -> scheduleSimulationBridge', schedulingModel: 'mower-alpha', warmupHours: config.warmupHours, sampleHours: config.sampleHours, production: {
            runOrderMode: 'ideal', outputMode: 'potential', droneTarget: 'gold', seed: config.seed
        }, assumptions: { restingThreshold: 0.65, operationDurationHours: 0 }, wallTimeoutMs: config.timeoutMs, concurrency: 1
    }, acceptanceWindow: config.sampleHours >= 48 && config.warmupHours >= 24, limitations: ['Singleton/neutral production masks only; no atomic combos', 'Fixed dorm keeper and Free beds are context, not learned placements', 'Tiny layout is a mechanism fixture, not practical full-base performance', 'Actual levels are randomized explicit synthetic ownership, not user inventory', 'Finite simulation success is not game validation or universal policy safety'], families: families.map(({ inventory, ...f }) => ({ ...f, stageSummary: inventory.operators.reduce((acc, o) => ({ ...acc, [`E${o.elitePhase}`]: (acc[`E${o.elitePhase}`] ?? 0) + 1 }), {} as Record<string, number>) }))
};
if (!resume)
    write('manifest.json', manifest);
const checkpointPath = join(output, 'checkpoint.json');
const checkpoint: any = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : {
    signature, teachers: [], evaluations: []
};
if (checkpoint.signature !== signature)
    throw Error('Checkpoint signature mismatch');
async function simulate(workspace: any, entries: OwnedOperatorInput[]) {
    return runBoundedProcess(process.execPath, [process.env.NEURAL_SIMULATION_WORKER!], {
        timeoutMs: config.timeoutMs, signal: cancellation.signal, input: JSON.stringify({
            workspace, options: {
                ...manifest.simulation, operatorInventory: entries, production: manifest.simulation.production
            }, assumptions: manifest.simulation.assumptions
        })
    });
}
for (const family of families) {
    if (checkpoint.teachers.some((r: any) => r.familyId === family.familyId && !r.simulation.diagnostics?.includes('CANCELLED')))
        continue;
    checkpoint.teachers = checkpoint.teachers.filter((r: any) => r.familyId !== family.familyId);
    const started = performance.now(), scenario = createNeuralScenario(family.workspace, family.inventory), teacher = buildSingletonFallback(family.workspace, family.inventory, new Set());
    const replay = teacher ? replayTeacherTrace(scenario, teacher) : null;
    const simulation = replay?.complete ? await simulate(teacher, family.entries) : {
        completed: false, score: null, diagnostics: replay?.diagnostics ?? ['NO_SINGLETON_TEACHER']
    };
    const record = {
        familyId: family.familyId, split: family.split, inventorySize: family.entries.length, decodeComplete: !!replay?.complete,
        complete: !!replay?.complete && simulation.completed, score: simulation.completed ? simulation.score : null, simulation, workspace: teacher, samples: replay?.complete ? replay.samples : [], diagnostics: replay?.diagnostics ?? ['NO_SINGLETON_TEACHER'], durationMs: performance.now() - started
    };
    checkpoint.teachers.push(record);
    write('checkpoint.json', checkpoint);
    if (cancellation.signal.aborted) {
        console.error('Cancelled; checkpoint preserved (cancelled record is null).');
        process.exit(130);
    }
    console.log(JSON.stringify({
        phase: 'teacher', family: family.familyId, split: family.split, complete: record.complete, score: record.score, ms: Math.round(record.durationMs), diagnostics: record.diagnostics
    }));
}
const qualified = qualifiedTrainingRecords(checkpoint.teachers), samples: PolicySample[] = qualified.flatMap((r: any) => r.samples);
const dataset = {
    signature, qualifiedFamilies: qualified.map((r: any) => r.familyId), samples
};
write('dataset.json', dataset);
if (!samples.length) {
    write('report.json', {
        status: 'blocked-no-qualified-training-teachers', signature, teachers: checkpoint.teachers.map(({ samples, workspace, ...r }: any) => r)
    });
    throw Error('No simulator-qualified training samples; retained null failures');
}
const fresh = createPolicyModel(NEURAL_FEATURE_COUNT, 24, config.seed), trainStart = performance.now();
console.log(JSON.stringify({ phase: 'training-start', samples: samples.length, epochs: config.epochs }));
const trained = trainPolicy(fresh, samples, {
    epochs: config.epochs, learningRate: 0.03, maxUpdates: 100000, shouldCancel: () => cancellation.signal.aborted
});
write('model.json', trained.model);
const model = validatePolicyModel(JSON.parse(readFileSync(join(output, 'model.json'), 'utf8')));
if (JSON.stringify(policyLogits(model, samples[0]!.candidates)) !== JSON.stringify(policyLogits(trained.model, samples[0]!.candidates)))
    throw Error('Serialized forward parity failed');
const training = {
    ...trained.diagnostics, durationMs: performance.now() - trainStart, samples: samples.length, datasetHash: hash(dataset), modelHash: hash(model), freshModelHash: hash(fresh), qualifiedFamilies: qualified.length, serializationParity: true
};
write('checkpoint-model.json', {
    schemaVersion: 2, model, modelHash: training.modelHash, datasetHash: training.datasetHash, trainingSourceHash: sourceHash, inferenceContractHash, featureVersion: NEURAL_FEATURE_VERSION, featureCount: NEURAL_FEATURE_COUNT, featureHash: manifest.featureHash, limitations: manifest.limitations
});
for (const family of families.filter(f => f.split !== 'train')) {
    for (const method of ['teacher', 'fresh', 'random', 'trained'] as const) {
        if (checkpoint.evaluations.some((r: any) => r.familyId === family.familyId && r.method === method && !r.simulation.diagnostics?.includes('CANCELLED')))
            continue;
        checkpoint.evaluations = checkpoint.evaluations.filter((r: any) => r.familyId !== family.familyId || r.method !== method);
        const start = performance.now(), scenario = createNeuralScenario(family.workspace, family.inventory), random = seededRandom(config.seed + families.indexOf(family)), teacher = checkpoint.teachers.find((r: any) => r.familyId === family.familyId);
        const decoded = method === 'teacher' ? null : decodeRoster(scenario, rows => method === 'random' ? rows.map(() => random()) : policyLogits(method === 'fresh' ? fresh : model, rows));
        const complete = method === 'teacher' ? teacher.decodeComplete : decoded!.complete, workspace = method === 'teacher' ? teacher.workspace : decoded!.workspace;
        const violations = workspace ? validatePhysicalRoster(workspace) : ['NO_WORKSPACE'];
        const simulation = method === 'teacher' ? teacher.simulation : complete && violations.length === 0 ? await simulate(workspace, family.entries) : {
            completed: false, score: null, diagnostics: decoded?.diagnostics ?? ['INCOMPLETE_DECODE']
        };
        const neuralPlacements = method === 'trained' || method === 'fresh' ? decoded!.modelPlacements : 0;
        const record = {
            familyId: family.familyId, split: family.split, inventorySize: family.entries.length, method, decodeComplete: complete, simulationComplete: simulation.completed, score: simulation.completed ? simulation.score : null, violations, neuralPlacements, generatedPlacements: decoded?.modelPlacements ?? 0,
            heuristicPlacements: method === 'teacher' ? scenario.positions.length : 0,
            frozenAssignments: decoded?.frozenAssignments ?? scenario.frozenAssignments, mechanicalChanges: decoded?.mechanicalChanges ?? null, neuralPlacementShare: decoded ? neuralPlacements / (decoded.modelPlacements + decoded.frozenAssignments) : 0, fallbackPlacements: 0, simulation, diagnostics: decoded?.diagnostics ?? teacher.diagnostics, workspace, trace: decoded?.trace ?? null, durationMs: performance.now() - start
        };
        checkpoint.evaluations.push(record);
        write('checkpoint.json', checkpoint);
        if (cancellation.signal.aborted) {
            console.error('Cancelled; checkpoint preserved (cancelled record is null).');
            process.exit(130);
        }
        console.log(JSON.stringify({
            phase: 'evaluation', family: family.familyId, method, complete: simulation.completed, score: record.score, neuralPlacements, ms: Math.round(record.durationMs)
        }));
    }
}
const evaluations = checkpoint.evaluations.map(({ workspace, trace, ...r }: any) => r);
const summarize = (selected: any[]) => Object.fromEntries(['teacher', 'fresh', 'random', 'trained'].map(method => {
    const rows = selected.filter((r: any) => r.method === method), scores = rows.filter((r: any) => r.score !== null).map((r: any) => r.score);
    return [method, {
            attempted: rows.length, completed: scores.length, completionRate: rows.length ? scores.length / rows.length : null, meanCompletedScore: scores.length ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : null, violations: rows.reduce((n: number, r: any) => n + r.violations.length, 0), fallbackPlacements: 0
        }];
}));
const summary = summarize(evaluations), bySplit = Object.fromEntries(['dev', 'test'].map(split => [split, summarize(evaluations.filter((r: any) => r.split === split))]));
write('report.json', {
    status: 'complete', signature, sourceHash, training, summary, bySplit, evaluations, teachers: checkpoint.teachers.map(({ samples, workspace, ...r }: any) => r), claim: 'Imitation baseline experiment; scores describe only these held-out families. No superiority claim.', acceptanceWindow: manifest.acceptanceWindow
});
console.log(JSON.stringify({
    phase: 'finished', output, training, summary
}));
