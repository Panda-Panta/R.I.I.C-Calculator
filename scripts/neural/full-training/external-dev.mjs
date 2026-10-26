/** Snapshot a TRAIN model, then evaluate on separately qualified exposed FULL DEV families. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomic, digest, inspectCheckpoint } from './state.mjs';
import { assertFullBaselineDataset } from './evaluate.mjs';
import { verifyTeacherSourceCompatibility, STAFFING_SOURCE_TRANSITION } from './source-compatibility.mjs';
import { openBaselineCache } from './baseline-cache.mjs';
import { runWorker } from './process.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), read = p => JSON.parse(readFileSync(p, 'utf8'));
export function validateExternalSources(training, dev, trainingData, devData) {
    if (training.config.purpose !== 'train' || trainingData.purpose !== 'train')
        throw Error('Transfer evaluation requires actual TRAIN model');
    if (dev.config.purpose !== 'dev-overfit' || devData.purpose !== 'dev-overfit' || devData.records.some(r => r.input.split !== 'dev'))
        throw Error('Only exposed FULL DEV is authorized');
    assertFullBaselineDataset(devData, dev);
    if (trainingData.records.some(r => devData.records.some(d => d.familyId === r.familyId)))
        throw Error('TRAIN/DEV family overlap');
}
export function validateExternalTeacherContract(training, sources) {
    const policy = training.config?.sourceTransition ?? 'none';
    if (policy !== 'none' && (policy !== STAFFING_SOURCE_TRANSITION || training.config?.constructionOrder !== 'staffing-first-v1'))
        throw Error('Invalid external reference action transition');
    return verifyTeacherSourceCompatibility(sources.teacherManifest.provenance, training.provenance, policy);
}
export async function evaluateExternalDev(modelDirectory, devDirectory, name, { timeoutMs = 120000, baselineCacheDirectory = null } = {}) {
    if (!/^[\w-]+$/.test(name) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000)
        throw Error('Invalid bounded evaluation options');
    const training = read(join(modelDirectory, 'manifest.json')), dev = read(join(devDirectory, 'manifest.json')), trainingData = read(join(modelDirectory, 'dataset.json')), devData = read(join(devDirectory, 'dataset.json')), sources = read(join(devDirectory, 'source-records.json'));
    validateExternalSources(training, dev, trainingData, devData);
    if (read(join(devDirectory, 'preparation.json')).result?.datasetHash !== digest(devData))
        throw Error('DEV prepared dataset commitment mismatch');
    if (sources.teacherManifestHash !== digest(sources.teacherManifest))
        throw Error('DEV teacher manifest commitment mismatch');
    const referenceContract = validateExternalTeacherContract(training, sources);
    if (digest(sources) !== devData.sourceRecordsHash)
        throw Error('DEV source record commitment mismatch');
    for (const [key, hash] of Object.entries(training.provenance.sourceHashes))
        if (digest(readFileSync(join(root, key))) !== hash)
            throw Error('Model inference source mismatch: ' + key);
    if (digest(readFileSync(join(modelDirectory, 'worker.mjs'))) !== training.provenance.bundleHash)
        throw Error('Frozen simulator bundle mismatch');
    const checkpoint = inspectCheckpoint(modelDirectory);
    if (!checkpoint || checkpoint.state.binding.datasetHash !== digest(trainingData))
        throw Error('TRAIN checkpoint dataset mismatch');
    const directory = join(modelDirectory, 'external-dev-' + name);
    mkdirSync(directory, { mode: 0o700 });
    const modelPath = join(directory, 'model.bin');
    writeFileSync(modelPath, checkpoint.bytes, { mode: 0o600 });
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), sourceHashes = {}, bundle = join(directory, 'decode-worker.mjs');
    await build({ entryPoints: [join(root, 'scripts/neural/full-training/external-dev-worker.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'warning', plugins: [{ name: 'pin-evaluation-source', setup(b) { b.onLoad({ filter: /\.(ts|json|mjs)$/ }, args => { const contents = readFileSync(args.path, 'utf8'); sourceHashes[relative(root, args.path)] = digest(contents); return { contents, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith('.ts') ? 'ts' : 'js' }; }); } }] });
    for (const key of ['scripts/neural/full-training/external-dev.mjs', 'scripts/neural/full-training/baseline-cache.mjs', 'scripts/neural/full-training/source-compatibility.mjs', 'scripts/neural/full-training/process.mjs', 'scripts/neural/full-training/supervisor.mjs', 'scripts/neural/full-training/evaluate.mjs'])
        sourceHashes[key] = digest(readFileSync(join(root, key)));
    for (const [key, hash] of Object.entries(sourceHashes))
        if (digest(readFileSync(join(root, key))) !== hash)
            throw Error('Evaluation source changed while freezing');
    let baselineCache = null, baselineCacheStatus = { requested: baselineCacheDirectory, enabled: false, reason: null };
    if (baselineCacheDirectory) {
        try {
            baselineCache = await openBaselineCache(root, resolve(baselineCacheDirectory), modelDirectory, training, referenceContract);
            baselineCacheStatus.enabled = true;
        }
        catch (error) {
            baselineCacheStatus.reason = String(error);
        }
    }
    const binding = { referenceContract, baselineCacheStatus, modelHash: digest(checkpoint.bytes), cursor: checkpoint.state.cursor, trainingManifestHash: digest(training), trainingDatasetHash: digest(trainingData), devManifestHash: digest(dev), devDatasetHash: digest(devData), devSourceRecordsHash: digest(sources), decodeBundleHash: digest(readFileSync(bundle)), sourceHashes, timeoutMs };
    atomic(join(directory, 'manifest.json'), binding);
    const reports = [];
    for (const record of devData.records) {
        const source = sources.records.find(r => r.resultHash === record.teacherRecordHash);
        if (!source || digest(source.outcome) !== record.teacherRecordHash || digest(source.input) !== digest(record.input))
            throw Error('Missing or conflicting exact full teacher');
        const declared = sources.teacherManifest.cases.find(c => c.familyId === record.familyId);
        if (!declared || declared.inputHash !== digest(record.input))
            throw Error('DEV original input manifest mismatch');
        const job = { archivedTeacherTrace: { constructionOrder: record.constructionOrder ?? 'legacy-v1', actionIds: record.actionIds, teacherSemanticHash: record.teacherSemanticHash }, constructionOrder: training.config.constructionOrder ?? 'legacy-v1', input: record.input, outcome: source.outcome, trainingInputs: trainingData.records.map(r => r.input), modelPath, modelHash: binding.modelHash };
        const decoded = await runWorker(bundle, job, { timeoutMs, stderrPath: join(directory, record.familyId + '-decode.stderr') });
        atomic(join(directory, record.familyId + '-decode.json'), { binding, jobHash: digest(job), outcome: decoded });
        const report = { familyId: record.familyId, decodeStatus: decoded.status, complete: decoded.result?.complete ?? false, exactTeacherSemantics: decoded.result?.exactTeacherSemantics ?? false, diagnostics: decoded.result?.diagnostics ?? [], pairs: [] };
        if (decoded.status !== 'completed') {
            reports.push(report);
            atomic(join(directory, 'summary.json'), { binding, reports, scope: 'EXPOSED FULL DEV TRANSFER ONLY; NOT RELEASE OR PARITY', parity: false });
            continue;
        }
        for (const seed of [record.input.options.seed, (record.input.options.seed + 1) >>> 0])
            for (const maxStepHours of [.25, .125]) {
                const pair = { seed, maxStepHours, neural: null, baseline: null };
                for (const side of ['neural', 'baseline']) {
                    if (!report.complete) {
                        pair[side] = { status: side === 'neural' ? 'invalid-or-unknown-decode' : 'not-run-invalid-neural', score: null };
                        continue;
                    }
                    const simJob = { mode: 'evaluate', input: record.input, workspace: side === 'neural' ? decoded.result.workspace : source.outcome.result.result.workspace, seed, maxStepHours };
                    const fileName = `${record.familyId}-${seed}-${maxStepHours}-${side}.json`, path = join(directory, fileName);
                    const cached = side === 'baseline' && baselineCache ? baselineCache.tryReuse(fileName, simJob) : { hit: false, reason: 'not-requested-or-neural' };
                    const result = cached.hit ? cached.artifact.outcome : await runWorker(join(modelDirectory, 'worker.mjs'), simJob, { timeoutMs, stderrPath: join(directory, record.familyId + '-simulation.stderr') });
                    atomic(path, { binding, jobHash: digest(simJob), outcome: result, baselineReuse: cached.hit ? { sourceArtifactPath: cached.path, proof: cached.proof } : { reused: false, reason: cached.reason } });
                    pair[side] = { status: result.status, completed: result.result?.completed ?? false, score: result.status === 'completed' && result.result?.completed && Number.isFinite(result.result.score) ? result.result.score : null, reusedBaseline: cached.hit, artifactHash: digest(read(path)) };
                }
                report.pairs.push(pair);
            }
        reports.push(report);
        atomic(join(directory, 'summary.json'), { binding, reports, scope: 'EXPOSED FULL DEV TRANSFER ONLY; NOT RELEASE OR PARITY', parity: false });
    }
    return { directory, reports, parity: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length < 5)
        throw Error('Usage: external-dev.mjs TRAIN_RUN FULL_DEV_RUN NAME [timeoutMs] [originalFullDevBaselineCacheDirectory]');
    console.log(JSON.stringify(await evaluateExternalDev(resolve(process.argv[2]), resolve(process.argv[3]), process.argv[4], { timeoutMs: Number(process.argv[5] ?? 120000), baselineCacheDirectory: process.argv[6] ?? null })));
}
