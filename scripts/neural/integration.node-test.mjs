import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './provenance.mjs';
test('CLI evidence is resumable, source-bound, and refuses unrelated overwrite', { timeout: 30000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), 'neural-integration-'));
    const output = join(temp, 'evidence');
    const args = ['scripts/neural/run.mjs', '--output', output, '--families', '3', '--sizes', '20', '--warmup', '0', '--sample', '1', '--epochs', '1'];
    const run = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', timeout: 25000 });
    try {
        const initial = run([]);
        assert.equal(initial.status, 0, initial.stderr + initial.stdout);
        const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
        const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
        const originalModel = readFileSync(join(output, 'model.json'), 'utf8');
        assert.equal(manifest.acceptanceWindow, false);
        assert.ok(manifest.sourceHash.length === 64 && manifest.featureHash.length === 64);
        assert.equal(new Set(manifest.families.map(f => f.inventoryHash)).size, 3);
        assert.ok(manifest.families.every(f => f.requiredProviso && f.entries.some(e => JSON.stringify(e) === JSON.stringify(f.requiredProviso))));
        assert.ok(report.evaluations.every(r => r.fallbackPlacements === 0));
        assert.ok(report.evaluations.filter(r => r.method === 'trained').every(r => r.neuralPlacements === 4));
        const scenarioPath = join(temp, 'scenario.json');
        const inferredPath = join(temp, 'inferred.json');
        writeFileSync(scenarioPath, JSON.stringify(manifest.families[0]));
        const inferenceArgs = ['scripts/neural/run.mjs', 'infer', '--checkpoint', join(output, 'checkpoint-model.json'), '--scenario', scenarioPath, '--output', inferredPath];
        const inference = spawnSync(process.execPath, inferenceArgs, { encoding: 'utf8', timeout: 10000 });
        assert.equal(inference.status, 0, inference.stderr);
        const decoded = JSON.parse(readFileSync(inferredPath, 'utf8'));
        assert.equal(decoded.modelPlacements, 4);
        assert.equal(decoded.fallbackPlacements, 0);
        assert.equal(decoded.simulation, null);
        assert.match(decoded.trainingSourceHash, /^[a-f0-9]{64}$/);
        assert.match(decoded.runtimeSourceHash, /^[a-f0-9]{64}$/);
        assert.match(decoded.datasetHash, /^[a-f0-9]{64}$/);
        const envelope = JSON.parse(readFileSync(join(output, 'checkpoint-model.json'), 'utf8'));
        let invalidIndex = 0;
        for (const mutate of [value => { delete value.featureHash }, value => { value.inferenceContractHash = 'f'.repeat(64) }, value => { delete value.datasetHash }, value => { value.model.featureCount++ }]) {
            const malformed = structuredClone(envelope);
            mutate(malformed);
            const badPath = join(temp, 'bad-checkpoint.json');
            writeFileSync(badPath, JSON.stringify(malformed));
            const absentOutput = join(temp, `invalid-${invalidIndex++}.json`);
            assert.equal(existsSync(absentOutput), false);
            const invalid = spawnSync(process.execPath, inferenceArgs.map((arg, index) => index === 3 ? badPath : index === 7 ? absentOutput : arg), { encoding: 'utf8', timeout: 10000 });
            assert.notEqual(invalid.status, 0, 'Malformed/stale model must fail before writing output');
            assert.match(invalid.stderr, /Missing or invalid checkpoint|Incompatible checkpoint inference contract|Invalid .*dimension|feature count mismatch/);
            assert.equal(existsSync(absentOutput), false, 'Validation must reject before creating output');
        }
        
        assert.notEqual(spawnSync(process.execPath, inferenceArgs, { encoding: 'utf8' }).status, 0);
        const originalV1 = { ...envelope, schemaVersion: 1, sourceHash: envelope.trainingSourceHash };
        delete originalV1.trainingSourceHash;
        delete originalV1.inferenceContractHash;
        const originalPath = join(temp, 'v1.json');
        const migratedPath = join(temp, 'v2.json');
        writeFileSync(originalPath, JSON.stringify(originalV1));
        const migration = spawnSync(process.execPath, ['scripts/neural/migrate-checkpoint.mjs', originalPath, join(output, 'manifest.json'), migratedPath], { encoding: 'utf8' });
        assert.equal(migration.status, 0, migration.stderr);
        const migrated = JSON.parse(readFileSync(migratedPath, 'utf8'));
        assert.equal(migrated.trainingSourceHash, envelope.trainingSourceHash);
        assert.equal(migrated.modelHash, envelope.modelHash);
        assert.match(migrated.migration.originalEnvelopeHash, /^[a-f0-9]{64}$/);
        const changedManifest = structuredClone(manifest);
        changedManifest.sourceHashes['src/optimizer/neural/decode.ts'] = '0'.repeat(64);
        changedManifest.sourceHash = sha256(changedManifest.sourceHashes);
        originalV1.sourceHash = changedManifest.sourceHash;
        writeFileSync(originalPath, JSON.stringify(originalV1));
        const changedManifestPath = join(temp, 'changed-manifest.json');
        writeFileSync(changedManifestPath, JSON.stringify(changedManifest));
        const rejectedMigration = spawnSync(process.execPath, ['scripts/neural/migrate-checkpoint.mjs', originalPath, changedManifestPath, join(temp, 'must-not-write.json')], { encoding: 'utf8' });
        assert.notEqual(rejectedMigration.status, 0);
        assert.match(rejectedMigration.stderr, /Inference source changed/);
        const duplicate = run([]);
        assert.notEqual(duplicate.status, 0);
        assert.match(duplicate.stderr, /refusing overwrite/);
        assert.equal(readFileSync(join(output, 'model.json'), 'utf8'), originalModel);
        const resumed = run(['--resume']);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(readFileSync(join(output, 'model.json'), 'utf8'), originalModel);
        const mismatch = run(['--resume', '--seed', '1']);
        assert.notEqual(mismatch.status, 0);
        assert.match(mismatch.stderr, /signature mismatch/);
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
});


test('actual synchronous training has a bounded signal exit and preserves teacher checkpoint', { timeout: 30000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'neural-cancel-'));
    const output = join(temp, 'evidence');
    const child = spawn(process.execPath, ['scripts/neural/run.mjs', '--output', output, '--families', '3', '--sizes', '400', '--warmup', '0', '--sample', '1', '--epochs', '500'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', interruptedAt = null, stderr = '';
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.on('data', data => {
        text += data.toString();
        if (interruptedAt === null && text.includes('"phase":"training-start"')) {
            interruptedAt = performance.now();
            child.kill('SIGTERM');
        }
    });
    child.stderr.on('data', data => { stderr += data.toString(); });
    try {
        const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        assert.notEqual(interruptedAt, null, stderr + text);
        assert.ok(performance.now() - interruptedAt < 5000, 'signal must not wait for all training epochs');
        assert.equal(code, 130);
        const checkpoint = JSON.parse(readFileSync(join(output, 'checkpoint.json'), 'utf8'));
        assert.equal(checkpoint.teachers.length, 3);
        assert.ok(checkpoint.teachers.every(t => t.complete));
        assert.equal(existsSync(join(output, 'model.json')), false);
    } finally { clearTimeout(watchdog); rmSync(temp, { recursive: true, force: true }); }
});
