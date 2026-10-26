/** Explicit new experiment initialization; never weakens exact-resume bindings. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectCheckpoint, digest, atomic, verifyBinding } from './state.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
export function initializationSpec(options, previous) {
    const fork = options['fork-from'], fresh = options['fresh-from'], reason = options['init-reason'];
    if (fork && fresh)
        throw Error('Choose fork-from OR fresh-from');
    if (!fork && !fresh && !reason && previous)
        return previous;
    if ((fork || fresh) && (!/^[\w-]+$/.test(fork || fresh) || !reason?.trim()))
        throw Error('Explicit safe parent run and nonempty init-reason required');
    if (reason?.length > 2048)
        throw Error('Initialization reason too long');
    return { mode: fork ? 'fork' : 'fresh', parentRun: fork || fresh || null, reason: reason?.trim() || 'initial run' };
}
export function captureLineage(runsDirectory, directory, spec, purpose) {
    const lineage = { schemaVersion: 1, spec, parent: null, initialModelHash: null };
    if (spec.parentRun) {
        const parentDirectory = join(runsDirectory, spec.parentRun);
        if (parentDirectory === directory)
            throw Error('Cannot initialize from the same run');
        if (existsSync(join(parentDirectory, 'run.lock')))
            throw Error('Parent run must be stopped before taking an initialization snapshot');
        const manifest = read(join(parentDirectory, 'manifest.json')), dataset = read(join(parentDirectory, 'dataset.json')), checkpoint = inspectCheckpoint(parentDirectory);
        if (!checkpoint)
            throw Error('Parent has no committed model');
        if (!['train', 'dev-overfit'].includes(manifest.config.purpose))
            throw Error('Unsupported parent purpose');
        if (spec.mode === 'fork' && purpose === 'train' && manifest.config.purpose !== 'train')
            throw Error('Cannot promote dev-overfit parameters into training');
        const binding = checkpoint.state.binding;
        for (const [key, value] of Object.entries({ datasetHash: digest(dataset), sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, featureManifestHash: dataset.featureManifestHash, ...manifest.config }))
            verifyBinding(binding[key], value);
        if (manifest.lineage)
            verifyBinding(binding.lineageHash, digest(manifest.lineage));
        if (digest(readFileSync(join(parentDirectory, 'worker.mjs'))) !== manifest.provenance.bundleHash)
            throw Error('Parent bundle mismatch');
        if (spec.mode === 'fork' && (checkpoint.state.cursor.family !== 0 || checkpoint.state.cursor.action !== 0))
            throw Error('Fork requires a committed outer epoch boundary; exact resume partial work first');
        lineage.parent = { run: spec.parentRun, manifestHash: digest(manifest), modelHash: checkpoint.state.modelHash, sourceHash: binding.sourceHash, bundleHash: binding.bundleHash, datasetHash: binding.datasetHash, featureManifestHash: binding.featureManifestHash, purpose: manifest.config.purpose, optimizer: manifest.config.optimizer ?? 'sgd-v1', teacherKind: manifest.config.teacherKind ?? 'legacy-full-optimizer', constructionOrder: manifest.config.constructionOrder ?? 'legacy-v1', inputProfile: manifest.config.inputProfile ?? 'actual-mixture-v1', cursor: checkpoint.state.cursor, generation: checkpoint.generation };
        if (spec.mode === 'fork') {
            lineage.initialModelHash = checkpoint.state.modelHash;
            writeFileSync(join(directory, 'initial-model.bin'), checkpoint.bytes, { mode: 0o600 });
        }
        atomic(join(directory, 'parent-manifest.json'), manifest);
        atomic(join(directory, 'parent-checkpoint.json'), checkpoint.state);
    }
    atomic(join(directory, 'lineage.json'), lineage);
    return lineage;
}
export function verifyInitialization(lineage, binding) {
    if (!lineage || digest(lineage) !== binding.lineageHash)
        throw Error('Initialization lineage mismatch');
    if (lineage.spec.mode === 'fork') {
        if (!lineage.parent || lineage.initialModelHash !== lineage.parent.modelHash)
            throw Error('Missing exact fork parameter commitment');
        if (lineage.parent.featureManifestHash !== binding.featureManifestHash)
            throw Error('Fork feature contract mismatch; explicit fresh initialization required, no silent migration');
        if (binding.purpose === 'train' && lineage.parent.purpose !== 'train')
            throw Error('Cannot promote dev-overfit parameters into training');
    }
    else if (lineage.spec.mode !== 'fresh' || lineage.initialModelHash !== null)
        throw Error('Invalid fresh initialization lineage');
}
