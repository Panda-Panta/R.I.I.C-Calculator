/** Optional authoritative DEVELOPMENT evaluation. No optimizer call and no parity declaration. */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, digest } from './state.mjs';
import { referenceProtocol, resolveReferenceProtocol, referenceManifestContract, HISTORICAL_REFERENCE } from '../full-baseline/reference-protocol.mjs';
import { runWorker } from './process.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
export function assertFullBaselineDataset(dataset, manifest) {
    if ((manifest.config?.teacherKind && manifest.config.teacherKind !== 'full-optimizer') || (dataset.teacherKinds && dataset.teacherKinds.some(k => k !== 'full-optimizer')) || dataset.baselineEligible === false || dataset.records.some(r => r.degradedBaseline === true || r.baselineEligible === false || r.fullOptimizerTeacher === false || (r.sourceKind && r.sourceKind !== 'full-optimizer')))
        throw Error('Auxiliary training targets are never full mathematical baselines; use separate full-optimizer validation evidence');
    const protocols = dataset.records.map(r => r.input?.referenceProtocol ? resolveReferenceProtocol(r.input) : referenceProtocol(HISTORICAL_REFERENCE));
    for (const [i, record] of dataset.records.entries()) if (record.referenceProtocol && digest(record.referenceProtocol) !== digest(protocols[i])) throw Error('Full reference protocol record/input mismatch');
    const unique = [...new Map(protocols.map(p => [digest(p), p])).values()];
    if (unique.length > 1 || (dataset.referenceProtocols && digest(dataset.referenceProtocols) !== digest(unique)) || (unique.some(p => p.id !== HISTORICAL_REFERENCE) && !dataset.referenceProtocols)) throw Error('Full reference protocol population mismatch');
}
export async function evaluateFreeRunning(directory, { timeoutMs = 120000, signal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100)
        throw Error('Invalid evaluation timeout');
    const manifest = read(join(directory, 'manifest.json')), dataset = read(join(directory, 'dataset.json')), decode = read(join(directory, 'decode-latest.json')), sources = read(join(directory, 'source-records.json')), bundle = join(directory, 'worker.mjs');
    assertFullBaselineDataset(dataset, manifest);
    if (digest(readFileSync(bundle)) !== manifest.provenance.bundleHash)
        throw Error('Evaluation bundle mismatch');
    const referenceContract = referenceManifestContract(sources.teacherManifest, dataset.records.map(r => r.input));
    if (dataset.referenceContract && digest(dataset.referenceContract) !== digest(referenceContract)) throw Error('Evaluation full reference contract mismatch');
    if (dataset.sourceRecordsHash !== digest(sources))
        throw Error('Evaluation dataset sources mismatch');
    if (digest(readFileSync(join(directory, 'decode-model.bin'))) !== decode.modelHash)
        throw Error('Decode model commitment mismatch');
    if (!decode.modelHash || !decode.cursor)
        throw Error('Decode lacks checkpoint commitment');
    const evaluationDirectory = join(directory, 'evaluation-' + decode.cursor.updates);
    mkdirSync(evaluationDirectory, { recursive: true });
    const pairs = [];
    for (const record of dataset.records) {
        const generated = decode.reports.find(r => r.familyId === record.familyId);
        if (!generated)
            throw Error('Missing family in decode report');
        const source = sources.records.find(r => digest(r.outcome) === record.teacherRecordHash);
        if (!source)
            throw Error('Missing exact teacher evidence');
        for (const seed of [record.input.options.seed, (record.input.options.seed + 1) >>> 0])
            for (const maxStepHours of [.25, .125]) {
                const pair = { referenceContract, familyId: record.familyId, seed, maxStepHours, modelHash: decode.modelHash, sourceHash: manifest.provenance.sourceHash, neural: null, baseline: null };
                for (const side of ['neural', 'baseline']) {
                    if (signal?.aborted) {
                        pair[side] = { status: 'cancelled', score: null };
                        continue;
                    }
                    if (side === 'neural' && !generated.complete) {
                        pair.neural = { status: 'invalid-decode', score: null, diagnostics: generated.diagnostics };
                        continue;
                    }
                    const workspace = side === 'neural' ? generated.workspace : source.outcome.result.result.workspace, job = { mode: 'evaluate', input: record.input, workspace, seed, maxStepHours }, name = `${record.familyId}-${seed}-${maxStepHours}-${side}`, path = join(evaluationDirectory, name + '.json');
                    // Completed evidence may be reused only for byte-identical job and frozen model/source.
                    const binding = { referenceContract, jobHash: digest(job), bundleHash: manifest.provenance.bundleHash, modelHash: decode.modelHash };
                    let artifact;
                    if (existsSync(path)) {
                        artifact = read(path);
                        if (digest(artifact.binding) !== digest(binding))
                            throw Error('Evaluation resume mismatch');
                    }
                    else {
                        const outcome = await runWorker(bundle, job, { timeoutMs, signal, stderrPath: join(evaluationDirectory, name + '.stderr.jsonl') });
                        artifact = { binding, job, outcome, score: outcome.status === 'completed' && outcome.result?.completed ? outcome.result.score : null };
                        atomic(path, artifact);
                    }
                    pair[side] = { status: artifact.outcome.status, score: artifact.score, completed: artifact.outcome.result?.completed ?? false, result: artifact.outcome.result?.result ?? null, artifactHash: digest(artifact), artifactPath: path, settings: artifact.outcome.result?.settings ?? job };
                }
                pairs.push(pair);
                atomic(join(evaluationDirectory, 'summary.json'), { scope: 'EXPOSED DEVELOPMENT ONLY; NOT PARITY', modelHash: decode.modelHash, pairs, parity: false });
            }
    }
    return { scope: 'EXPOSED DEVELOPMENT ONLY; NOT PARITY', modelHash: decode.modelHash, pairs, parity: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2])
        throw Error('Usage: node scripts/neural/full-training/evaluate.mjs TRAINING_RUN_DIRECTORY [timeoutMs]');
    console.log(JSON.stringify(await evaluateFreeRunning(resolve(process.argv[2]), { timeoutMs: Number(process.argv[3] ?? 120000) })));
}
