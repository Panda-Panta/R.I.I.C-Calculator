// Re-export existing pure helpers from a copy; never rebuild or modify the native F core.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from './native_evaluator.mjs'
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) { assert(process.argv[index]?.startsWith('--') && process.argv[index + 1]); args.set(process.argv[index].slice(2), process.argv[index + 1]) }
assert(args.has('engine-binding') && args.has('out'))
const bindingPath = resolve(args.get('engine-binding')), binding = JSON.parse(readFileSync(bindingPath, 'utf8')), out = resolve(args.get('out'))
assert(!existsSync(out)); assert.equal(sha256(readFileSync(binding.bundlePath)), binding.bundleSha256)
assert.equal(sha256(readFileSync(binding.manifestPath)), binding.manifestSha256)
const manifest = JSON.parse(readFileSync(binding.manifestPath, 'utf8'))
assert(manifest.inputs.every(row => sha256(readFileSync(row.path)) === row.sha256))
const text = readFileSync(binding.bundlePath, 'utf8'), extra = ['formedCombinations', 'preservesFormedCombinations', 'importMowerJson', 'exportMowerJson']
for (const name of extra) assert.equal(text.split(`function ${name}(`).length - 1, 1, `Existing pure helper is not uniquely bundled: ${name}`)
mkdirSync(out, { recursive: true })
const modulePath = resolve(out, 'native-audit.mjs'); writeFileSync(modulePath, text + '\nexport {' + extra.join(',') + '}\n')
const module = await import(pathToFileURL(modulePath).href)
for (const name of extra) assert.equal(typeof module[name], 'function')
assert.equal(sha256(readFileSync(binding.bundlePath)), binding.bundleSha256)
const record = { schemaVersion: 1, modulePath, moduleSha256: sha256(readFileSync(modulePath)), nativeBundlePath: binding.bundlePath,
  nativeBundleSha256: binding.bundleSha256, sourceSha256: binding.sourceSha256, engineBindingPath: bindingPath,
  engineBindingSha256: sha256(readFileSync(bindingPath)), existingExportsOnly: true, extraExportNames: extra,
  originalNativeFBundleModified: false, nativeFCalls: 0,
  scope: 'Pure audit helpers exported from an exact copy. F evaluation/cache identity remains the original native bundle, not this audit copy.' }
writeFileSync(resolve(out, 'binding.json'), JSON.stringify(record, null, 2)); console.log(JSON.stringify(record))
