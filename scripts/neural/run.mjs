import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sourceProvenance } from './provenance.mjs';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = await mkdtemp(join(tmpdir(), 'riic-neural-'));
try {
    const provenance = sourceProvenance(root);
    await build({
        entryPoints: [join(root, 'scripts/neural/experiment.ts'), join(root, 'scripts/neural/simulation-worker.ts'), join(root, 'scripts/neural/infer.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outdir: temp, logLevel: 'warning'
    });
    if (sourceProvenance(root).sourceHash !== provenance.sourceHash)
        throw Error('Source changed during bundling; retry after source freeze');
    await writeFile(join(temp, 'provenance.json'), JSON.stringify(provenance));
    const code = await new Promise((resolve, reject) => {
        const inference = process.argv[2] === 'infer';
        const child = spawn(process.execPath, [join(temp, inference ? 'infer.js' : 'experiment.js'), ...process.argv.slice(inference ? 3 : 2)], {
            cwd: root, stdio: 'inherit', env: {
                ...process.env, NEURAL_SIMULATION_WORKER: join(temp, 'simulation-worker.js'), NEURAL_SOURCE_PROVENANCE: join(temp, 'provenance.json')
            }
        });
        let killTimer;
        const stop = signal => {
            child.kill(signal);
            // trainPolicy is synchronous: its event loop may not process a graceful signal.
            // The independent launcher enforces a finite grace period in that case.
            killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
        };
        const interrupt = () => stop('SIGINT');
        const terminate = () => stop('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        let error;
        child.on('error', value => { error = value; });
        child.on('close', (code, signal) => {
            clearTimeout(killTimer);
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            if (error)
                reject(error);
            else
                resolve(code ?? (signal ? 130 : 1));
        });
    });
    process.exitCode = code;
}
finally {
    // Child close (not merely exit/error) is awaited before deleting its worker bundle.
    await rm(temp, { recursive: true, force: true });
}
