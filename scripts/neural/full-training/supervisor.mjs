/** Independent event-loop watchdog survives a controller SIGKILL while worker runs synchronous CPU. */
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
const [bundle, parentText, timeoutText, ownerPath, instanceId] = process.argv.slice(2), parentPid = Number(parentText), timeoutMs = Number(timeoutText);
if (!Number.isSafeInteger(parentPid) || parentPid < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100)
    throw Error('Invalid supervisor arguments');
const child = spawn(process.execPath, [bundle], { stdio: ['pipe', 'pipe', 'pipe'] });
let reason = null;
const own = status => {
    if (ownerPath) {
        const path = ownerPath + '.supervisor.tmp';
        writeFileSync(path, JSON.stringify({ controllerPid: parentPid, supervisorPid: process.pid, workerPid: child.pid ?? null, instanceId, status, terminal: status === 'stopped', reason: status === 'stopped' && !parentAlive() ? 'controller-dead' : reason }));
        renameSync(path, ownerPath);
    }
};
const stop = why => { reason ??= why; child.kill('SIGKILL'); };
process.on('SIGTERM', () => stop('cancelled'));
process.on('SIGINT', () => stop('cancelled'));
const parentAlive = () => {
    try {
        process.kill(parentPid, 0);
        return true;
    }
    catch (e) {
        return e.code !== 'ESRCH';
    }
};
const watch = setInterval(() => {
    if (!parentAlive())
        stop('controller-dead');
}, 50), timer = setTimeout(() => stop('timeout'), timeoutMs);
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdout.on('error', () => stop('controller-pipe-closed'));
process.stderr.on('error', () => stop('controller-pipe-closed'));
child.on('error', () => { reason ??= 'worker-error'; });
own('running');
if (!parentAlive())
    stop('controller-dead');
child.on('close', code => { clearInterval(watch); clearTimeout(timer); own('stopped'); process.exitCode = reason === 'timeout' ? 124 : reason ? 125 : code ?? 1; });
