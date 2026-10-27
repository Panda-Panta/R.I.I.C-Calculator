import {POLICY_FORK_ID,POLICY_FORK_MODE,POLICY_FORK_SOURCE_TRANSITION} from './full-training/aligned-policy-fork-contract.mjs';
import { referenceManifestContract } from './full-baseline/reference-protocol.mjs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyTeacherSourceCompatibility, STAFFING_SOURCE_TRANSITION, LATEST_POLICY_TRANSITIONS, isLatestPolicyMode } from './full-training/source-compatibility.mjs';
import { prepareProducerReplay } from './full-training/producer-replay.mjs';
import {ALIGNED_CONTINUATION_ID,GROUP_COVER_SOURCE_TRANSITION} from './full-training/aligned-continuation-contract.mjs';
import {FEATURE_MIGRATION_ID,ALIGNED_SOURCE_TRANSITION} from './full-training/feature-migration-contract.mjs';
import {FULL_UNION_KIND,validateFullUnionDefinition,composeFullTrainingUnion,fullUnionDatasetContract} from './full-training/full-union-contract.mjs';
import { mergeLinkedAuxiliarySources } from './full-training/linked-sources.mjs';
import { initializationSpec, captureLineage, verifyInitialization } from './full-training/lineage.mjs';
import { atomic, digest, verifyBinding } from './full-training/state.mjs';
import { runWorker, assertPriorWorkerStopped, acquireControllerLock } from './full-training/process.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), read = p => JSON.parse(readFileSync(p, 'utf8'));
export async function freezeTrainingBundle(directory) {
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), sourceHashes = {}, snapshots = {};
    for (const key of ['scripts/neural/full-train.mjs', 'scripts/neural/full-training/process.mjs', 'scripts/neural/full-training/supervisor.mjs', 'scripts/neural/full-training/lineage.mjs', 'scripts/neural/full-training/evaluate.mjs', 'scripts/neural/full-training/linked-sources.mjs', 'scripts/neural/full-training/source-compatibility.mjs', 'scripts/neural/full-training/producer-replay.mjs']) {
        const contents = readFileSync(join(root, key), 'utf8');
        sourceHashes[key] = digest(contents);
        snapshots[key] = contents;
    }
    const bundle = join(directory, 'worker.mjs');
    await build({ entryPoints: [join(root, 'scripts/neural/full-train-worker.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'warning', plugins: [{ name: 'freeze-imports', setup(b) { b.onLoad({ filter: /\.(ts|json|mjs)$/ }, args => { const contents = readFileSync(args.path, 'utf8'), key = relative(root, args.path).replaceAll('\\', '/'); sourceHashes[key] = digest(contents); snapshots[key] = contents; return { contents, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith('.ts') ? 'ts' : 'js' }; }); } }] });
    const provenance = { sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a < b ? -1 : 1)), bundleHash: digest(readFileSync(bundle)), gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
    provenance.sourceHash = digest(provenance.sourceHashes);
    verifySources(provenance);
    atomic(join(directory, 'source-snapshot.json'), snapshots);
    return provenance;
}
function verifySources(provenance) {
    for (const [key, hash] of Object.entries(provenance.sourceHashes))
        if (digest(readFileSync(join(root, key))) !== hash)
            throw Error('Source mismatch: ' + key);
}
export function collectSources(sourceDirectory, purpose, trainingProvenance, teacherKind = 'full-optimizer', sourceTransition = 'none') {
    const manifest = read(join(sourceDirectory, 'manifest.json')), checkpointPath = join(sourceDirectory, 'checkpoint.json'), checkpoint = existsSync(checkpointPath) ? read(checkpointPath) : { cases: {} }, records = [], pending = [];
    if (!['full-optimizer', 'molecular-simulated'].includes(teacherKind))
        throw Error('Unknown explicit teacher kind');
    if (teacherKind === 'molecular-simulated' && (purpose !== 'train' || manifest.sourceKind !== 'molecular-simulated' || manifest.purpose !== 'training'))
        throw Error('Auxiliary source requires explicit molecular-simulated TRAIN authorization');
    if (teacherKind === 'full-optimizer' && manifest.sourceKind && manifest.sourceKind !== 'full-optimizer')
        throw Error('Auxiliary sources cannot substitute for full optimizer teachers');
    if (checkpoint.manifestHash && checkpoint.manifestHash !== digest(manifest))
        throw Error('Teacher checkpoint/manifest mismatch');
    const sourceCompatibility = verifyTeacherSourceCompatibility(manifest.provenance, trainingProvenance, sourceTransition);
    for (const c of manifest.cases) {
        const input = read(join(sourceDirectory, c.familyId + '.input.json'));
        if (digest(input) !== c.inputHash)
            throw Error('Teacher input changed: ' + c.familyId);
        if (teacherKind === 'full-optimizer') referenceManifestContract(manifest, [input]);
        const attempts = checkpoint.cases[c.familyId] ?? [];
        if (!attempts.length)
            pending.push({ familyId: c.familyId, status: 'not-started' });
        for (const attempt of attempts) {
            if (!attempt.resultPath) {
                pending.push({ familyId: c.familyId, status: attempt.status, attempt: attempt.attempt });
                continue;
            }
            const path = resolve(root, attempt.resultPath);
            if (!path.startsWith(sourceDirectory + '/'))
                throw Error('Teacher result outside source directory');
            const outcome = read(path);
            if (digest(outcome) !== attempt.resultHash)
                throw Error('Teacher result hash mismatch');
            records.push({ input, outcome, attempt: attempt.attempt, resultPath: attempt.resultPath, resultHash: attempt.resultHash });
        }
    }
    // Multiple successful outputs for a family require an explicit selection policy, not accidental duplicate weighting.
    const counts = new Map();
    for (const r of records)
        if (r.outcome.completed) {
            const n = (counts.get(r.input.familyId) ?? 0) + 1;
            counts.set(r.input.familyId, n);
            if (n > 1)
                throw Error('Conflicting completed teacher attempts: ' + r.input.familyId);
        }
    const referenceContract = teacherKind === 'full-optimizer' ? referenceManifestContract(manifest, records.map(r => r.input)) : null;
    return { schemaVersion: 3, referenceContract, purpose, teacherKind, sourceCompatibility, teacherManifest: manifest, teacherManifestHash: digest(manifest), records, pending };
}
export function sourceContracts(sources) {
    const contract = (manifest, compatibility) => ({ manifestHash: digest(manifest), producerSourceHash: manifest.provenance.sourceHash, producerBundleHash: manifest.provenance.bundleHash, inputProfile: manifest.inputProfile ?? 'actual-mixture-v1', ...(manifest.sourceKind === 'molecular-simulated' ? {} : { reference: referenceManifestContract(manifest) }), compatibility });
    if(sources.kind===FULL_UNION_KIND)return {kind:FULL_UNION_KIND,union:fullUnionDatasetContract(sources),members:sources.members.map((member,index)=>({index,...contract(member.sources.teacherManifest,member.sources.sourceCompatibility),producerReplayProofHash:digest(member.sources.producerReplay),sourceRecordsHash:digest(member.sources)}))};
    return { ...(sources.producerReplay ? { producerReplayProofHash: digest(sources.producerReplay) } : {}), primary: contract(sources.teacherManifest, sources.sourceCompatibility), linked: (sources.linkedSourceManifests ?? []).map((m, i) => contract(m, sources.linkedSourceCompatibilities?.[i])) };
}
export async function collectFullUnionSources(definitionPath,directory,provenance,sourceTransition,sourceName,timeoutMs){
    const definition=validateFullUnionDefinition(read(definitionPath));
    if(definition.name!==sourceName)throw Error('Full union source name/definition mismatch');
    const rawRoot=join(root,'training_data/neural-full-v2'),members=[];
    mkdirSync(join(directory,'producer-replay'),{recursive:false,mode:0o700});
    for(const[index,item]of definition.members.entries()){
        const producerDirectory=resolve(item.producerReplayDirectory);
        if(![join(root,'artifacts/neural')+'/',join(rawRoot,'training-runs')+'/'].some(prefix=>producerDirectory.startsWith(prefix)))throw Error('Full union producer replay directory outside declared repository artifact roots');
        const sourceDirectory=join(rawRoot,item.source),sources=collectSources(sourceDirectory,'train',provenance,'full-optimizer',sourceTransition);
        sources.producerReplay=await prepareProducerReplay({producerDirectory,directory:join(directory,'producer-replay','member-'+index),sources,trainingProvenance:provenance,sourceTransition,timeoutMs});
        members.push({directory:sourceDirectory,sources,checkpoint:read(join(sourceDirectory,'checkpoint.json')),inputs:sources.teacherManifest.cases.map(c=>read(join(sourceDirectory,c.familyId+'.input.json')))});
    }
    const excludedCohorts=definition.excludedSources.map(name=>{const sourceDirectory=join(rawRoot,name),manifest=read(join(sourceDirectory,'manifest.json'));return {directory:sourceDirectory,manifest,manifestHash:digest(manifest),inputs:manifest.cases.map(c=>read(join(sourceDirectory,c.familyId+'.input.json')))};});
    return composeFullTrainingUnion(members,{definition,excludedCohorts,trainingProvenance:provenance,sourceTransition});
}
export function parseFullTrainingOptions(args) {
    const out = { source: 'pilot-20261027', run: '', purpose: 'dev-overfit', 'budget-ms': '120000', 'epochs': '10', 'chunk-size': '128', 'hidden-size': '64', seed: '43', 'learning-rate': '.03', optimizer: 'sgd-v1', 'teacher-kind': 'full-optimizer', 'linked-retry': '', 'construction-order': 'legacy-v1', 'input-profile': 'actual-mixture-v1', 'source-transition': 'none', 'policy-mode': 'legacy-unconstrained-v1', 'producer-replay-run': '', 'full-source-union':'', 'fork-from': '', 'fresh-from': '', 'migrate-from':'', 'feature-migration':'', 'continue-from':'', 'continuation-id':'', 'init-reason': '', 'policy-fork-from':'', 'policy-fork-id':'' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--resume') {
            out.resume = true;
            continue;
        }
        const key = args[i].slice(2);
        if (!args[i].startsWith('--') || !Object.hasOwn(out, key) || args[i + 1] === undefined)
            throw Error('Invalid option ' + args[i]);
        out[key] = args[++i];
    }
    if (!out.run || ![out.run, out.source].every(x => /^[\w-]+$/.test(x)))
        throw Error('Safe --run and --source names required');
    if (!['full-optimizer', 'molecular-simulated'].includes(out['teacher-kind']) || (out['teacher-kind'] === 'molecular-simulated' && out.purpose !== 'train'))
        throw Error('Explicit auxiliary teacher-kind requires purpose train');
    if (out['linked-retry'] && (out['teacher-kind'] !== 'molecular-simulated' || !/^[\w-]+(?:\/[\w-]+)*$/.test(out['linked-retry']) || !out['linked-retry'].startsWith(out.source + '/retries/')))
        throw Error('Linked retry must be an explicit nested retry of the auxiliary source');
    if (!['none', STAFFING_SOURCE_TRANSITION, ...Object.keys(LATEST_POLICY_TRANSITIONS)].includes(out['source-transition'])) throw Error('Unknown source transition');
    if (out['policy-mode'] !== 'legacy-unconstrained-v1' && !isLatestPolicyMode(out['policy-mode'])) throw Error('Unknown policy mode');
    if (out['source-transition'] === STAFFING_SOURCE_TRANSITION && (out['construction-order'] !== 'staffing-first-v1' || out['teacher-kind'] !== 'molecular-simulated' || out['policy-mode'] !== 'legacy-unconstrained-v1')) throw Error('Legacy source transition requires explicit staffing-first auxiliary mode');
    if (isLatestPolicyMode(out['policy-mode']) || Object.hasOwn(LATEST_POLICY_TRANSITIONS, out['source-transition'])) {
        if (out['construction-order'] !== 'staffing-first-v1' || out['teacher-kind'] !== 'full-optimizer') throw Error('Latest policy transition requires staffing-first full-optimizer mode');
        if (LATEST_POLICY_TRANSITIONS[out['source-transition']] !== out['policy-mode']) throw Error('Latest policy mode and source transition must be explicit together');
        if (!out['full-source-union']&&!/^[\w-]+$/.test(out['producer-replay-run'])) throw Error('Latest policy transition requires explicit safe producer replay run');
    } else if (out['producer-replay-run']) throw Error('Producer replay run requires latest policy transition');
    if(out['full-source-union']){
        if(!isLatestPolicyMode(out['policy-mode'])||out.purpose!=='train'||out['teacher-kind']!=='full-optimizer'||out['linked-retry']||out['producer-replay-run'])throw Error('Full union requires explicit independent latest TRAIN member proofs, not primary/auxiliary retry');
        out['full-source-union']=resolve(root,out['full-source-union']);
        if(!out['full-source-union'].startsWith(root+'/')||!out['full-source-union'].endsWith('.json'))throw Error('Full union definition must be explicit repository JSON');
    }
    if(out['policy-fork-from']||out['policy-fork-id']||out['source-transition']===POLICY_FORK_SOURCE_TRANSITION){
        if(out['policy-fork-id']!==POLICY_FORK_ID||out['source-transition']!==POLICY_FORK_SOURCE_TRANSITION||out['policy-mode']!==POLICY_FORK_MODE||out['feature-migration']!==FEATURE_MIGRATION_ID||out.purpose!=='train'||!out['full-source-union']||out['fork-from']||out['fresh-from']||out['migrate-from']||out['continue-from']||out['continuation-id']||(!out.resume&&!/^[\w-]+$/.test(out['policy-fork-from'])))throw Error('Policy fork requires exclusive named initialization/source/union contract');
        initializationSpec(out);
    }else if(out['continue-from']||out['continuation-id']||out['source-transition']===GROUP_COVER_SOURCE_TRANSITION){
        if(out['continuation-id']!==ALIGNED_CONTINUATION_ID||out['source-transition']!==GROUP_COVER_SOURCE_TRANSITION||out['feature-migration']!==FEATURE_MIGRATION_ID||out.purpose!=='train'||!out['full-source-union']||out['fork-from']||out['fresh-from']||out['migrate-from']||(!out.resume&&!/^[\w-]+$/.test(out['continue-from'])))throw Error('Aligned continuation requires exclusive continue-from and explicit inherited migration/source/union contract');
        initializationSpec(out);
    }else if(out['feature-migration']||out['migrate-from']||out['source-transition']===ALIGNED_SOURCE_TRANSITION){
        if(out['feature-migration']!==FEATURE_MIGRATION_ID||out['source-transition']!==ALIGNED_SOURCE_TRANSITION||out.purpose!=='train'||out['fork-from']||out['fresh-from']||(!out.resume&&!/^[\w-]+$/.test(out['migrate-from'])))throw Error('Feature migration requires explicit paired source contract and exclusive migrate-from TRAIN initialization');
        initializationSpec(out);
    }
    if (!['actual-mixture-v1', 'TRAIN-enriched-catalog-high-stage-v1'].includes(out['input-profile']) || (out['input-profile'] !== 'actual-mixture-v1' && out['teacher-kind'] !== 'molecular-simulated'))
        throw Error('Invalid explicit auxiliary input profile');
    if (!['legacy-v1', 'staffing-first-v1'].includes(out['construction-order']))
        throw Error('Invalid construction order');
    if (!['train', 'dev-overfit'].includes(out.purpose))
        throw Error('Invalid purpose');
    for (const key of ['budget-ms', 'epochs', 'chunk-size', 'hidden-size', 'seed']) {
        out[key] = Number(out[key]);
        if (!Number.isSafeInteger(out[key]) || out[key] < 0)
            throw Error('Invalid ' + key);
    }
    if (out['budget-ms'] < 100 || out['chunk-size'] < 1 || out['chunk-size'] > 2048 || out['hidden-size'] < 1 || out['hidden-size'] > 256 || out.epochs > 100000 || out.seed > 0xffffffff)
        throw Error('Invalid bounds');
    if (!['sgd-v1', 'common-l2-sgd-v1'].includes(out.optimizer))
        throw Error('Invalid optimizer');
    out['learning-rate'] = Number(out['learning-rate']);
    if (!(out['learning-rate'] > 0 && out['learning-rate'] <= 10))
        throw Error('Invalid learning rate');
    if(out['policy-fork-id']&& (out['learning-rate']!==.003||out.optimizer!=='common-l2-sgd-v1'||out['hidden-size']!==64||out.seed!==43||out['chunk-size']!==512))throw Error('Policy fork supports only declared .003/common-l2/64/43/512 settings');
    return out;
}
export function fullTrainingConfig(o) { return { source: o.source, purpose: o.purpose, chunkSize: o['chunk-size'], hiddenSize: o['hidden-size'], seed: o.seed, learningRate: o['learning-rate'], optimizer: o.optimizer, teacherKind: o['teacher-kind'], constructionOrder: o['construction-order'], inputProfile: o['input-profile'], sourceTransition: o['source-transition'], ...(o['linked-retry'] ? { linkedRetry: o['linked-retry'] } : {}), policyMode: o['policy-mode'], ...(o['producer-replay-run'] ? { producerReplayRun: o['producer-replay-run'] } : {}),...(o['feature-migration']?{featureMigration:o['feature-migration']}:{}),...(o['continuation-id']?{continuationId:o['continuation-id']}:{}),...(o['policy-fork-id']?{policyForkId:o['policy-fork-id']}:{}),...(o['full-source-union']?{fullSourceUnion:o['full-source-union']}:{}) }; }
export async function main(args = process.argv.slice(2)) {
    if (args.includes('--help')) {
        console.log('node scripts/neural/full-train.mjs --source pilot-20261027 --run NAME --purpose dev-overfit --budget-ms 120000 --epochs 10 [--resume]\nAdditional: --chunk-size 128 --hidden-size 64 --seed 43 --learning-rate .03 --optimizer sgd-v1|common-l2-sgd-v1. Epochs is absolute target; wall budget applies per invocation. DEV overfit never promotes a model. Resume requires exact dataset/source/feature/numerical settings; increasing epochs/budget is allowed. Create CANCEL in run directory for cooperative cancellation, remove before resume. Status and binary checkpoints are under training_data/neural-full-v2/training-runs/NAME. No automatic teacher or fallback in inference.\nNew experiments: --fork-from RUN --init-reason TEXT preserves exact parameters/cumulative updates but resets outer curriculum to epoch0; --fresh-from RUN --init-reason TEXT records a justified fresh initialization. Feature mismatch forbids fork. Original runs are never modified.\nAuxiliary TRAIN only: --teacher-kind molecular-simulated --purpose train. Requires explicit manifest sourceKind/purpose and completed candidate evidence; never accepted as full baseline/parity. Optional --linked-retry SOURCE/retries/NAME explicitly unions a same-input failed-family retry with verified parent lineage; requires a new dataset phase. --construction-order legacy-v1|staffing-first-v1 binds the explicit decoding/training trace protocol. --source-transition legacy-action-replay-to-staffing-first-v1 permits only four declared action/replay module drifts with independent legacy proof; all other shared sources remain exact. --input-profile TRAIN-enriched-catalog-high-stage-v1 explicitly authorizes enriched TRAIN metadata. Latest full-reference phases require paired --policy-mode latest-warmup-exhaustion-v1 --source-transition latest-default-to-warmup-policy-v1, or --policy-mode latest-warmup-runorder-v2 --source-transition latest-default-to-warmup-runorder-v2 --producer-replay-run ORIGINAL_PREPARED_RUN and staffing-first-v1; independently replay original frozen full targets before exact new-policy inversion.');
        console.log('Explicit aligned policy/curriculum fork: --policy-fork-from IMMUTABLE_PHASE10 --policy-fork-id aligned-policy-curriculum-fork-v1; exact learned parent bytes, .003 LR, V4 and complete ordered TRAIN40 only. Not resume/remigration.');
        console.log('Same-aligned continuation: --continue-from STOPPED_TRAIN_RUN --continuation-id aligned-union-native-cover-continuation-v1 --policy-mode latest-native-group-cover-v3 --source-transition latest-default-to-aligned-group-cover-v4 plus inherited --feature-migration and complete --full-source-union. Exact learned binary and numerical settings retained; only outer curriculum resets. No repeat zero migration.');
        console.log('Aligned migration: --migrate-from TRAIN_RUN --feature-migration input-conf-to-slot-group-alignment-zero-v1 --source-transition latest-default-to-aligned-warmup-runorder-v3. Ordinary fork remains feature-exact. Optional --full-source-union REPOSITORY_JSON binds independent full TRAIN members and per-member original replay; it cannot combine with auxiliary retry or primary producer-replay-run.');
        return;
    }
    const o = parseFullTrainingOptions(args), directory = join(root, 'training_data/neural-full-v2/training-runs', o.run), reports = join(root, 'artifacts/neural/full-training', o.run), manifestPath = join(directory, 'manifest.json');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(reports, { recursive: true });
    const instanceId = randomUUID(), lock = acquireControllerLock(directory, instanceId);
    const controller = new AbortController();
    let killTimer;
    const cancel = () => { writeFileSync(join(directory, 'CANCEL'), 'cancel requested\n'); killTimer ??= setTimeout(() => controller.abort(), 10000); };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        assertPriorWorkerStopped(join(directory, 'worker-owner.json'));
        let manifest;
        if (existsSync(manifestPath)) {
            if (!o.resume)
                throw Error('Existing run requires --resume');
            manifest = read(manifestPath);
            if (manifest.lineage) {
                verifyBinding(manifest.lineage.spec, initializationSpec(o, manifest.lineage.spec));
                verifyBinding(read(join(directory, 'lineage.json')), manifest.lineage);
            }
            else if (o['fork-from'] || o['fresh-from'] || o['migrate-from'] || o['feature-migration'] || o['continue-from'] || o['continuation-id'] || o['init-reason'] || o['policy-fork-from'] || o['policy-fork-id'])
                throw Error('Cannot change existing initialization');
            verifyBinding(manifest.config, fullTrainingConfig(o));
            verifySources(manifest.provenance);
            if (digest(readFileSync(join(directory, 'worker.mjs'))) !== manifest.provenance.bundleHash)
                throw Error('Frozen bundle mismatch');
        }
        else {
            if (o.resume)
                throw Error('No manifest to resume');
            const lineage = captureLineage(join(root, 'training_data/neural-full-v2/training-runs'), directory, initializationSpec(o), o.purpose);
            manifest = { schemaVersion: 2, lineage, config: fullTrainingConfig(o), createdUtc: new Date().toISOString(), provenance: await freezeTrainingBundle(directory),...(o['full-source-union']?{fullSourceUnionDefinitionHash:digest(validateFullUnionDefinition(read(o['full-source-union'])))}:{}) };
            atomic(manifestPath, manifest);
        }
        if(o['full-source-union']&&manifest.fullSourceUnionDefinitionHash!==digest(validateFullUnionDefinition(read(o['full-source-union']))))throw Error('Full union definition changed after phase freeze');
        const bundle = join(directory, 'worker.mjs'), run = job => runWorker(bundle, job, { timeoutMs: o['budget-ms'] + 30000, signal: controller.signal, stderrPath: join(directory, 'worker-progress.jsonl'), ownerPath: join(directory, 'worker-owner.json'), instanceId });
        if (!existsSync(join(directory, 'checkpoint.json'))) {
            const sourceDirectory = join(root, 'training_data/neural-full-v2', o.source);
            let sources = o['full-source-union']?await collectFullUnionSources(o['full-source-union'],directory,manifest.provenance,o['source-transition'],o.source,o['budget-ms']+30000):collectSources(sourceDirectory, o.purpose, manifest.provenance, o['teacher-kind'], o['source-transition']);
            if (o['linked-retry'])
                sources = mergeLinkedAuxiliarySources(sources, collectSources(join(root, 'training_data/neural-full-v2', o['linked-retry']), o.purpose, manifest.provenance, o['teacher-kind'], o['source-transition']), read(join(sourceDirectory, 'checkpoint.json')));
            if (sources.kind!==FULL_UNION_KIND&&sources.sourceCompatibility.producerReplayProofRequired) sources.producerReplay = await prepareProducerReplay({ producerDirectory: join(root, 'training_data/neural-full-v2/training-runs', o['producer-replay-run']), directory: join(directory, 'producer-replay'), sources, trainingProvenance: manifest.provenance, sourceTransition: o['source-transition'], timeoutMs: o['budget-ms'] + 30000 });
            manifest.sourceContracts = sourceContracts(sources);
            atomic(manifestPath, manifest);
            atomic(join(directory, 'source-records.json'), sources);
            const prepared = await run({ mode: 'prepare', directory, purpose: o.purpose, teacherKind: o['teacher-kind'], constructionOrder: o['construction-order'], policyMode: o['policy-mode'], inputProfile: o['input-profile'], sourceTransition: o['source-transition'], ...(o['feature-migration']?{featureMigration:o['feature-migration']}:{}), ...(o['policy-fork-id']?{policyForkId:o['policy-fork-id']}:{}), ...(o['linked-retry'] ? { linkedRetry: o['linked-retry'] } : {}) });
            atomic(join(directory, 'preparation.json'), prepared);
            if (prepared.status !== 'completed' || prepared.result.status !== 'dataset-ready') {
                const status = { ...prepared.result, workerStatus: prepared.status, parity: false, updatedUtc: new Date().toISOString() };
                atomic(join(directory, 'status.json'), status);
                atomic(join(reports, 'status.json'), status);
                console.log(JSON.stringify(status));
                return;
            }
        }
        if (manifest.sourceContracts)
            verifyBinding(manifest.sourceContracts, sourceContracts(read(join(directory, 'source-records.json'))));
        const dataset = read(join(directory, 'dataset.json')), binding = { datasetHash: digest(dataset), sourceHash: manifest.provenance.sourceHash, bundleHash: manifest.provenance.bundleHash, featureManifestHash: dataset.featureManifestHash, ...manifest.config, ...(manifest.lineage ? { lineageHash: digest(manifest.lineage) } : {}) };
        if (manifest.lineage)
            verifyInitialization(manifest.lineage, binding);
        const outcome = await run({ mode: 'train', directory, binding, epochs: o.epochs, budgetMs: o['budget-ms'], deadlineUtcMs: Date.now() + o['budget-ms'], chunkSize: o['chunk-size'] });
        atomic(join(directory, 'invocation-latest.json'), outcome);
        const status = existsSync(join(directory, 'status.json')) ? read(join(directory, 'status.json')) : {};
        atomic(join(reports, 'status.json'), { ...status, workerOutcome: outcome.status, parity: false });
        console.log(JSON.stringify({ ...outcome, status: outcome.result?.status ?? outcome.status }));
    }
    finally {
        if (killTimer)
            clearTimeout(killTimer);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        assertPriorWorkerStopped(join(directory, 'worker-owner.json'));
        unlinkSync(lock);
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
