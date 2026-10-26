import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualifyEnvelope, advanceCursor, saveCheckpoint, loadCheckpoint, verifyBinding } from './full-training/state.mjs';
function record() { const input = { split: 'dev', options: { branchCount: 10, enableDeepSearch: true, simulationWarmupHours: 24, simulationSampleHours: 72 } }, teacher = { status: 'draft', score: 0, workspace: {}, calculationReport: {} }; return { input, outcome: { status: 'completed', completed: true, score: 0, result: { completed: true, score: 0, result: teacher, validation: { physical: [] } } } }; }
test('only completed qualified envelope; zero retained and exposed dev cannot become train', () => { const { input, outcome } = record(); assert.equal(qualifyEnvelope(input, outcome, 'dev-overfit').qualified, true); assert.equal(qualifyEnvelope(input, outcome, 'train').qualified, false); outcome.score = null; assert.equal(qualifyEnvelope(input, outcome, 'dev-overfit').qualified, false); });
test('incomplete/conflicting/unknown physical outputs rejected without mutation', () => {
    for (const change of [o => o.completed = false, o => o.result.result.status = 'error', o => o.result.score = 1, o => delete o.result.validation.physical]) {
        const { input, outcome } = record();
        change(outcome);
        const before = JSON.stringify(outcome);
        assert.equal(qualifyEnvelope(input, outcome, 'dev-overfit').qualified, false);
        assert.equal(JSON.stringify(outcome), before);
    }
});
test('outer epoch family action cursor resumes exactly at cancellation boundaries', () => { const c = { epoch: 0, family: 0, action: 0, updates: 0 }, lengths = [3, 2]; assert.deepEqual(advanceCursor(advanceCursor(c, 2, lengths), 7, lengths), advanceCursor(c, 9, lengths)); assert.deepEqual(advanceCursor(c, 0, lengths), c); assert.deepEqual(advanceCursor(c, 5, lengths), { epoch: 1, family: 0, action: 0, updates: 5 }); });
test('atomic model+cursor binding rejects changed datasets/sources/features/settings and corrupt model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'full-train-'));
    try {
        const binding = { dataset: 'a', source: 'b', feature: 'c', learningRate: .1 }, state = { binding, cursor: { epoch: 0, family: 0, action: 2, updates: 2 } };
        saveCheckpoint(dir, new Uint8Array([1, 2, 3]), state);
        assert.deepEqual(loadCheckpoint(dir, binding).state.cursor, state.cursor);
        for (const k of Object.keys(binding))
            assert.throws(() => loadCheckpoint(dir, { ...binding, [k]: 'changed' }), /mismatch/);
        const pointer = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8'));
        writeFileSync(join(dir, pointer.generation, 'model.bin'), 'broken');
        assert.throws(() => loadCheckpoint(dir, binding), /integrity/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('stable exact binding, no permissive partial matching', () => { assert.doesNotThrow(() => verifyBinding({ source: 'x' }, { source: 'x' })); assert.throws(() => verifyBinding({ source: 'x', unknown: 1 }, { source: 'x' })); });
test('full compact trace exactly replays; numeric binary resume is bitwise and cancellation performs zero updates', async () => {
    const { createRequire } = await import('node:module'), { execFileSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
    const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })), dir = mkdtempSync(join(tmpdir(), 'full-contract-'));
    try {
        const outfile = join(dir, 'contract.mjs');
        await build({ entryPoints: [fileURLToPath(new URL('./full-training/contract-tests.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning' });
        const output = execFileSync(process.execPath, [outfile, '--library'], { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        assert.match(output, /bitwise equal/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('external watchdog bounds synchronous workers', async () => {
    const { runWorker } = await import('./full-training/process.mjs'), dir = mkdtempSync(join(tmpdir(), 'full-watchdog-'));
    try {
        const p = join(dir, 'worker.mjs');
        writeFileSync(p, 'while(true){}');
        const outcome = await runWorker(p, {}, { timeoutMs: 100 });
        assert.equal(outcome.status, 'timeout');
        assert.equal(outcome.result, null);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('collector ingestion verifies input/result/shared-source commitments and preserves failed attempts', async () => {
    const { collectSources } = await import('./full-train.mjs'), { atomic, digest } = await import('./full-training/state.mjs'), dir = mkdtempSync(join(tmpdir(), 'full-ingest-'));
    try {
        const { input, outcome } = record();
        input.familyId = 'fixture';
        const manifest = { provenance: { sourceHashes: { 'src/shared.ts': 'a' } }, cases: [{ familyId: 'fixture', inputHash: digest(input) }] }, resultPath = join(dir, 'result.json');
        atomic(join(dir, 'manifest.json'), manifest);
        atomic(join(dir, 'fixture.input.json'), input);
        outcome.completed = false;
        outcome.score = null;
        atomic(resultPath, outcome);
        atomic(join(dir, 'checkpoint.json'), { manifestHash: digest(manifest), cases: { fixture: [{ attempt: 1, status: 'unqualified', resultPath, resultHash: digest(outcome) }] } });
        assert.equal(collectSources(dir, 'dev-overfit', { sourceHashes: { 'src/shared.ts': 'a' } }).records.length, 1);
        assert.throws(() => collectSources(dir, 'dev-overfit', { sourceHashes: { 'src/shared.ts': 'b' } }), /shared source mismatch/);
        atomic(join(dir, 'fixture.input.json'), { ...input, changed: 1 });
        assert.throws(() => collectSources(dir, 'dev-overfit', { sourceHashes: {} }), /input changed/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('paired evaluator retains invalid neural cases as null, never scores missing outputs zero', async () => {
    const { evaluateFreeRunning } = await import('./full-training/evaluate.mjs'), { atomic, digest } = await import('./full-training/state.mjs'), dir = mkdtempSync(join(tmpdir(), 'full-evaluate-'));
    try {
        const bundle = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({completed:true,score:0,result:{completed:true,simScore:0}})));", input = { familyId: 'fixture', options: { seed: 1, branchCount: 10, enableDeepSearch: true, simulationWarmupHours: 24, simulationSampleHours: 72 } }, outcome = { result: { result: { workspace: { exactTeacher: true } } } }, sources = { records: [{ outcome }] };
        writeFileSync(join(dir, 'worker.mjs'), bundle);
        writeFileSync(join(dir, 'decode-model.bin'), 'fixture-model');
        atomic(join(dir, 'manifest.json'), { provenance: { bundleHash: digest(bundle), sourceHash: 'fixture' } });
        atomic(join(dir, 'source-records.json'), sources);
        atomic(join(dir, 'dataset.json'), { sourceRecordsHash: digest(sources), records: [{ familyId: 'fixture', input, teacherRecordHash: digest(outcome) }] });
        atomic(join(dir, 'decode-latest.json'), { modelHash: digest('fixture-model'), cursor: { updates: 1 }, reports: [{ familyId: 'fixture', complete: false, diagnostics: ['invalid'], workspace: {} }] });
        const report = await evaluateFreeRunning(dir, { timeoutMs: 2000 });
        assert.equal(report.pairs.length, 4);
        for (const p of report.pairs) {
            assert.equal(p.neural.score, null);
            assert.equal(p.neural.status, 'invalid-decode');
            assert.equal(p.baseline.score, 0);
        }
        assert.equal(report.parity, false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('worker is terminated when its controller is SIGKILLed, not orphaned beyond watchdog', async () => {
    const { spawn } = await import('node:child_process'), { existsSync } = await import('node:fs'), dir = mkdtempSync(join(tmpdir(), 'full-owner-'));
    let parent;
    try {
        const ownerPath = join(dir, 'owner.json'), instanceId = 'regression-instance';
        const { runWorker, assertReclaimableController } = await import('./full-training/process.mjs');
        const worker = join(dir, 'worker.mjs'), started = join(dir, 'started'), escaped = join(dir, 'escaped'), runner = join(dir, 'runner.mjs');
        writeFileSync(worker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(started)},'started');const t=Date.now();while(Date.now()-t<800){}writeFileSync(${JSON.stringify(escaped)},'escaped');process.stdout.write('{}');`);
        writeFileSync(runner, `import{runWorker}from${JSON.stringify(new URL('./full-training/process.mjs', import.meta.url).href)};await runWorker(${JSON.stringify(worker)},{},{timeoutMs:5000,ownerPath:${JSON.stringify(ownerPath)},instanceId:${JSON.stringify(instanceId)}});`);
        parent = spawn(process.execPath, [runner], { stdio: 'ignore' });
        for (let i = 0; i < 100 && !existsSync(started); i++)
            await new Promise(r => setTimeout(r, 10));
        assert.ok(existsSync(started));
        assert.throws(() => runWorker(worker, {}, { timeoutMs: 1000, ownerPath, instanceId: 'second-writer' }), /terminal receipt/);
        parent.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 1100));
        assert.equal(existsSync(escaped), false, 'orphan worker continued after controller death');
        const receipt = JSON.parse(readFileSync(ownerPath, 'utf8'));
        assert.equal(receipt.terminal, true);
        assert.equal(receipt.reason, 'controller-dead');
        assert.doesNotThrow(() => assertReclaimableController({ controllerPid: parent.pid, instanceId, namespaceId: 'foreign' }, ownerPath, 'current'));
    }
    finally {
        parent?.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    }
});
test('stale controller ownership cannot reclaim a still-live supervisor or numerical worker', async () => {
    const { assertPriorWorkerStopped } = await import('./full-training/process.mjs'), { atomic } = await import('./full-training/state.mjs'), dir = mkdtempSync(join(tmpdir(), 'full-lock-'));
    try {
        const path = join(dir, 'owner.json');
        for (const field of ['supervisorPid', 'workerPid']) {
            atomic(path, { status: 'running', [field]: process.pid });
            assert.throws(() => assertPriorWorkerStopped(path), /still alive/);
        }
        atomic(path, { status: 'stopped', terminal: true, supervisorPid: process.pid });
        assert.doesNotThrow(() => assertPriorWorkerStopped(path));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('unknown/foreign PID namespaces require matching verified controller-death terminal receipts', async () => {
    const { assertReclaimableController, assertPriorWorkerStopped } = await import('./full-training/process.mjs'), { atomic } = await import('./full-training/state.mjs'), dir = mkdtempSync(join(tmpdir(), 'full-foreign-lock-'));
    try {
        const path = join(dir, 'owner.json'), lock = { controllerPid: 99999999, instanceId: 'one', namespaceId: 'foreign' };
        atomic(path, { status: 'running', supervisorPid: 99999998, workerPid: 99999997 });
        assert.throws(() => assertPriorWorkerStopped(path), /uncertain/);
        atomic(path, { status: 'stopped', terminal: true, instanceId: 'one', reason: null });
        assert.throws(() => assertReclaimableController(lock, path, 'current'), /controller-death receipt/);
        atomic(path, { status: 'stopped', terminal: true, instanceId: 'different', reason: 'controller-dead' });
        assert.throws(() => assertReclaimableController(lock, path, 'current'), /mismatch/);
        atomic(path, { status: 'stopped', terminal: true, instanceId: 'one', reason: 'controller-dead' });
        assert.doesNotThrow(() => assertReclaimableController(lock, path, 'current'));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('concurrent stale-lock reclaim serializes check+replace and stale transition guard fails closed', async () => {
    const { acquireControllerLock, namespaceIdentity } = await import('./full-training/process.mjs'), { atomic } = await import('./full-training/state.mjs'), { mkdirSync } = await import('node:fs'), { spawn } = await import('node:child_process'), dir = mkdtempSync(join(tmpdir(), 'full-lock-race-'));
    try {
        mkdirSync(join(dir, 'run-lock-transition'));
        assert.throws(() => acquireControllerLock(dir, 'blocked'), /uncertain lock transition/);
        rmSync(join(dir, 'run-lock-transition'), { recursive: true });
        atomic(join(dir, 'run.lock'), { controllerPid: 99999999, namespaceId: namespaceIdentity(), instanceId: 'old' });
        atomic(join(dir, 'worker-owner.json'), { terminal: true, status: 'stopped', instanceId: 'old', reason: 'controller-dead' });
        const script = join(dir, 'claim.mjs');
        writeFileSync(script, `import{acquireControllerLock}from${JSON.stringify(new URL('./full-training/process.mjs', import.meta.url).href)};try{acquireControllerLock(process.argv[2],process.argv[3]);process.stdout.write('acquired');await new Promise(r=>setTimeout(r,200));}catch(e){process.stdout.write('blocked');process.exitCode=1;}`);
        const claim = id => new Promise(resolve => { const child = spawn(process.execPath, [script, dir, id], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; child.stdout.on('data', b => out += b); child.on('close', () => resolve(out)); });
        const results = await Promise.all([claim('one'), claim('two')]);
        assert.equal(results.filter(x => x === 'acquired').length, 1);
        assert.equal(results.filter(x => x === 'blocked').length, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('lineage selection is explicit, immutable on resume, and rejects feature mismatch/dev promotion', async () => {
    const { initializationSpec, verifyInitialization } = await import('./full-training/lineage.mjs'), { digest } = await import('./full-training/state.mjs');
    assert.throws(() => initializationSpec({ 'fork-from': 'a', 'fresh-from': 'b', 'init-reason': 'x' }), /OR/);
    assert.throws(() => initializationSpec({ 'fork-from': 'a' }), /nonempty/);
    assert.deepEqual(initializationSpec({}, { mode: 'fork', parentRun: 'a', reason: 'diagnosis' }), { mode: 'fork', parentRun: 'a', reason: 'diagnosis' });
    const lineage = { spec: { mode: 'fork' }, parent: { modelHash: 'm', featureManifestHash: 'f', purpose: 'dev-overfit' }, initialModelHash: 'm' }, binding = { lineageHash: digest(lineage), featureManifestHash: 'f', purpose: 'dev-overfit' };
    assert.doesNotThrow(() => verifyInitialization(lineage, binding));
    assert.throws(() => verifyInitialization(lineage, { ...binding, featureManifestHash: 'new' }), /feature contract/);
    assert.throws(() => verifyInitialization(lineage, { ...binding, purpose: 'train' }), /promote/);
    assert.throws(() => verifyInitialization({ ...lineage, initialModelHash: 'changed' }, binding), /lineage mismatch/);
});
test('explicit fresh lineage can cross a feature contract without transferring weights', async () => { const { verifyInitialization } = await import('./full-training/lineage.mjs'), { digest } = await import('./full-training/state.mjs'); const lineage = { spec: { mode: 'fresh' }, parent: { featureManifestHash: 'old', modelHash: 'old-model', purpose: 'dev-overfit' }, initialModelHash: null }; assert.doesNotThrow(() => verifyInitialization(lineage, { lineageHash: digest(lineage), featureManifestHash: 'new', purpose: 'dev-overfit' })); });
