import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, existsSync, writeFileSync, renameSync, readlinkSync, mkdirSync, rmdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code !== 'ESRCH';
    }
}
export function namespaceIdentity() {
    try {
        return readlinkSync('/proc/self/ns/pid');
    }
    catch {
        return null;
    }
}
export function assertPriorWorkerStopped(ownerPath) {
    if (!existsSync(ownerPath))
        return;
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (owner.status !== 'stopped' || owner.terminal !== true)
        throw Error('Prior supervisor/worker is still alive or uncertain; terminal receipt required before resume');
}
export function assertReclaimableController(lock, ownerPath, currentNamespace = namespaceIdentity()) {
    if (!lock || typeof lock !== 'object' || !lock.instanceId || !existsSync(ownerPath))
        throw Error('Uncertain stale lock; matching terminal receipt required');
    assertPriorWorkerStopped(ownerPath);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (owner.instanceId !== lock.instanceId)
        throw Error('Stale lock instance/terminal receipt mismatch');
    if (currentNamespace && lock.namespaceId === currentNamespace) {
        if (alive(lock.controllerPid))
            throw Error('Training controller still alive');
    }
    else if (owner.reason !== 'controller-dead')
        throw Error('Foreign or unknown PID namespace; verified controller-death receipt required');
}
/** Serialize validation + replacement; a crashed transition guard is deliberately never auto-reclaimed. */
export function acquireControllerLock(directory, instanceId) {
    const lock = join(directory, 'run.lock'), guard = join(directory, 'run-lock-transition');
    try {
        mkdirSync(guard, { mode: 0o700 });
    }
    catch (error) {
        throw Error('Concurrent or uncertain lock transition; do not reclaim its guard automatically: ' + String(error));
    }
    try {
        if (existsSync(lock)) {
            let previous;
            try {
                previous = JSON.parse(readFileSync(lock, 'utf8'));
            }
            catch {
                previous = null;
            }
            assertReclaimableController(previous, join(directory, 'worker-owner.json'));
            unlinkSync(lock);
        }
        const fd = openSync(lock, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify({ controllerPid: process.pid, instanceId, namespaceId: namespaceIdentity() }));
        }
        finally {
            closeSync(fd);
        }
        return lock;
    }
    finally {
        rmdirSync(guard);
    }
}
/** Independent supervisor + parent backstop, including synchronous numerical/simulation code. */
export function runWorker(bundle, job, { timeoutMs, signal, stderrPath, ownerPath, instanceId } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100)
        throw Error('Invalid worker timeout');
    if (ownerPath)
        assertPriorWorkerStopped(ownerPath);
    return new Promise(resolve => {
        const start = performance.now(), supervisor = fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), child = spawn(process.execPath, [supervisor, bundle, String(process.pid), String(timeoutMs), ownerPath ?? '', instanceId ?? ''], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }), chunks = [], log = stderrPath ? createWriteStream(stderrPath, { flags: 'a' }) : null;
        if (ownerPath) {
            const path = ownerPath + '.controller.tmp';
            writeFileSync(path, JSON.stringify({ controllerPid: process.pid, instanceId, supervisorPid: child.pid ?? null, workerPid: null, status: 'starting' }));
            renameSync(path, ownerPath);
        }
        let reason = null, error = null;
        const killGroup = () => {
            try {
                if (process.platform !== 'win32' && child.pid)
                    process.kill(-child.pid, 'SIGKILL');
                else
                    child.kill('SIGKILL');
            }
            catch { }
        };
        const stop = () => { reason ??= 'cancelled'; child.kill('SIGTERM'); };
        const backstop = setTimeout(() => { reason ??= 'timeout'; killGroup(); }, timeoutMs + 2000);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted)
            stop();
        child.stdout.on('data', x => chunks.push(x));
        child.stderr.on('data', x => log?.write(x));
        child.on('error', e => error = String(e));
        child.stdin.on('error', () => { });
        child.stdin.end(JSON.stringify(job));
        child.on('close', async (code) => {
            clearTimeout(backstop);
            signal?.removeEventListener('abort', stop);
            killGroup();
            if (log)
                await new Promise(r => log.end(r));
            let result = null;
            try {
                result = JSON.parse(Buffer.concat(chunks).toString());
            }
            catch { }
            resolve({ status: reason ?? (code === 124 ? 'timeout' : code === 125 ? 'cancelled' : code === 0 && result ? 'completed' : 'worker-error'), result, error, exitCode: code, durationMs: performance.now() - start });
        });
    });
}
