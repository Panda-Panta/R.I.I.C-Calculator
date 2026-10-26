import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedProcess } from './process.mjs';
test('external watchdog kills synchronous infinite loop and keeps null label', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', 'while(true){}'], { timeoutMs: 100 });
    assert.equal(result.completed, false);
    assert.equal(result.score, null);
    assert.deepEqual(result.diagnostics, ['EXTERNAL_PROCESS_TIMEOUT']);
    assert.ok(result.durationMs < 5000);
});
test('crash cannot become zero reward', async () => { const r = await runBoundedProcess(process.execPath, ['-e', 'throw Error("bad")']); assert.equal(r.score, null); });
test('spawn error closes cleanly and preserves a null label', async () => {
    const result = await runBoundedProcess('/definitely/nonexistent/neural-executable', [], { timeoutMs: 1000 });
    assert.equal(result.completed, false);
    assert.equal(result.score, null);
    assert.equal(result.diagnostics[0], 'CHILD_PROCESS_FAILED');
});
test('abort kills child and resolves only after closure', async () => {
    const controller = new AbortController();
    const pending = runBoundedProcess(process.execPath, ['-e', 'while(true){}'], { signal: controller.signal, timeoutMs: 10000 });
    setTimeout(() => controller.abort(), 80);
    const result = await pending;
    assert.equal(result.score, null);
    assert.equal(result.diagnostics[0], 'CANCELLED');
    assert.ok(result.durationMs < 5000);
});
