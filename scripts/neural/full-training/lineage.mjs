/** Explicit new experiment initialization; never weakens exact-resume bindings. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectCheckpoint, digest, atomic, verifyBinding } from './state.mjs';
import {FEATURE_MIGRATION_ID,FEATURE_MIGRATION_CONTRACT,ALIGNED_SOURCE_TRANSITION} from './feature-migration-contract.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
export function initializationSpec(options, previous) {
    const fork = options['fork-from'], fresh = options['fresh-from'], migration=options['migrate-from'], reason = options['init-reason'];
    if ([fork,fresh,migration].filter(Boolean).length>1)
        throw Error('Choose fork-from OR fresh-from OR migrate-from');
    if (!fork && !fresh && !migration && !reason && previous)
        return previous;
    if ((fork || fresh || migration) && (!/^[\w-]+$/.test(fork || fresh || migration) || !reason?.trim()))
        throw Error('Explicit safe parent run and nonempty init-reason required');
    if(migration&&options['feature-migration']!==FEATURE_MIGRATION_ID)throw Error('Explicit feature migration identifier required');
    if (reason?.length > 2048)
        throw Error('Initialization reason too long');
    return { mode: migration?'feature-migration':fork ? 'fork' : 'fresh', parentRun: migration||fork || fresh || null, reason: reason?.trim() || 'initial run',...(migration?{featureMigration:FEATURE_MIGRATION_ID}:{}) };
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
        if (['fork','feature-migration'].includes(spec.mode) && purpose === 'train' && manifest.config.purpose !== 'train')
            throw Error('Cannot promote dev-overfit parameters into training');
        const binding = checkpoint.state.binding;
        for (const [key, value] of Object.entries({ datasetHash: digest(dataset), sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, featureManifestHash: dataset.featureManifestHash, ...manifest.config }))
            verifyBinding(binding[key], value);
        if (manifest.lineage)
            verifyBinding(binding.lineageHash, digest(manifest.lineage));
        if (digest(readFileSync(join(parentDirectory, 'worker.mjs'))) !== manifest.provenance.bundleHash)
            throw Error('Parent bundle mismatch');
        if (['fork','feature-migration'].includes(spec.mode) && (checkpoint.state.cursor.family !== 0 || checkpoint.state.cursor.action !== 0))
            throw Error('Fork requires a committed outer epoch boundary; exact resume partial work first');
        lineage.parent = { run: spec.parentRun, manifestHash: digest(manifest), modelHash: checkpoint.state.modelHash, sourceHash: binding.sourceHash, bundleHash: binding.bundleHash, datasetHash: binding.datasetHash, featureManifestHash: binding.featureManifestHash, purpose: manifest.config.purpose, optimizer: manifest.config.optimizer ?? 'sgd-v1', teacherKind: manifest.config.teacherKind ?? 'legacy-full-optimizer', constructionOrder: manifest.config.constructionOrder ?? 'legacy-v1', inputProfile: manifest.config.inputProfile ?? 'actual-mixture-v1', cursor: checkpoint.state.cursor, generation: checkpoint.generation };
        if (['fork','feature-migration'].includes(spec.mode)) {
            lineage.initialModelHash = checkpoint.state.modelHash;
            writeFileSync(join(directory, 'initial-model.bin'), checkpoint.bytes, { mode: 0o600 });
        }
        if(spec.mode==='feature-migration'){
            if(spec.featureMigration!==FEATURE_MIGRATION_ID||purpose!=='train'||binding.featureManifestHash!==FEATURE_MIGRATION_CONTRACT.oldHash)throw Error('Feature migration requires exact legacy TRAIN parent contract');
            const legacyManifest=read(join(parentDirectory,'feature-manifest.json'));
            if(digest(legacyManifest)!==FEATURE_MIGRATION_CONTRACT.oldManifestSha256)throw Error('Feature migration parent full manifest mismatch');
            atomic(join(directory,'parent-feature-manifest.json'),legacyManifest);
            atomic(join(directory,'parent-dataset.json'),dataset);
            lineage.featureMigration={id:FEATURE_MIGRATION_ID,parentFeatureManifestHash:digest(legacyManifest),parentNumericalConfig:Object.fromEntries(['optimizer','learningRate','hiddenSize','seed','chunkSize'].map(key=>[key,manifest.config[key]]))};
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
    if (lineage.spec.mode === 'feature-migration') {
        const c=FEATURE_MIGRATION_CONTRACT;
        if(!lineage.parent||lineage.spec.featureMigration!==FEATURE_MIGRATION_ID||lineage.parent.modelHash!==lineage.initialModelHash||lineage.parent.purpose!=='train'||binding.purpose!=='train'||lineage.parent.featureManifestHash!==c.oldHash||binding.featureManifestHash!==c.newHash||binding.featureMigration!==FEATURE_MIGRATION_ID||binding.sourceTransition!==ALIGNED_SOURCE_TRANSITION||lineage.featureMigration?.id!==FEATURE_MIGRATION_ID||lineage.featureMigration.parentFeatureManifestHash!==c.oldManifestSha256)throw Error('Feature migration lineage/feature contract mismatch');
        for(const key of ['optimizer','learningRate','hiddenSize','seed','chunkSize'])if(lineage.featureMigration.parentNumericalConfig?.[key]===undefined||digest(lineage.featureMigration.parentNumericalConfig[key])!==digest(binding[key]))throw Error('Feature migration numerical settings mismatch');
    }
    else if (lineage.spec.mode === 'fork') {
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
