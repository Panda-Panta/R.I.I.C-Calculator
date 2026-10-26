import { enrichedCollection } from './molecular-training/enriched.mjs';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256 } from './provenance.mjs';
import { bounded } from './full-baseline/process.mjs';
import { inventoryCollisions } from './full-baseline/collisions.mjs';
import { auditTradingExclusions } from './full-baseline/semantic-audit.mjs';
import { retryBudget } from './full-baseline/retry.mjs';
import { retryFailed400 } from './molecular-training/retry.mjs';
import { cohort as molecularCases } from './molecular-training/policy.mjs';
import { validateCohort } from './full-baseline/cohort.mjs';
import { publishExclusiveJson } from './full-baseline/atomic.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function atomic(path, value) { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path); }
export function validateResume(manifest, config) { if (sha256(manifest.config) !== sha256(config)) throw Error('Resume configuration mismatch'); }
export async function freezeBundle(directory) {
  const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));
  const sources = {}, snapshots = {};
  const bundle = join(directory, 'worker.mjs');
  await build({ entryPoints: [join(root, 'scripts/neural/molecular-teacher-worker.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, logLevel: 'warning', plugins: [{ name: 'freeze-exact-imports', setup(b) { b.onLoad({ filter: /\.(ts|json|[cm]?js)$/ }, async args => {
    const contents = readFileSync(args.path, 'utf8'), key = relative(root, args.path).replaceAll('\\', '/');
    sources[key] = sha256(contents); snapshots[key] = contents;
    return { contents, loader: args.path.endsWith('.json') ? 'json' : /\.[cm]?js$/.test(args.path) ? 'js' : 'ts' };
  }); } }] });
  for (const [key, hash] of Object.entries(sources)) if (sha256(readFileSync(join(root, key), 'utf8')) !== hash) throw Error('Imported source changed during bundle: ' + key);
  const sourceHashes = Object.fromEntries(Object.entries(sources).sort(([a],[b]) => a.localeCompare(b)));
  atomic(join(directory, 'source-snapshot.json'), snapshots);
  return { sourceHashes, sourceHash: sha256(sourceHashes), bundleHash: sha256(readFileSync(bundle, 'utf8')), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}
export async function main(args = process.argv.slice(2)) {
  if(args.length===1&&['--prepare-enriched','--pilot-enriched','--collect-enriched-all'].includes(args[0]))return enrichedCollection(root,freezeBundle,args[0]==='--prepare-enriched'?'prepare':args[0]==='--pilot-enriched'?'pilot':'all');
  if(args.length===1&&args[0]==='--retry-failed-400')return retryFailed400(root,freezeBundle);
  if(args.includes('--help')) { console.log('Bounded molecular TRAIN targets only. Fixed eight families, branchCount=3, deepSearch=false, cap600000ms/case. --resume skips every existing attempt, no hidden retries.'); return; }
  if(args.some(a=>a!=='--resume'))throw Error('Only --resume supported; cohort, output and protocol fixed');
  const resume=args.includes('--resume'), options={}, retryTimeoutMs=undefined;
  const run='molecular-training-20261030', cohort={purpose:'training',namespace:'20261030',sourceKind:'molecular-simulated',cases:molecularCases};
  const config={run,sourceKind:'molecular-simulated',purpose:'training',timeoutMs:600000,concurrency:1,cases:molecularCases,cohort};
  const data = join(root,'training_data/neural-full-v2',run), reports = join(root,'artifacts/neural/molecular-training',run);
  mkdirSync(dirname(data),{recursive:true,mode:0o700});
  const lockPath=join(dirname(data),`.${run}.collector.lock`); const lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,utc:new Date().toISOString()}));
  const cancellation = new AbortController(); const stop=()=>cancellation.abort(); process.on('SIGINT',stop); process.on('SIGTERM',stop);
  try {
  if (existsSync(join(data,'collector.lock'))) throw Error('Legacy collector lock exists; termination uncertain, refusing takeover');
  const manifestPath = join(data,'manifest.json'); let manifest;
  if (existsSync(data)) {
    if (!resume || !existsSync(manifestPath)) throw Error('Existing data requires matching --resume');
    manifest = JSON.parse(readFileSync(manifestPath,'utf8')); validateResume(manifest,config);
    if (sha256(readFileSync(join(data,'worker.mjs'),'utf8')) !== manifest.provenance.bundleHash) throw Error('Frozen bundle hash mismatch');
  } else {
    mkdirSync(data,{recursive:true,mode:0o700}); mkdirSync(reports,{recursive:true});
    const provenance = await freezeBundle(data);
    manifest = { schemaVersion:2, sourceKind:'molecular-simulated',purpose:'training',scope:'Bounded molecular simulated TRAIN targets; never full mathematical teacher or parity evidence', createdUtc:new Date().toISOString(), config, provenance, cohort:cohort ? `${cohort.purpose}; namespace=${cohort.namespace}; not release test` : 'development calibration; exposed; never release test', inputPolicy:'empty full default243; no teacher dorm or auxiliary context; branchCount3 deepSearchfalse', stagePolicy:'actual legal random stage mixture, required proviso same draw', seedDerivation:'inventory LCG32(seed), stage LCG32(seed XOR 0x9e3779b9), optimizer seed XOR 0x85ebca6b', node:process.version, cases:[] };
    for (const c of config.cases) {
      const input = JSON.parse(execFileSync(process.execPath,[join(data,'worker.mjs'),'--prepare'], {input:JSON.stringify(c),maxBuffer:8*1024*1024,encoding:'utf8'}));
      const inputHash = sha256(input); publishExclusiveJson(join(data,`${input.familyId}.input.json`),input);
      manifest.cases.push({familyId:input.familyId,inputHash,inventoryHash:input.inventoryHash,...c});
    }
    if (new Set(manifest.cases.map(c=>c.inventoryHash)).size !== manifest.cases.length) throw Error('Duplicate inventory family');
    const collisionAudit = inventoryCollisions(root, manifest.cases.map(c => JSON.parse(readFileSync(join(data,`${c.familyId}.input.json`),'utf8'))), data);
    atomic(join(reports,'inventory-collision-audit.json'), collisionAudit);
    if (!collisionAudit.complete || collisionAudit.collisions.length || collisionAudit.familyIdCollisions.length) throw Error('Inventory collision audit failed; inspect report');
    manifest.collisionAuditHash = sha256(collisionAudit);
    publishExclusiveJson(manifestPath,manifest);
  }
  const checkpointPath=join(data,'checkpoint.json');
  const checkpoint=existsSync(checkpointPath)?JSON.parse(readFileSync(checkpointPath,'utf8')):{manifestHash:sha256(manifest),cases:{}};
  if(checkpoint.manifestHash!==sha256(manifest)) throw Error('Checkpoint manifest mismatch');
  if (Object.values(checkpoint.cases).some(attempts => attempts.at(-1)?.status === 'running')) throw Error('Cannot resume while a process is running or its termination is uncertain');
    for(const c of manifest.cases) {
      if(cancellation.signal.aborted) break;
      const attempts=checkpoint.cases[c.familyId]??=[]; const last=attempts.at(-1);
      if(last?.status==='completed') continue;
      if(last && !options['retry-reason']) { console.error(JSON.stringify({event:'not-retried',familyId:c.familyId,status:last.status,reason:'requires diagnosed --retry-reason'})); continue; }
      const wallTimeoutMs=retryBudget(last,{defaultTimeoutMs:config.timeoutMs,retryTimeoutMs,reason:options['retry-reason'],resume});
      const input=JSON.parse(readFileSync(join(data,`${c.familyId}.input.json`),'utf8')); if(sha256(input)!==c.inputHash) throw Error('Input hash mismatch');
      const prefix=join(data,`${c.familyId}.attempt-${attempts.length+1}`);
      for(const suffix of ['.result.json','.stdout.json','.progress.jsonl','.stdout.json.terminal.json'])if(existsSync(prefix+suffix))throw Error('Refusing existing immutable attempt artifact: '+prefix+suffix);
      const attempt={attempt:attempts.length+1,wallTimeoutMs,status:'running',score:null,inputHash:c.inputHash,bundleHash:manifest.provenance.bundleHash,startedUtc:new Date().toISOString(),retryReason:options['retry-reason']??null}; attempts.push(attempt); atomic(checkpointPath,checkpoint);
      console.error(JSON.stringify({event:'case-start',familyId:c.familyId,...attempt,timeoutMs:wallTimeoutMs}));
      const candidateDirectory=prefix+'.candidates';mkdirSync(candidateDirectory,{mode:0o700});
      const outcome=await bounded(process.execPath,[join(data,'worker.mjs'),'--candidate-evidence',JSON.stringify({directory:candidateDirectory,sourceHash:manifest.provenance.sourceHash,bundleHash:manifest.provenance.bundleHash})],{input:JSON.stringify(input),timeoutMs:wallTimeoutMs,signal:cancellation.signal,stderrPath:prefix+'.progress.jsonl',stdoutPath:prefix+'.stdout.json',onProgress:progress=>{attempt.lastProgress=progress;atomic(checkpointPath,checkpoint);console.error(JSON.stringify({familyId:c.familyId,...progress}));}});
      if (outcome.result?.result?.workspace) { outcome.semanticAudit = auditTradingExclusions(outcome.result.result.workspace); atomic(join(reports,`${c.familyId}.semantic-audit.json`),outcome.semanticAudit); }
      publishExclusiveJson(prefix+'.result.json',outcome); Object.assign(attempt,{status:outcome.status,score:outcome.score,endedUtc:new Date().toISOString(),durationMs:outcome.durationMs,resultHash:sha256(outcome),resultPath:relative(root,prefix+'.result.json')}); atomic(checkpointPath,checkpoint);
      atomic(join(reports,'summary.json'),{manifestHash:sha256(manifest),sourceHash:manifest.provenance.sourceHash,bundleHash:manifest.provenance.bundleHash,cohort:manifest.cohort,cases:checkpoint.cases});
      console.error(JSON.stringify({event:'case-finished',familyId:c.familyId,...attempt}));
    }
  } finally { process.off('SIGINT',stop);process.off('SIGTERM',stop);closeSync(lock);unlinkSync(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
