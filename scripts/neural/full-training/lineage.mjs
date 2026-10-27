import {POLICY_FORK_ID,POLICY_FORK_MODE,POLICY_FORK_SOURCE_TRANSITION,POLICY_FORK_PARENT,capturePolicyForkEvidence} from './aligned-policy-fork-contract.mjs';
/** Explicit new experiment initialization; never weakens exact-resume bindings. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectCheckpoint, digest, atomic, verifyBinding } from './state.mjs';
import {FEATURE_MIGRATION_ID,FEATURE_MIGRATION_CONTRACT,ALIGNED_SOURCE_TRANSITION} from './feature-migration-contract.mjs';
import {ALIGNED_CONTINUATION_ID,GROUP_COVER_SOURCE_TRANSITION,GROUP_COVER_POLICY_MODE} from './aligned-continuation-contract.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
export function initializationSpec(options, previous) {
    const fork = options['fork-from'], fresh = options['fresh-from'], migration=options['migrate-from'],continuation=options['continue-from'],policyFork=options['policy-fork-from'], reason = options['init-reason'];
    if ([fork,fresh,migration,continuation,policyFork].filter(Boolean).length>1)
        throw Error('Choose fork-from OR fresh-from OR migrate-from OR continue-from OR policy-fork-from');
    if (!fork && !fresh && !migration && !continuation && !policyFork && !reason && previous)
        return previous;
    if ((fork || fresh || migration || continuation || policyFork) && (!/^[\w-]+$/.test(fork || fresh || migration || continuation || policyFork) || !reason?.trim()))
        throw Error('Explicit safe parent run and nonempty init-reason required');
    if(policyFork&&options['policy-fork-id']!==POLICY_FORK_ID)throw Error('Explicit policy fork identifier required');
    if(continuation&&options['continuation-id']!==ALIGNED_CONTINUATION_ID)throw Error('Explicit aligned continuation identifier required');
    if(migration&&options['feature-migration']!==FEATURE_MIGRATION_ID)throw Error('Explicit feature migration identifier required');
    if (reason?.length > 2048)
        throw Error('Initialization reason too long');
    return { mode: policyFork?'aligned-policy-fork':continuation?'aligned-continuation':migration?'feature-migration':fork ? 'fork' : 'fresh', parentRun: policyFork||continuation||migration||fork || fresh || null, reason: reason?.trim() || 'initial run',...(migration?{featureMigration:FEATURE_MIGRATION_ID}:{}),...(continuation?{continuationId:ALIGNED_CONTINUATION_ID}:{}),...(policyFork?{policyForkId:POLICY_FORK_ID}:{}) };
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
        if (['fork','feature-migration','aligned-continuation','aligned-policy-fork'].includes(spec.mode) && purpose === 'train' && manifest.config.purpose !== 'train')
            throw Error('Cannot promote dev-overfit parameters into training');
        const binding = checkpoint.state.binding;
        for (const [key, value] of Object.entries({ datasetHash: digest(dataset), sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, featureManifestHash: dataset.featureManifestHash, ...manifest.config }))
            verifyBinding(binding[key], value);
        if (manifest.lineage)
            verifyBinding(binding.lineageHash, digest(manifest.lineage));
        if (digest(readFileSync(join(parentDirectory, 'worker.mjs'))) !== manifest.provenance.bundleHash)
            throw Error('Parent bundle mismatch');
        if (['fork','feature-migration','aligned-continuation','aligned-policy-fork'].includes(spec.mode) && (checkpoint.state.cursor.family !== 0 || checkpoint.state.cursor.action !== 0))
            throw Error('Fork requires a committed outer epoch boundary; exact resume partial work first');
        lineage.parent = { run: spec.parentRun, manifestHash: digest(manifest), modelHash: checkpoint.state.modelHash, sourceHash: binding.sourceHash, bundleHash: binding.bundleHash, datasetHash: binding.datasetHash, featureManifestHash: binding.featureManifestHash, purpose: manifest.config.purpose, optimizer: manifest.config.optimizer ?? 'sgd-v1', teacherKind: manifest.config.teacherKind ?? 'legacy-full-optimizer', constructionOrder: manifest.config.constructionOrder ?? 'legacy-v1', inputProfile: manifest.config.inputProfile ?? 'actual-mixture-v1', cursor: checkpoint.state.cursor, generation: checkpoint.generation };
        if (['fork','feature-migration','aligned-continuation','aligned-policy-fork'].includes(spec.mode)) {
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
        if(spec.mode==='aligned-policy-fork'){
            if(spec.policyForkId!==POLICY_FORK_ID||purpose!=='train')throw Error('Explicit TRAIN policy fork required');
            atomic(join(directory,'parent-feature-manifest.json'),read(join(parentDirectory,'feature-manifest.json')));atomic(join(directory,'parent-dataset.json'),dataset);
            lineage.policyFork=capturePolicyForkEvidence(parentDirectory,directory,checkpoint);
        }
        if(spec.mode==='aligned-continuation'){
            const features=read(join(parentDirectory,'feature-manifest.json')),receipt=read(join(parentDirectory,'feature-migration.json'));
            if(spec.continuationId!==ALIGNED_CONTINUATION_ID||purpose!=='train'||manifest.lineage?.spec.mode!=='feature-migration'||binding.featureManifestHash!==FEATURE_MIGRATION_CONTRACT.newHash||digest(features)!==FEATURE_MIGRATION_CONTRACT.newManifestSha256||checkpoint.state.pendingEvaluation!==null||checkpoint.state.initializationProofHash!==digest(receipt))throw Error('Aligned continuation requires stopped direct migrated TRAIN parent and inherited receipt');
            atomic(join(directory,'parent-feature-manifest.json'),features);atomic(join(directory,'parent-dataset.json'),dataset);
            const inherited=join(directory,'inherited-migration');mkdirSync(inherited,{mode:0o700});
            for(const file of ['manifest.json','lineage.json','dataset.json','source-records.json','source-snapshot.json','feature-manifest.json','feature-migration.json','parent-manifest.json','parent-checkpoint.json','parent-dataset.json','parent-feature-manifest.json','initial-model.bin','migrated-initial-model.bin'])copyFileSync(join(parentDirectory,file),join(inherited,file));
            lineage.continuation={id:ALIGNED_CONTINUATION_ID,parentFeatureManifestHash:digest(features),parentNumericalConfig:Object.fromEntries(['optimizer','learningRate','hiddenSize','seed','chunkSize'].map(key=>[key,manifest.config[key]])),inheritedMigration:{directory:parentDirectory,manifestHash:digest(manifest),lineageHash:digest(manifest.lineage),receiptHash:digest(receipt)}};
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
    else if(lineage.spec.mode==='aligned-policy-fork'){
        const p=lineage.parent,c=FEATURE_MIGRATION_CONTRACT,proof=lineage.policyFork;
        if(lineage.spec.policyForkId!==POLICY_FORK_ID||binding.policyForkId!==POLICY_FORK_ID||!p||p.purpose!=='train'||binding.purpose!=='train'||lineage.initialModelHash!==POLICY_FORK_PARENT.modelHash||p.modelHash!==POLICY_FORK_PARENT.modelHash||p.cursor?.updates!==248335||p.manifestHash!==POLICY_FORK_PARENT.manifestHash||p.featureManifestHash!==c.newHash||binding.featureManifestHash!==c.newHash||binding.featureMigration!==FEATURE_MIGRATION_ID||binding.policyMode!==POLICY_FORK_MODE||binding.sourceTransition!==POLICY_FORK_SOURCE_TRANSITION||binding.continuationId||proof?.id!==POLICY_FORK_ID||proof.parentFeatureManifestHash!==c.newManifestSha256||proof.parentContinuationHash!==POLICY_FORK_PARENT.continuationHash||proof.inheritedMigrationHash!==POLICY_FORK_PARENT.migrationHash)throw Error('Policy fork lineage/selected parent/feature contract mismatch');
        for(const[k,v]of Object.entries({optimizer:'common-l2-sgd-v1',learningRate:.003,hiddenSize:64,seed:43,chunkSize:512}))if(binding[k]!==v||proof.parentNumericalConfig?.[k]!== (k==='learningRate'?.01:v))throw Error('Policy fork numerical delta mismatch');
    }
    else if(lineage.spec.mode==='aligned-continuation'){
        const c=FEATURE_MIGRATION_CONTRACT,p=lineage.parent,proof=lineage.continuation;
        if(lineage.spec.continuationId!==ALIGNED_CONTINUATION_ID||binding.continuationId!==ALIGNED_CONTINUATION_ID||!p||lineage.initialModelHash!==p.modelHash||p.purpose!=='train'||binding.purpose!=='train'||p.featureManifestHash!==c.newHash||binding.featureManifestHash!==c.newHash||binding.featureMigration!==FEATURE_MIGRATION_ID||binding.sourceTransition!==GROUP_COVER_SOURCE_TRANSITION||binding.policyMode!==GROUP_COVER_POLICY_MODE||proof?.id!==ALIGNED_CONTINUATION_ID||proof.parentFeatureManifestHash!==c.newManifestSha256||proof.inheritedMigration?.manifestHash!==p.manifestHash||!(/^[a-f0-9]{64}$/.test(proof.inheritedMigration?.receiptHash??'')))throw Error('Aligned continuation lineage/feature/migration contract mismatch');
        for(const key of ['optimizer','learningRate','hiddenSize','seed','chunkSize'])if(proof.parentNumericalConfig?.[key]===undefined||digest(proof.parentNumericalConfig[key])!==digest(binding[key]))throw Error('Aligned continuation numerical settings mismatch');
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
