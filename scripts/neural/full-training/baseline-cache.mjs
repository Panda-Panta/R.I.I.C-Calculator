/** Optional exact FULL-DEV baseline reuse; never a source of model-generated candidates. */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { digest } from './state.mjs';
import { verifyTeacherSourceCompatibility } from './source-compatibility.mjs';
import { assertFullBaselineDataset } from './evaluate.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
export async function simulationDependencyPaths(root) { const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })); const result = await build({ stdin: { contents: "export {simulateCandidate} from './src/optimizer/candidateSimulation.ts';", resolveDir: root, sourcefile: 'simulation-contract-entry.ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, metafile: true, logLevel: 'silent' }); return Object.keys(result.metafile.inputs).filter(p => p !== '<stdin>' && p !== 'simulation-contract-entry.ts').sort(); }
export function simulationAdapterHash(snapshot) {
    const source = snapshot['scripts/neural/full-train-worker.ts'];
    if (typeof source !== 'string')
        throw Error('Missing frozen simulation adapter source');
    const start = source.indexOf('export function simulationJob('), end = source.indexOf('\nfunction evaluate(', start);
    if (start < 0 || end < 0)
        throw Error('Unknown simulation adapter boundary');
    // Include evaluate() and the stdin dispatch/output tail, not just job construction.
    return digest(source.slice(start));
}
export function verifyBaselineReuse({ artifact, job, cacheManifest, currentManifest, cacheAdapterHash, currentAdapterHash, physicsPaths }) {
    if (artifact.binding?.jobHash !== digest(job) || digest(artifact.job) !== digest(job))
        throw Error('Baseline cache job/settings/workspace mismatch');
    if (artifact.binding.bundleHash !== cacheManifest.provenance.bundleHash)
        throw Error('Baseline cache bundle mismatch');
    if (artifact.outcome?.status !== 'completed' || artifact.outcome.result?.completed !== true || !Number.isFinite(artifact.score) || artifact.score !== artifact.outcome.result.score)
        throw Error('Baseline cache result is unknown or conflicting');
    if (!cacheAdapterHash || cacheAdapterHash !== currentAdapterHash)
        throw Error('Baseline cache simulation adapter mismatch');
    if (!physicsPaths.length)
        throw Error('Missing transitive simulation source contract');
    const physicsSourceHashes = {};
    for (const path of physicsPaths) {
        const oldHash = cacheManifest.provenance.sourceHashes[path], newHash = currentManifest.provenance.sourceHashes[path];
        if (!oldHash || oldHash !== newHash)
            throw Error('Baseline cache physics source mismatch: ' + path);
        physicsSourceHashes[path] = newHash;
    }
    return { jobHash: digest(job), cacheManifestHash: digest(cacheManifest), currentManifestHash: digest(currentManifest), adapterHash: currentAdapterHash, physicsSourceHashes, artifactHash: digest(artifact), reusedSide: 'baseline-only', score: artifact.score };
}
export async function openBaselineCache(root, cacheDirectory, currentDirectory, currentManifest, referenceContract) {
    if (!referenceContract)
        throw Error('Baseline reuse requires current FULL reference provenance guard');
    const cacheRun = dirname(cacheDirectory), cacheManifest = read(join(cacheRun, 'manifest.json')), cacheData = read(join(cacheRun, 'dataset.json'));
    if (cacheManifest.config?.purpose !== 'dev-overfit')
        throw Error('Baseline reuse requires original FULL DEV reference run');
    assertFullBaselineDataset(cacheData, cacheManifest);
    const cacheSources = read(join(cacheRun, 'source-records.json'));
    if (digest(cacheSources) !== cacheData.sourceRecordsHash || digest(cacheSources.teacherManifest) !== cacheSources.teacherManifestHash)
        throw Error('Cached FULL reference source commitment mismatch');
    const cacheReferenceContract = verifyTeacherSourceCompatibility(cacheSources.teacherManifest.provenance, currentManifest.provenance, currentManifest.config?.sourceTransition ?? 'none');
    if (digest(readFileSync(join(cacheRun, 'worker.mjs'))) !== cacheManifest.provenance.bundleHash)
        throw Error('Original baseline bundle changed');
    const cacheSnapshot = read(join(cacheRun, 'source-snapshot.json')), currentSnapshot = read(join(currentDirectory, 'source-snapshot.json'));
    for (const [manifest, snapshot] of [[cacheManifest, cacheSnapshot], [currentManifest, currentSnapshot]])
        if (digest(snapshot['scripts/neural/full-train-worker.ts']) !== manifest.provenance.sourceHashes['scripts/neural/full-train-worker.ts'])
            throw Error('Frozen adapter snapshot mismatch');
    const physicsPaths = await simulationDependencyPaths(root);
    for (const p of physicsPaths)
        if (digest(readFileSync(join(root, p))) !== currentManifest.provenance.sourceHashes[p])
            throw Error('Current simulation source mismatch: ' + p);
    const cacheAdapterHash = simulationAdapterHash(cacheSnapshot), currentAdapterHash = simulationAdapterHash(currentSnapshot);
    return { name: cacheDirectory, cacheReferenceContract, tryReuse(fileName, job) {
            if (!fileName.endsWith('-baseline.json'))
                throw Error('Only baseline artifacts may be reused');
            const path = join(cacheDirectory, fileName);
            if (!existsSync(path))
                return { hit: false, reason: 'missing-cache-artifact' };
            try {
                const artifact = read(path), proof = verifyBaselineReuse({ artifact, job, cacheManifest, currentManifest, cacheAdapterHash, currentAdapterHash, physicsPaths });
                return { hit: true, path, artifact, proof: { ...proof, currentReferenceContract: referenceContract, cacheReferenceContract } };
            }
            catch (error) {
                return { hit: false, reason: String(error) };
            }
        } };
}
