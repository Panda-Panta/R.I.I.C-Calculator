// Test-only page for real built nested Workers; never changes application storage.
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const out = resolve('validation/neighborhood-performance-2026-10-01')
await build({ stdin: { contents: `export * from './src/optimizer/smartRoster'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: `${out}/browser-fixture-engine.mjs` })
const engine = await import(pathToFileURL(`${out}/browser-fixture-engine.mjs`).href)
const request = JSON.parse(readFileSync(new URL('./fixtures/neighborhood-request.json', import.meta.url), 'utf8'))
const workerRequest = { base: request.baseline, entries: request.inventory, options: {
  branchCount: 1, seed: 42, simulationWarmupHours: 0, simulationSampleHours: 1, enableDeepSearch: true, droneTarget: 'gold',
} }
const expected = engine.runSmartRoster(workerRequest.base, workerRequest.entries, workerRequest.options)
if (expected.status !== 'draft' || expected.phases.search?.result?.baseline.cases.length !== 4) throw new Error('Fixture must reach the real deep-search path')
writeFileSync('dist/neighborhood-request.json', JSON.stringify(workerRequest))
writeFileSync('dist/neighborhood-expected.json', JSON.stringify(expected))
const assets = readdirSync('dist/assets')
const parent = assets.find(name => name.startsWith('smartRosterWorker-'))
const child = assets.find(name => name.startsWith('candidateSimulationWorker-'))
if (!parent || !child) throw new Error('Build the application first')
const instrumentation = `const NativeWorker = self.Worker;
self.Worker = class extends NativeWorker {
  constructor(...args) { super(...args); self.postMessage({type:'lifecycle',action:'created'}); }
  postMessage(job) { self.postMessage({type:'lifecycle',action:job.incomeComparison?'scenario':'candidate'}); super.postMessage(job); }
  terminate() { self.postMessage({type:'lifecycle',action:'terminated'}); super.terminate(); }
};\n`
writeFileSync('dist/neighborhood-parent.js', instrumentation + readFileSync(`dist/assets/${parent}`, 'utf8'))
writeFileSync('dist/neighborhood-cancel-child.js', `const channel = new BroadcastChannel('neighborhood-cancel');
const id = crypto.randomUUID(); channel.postMessage({id,kind:'ready'});
setInterval(() => channel.postMessage({id,kind:'heartbeat'}), 50);
` + readFileSync(`dist/assets/${child}`, 'utf8') + `\nconst neighborhoodOriginalHandler = self.onmessage; self.onmessage = e => setTimeout(() => neighborhoodOriginalHandler(e), 3000);`)
writeFileSync('dist/neighborhood-cancel-parent.js', `const NativeWorker = self.Worker;
self.Worker = class extends NativeWorker { constructor(_url, options) { super('/neighborhood-cancel-child.js', options); } };\n` + readFileSync(`dist/assets/${parent}`, 'utf8'))
writeFileSync('dist/neighborhood-check.html', `<!doctype html><meta charset="utf-8"><title>邻域并行验证</title>
<h1>第三阶段邻域并行验证</h1><p>使用正式构建、真实仿真和嵌套线程，比较完整报告；不写入应用存档。</p>
<button id="start">验证并行与线程复用</button><button id="lifecycle">验证取消后线程退出</button><pre id="status">就绪</pre>
<script type="module">
const status = document.querySelector('#status'), start = document.querySelector('#start'), lifecycle = document.querySelector('#lifecycle');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
start.onclick = async () => {
  start.disabled = lifecycle.disabled = true;
  const request = await fetch('/neighborhood-request.json').then(r => r.json());
  const expected = await fetch('/neighborhood-expected.json').then(r => r.json());
  const worker = new Worker('/neighborhood-parent.js', {type:'module'});
  let created = 0, terminated = 0, scenarios = 0, searching = false;
  worker.onerror = e => { status.textContent = 'FAIL ' + e.message; worker.terminate(); start.disabled = lifecycle.disabled = false; };
  worker.onmessage = ({data}) => {
    if (data.type === 'lifecycle') { if(data.action === 'created') created++; if(data.action === 'terminated') terminated++; if(data.action === 'scenario') scenarios++; }
    if (data.type === 'progress') { searching ||= data.progress.label.includes('场景'); status.textContent = data.progress.label + '\\n创建 ' + created + '，释放 ' + terminated + '，邻域场景 ' + scenarios; }
    if (data.type === 'error') { status.textContent = 'FAIL ' + data.error; worker.terminate(); start.disabled = lifecycle.disabled = false; }
    if (data.type === 'complete') {
      const equivalent = canonical(data.report) === canonical(expected);
      const passed = equivalent && searching && scenarios === 4 && created > 1 && created <= 4 && created === terminated;
      status.textContent = (passed ? 'PASS' : 'FAIL') + '\\n' + JSON.stringify({equivalent,created,terminated,scenarios,searching,status:data.report.status,score:data.report.score}, null, 2);
      worker.terminate(); start.disabled = lifecycle.disabled = false;
    }
  };
  worker.postMessage(request);
};
lifecycle.onclick = async () => {
  start.disabled = lifecycle.disabled = true;
  const channel = new BroadcastChannel('neighborhood-cancel'), ready = new Set();
  const worker = new Worker('/neighborhood-cancel-parent.js', {type:'module'});
  let stopped = false, stoppedAt = 0, late = 0;
  const needed = Math.min(4, Math.max(1, navigator.hardwareConcurrency - 2));
  status.textContent = '等待第三阶段四场景子线程...';
  const timeout = setTimeout(() => { worker.terminate(); channel.close(); status.textContent = 'FAIL 子线程启动超时'; start.disabled = lifecycle.disabled = false; }, 60000);
  channel.onmessage = ({data}) => {
    if (data.kind === 'ready') ready.add(data.id);
    if (stopped && performance.now() - stoppedAt > 100) late++;
    if (!stopped && ready.size === needed && data.kind === 'heartbeat') {
      stopped = true; stoppedAt = performance.now(); worker.terminate(); clearTimeout(timeout);
      setTimeout(() => { channel.close(); status.textContent = (late === 0 ? 'PASS' : 'FAIL') + ' cancellation: children=' + ready.size + ', lateHeartbeats=' + late; start.disabled = lifecycle.disabled = false; }, 1500);
    }
  };
  worker.postMessage(await fetch('/neighborhood-request.json').then(r => r.json()));
};
</script>`)
console.log('Prepared http://127.0.0.1:4175/neighborhood-check.html')
