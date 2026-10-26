import { spawn } from 'node:child_process';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** External watchdog covers synchronous construction, search, and output. All stderr retained. */
export function bounded(command, args, { input = '', timeoutMs, signal, stderrPath, stdoutPath, onProgress = () => {} }) {
  return new Promise(resolve => {
    const start = performance.now();
    const stdoutFd=stdoutPath ? openSync(stdoutPath,'wx',0o600) : null;let stderrFd;
    try{stderrFd=stderrPath ? openSync(stderrPath,'wx',0o600) : null;}catch(error){if(stdoutFd!==null)closeSync(stdoutFd);throw error;}
    const out = [], err = [], stdout = stdoutFd!==null ? createWriteStream(stdoutPath,{fd:stdoutFd}) : null, stderr = stderrFd!==null ? createWriteStream(stderrPath,{fd:stderrFd}) : null;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs',import.meta.url)),String(timeoutMs),stdoutPath ? stdoutPath+'.terminal.json' : '-',command,...args], { stdio: ['pipe','pipe','pipe'] });
    let reason = null, launchError = null, pending = '';
    const stop = () => { reason ??= 'CANCELLED'; child.kill('SIGTERM'); };
    const timer = setTimeout(() => { reason ??= 'EXTERNAL_PROCESS_TIMEOUT'; child.kill('SIGUSR2'); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    child.stdout.on('data', b => { out.push(b); stdout?.write(b); });
    child.stderr.on('data', b => { err.push(b); stderr?.write(b); pending += b; let i; while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i); pending = pending.slice(i + 1); try { onProgress(JSON.parse(line)); } catch {} } });
    child.on('error', e => { launchError = String(e); }); child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('close', async (code, killedSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      await Promise.all([stdout, stderr].filter(Boolean).map(s => new Promise(r => s.end(r))));
      let result = null; try { result = JSON.parse(Buffer.concat(out).toString()); } catch {}
      if (!reason && code === 124) reason = 'EXTERNAL_PROCESS_TIMEOUT';
      if (!reason && (launchError || code !== 0 || !result)) reason = 'CHILD_PROCESS_FAILED';
      const qualified = !reason && result?.completed === true && Number.isFinite(result.score);
      resolve({ status: reason ?? (qualified ? 'completed' : 'unqualified'), completed: qualified, score: qualified ? result.score : null, result, reason, launchError, exitCode: code, signal: killedSignal, durationMs: performance.now() - start, stderr: Buffer.concat(err).toString() });
    });
  });
}
