// Freeze the new research domain independently from the unchanged old native engine. Zero F.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sha256 } from './native_evaluator.mjs'
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..'), args = new Map()
for (let index = 2; index < process.argv.length; index += 2) { assert(process.argv[index]?.startsWith('--') && process.argv[index + 1]); args.set(process.argv[index].slice(2), process.argv[index + 1]) }
for (const key of ['case', 'engine-binding', 'out']) assert(args.has(key), `Missing --${key}`)
const casePath = resolve(args.get('case')), caseInput = JSON.parse(readFileSync(casePath, 'utf8')), inputPath = resolve(dirname(casePath), caseInput.domainInputPath)
const inputBytes = readFileSync(inputPath), input = JSON.parse(inputBytes), out = resolve(args.get('out')); assert(!existsSync(out), 'Refuse replacing frozen domain evidence')
const bindingPath = resolve(args.get('engine-binding')), bindingBytes = readFileSync(bindingPath), binding = JSON.parse(bindingBytes), manifest = JSON.parse(readFileSync(binding.manifestPath, 'utf8'))
const nativeMatches = () => manifest.inputs.every(row => sha256(readFileSync(row.path)) === row.sha256)
assert.equal(sha256(readFileSync(binding.bundlePath)), binding.bundleSha256); assert.equal(sha256(readFileSync(binding.manifestPath)), binding.manifestSha256)
assert(nativeMatches(), 'Native transitive sources drifted; new HEAD alone does not bind engine')
assert.equal(caseInput.sceneId, input.sceneId)
mkdirSync(out, { recursive: true })
const require = createRequire(resolve(root, 'package.json')), vite = require.resolve('vite'), { build, version } = require(require.resolve('esbuild', { paths: [vite] }))
const pinyin = require.resolve('pinyin-pro/package.json'), pinyinMeta = JSON.parse(readFileSync(pinyin, 'utf8')), captured = new Map(), guards = []
const bundlePath = resolve(out, 'domain-bundle.mjs')
await build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: "export {buildMainRosterHybridDomain} from './src/optimizer/mainRosterHybridDomain';" },
  bundle: true, platform: 'node', format: 'esm', outfile: bundlePath, nodePaths: [resolve(root, 'node_modules')],
  alias: { 'pinyin-pro': resolve(dirname(pinyin), pinyinMeta.exports['.'].import.default) }, logLevel: 'silent',
  plugins: [{ name: 'capture-domain-source-and-deny-native-f', setup(builder) { builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, file => {
    const bytes = readFileSync(file.path); captured.set(file.path, sha256(bytes)); let text = bytes.toString('utf8')
    if (file.path.replaceAll('\\', '/').endsWith('/src/simulator/scheduleSimulation.ts')) {
      const line = text.match(/export function simulateSchedule\([^\r\n]+\):ScheduleSimulationReport \{/)
      assert(line, 'Zero-F domain guard signature changed')
      text = text.replace(line[0], line[0] + '\n if ((globalThis as any).__hybridDomainForbidNativeF) { (globalThis as any).__hybridDomainNativeAttempts++; throw new Error("Research domain construction must not run native F") }')
      guards.push({ path: file.path, originalSha256: sha256(bytes), guardedSha256: sha256(text), scope: 'Domain-only bundle, no modification to native F bundle or source files' })
    }
    return { contents: text, loader: file.path.endsWith('.json') ? 'json' : /\.tsx?$/.test(file.path) ? 'ts' : 'js', resolveDir: dirname(file.path) }
  }) } }] })
// Types are erased by esbuild; bind their actual source bytes explicitly.
for (const path of [resolve(root, 'src/optimizer/mainRosterHybridTypes.ts')]) captured.set(path, sha256(readFileSync(path)))
assert([...captured].every(([path, digest]) => sha256(readFileSync(path)) === digest), 'Domain sources changed during compilation')
const module = await import(pathToFileURL(bundlePath).href); assert.equal(typeof module.buildMainRosterHybridDomain, 'function')
globalThis.__hybridDomainNativeAttempts = 0; globalThis.__hybridDomainForbidNativeF = true
let domain
try { domain = module.buildMainRosterHybridDomain(input) } finally { delete globalThis.__hybridDomainForbidNativeF }
const attempts = globalThis.__hybridDomainNativeAttempts; delete globalThis.__hybridDomainNativeAttempts
assert.equal(attempts, 0, 'Domain attempted a forbidden native F')
assert.equal(domain.schemaVersion, 1); assert.equal(domain.sceneId, caseInput.sceneId)
assert(domain.publicSpec.domains.length > 0 && domain.publicSpec.domains.reduce((n, size) => n * size, 1) <= 128)
assert.equal(JSON.stringify(domain.publicSpec.initial), JSON.stringify(domain.initial))
const incumbent = domain.materializations[domain.initial.join(',')]
assert.equal(incumbent.status, 'ready', 'Incumbent must have explicit original-base admission')
assert.equal(JSON.stringify(incumbent.workspace), JSON.stringify(input.incumbent), 'Domain initial silently changed the actual incumbent')
assert.equal(sha256(readFileSync(inputPath)), sha256(inputBytes), 'Typed domain input file changed')
assert(nativeMatches()); assert([...captured].every(([path, digest]) => sha256(readFileSync(path)) === digest), 'Domain source changed during materialization')
const domainPath = resolve(out, 'domain.json'), publicPath = resolve(out, 'public-spec.json')
writeFileSync(domainPath, JSON.stringify(domain, null, 2)); writeFileSync(publicPath, JSON.stringify(domain.publicSpec, null, 2))
const record = { schemaVersion: 1, sceneId: domain.sceneId, casePath, caseSha256: sha256(readFileSync(casePath)), inputPath, inputSha256: sha256(inputBytes),
  domainBundlePath: bundlePath, domainBundleSha256: sha256(readFileSync(bundlePath)), domainPath, domainSha256: sha256(readFileSync(domainPath)),
  publicSpecPath: publicPath, publicSpecSha256: sha256(readFileSync(publicPath)), sourceSha256: sha256(JSON.stringify([...captured].sort())),
  inputs: [...captured].sort().map(([path, sha256]) => ({ path, sha256 })), engineBindingPath: bindingPath, engineBindingSha256: sha256(bindingBytes),
  engineSourceSha256: binding.sourceSha256, engineBundleSha256: binding.bundleSha256, productionInputsStillMatch: true,
  node: process.version, esbuild: version, guards, domainEvidence: domain.evidence, nativeFCalls: 0,
  scope: 'Bound domain/public G model and actual private materializations only; not native F labels or a general sparsity/optimality certificate.' }
writeFileSync(resolve(out, 'domain-binding.json'), JSON.stringify(record, null, 2))
console.log(JSON.stringify({ out, sceneId: domain.sceneId, domainPath, domainSha256: record.domainSha256, evidence: domain.evidence, nativeFCalls: 0 }))
