import { spawn } from 'node:child_process';
/** An external watchdog can kill a blocked synchronous simulator. Cancellation waits for close. */
export function runBoundedProcess(command, args, { input = '', timeoutMs = 60000, signal } = {}) {
    return new Promise(resolve => {
        const started = performance.now();
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [], errors = [];
        let timedOut = false, cancelled = false, launchError;
        const stop = () => { cancelled = true; child.kill('SIGKILL'); };
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted)
            stop();
        child.stdout.on('data', data => chunks.push(data));
        child.stderr.on('data', data => errors.push(data));
        child.on('error', error => { launchError = error; });
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            const durationMs = performance.now() - started;
            let result;
            try {
                result = JSON.parse(Buffer.concat(chunks).toString());
            }
            catch { /* Invalid output is a failure, never a score. */ }
            if (timedOut || cancelled || launchError || code !== 0 || !result) {
                const reason = timedOut ? 'EXTERNAL_PROCESS_TIMEOUT' : cancelled ? 'CANCELLED' : 'CHILD_PROCESS_FAILED';
                resolve({
                    completed: false, score: null, diagnostics: [reason, ...(launchError ? [String(launchError)] : []), ...(!timedOut && !cancelled ? [Buffer.concat(errors).toString().slice(-4000)] : [])], durationMs
                });
            }
            else
                resolve({ ...result, durationMs });
        });
        child.stdin.on('error', () => { });
        child.stdin.end(input);
    });
}
